package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/ahvholding/ahvclaw/ai"
	"github.com/ahvholding/ahvclaw/crypto"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/models"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

// ─────────────────────────────────────────────────────────────────────────────
// Provider Connections CRUD
// ─────────────────────────────────────────────────────────────────────────────

func ListConnections(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	rows, err := db.Pool.Query(context.Background(),
		`SELECT id, user_id, provider_type, auth_type, name, priority, api_url, api_format,
		        token_expires_at, is_active, test_status, error_code, last_error, last_error_at,
		        backoff_level, models, provider_data, created_at, updated_at
		 FROM provider_connections WHERE user_id = $1 ORDER BY priority ASC, created_at DESC`, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch connections"})
	}
	defer rows.Close()

	var conns []models.ProviderConnection
	for rows.Next() {
		var p models.ProviderConnection
		if err := rows.Scan(
			&p.ID, &p.UserID, &p.ProviderType, &p.AuthType, &p.Name,
			&p.Priority, &p.APIURL, &p.APIFormat,
			&p.TokenExpiresAt, &p.IsActive, &p.TestStatus, &p.ErrorCode,
			&p.LastError, &p.LastErrorAt, &p.BackoffLevel,
			&p.Models, &p.ProviderData, &p.CreatedAt, &p.UpdatedAt,
		); err != nil {
			continue
		}
		conns = append(conns, p)
	}
	if conns == nil {
		conns = []models.ProviderConnection{}
	}
	return c.JSON(conns)
}

func CreateConnection(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	var req models.ConnectionCreateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}
	if req.ProviderType == "" {
		return c.Status(400).JSON(fiber.Map{"error": "provider_type is required"})
	}
	if req.APIKey == "" && req.AccessToken == "" {
		return c.Status(400).JSON(fiber.Map{"error": "api_key or access_token is required"})
	}

	// Auto-fill from registry
	regDef, ok := ai.ProviderRegistry[req.ProviderType]
	if !ok {
		regDef = ai.ProviderTypeDef{
			Type:      req.ProviderType,
			Name:      req.ProviderType,
			APIFormat: "openai",
		}
	}
	if req.APIURL == "" {
		req.APIURL = regDef.DefaultURL
	}
	if req.Name == "" {
		req.Name = regDef.Name
	}
	if req.AuthType == "" {
		req.AuthType = "api_key"
	}
	apiFormat := regDef.APIFormat
	if apiFormat == "" {
		apiFormat = "openai"
	}

	// Determine models
	modelsJSON := "[]"
	if req.Models != nil {
		modelsJSON = string(*req.Models)
	} else if len(regDef.KnownModels) > 0 {
		b, _ := json.Marshal(regDef.KnownModels)
		modelsJSON = string(b)
	}

	// Encrypt keys
	encAPIKey := ""
	if req.APIKey != "" {
		var err error
		encAPIKey, err = crypto.Encrypt(req.APIKey)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "failed to encrypt api_key"})
		}
	}
	encAccessToken := ""
	if req.AccessToken != "" {
		var err error
		encAccessToken, err = crypto.Encrypt(req.AccessToken)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "failed to encrypt access_token"})
		}
	}
	encRefreshToken := ""
	if req.RefreshToken != "" {
		var err error
		encRefreshToken, err = crypto.Encrypt(req.RefreshToken)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "failed to encrypt refresh_token"})
		}
	}

	var p models.ProviderConnection
	err := db.Pool.QueryRow(context.Background(),
		`INSERT INTO provider_connections
		 (user_id, provider_type, auth_type, name, priority, api_url, api_format,
		  api_key_encrypted, access_token_encrypted, refresh_token_encrypted, models)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
		 RETURNING id, user_id, provider_type, auth_type, name, priority, api_url, api_format,
		           token_expires_at, is_active, test_status, error_code, last_error, last_error_at,
		           backoff_level, models, provider_data, created_at, updated_at`,
		userID, req.ProviderType, req.AuthType, req.Name, req.Priority, req.APIURL, apiFormat,
		encAPIKey, encAccessToken, encRefreshToken, modelsJSON,
	).Scan(
		&p.ID, &p.UserID, &p.ProviderType, &p.AuthType, &p.Name,
		&p.Priority, &p.APIURL, &p.APIFormat,
		&p.TokenExpiresAt, &p.IsActive, &p.TestStatus, &p.ErrorCode,
		&p.LastError, &p.LastErrorAt, &p.BackoffLevel,
		&p.Models, &p.ProviderData, &p.CreatedAt, &p.UpdatedAt,
	)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to create connection: " + err.Error()})
	}
	return c.Status(201).JSON(p)
}

