package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/ahvholding/ahvclaw/crypto"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/models"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func ListProviders(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	rows, err := db.Pool.Query(context.Background(),
		"SELECT id, user_id, name, api_url, models, is_active, created_at, updated_at FROM model_providers WHERE user_id = $1 ORDER BY created_at DESC", userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch providers"})
	}
	defer rows.Close()

	var providers []models.ModelProvider
	for rows.Next() {
		var p models.ModelProvider
		if err := rows.Scan(&p.ID, &p.UserID, &p.Name, &p.APIURL, &p.Models, &p.IsActive, &p.CreatedAt, &p.UpdatedAt); err != nil {
			continue
		}
		providers = append(providers, p)
	}
	if providers == nil {
		providers = []models.ModelProvider{}
	}
	return c.JSON(providers)
}

func CreateProvider(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	var req models.ProviderCreateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}
	if req.Name == "" || req.APIURL == "" || req.APIKey == "" {
		return c.Status(400).JSON(fiber.Map{"error": "name, api_url, and api_key are required"})
	}

	encryptedKey, err := crypto.Encrypt(req.APIKey)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to encrypt API key"})
	}

	modelsJSON := "[]"
	if req.Models != nil {
		modelsJSON = string(*req.Models)
	}

	var p models.ModelProvider
	err = db.Pool.QueryRow(context.Background(),
		`INSERT INTO model_providers (user_id, name, api_url, api_key_encrypted, models)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, user_id, name, api_url, models, is_active, created_at, updated_at`,
		userID, req.Name, req.APIURL, encryptedKey, modelsJSON,
	).Scan(&p.ID, &p.UserID, &p.Name, &p.APIURL, &p.Models, &p.IsActive, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to create provider: " + err.Error()})
	}
	return c.Status(201).JSON(p)
}

func UpdateProvider(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	providerID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid provider ID"})
	}

	var req models.ProviderUpdateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}

	// Verify ownership
	var ownerID uuid.UUID
	err = db.Pool.QueryRow(context.Background(),
		"SELECT user_id FROM model_providers WHERE id = $1 AND user_id = $2", providerID, userID).Scan(&ownerID)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "provider not found"})
	}
	if ownerID != userID {
		return c.Status(403).JSON(fiber.Map{"error": "forbidden"})
	}

	setClauses := []string{}
	args := []interface{}{}
	argIdx := 1

	if req.Name != nil {
		setClauses = append(setClauses, fmt.Sprintf("name = $%d", argIdx))
		args = append(args, *req.Name)
		argIdx++
	}
	if req.APIURL != nil {
		setClauses = append(setClauses, fmt.Sprintf("api_url = $%d", argIdx))
		args = append(args, *req.APIURL)
		argIdx++
	}
	if req.APIKey != nil {
		encrypted, err := crypto.Encrypt(*req.APIKey)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "failed to encrypt API key"})
		}
		setClauses = append(setClauses, fmt.Sprintf("api_key_encrypted = $%d", argIdx))
		args = append(args, encrypted)
		argIdx++
	}
	if req.Models != nil {
		setClauses = append(setClauses, fmt.Sprintf("models = $%d", argIdx))
		args = append(args, string(*req.Models))
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
	args = append(args, providerID)
	args = append(args, userID)
	query := fmt.Sprintf("UPDATE model_providers SET %s WHERE id = $%d AND user_id = $%d",
		strings.Join(setClauses, ", "), argIdx, argIdx+1)

	_, err = db.Pool.Exec(context.Background(), query, args...)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to update provider"})
	}

	var p models.ModelProvider
	err = db.Pool.QueryRow(context.Background(),
		"SELECT id, user_id, name, api_url, models, is_active, created_at, updated_at FROM model_providers WHERE id = $1", providerID,
	).Scan(&p.ID, &p.UserID, &p.Name, &p.APIURL, &p.Models, &p.IsActive, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch updated provider"})
	}
	return c.JSON(p)
}

func DeleteProvider(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	providerID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid provider ID"})
	}

	result, err := db.Pool.Exec(context.Background(),
		"DELETE FROM model_providers WHERE id = $1 AND user_id = $2", providerID, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to delete provider"})
	}
	if result.RowsAffected() == 0 {
		return c.Status(404).JSON(fiber.Map{"error": "provider not found"})
	}
	return c.JSON(fiber.Map{"message": "provider deleted"})
}

func TestProvider(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	providerID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid provider ID"})
	}

	var apiURL, apiKeyEncrypted string
	err = db.Pool.QueryRow(context.Background(),
		"SELECT api_url, api_key_encrypted FROM model_providers WHERE id = $1 AND user_id = $2",
		providerID, userID).Scan(&apiURL, &apiKeyEncrypted)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "provider not found"})
	}

	apiKey, err := crypto.Decrypt(apiKeyEncrypted)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to decrypt API key"})
	}

	// Call /v1/models on the provider
	testURL := strings.TrimRight(apiURL, "/") + "/v1/models"
	req, err := http.NewRequest("GET", testURL, nil)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to create request"})
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return c.JSON(fiber.Map{"success": false, "error": "connection failed: " + err.Error()})
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		var result interface{}
		if err := json.Unmarshal(body, &result); err == nil {
			return c.JSON(fiber.Map{"success": true, "status": resp.StatusCode, "data": result})
		}
		return c.JSON(fiber.Map{"success": true, "status": resp.StatusCode})
	}
	return c.JSON(fiber.Map{"success": false, "status": resp.StatusCode, "error": string(body)})
}
