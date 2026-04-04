package ai

import (
	"context"
	"encoding/json"
	"log"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ahvholding/ahvclaw/crypto"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/google/uuid"
)

// ─── Connection Pool with Smart Rotation ─────────────────────────────────────

type ConnectionPool struct {
	DefaultRouter *RouterClient
	healthCache   sync.Map // connID -> *healthEntry
	rrCounters    sync.Map // comboID -> *uint64  (round-robin index)
}

type candidate struct {
	model string
	conn  *ResolvedConnection
}

type healthEntry struct {
	SuccessCount int64
	ErrorCount   int64
	LastError    time.Time
	LastSuccess  time.Time
	AvgLatencyMs int64 // exponential moving average
}

type ResolvedConnection struct {
	ConnectionID uuid.UUID
	BaseURL      string
	APIKey       string
	APIFormat    string
	Model        string
	AuthHeader   string
}

func NewConnectionPool(defaultRouter *RouterClient) *ConnectionPool {
	return &ConnectionPool{DefaultRouter: defaultRouter}
}

// Resolve finds the best connection for a given model, applying smart rotation strategy.
func (cp *ConnectionPool) Resolve(ctx context.Context, userID uuid.UUID, model string) ResolvedConnection {
	// 1. Check combos first — model name might be a combo name
	var comboID uuid.UUID
	var comboModelsRaw json.RawMessage
	var strategy string
	err := db.Pool.QueryRow(ctx,
		`SELECT id, models, strategy FROM model_combos
		 WHERE user_id = $1 AND name = $2 AND is_active = true`,
		userID, model).Scan(&comboID, &comboModelsRaw, &strategy)

	if err == nil {
		var chain []string
		if json.Unmarshal(comboModelsRaw, &chain) == nil && len(chain) > 0 {
			conn := cp.resolveCombo(ctx, userID, comboID, chain, strategy, model)
			if conn != nil {
				return *conn
			}
		}
	}

	// 2. Direct model lookup with smart fallback
	conn := cp.findConnectionByModel(ctx, userID, model)
	if conn != nil {
		return *conn
	}

	// 3. Fallback to default 9router
	log.Printf("[pool] %s -> default 9router", model)
	return ResolvedConnection{
		BaseURL:    cp.DefaultRouter.BaseURL,
		APIKey:     cp.DefaultRouter.APIKey,
		APIFormat:  "openai",
		Model:      model,
		AuthHeader: "Authorization",
	}
}

// resolveCombo applies the combo's strategy to pick a connection from the chain.
func (cp *ConnectionPool) resolveCombo(ctx context.Context, userID, comboID uuid.UUID, chain []string, strategy, comboName string) *ResolvedConnection {
	if strategy == "" {
		strategy = "auto"
	}

	// Resolve all valid connections first
	var candidates []candidate
	for _, m := range chain {
		parts := strings.SplitN(m, "/", 2)
		modelName := m
		if len(parts) == 2 {
			modelName = parts[1]
		}
		c := cp.findConnectionByModel(ctx, userID, modelName)
		if c != nil {
			candidates = append(candidates, candidate{model: modelName, conn: c})
		}
	}

	if len(candidates) == 0 {
		return nil
	}

	switch strategy {
	case "round-robin":
		idx := cp.nextRoundRobin(comboID, len(candidates))
		pick := candidates[idx]
		log.Printf("[pool] combo %s (round-robin #%d) -> %s", comboName, idx, pick.model)
		return pick.conn

	case "fallback":
		// Use first healthy connection, skip unhealthy ones
		for _, c := range candidates {
			if cp.isHealthy(c.conn.ConnectionID) {
				log.Printf("[pool] combo %s (fallback) -> %s", comboName, c.model)
				return c.conn
			}
		}
		// All unhealthy, use first anyway
		log.Printf("[pool] combo %s (fallback, all unhealthy) -> %s", comboName, candidates[0].model)
		return candidates[0].conn

	case "random":
		idx := rand.Intn(len(candidates))
		log.Printf("[pool] combo %s (random) -> %s", comboName, candidates[idx].model)
		return candidates[idx].conn

	default: // "auto" — smart mode
		// 1. Filter healthy candidates
		var healthy []candidate
		for _, c := range candidates {
			if cp.isHealthy(c.conn.ConnectionID) {
				healthy = append(healthy, c)
			}
		}
		if len(healthy) == 0 {
			healthy = candidates
		}

		// 2. If only one healthy, use it (fallback behavior)
		if len(healthy) == 1 {
			log.Printf("[pool] combo %s (auto/single) -> %s", comboName, healthy[0].model)
			return healthy[0].conn
		}

		// 3. Multiple healthy: weighted random by success rate
		pick := cp.weightedPick(healthy)
		log.Printf("[pool] combo %s (auto/weighted) -> %s", comboName, pick.model)
		return pick.conn
	}
}