func UpdateConnection(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	connID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid connection ID"})
	}

	// Verify ownership
	var ownerID uuid.UUID
	err = db.Pool.QueryRow(context.Background(),
		"SELECT user_id FROM provider_connections WHERE id = $1", connID).Scan(&ownerID)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "connection not found"})
	}
	if ownerID != userID {
		return c.Status(403).JSON(fiber.Map{"error": "forbidden"})
	}

	var req models.ConnectionCreateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}

	setClauses := []string{}
	args := []interface{}{}
	argIdx := 1

	if req.Name != "" {
		setClauses = append(setClauses, fmt.Sprintf("name = $%d", argIdx))
		args = append(args, req.Name)
		argIdx++
	}
	if req.APIURL != "" {
		setClauses = append(setClauses, fmt.Sprintf("api_url = $%d", argIdx))
		args = append(args, req.APIURL)
		argIdx++
	}
	if req.APIKey != "" {
		encrypted, err := crypto.Encrypt(req.APIKey)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "failed to encrypt api_key"})
		}
		setClauses = append(setClauses, fmt.Sprintf("api_key_encrypted = $%d", argIdx))
		args = append(args, encrypted)
		argIdx++
	}
	if req.AccessToken != "" {
		encrypted, err := crypto.Encrypt(req.AccessToken)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "failed to encrypt access_token"})
		}
		setClauses = append(setClauses, fmt.Sprintf("access_token_encrypted = $%d", argIdx))
		args = append(args, encrypted)
		argIdx++
	}
	if req.Models != nil {
		setClauses = append(setClauses, fmt.Sprintf("models = $%d", argIdx))
		args = append(args, string(*req.Models))
		argIdx++
	}
	if req.Priority != 0 {
		setClauses = append(setClauses, fmt.Sprintf("priority = $%d", argIdx))
		args = append(args, req.Priority)
		argIdx++
	}

	// Allow toggling is_active via a special field
	type updateReqExtra struct {
		IsActive *bool `json:"is_active"`
	}
	var extra updateReqExtra
	_ = c.BodyParser(&extra)
	if extra.IsActive != nil {
		setClauses = append(setClauses, fmt.Sprintf("is_active = $%d", argIdx))
		args = append(args, *extra.IsActive)
		argIdx++
	}

	if len(setClauses) == 0 {
		return c.Status(400).JSON(fiber.Map{"error": "no fields to update"})
	}

	setClauses = append(setClauses, "updated_at = NOW()")
	args = append(args, connID)
	args = append(args, userID)
	query := fmt.Sprintf("UPDATE provider_connections SET %s WHERE id = $%d AND user_id = $%d",
		strings.Join(setClauses, ", "), argIdx, argIdx+1)

	_, err = db.Pool.Exec(context.Background(), query, args...)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to update connection"})
	}

	var p models.ProviderConnection
	err = db.Pool.QueryRow(context.Background(),
		`SELECT id, user_id, provider_type, auth_type, name, priority, api_url, api_format,
		        token_expires_at, is_active, test_status, error_code, last_error, last_error_at,
		        backoff_level, models, provider_data, created_at, updated_at
		 FROM provider_connections WHERE id = $1`, connID,
	).Scan(
		&p.ID, &p.UserID, &p.ProviderType, &p.AuthType, &p.Name,
		&p.Priority, &p.APIURL, &p.APIFormat,
		&p.TokenExpiresAt, &p.IsActive, &p.TestStatus, &p.ErrorCode,
		&p.LastError, &p.LastErrorAt, &p.BackoffLevel,
		&p.Models, &p.ProviderData, &p.CreatedAt, &p.UpdatedAt,
	)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch updated connection"})
	}
	return c.JSON(p)
}

func DeleteConnection(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	connID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid connection ID"})
	}

	result, err := db.Pool.Exec(context.Background(),
		"DELETE FROM provider_connections WHERE id = $1 AND user_id = $2", connID, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to delete connection"})
	}
	if result.RowsAffected() == 0 {
		return c.Status(404).JSON(fiber.Map{"error": "connection not found"})
	}
	return c.JSON(fiber.Map{"message": "connection deleted"})
}

