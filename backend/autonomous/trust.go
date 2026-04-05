package autonomous

import (
	"context"
	"log"
	"time"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/google/uuid"
)

// Action category defaults
var categoryDefaults = map[string]int{
	"read":       10,
	"write_low":  5,
	"write_high": 3,
	"critical":   0,
}

// TrustEntry represents a trust permission record
type TrustEntry struct {
	ID            uuid.UUID  `json:"id"`
	UserID        uuid.UUID  `json:"user_id"`
	ActionType    string     `json:"action_type"`
	ActionPattern string     `json:"action_pattern"`
	TrustScore    int        `json:"trust_score"`
	ApproveCount  int        `json:"approve_count"`
	RejectCount   int        `json:"reject_count"`
	LastUsedAt    *time.Time `json:"last_used_at"`
	CreatedAt     time.Time  `json:"created_at"`
}

// GetTrustScore returns trust score for a given action. Returns category default if not found.
func GetTrustScore(ctx context.Context, userID uuid.UUID, actionType, actionPattern string) (int, error) {
	var score int
	err := db.Pool.QueryRow(ctx,
		`SELECT trust_score FROM action_trust WHERE user_id=$1 AND action_type=$2 AND action_pattern=$3`,
		userID, actionType, actionPattern,
	).Scan(&score)
	if err != nil {
		if def, ok := categoryDefaults[actionType]; ok {
			return def, nil
		}
		return 0, nil
	}
	return score, nil
}

// CheckTrust returns the decision for an action: "execute", "notify", "ask", "block"
func CheckTrust(ctx context.Context, userID uuid.UUID, actionType, actionPattern string) (string, int, error) {
	score, err := GetTrustScore(ctx, userID, actionType, actionPattern)
	if err != nil {
		return "block", 0, err
	}
	switch {
	case score >= 8:
		return "execute", score, nil
	case score >= 4:
		return "notify", score, nil
	case score >= 1:
		return "ask", score, nil
	default:
		return "block", score, nil
	}
}

// Escalate increases trust score after user approves an action (+2, max 10)
func Escalate(ctx context.Context, userID uuid.UUID, actionType, actionPattern string) error {
	_, err := db.Pool.Exec(ctx,
		`INSERT INTO action_trust (user_id, action_type, action_pattern, trust_score, approve_count, last_used_at)
		 VALUES ($1, $2, $3, LEAST($4 + 2, 10), 1, NOW())
		 ON CONFLICT (user_id, action_type, action_pattern) DO UPDATE SET
		   trust_score = LEAST(action_trust.trust_score + 2, 10),
		   approve_count = action_trust.approve_count + 1,
		   last_used_at = NOW(),
		   updated_at = NOW()`,
		userID, actionType, actionPattern, categoryDefaults[actionType],
	)
	return err
}

// Deescalate decreases trust score after user rejects (-3, min 0)
func Deescalate(ctx context.Context, userID uuid.UUID, actionType, actionPattern string) error {
	_, err := db.Pool.Exec(ctx,
		`INSERT INTO action_trust (user_id, action_type, action_pattern, trust_score, reject_count, last_used_at)
		 VALUES ($1, $2, $3, GREATEST($4 - 3, 0), 1, NOW())
		 ON CONFLICT (user_id, action_type, action_pattern) DO UPDATE SET
		   trust_score = GREATEST(action_trust.trust_score - 3, 0),
		   reject_count = action_trust.reject_count + 1,
		   last_used_at = NOW(),
		   updated_at = NOW()`,
		userID, actionType, actionPattern, categoryDefaults[actionType],
	)
	return err
}

// ListTrust returns all trust entries for a user
func ListTrust(ctx context.Context, userID uuid.UUID) ([]TrustEntry, error) {
	rows, err := db.Pool.Query(ctx,
		`SELECT id, user_id, action_type, action_pattern, trust_score, approve_count, reject_count, last_used_at, created_at
		 FROM action_trust WHERE user_id=$1 ORDER BY action_type, action_pattern`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var entries []TrustEntry
	for rows.Next() {
		var e TrustEntry
		if err := rows.Scan(&e.ID, &e.UserID, &e.ActionType, &e.ActionPattern, &e.TrustScore,
			&e.ApproveCount, &e.RejectCount, &e.LastUsedAt, &e.CreatedAt); err != nil {
			continue
		}
		entries = append(entries, e)
	}
	return entries, nil
}

// DecayUnusedTrust reduces trust_score by 1 for entries not used in 30 days
func DecayUnusedTrust(ctx context.Context) error {
	_, err := db.Pool.Exec(ctx,
		`UPDATE action_trust SET trust_score = GREATEST(trust_score - 1, 0), updated_at = NOW()
		 WHERE last_used_at < NOW() - INTERVAL '30 days' AND trust_score > 0`)
	return err
}

// SeedDefaultTrust creates default trust entries for a new user if none exist.
func SeedDefaultTrust(ctx context.Context, userID uuid.UUID) error {
	var count int
	db.Pool.QueryRow(ctx, "SELECT COUNT(*) FROM action_trust WHERE user_id=$1", userID).Scan(&count)
	if count > 0 {
		return nil
	}

	defaults := []struct {
		actionType string
		pattern    string
		score      int
	}{
		// read = auto-execute (score 10)
		{"read", "memory_search", 10},
		{"read", "memory_list", 10},
		{"read", "knowledge_search", 10},
		{"read", "file_read", 10},
		{"read", "file_list", 10},
		{"read", "file_search", 10},
		// write_low = notify (score 5-8)
		{"write_low", "memory_save", 5},
		{"write_high", "file_write", 3},
		{"write_low", "send_file", 5},
		{"write_low", "manage_scheduled_task", 4},
		// write_high = ask (score 1-3)
		{"write_high", "terminal_exec", 1},
		{"write_high", "http_request", 3},
		// critical = blocked (score 0)
		{"critical", "server_ssh_exec", 0},
		{"critical", "delegate_agent", 0},
	}

	for _, d := range defaults {
		db.Pool.Exec(ctx,
			`INSERT INTO action_trust (id, user_id, action_type, action_pattern, trust_score, created_at, updated_at)
			 VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), now())
			 ON CONFLICT DO NOTHING`,
			userID, d.actionType, d.pattern, d.score)
	}
	log.Printf("[trust] seeded default trust entries for user %s", userID)
	return nil
}