// weightedPick selects a candidate weighted by health score (more successes = higher weight).
func (cp *ConnectionPool) weightedPick(candidates []candidate) candidate {
	type weighted struct {
		idx    int
		weight float64
	}
	var ws []weighted
	totalWeight := 0.0

	for i, c := range candidates {
		w := 1.0 // base weight
		if entry, ok := cp.healthCache.Load(c.conn.ConnectionID); ok {
			h := entry.(*healthEntry)
			total := float64(h.SuccessCount + h.ErrorCount)
			if total > 0 {
				successRate := float64(h.SuccessCount) / total
				w = successRate*10 + 1 // range: 1-11
			}
			// Penalize slow connections
			if h.AvgLatencyMs > 5000 {
				w *= 0.5
			}
		}
		ws = append(ws, weighted{idx: i, weight: w})
		totalWeight += w
	}

	r := rand.Float64() * totalWeight
	cumulative := 0.0
	for _, w := range ws {
		cumulative += w.weight
		if r <= cumulative {
			return candidates[w.idx]
		}
	}
	return candidates[0]
}

// nextRoundRobin returns the next index for round-robin selection.
func (cp *ConnectionPool) nextRoundRobin(comboID uuid.UUID, total int) int {
	val, _ := cp.rrCounters.LoadOrStore(comboID, new(uint64))
	counter := val.(*uint64)
	idx := atomic.AddUint64(counter, 1) - 1
	return int(idx % uint64(total))
}

// isHealthy returns true if the connection hasn't had too many recent errors.
func (cp *ConnectionPool) isHealthy(connID uuid.UUID) bool {
	if connID == uuid.Nil {
		return true
	}
	entry, ok := cp.healthCache.Load(connID)
	if !ok {
		return true // no data = assume healthy
	}
	h := entry.(*healthEntry)
	// Unhealthy if >50% errors in recent window and last error was recent
	total := h.SuccessCount + h.ErrorCount
	if total < 3 {
		return true
	}
	errorRate := float64(h.ErrorCount) / float64(total)
	recentError := time.Since(h.LastError) < 5*time.Minute
	return !(errorRate > 0.5 && recentError)
}

func (cp *ConnectionPool) findConnectionByModel(ctx context.Context, userID uuid.UUID, model string) *ResolvedConnection {
	rows, err := db.Pool.Query(ctx,
		`SELECT id, api_url, api_key_encrypted, api_format, provider_type, models, backoff_level
		 FROM provider_connections
		 WHERE user_id = $1 AND is_active = true
		 ORDER BY priority ASC, created_at ASC`, userID)
	if err != nil {
		return nil
	}
	defer rows.Close()

	for rows.Next() {
		var id uuid.UUID
		var apiURL, keyEnc, format, provType string
		var modelsRaw json.RawMessage
		var backoff int
		if rows.Scan(&id, &apiURL, &keyEnc, &format, &provType, &modelsRaw, &backoff) != nil {
			continue
		}
		if backoff > 5 {
			continue // skip connections in deep backoff
		}
		var models []string
		if json.Unmarshal(modelsRaw, &models) != nil {
			continue
		}
		for _, m := range models {
			if strings.EqualFold(m, model) {
				apiKey := decryptKey(keyEnc)
				regDef := ProviderRegistry[provType]
				authHeader := regDef.AuthHeader
				if authHeader == "" {
					authHeader = "Authorization"
				}
				return &ResolvedConnection{
					ConnectionID: id,
					BaseURL:      apiURL,
					APIKey:       apiKey,
					APIFormat:    format,
					Model:        model,
					AuthHeader:   authHeader,
				}
			}
		}
	}
	return nil
}