func TestConnection(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	connID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid connection ID"})
	}

	var apiURL, apiKeyEnc, accessTokenEnc, apiFormat, providerType string
	err = db.Pool.QueryRow(context.Background(),
		`SELECT api_url, COALESCE(api_key_encrypted,''), COALESCE(access_token_encrypted,''), api_format, provider_type
		 FROM provider_connections WHERE id = $1 AND user_id = $2`,
		connID, userID).Scan(&apiURL, &apiKeyEnc, &accessTokenEnc, &apiFormat, &providerType)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "connection not found"})
	}

	var apiKey string
	if apiKeyEnc != "" {
		apiKey, _ = crypto.Decrypt(apiKeyEnc)
	}
	if apiKey == "" && accessTokenEnc != "" {
		apiKey, _ = crypto.Decrypt(accessTokenEnc)
	}
	if apiKey == "" {
		return c.Status(500).JSON(fiber.Map{"error": "no credentials found"})
	}

	client := &http.Client{Timeout: 15 * time.Second}
	var testReq *http.Request
	var testReqErr error

	if apiFormat == "anthropic" {
		// POST /v1/messages with a minimal test request
		baseURL := strings.TrimRight(apiURL, "/")
		testURL := baseURL + "/v1/messages"
		// Use first model from connection's model list
		testModel := "claude-haiku-4-5-20251001"
		var modelsRaw *string
		_ = db.Pool.QueryRow(context.Background(),
			"SELECT models::text FROM provider_connections WHERE id=$1", connID).Scan(&modelsRaw)
		if modelsRaw != nil {
			var ml []string
			if json.Unmarshal([]byte(*modelsRaw), &ml) == nil && len(ml) > 0 {
				testModel = ml[0]
			}
		}
		payload := map[string]interface{}{
			"model":      testModel,
			"max_tokens": 1,
			"messages":   []map[string]string{{"role": "user", "content": "hi"}},
		}
		body, _ := json.Marshal(payload)
		testReq, testReqErr = http.NewRequest("POST", testURL, bytes.NewReader(body))
		if testReqErr == nil {
			testReq.Header.Set("Content-Type", "application/json")
			testReq.Header.Set("x-api-key", apiKey)
			testReq.Header.Set("anthropic-version", "2023-06-01")
		}
	} else {
		// Try POST /v1/chat/completions with minimal request (more reliable than /v1/models)
		baseURL := strings.TrimRight(apiURL, "/")
		baseURL = strings.TrimSuffix(baseURL, "/v1")
		testModel := "gpt-4o-mini"
		var modelsRaw *string
		_ = db.Pool.QueryRow(context.Background(),
			"SELECT models::text FROM provider_connections WHERE id=$1", connID).Scan(&modelsRaw)
		if modelsRaw != nil {
			var ml []string
			if json.Unmarshal([]byte(*modelsRaw), &ml) == nil && len(ml) > 0 {
				testModel = ml[0]
			}
		}
		payload := map[string]interface{}{
			"model":      testModel,
			"max_tokens": 1,
			"messages":   []map[string]string{{"role": "user", "content": "hi"}},
		}
		body, _ := json.Marshal(payload)
		testReq, testReqErr = http.NewRequest("POST", baseURL+"/v1/chat/completions", bytes.NewReader(body))
		if testReqErr == nil {
			testReq.Header.Set("Content-Type", "application/json")
			testReq.Header.Set("Authorization", "Bearer "+apiKey)
		}
	}

	if testReqErr != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to create request"})
	}

	resp, err := client.Do(testReq)
	if err != nil {
		// Update error state
		db.Pool.Exec(context.Background(),
			`UPDATE provider_connections SET test_status='unavailable', last_error=$2,
			 last_error_at=now(), error_code=0, backoff_level=LEAST(backoff_level+1,10), updated_at=now()
			 WHERE id=$1`, connID, err.Error())
		return c.JSON(fiber.Map{"success": false, "error": "connection failed: " + err.Error()})
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		// Clear error state on success
		db.Pool.Exec(context.Background(),
			`UPDATE provider_connections SET test_status='active', error_code=0,
			 backoff_level=0, last_error='', updated_at=now() WHERE id=$1`, connID)

		var result interface{}
		if json.Unmarshal(respBody, &result) == nil {
			return c.JSON(fiber.Map{"success": true, "status": resp.StatusCode, "data": result})
		}
		return c.JSON(fiber.Map{"success": true, "status": resp.StatusCode})
	}

	// Record error
	db.Pool.Exec(context.Background(),
		`UPDATE provider_connections SET test_status='error', error_code=$2, last_error=$3,
		 last_error_at=now(), backoff_level=LEAST(backoff_level+1,10), updated_at=now()
		 WHERE id=$1`, connID, resp.StatusCode, string(respBody))

	return c.JSON(fiber.Map{"success": false, "status": resp.StatusCode, "error": string(respBody)})
}

func ResetConnection(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	connID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid connection ID"})
	}

	result, err := db.Pool.Exec(context.Background(),
		`UPDATE provider_connections
		 SET backoff_level=0, error_code=0, last_error='', last_error_at=NULL,
		     test_status='pending', updated_at=NOW()
		 WHERE id=$1 AND user_id=$2`, connID, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to reset connection"})
	}
	if result.RowsAffected() == 0 {
		return c.Status(404).JSON(fiber.Map{"error": "connection not found"})
	}
	return c.JSON(fiber.Map{"message": "connection reset"})
}

// ─────────────────────────────────────────────────────────────────────────────
// Model Combos CRUD
// ─────────────────────────────────────────────────────────────────────────────

func ListCombos(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	rows, err := db.Pool.Query(context.Background(),
		`SELECT id, user_id, name, models, strategy, is_active, created_at, updated_at
		 FROM model_combos WHERE user_id = $1 ORDER BY created_at DESC`, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch combos"})
	}
	defer rows.Close()

	var combos []models.ModelCombo
	for rows.Next() {
		var mc models.ModelCombo
		if err := rows.Scan(
			&mc.ID, &mc.UserID, &mc.Name, &mc.Models, &mc.Strategy,
			&mc.IsActive, &mc.CreatedAt, &mc.UpdatedAt,
		); err != nil {
			continue
		}
		combos = append(combos, mc)
	}
	if combos == nil {
		combos = []models.ModelCombo{}
	}
	return c.JSON(combos)
}

func CreateCombo(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	var req models.ComboCreateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}
	if req.Name == "" {
		return c.Status(400).JSON(fiber.Map{"error": "name is required"})
	}
	if req.Models == nil {
		return c.Status(400).JSON(fiber.Map{"error": "models is required"})
	}
	if req.Strategy == "" {
		req.Strategy = "fallback"
	}

	var mc models.ModelCombo
	err := db.Pool.QueryRow(context.Background(),
		`INSERT INTO model_combos (user_id, name, models, strategy)
		 VALUES ($1,$2,$3,$4)
		 RETURNING id, user_id, name, models, strategy, is_active, created_at, updated_at`,
		userID, req.Name, string(*req.Models), req.Strategy,
	).Scan(
		&mc.ID, &mc.UserID, &mc.Name, &mc.Models, &mc.Strategy,
		&mc.IsActive, &mc.CreatedAt, &mc.UpdatedAt,
	)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to create combo: " + err.Error()})
	}
	return c.Status(201).JSON(mc)
}