// TrackError records an error for health monitoring.
func (cp *ConnectionPool) TrackError(ctx context.Context, connID uuid.UUID, code int, msg string) {
	// Update in-memory health
	entry, _ := cp.healthCache.LoadOrStore(connID, &healthEntry{})
	h := entry.(*healthEntry)
	atomic.AddInt64(&h.ErrorCount, 1)
	h.LastError = time.Now()

	// Persist to DB
	db.Pool.Exec(ctx,
		`UPDATE provider_connections SET
		 error_code = $2, last_error = $3, last_error_at = now(),
		 backoff_level = LEAST(backoff_level + 1, 10),
		 test_status = 'unavailable', updated_at = now()
		 WHERE id = $1`, connID, code, truncStr(msg, 500))
}

// TrackSuccess records a successful request.
func (cp *ConnectionPool) TrackSuccess(ctx context.Context, connID uuid.UUID) {
	// Update in-memory health
	entry, _ := cp.healthCache.LoadOrStore(connID, &healthEntry{})
	h := entry.(*healthEntry)
	atomic.AddInt64(&h.SuccessCount, 1)
	h.LastSuccess = time.Now()

	// Persist to DB (reset error state)
	db.Pool.Exec(ctx,
		`UPDATE provider_connections SET
		 error_code = 0, backoff_level = GREATEST(backoff_level - 1, 0),
		 test_status = 'active', updated_at = now()
		 WHERE id = $1`, connID)
}

// TrackLatency records request latency for weighted routing.
func (cp *ConnectionPool) TrackLatency(ctx context.Context, connID uuid.UUID, latencyMs int64) {
	entry, _ := cp.healthCache.LoadOrStore(connID, &healthEntry{})
	h := entry.(*healthEntry)
	// Exponential moving average (alpha=0.3)
	old := atomic.LoadInt64(&h.AvgLatencyMs)
	if old == 0 {
		atomic.StoreInt64(&h.AvgLatencyMs, latencyMs)
	} else {
		avg := int64(float64(old)*0.7 + float64(latencyMs)*0.3)
		atomic.StoreInt64(&h.AvgLatencyMs, avg)
	}
}

// GetHealthStats returns health stats for all tracked connections.
func (cp *ConnectionPool) GetHealthStats() map[uuid.UUID]map[string]interface{} {
	stats := make(map[uuid.UUID]map[string]interface{})
	cp.healthCache.Range(func(key, value interface{}) bool {
		connID := key.(uuid.UUID)
		h := value.(*healthEntry)
		stats[connID] = map[string]interface{}{
			"success_count":  h.SuccessCount,
			"error_count":    h.ErrorCount,
			"avg_latency_ms": h.AvgLatencyMs,
			"last_error":     h.LastError,
			"last_success":   h.LastSuccess,
			"healthy":        cp.isHealthy(connID),
		}
		return true
	})
	return stats
}

func (rc ResolvedConnection) CreateClient() *RouterClient {
	return &RouterClient{
		BaseURL: rc.BaseURL,
		APIKey:  rc.APIKey,
		Client:  &http.Client{Timeout: 120 * time.Second},
	}
}

func truncStr(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}

func decryptKey(encrypted string) string {
	if encrypted == "" {
		return ""
	}
	plaintext, err := crypto.Decrypt(encrypted)
	if err != nil {
		return encrypted
	}
	return plaintext
}