func UpdateCombo(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	comboID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid combo ID"})
	}

	var ownerID uuid.UUID
	err = db.Pool.QueryRow(context.Background(),
		"SELECT user_id FROM model_combos WHERE id = $1", comboID).Scan(&ownerID)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "combo not found"})
	}
	if ownerID != userID {
		return c.Status(403).JSON(fiber.Map{"error": "forbidden"})
	}

	var req struct {
		Name     *string          `json:"name"`
		Models   *json.RawMessage `json:"models"`
		Strategy *string          `json:"strategy"`
		IsActive *bool            `json:"is_active"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}

	setClauses := []string{}
	args := []interface{}{}
	argIdx := 1

	if req.Name != nil {
		setClauses = append(setClauses, fmt.Sprintf("name = $%d", argIdx))
		args = append(args, *req.Name)
		argIdx++
	}
	if req.Models != nil {
		setClauses = append(setClauses, fmt.Sprintf("models = $%d", argIdx))
		args = append(args, string(*req.Models))
		argIdx++
	}
	if req.Strategy != nil {
		setClauses = append(setClauses, fmt.Sprintf("strategy = $%d", argIdx))
		args = append(args, *req.Strategy)
		argIdx++
	}
	if req.IsActive != nil {
		setClauses = append(setClauses, fmt.Sprintf("is_active = $%d", argIdx))
		args = append(args, *req.IsActive)
		argIdx++
	}
	if len(setClauses) == 0 {
		return c.Status(400).JSON(fiber.Map{"error": "no fields to update"})
	}

	setClauses = append(setClauses, "updated_at = NOW()")
	args = append(args, comboID)
	query := fmt.Sprintf("UPDATE model_combos SET %s WHERE id = $%d",
		strings.Join(setClauses, ", "), argIdx)
	_, err = db.Pool.Exec(context.Background(), query, args...)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to update combo"})
	}

	var mc models.ModelCombo
	err = db.Pool.QueryRow(context.Background(),
		`SELECT id, user_id, name, models, strategy, is_active, created_at, updated_at
		 FROM model_combos WHERE id = $1`, comboID,
	).Scan(&mc.ID, &mc.UserID, &mc.Name, &mc.Models, &mc.Strategy, &mc.IsActive, &mc.CreatedAt, &mc.UpdatedAt)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch updated combo"})
	}
	return c.JSON(mc)
}

func DeleteCombo(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	comboID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid combo ID"})
	}

	result, err := db.Pool.Exec(context.Background(),
		"DELETE FROM model_combos WHERE id = $1 AND user_id = $2", comboID, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to delete combo"})
	}
	if result.RowsAffected() == 0 {
		return c.Status(404).JSON(fiber.Map{"error": "combo not found"})
	}
	return c.JSON(fiber.Map{"message": "combo deleted"})
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry + Aggregated Models
// ─────────────────────────────────────────────────────────────────────────────

func ListProviderTypes(c *fiber.Ctx) error {
	return c.JSON(ai.RegistryList())
}

func ListAvailableModels(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	seen := map[string]bool{}
	var result []fiber.Map

	// Collect models from active connections
	rows, err := db.Pool.Query(ctx,
		`SELECT provider_type, name, models FROM provider_connections
		 WHERE user_id = $1 AND is_active = true ORDER BY priority ASC`, userID)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var provType, connName string
			var modelsRaw json.RawMessage
			if rows.Scan(&provType, &connName, &modelsRaw) != nil {
				continue
			}
			var modelList []string
			if json.Unmarshal(modelsRaw, &modelList) != nil {
				continue
			}
			for _, m := range modelList {
				key := provType + "/" + m
				if seen[key] {
					continue
				}
				seen[key] = true
				result = append(result, fiber.Map{
					"id":            key,
					"name":          m,
					"provider_type": provType,
					"source":        "connection",
					"connection":    connName,
				})
			}
		}
	}

	// Collect combos (virtual model names)
	comboRows, err := db.Pool.Query(ctx,
		`SELECT name FROM model_combos WHERE user_id = $1 AND is_active = true`, userID)
	if err == nil {
		defer comboRows.Close()
		for comboRows.Next() {
			var name string
			if comboRows.Scan(&name) != nil {
				continue
			}
			if seen["combo/"+name] {
				continue
			}
			seen["combo/"+name] = true
			result = append(result, fiber.Map{
				"id":            "combo/" + name,
				"name":          name,
				"provider_type": "combo",
				"source":        "combo",
			})
		}
	}

	if result == nil {
		result = []fiber.Map{}
	}
	return c.JSON(result)
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection Health Stats
// ─────────────────────────────────────────────────────────────────────────────

func ConnectionHealthStats(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	// Get user's connections with their DB health data
	rows, err := db.Pool.Query(ctx,
		`SELECT id, name, provider_type, test_status, error_code, last_error,
		        last_error_at, backoff_level, is_active
		 FROM provider_connections WHERE user_id = $1 ORDER BY priority ASC`, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch stats"})
	}
	defer rows.Close()

	var stats []fiber.Map
	for rows.Next() {
		var id uuid.UUID
		var name, provType, testStatus, lastError string
		var errorCode, backoff int
		var lastErrorAt *time.Time
		var active bool
		if rows.Scan(&id, &name, &provType, &testStatus, &errorCode,
			&lastError, &lastErrorAt, &backoff, &active) != nil {
			continue
		}
		entry := fiber.Map{
			"id":            id,
			"name":          name,
			"provider_type": provType,
			"test_status":   testStatus,
			"error_code":    errorCode,
			"last_error":    lastError,
			"last_error_at": lastErrorAt,
			"backoff_level": backoff,
			"is_active":     active,
		}
		stats = append(stats, entry)
	}
	if stats == nil {
		stats = []fiber.Map{}
	}
	return c.JSON(stats)
}


// FetchRemoteModels fetches available models from a provider's API using the connection's credentials
func FetchRemoteModels(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	connID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid connection ID"})
	}

	var apiURL, apiKeyEnc, accessTokenEnc, apiFormat, providerType string
	err = db.Pool.QueryRow(context.Background(),
		`SELECT api_url, COALESCE(api_key_encrypted,''), COALESCE(access_token_encrypted,''), api_format, provider_type
		 FROM provider_connections WHERE id = $1 AND user_id = $2`,
		connID, userID).Scan(&apiURL, &apiKeyEnc, &accessTokenEnc, &apiFormat, &providerType)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "connection not found"})
	}

	// Determine auth token
	var authToken string
	if apiKeyEnc != "" {
		authToken, _ = crypto.Decrypt(apiKeyEnc)
	}
	if authToken == "" && accessTokenEnc != "" {
		authToken, _ = crypto.Decrypt(accessTokenEnc)
	}
	if authToken == "" {
		return c.Status(400).JSON(fiber.Map{"error": "no credentials found"})
	}

	client := &http.Client{Timeout: 15 * time.Second}
	var models []fiber.Map

	switch apiFormat {
	case "openai":
		baseURL := strings.TrimRight(apiURL, "/")
		baseURL = strings.TrimSuffix(baseURL, "/v1")
		req, _ := http.NewRequest("GET", baseURL+"/v1/models", nil)
		req.Header.Set("Authorization", "Bearer "+authToken)
		resp, err := client.Do(req)
		if err != nil {
			return c.Status(502).JSON(fiber.Map{"error": "failed to reach provider: " + err.Error()})
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if resp.StatusCode != 200 {
			return c.Status(resp.StatusCode).JSON(fiber.Map{"error": string(body)})
		}
		var result struct {
			Data []struct {
				ID      string `json:"id"`
				OwnedBy string `json:"owned_by"`
			} `json:"data"`
		}
		json.Unmarshal(body, &result)
		// Filter to chat models only
		for _, m := range result.Data {
			id := m.ID
			// Skip embedding, tts, whisper, dall-e, moderation models
			if strings.HasPrefix(id, "text-embedding") || strings.HasPrefix(id, "tts-") ||
				strings.HasPrefix(id, "whisper-") || strings.HasPrefix(id, "dall-e") ||
				strings.HasPrefix(id, "davinci") || strings.HasPrefix(id, "babbage") ||
				strings.Contains(id, "moderation") || strings.Contains(id, "embedding") ||
				strings.HasPrefix(id, "canary-") || strings.HasPrefix(id, "codex-") {
				continue
			}
			models = append(models, fiber.Map{"id": id, "owned_by": m.OwnedBy})
		}
		// Sort: gpt-4.1 and o-series first
		sort.Slice(models, func(i, j int) bool {
			a := models[i]["id"].(string)
			b := models[j]["id"].(string)
			aPri := modelPriority(a)
			bPri := modelPriority(b)
			if aPri != bPri {
				return aPri < bPri
			}
			return a < b
		})

	case "anthropic":
		// Anthropic doesn't have a /models endpoint, return known models
		knownModels := []string{
			"claude-opus-4-20250514", "claude-sonnet-4-20250514",
			"claude-sonnet-4-5-20250514",
			"claude-haiku-4-5-20251001", "claude-3-5-sonnet-20241022",
		}
		for _, m := range knownModels {
			models = append(models, fiber.Map{"id": m, "owned_by": "anthropic"})
		}

	case "google":
		// Google Gemini - use known models
		knownModels := []string{
			"gemini-2.5-pro", "gemini-2.5-flash",
			"gemini-2.0-flash", "gemini-2.0-flash-lite",
		}
		for _, m := range knownModels {
			models = append(models, fiber.Map{"id": m, "owned_by": "google"})
		}

	default:
		return c.Status(400).JSON(fiber.Map{"error": "unsupported provider format"})
	}

	if models == nil {
		models = []fiber.Map{}
	}
	return c.JSON(fiber.Map{"models": models, "provider_type": providerType})
}

func modelPriority(id string) int {
	switch {
	case strings.HasPrefix(id, "gpt-4.1"):
		return 0
	case strings.HasPrefix(id, "gpt-4o"):
		return 1
	case strings.HasPrefix(id, "o3") || strings.HasPrefix(id, "o4"):
		return 2
	case strings.HasPrefix(id, "o1"):
		return 3
	case strings.HasPrefix(id, "gpt-4"):
		return 4
	case strings.HasPrefix(id, "gpt-3"):
		return 8
	default:
		return 5
	}
}
