package handlers

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/ahvholding/ahvclaw/auth"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

func GetSettings(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	var settings string
	var storageUsed, storageQuota int64
	var name, email, role string
	var apiKey *string
	err := db.Pool.QueryRow(context.Background(),
		"SELECT COALESCE(settings, '{}'), storage_used, storage_quota, COALESCE(name,''), email, role, api_key FROM users WHERE id = $1", userID,
	).Scan(&settings, &storageUsed, &storageQuota, &name, &email, &role, &apiKey)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "user not found"})
	}
	var parsed interface{}
	if err := json.Unmarshal([]byte(settings), &parsed); err != nil {
		parsed = map[string]interface{}{}
	}
	result := fiber.Map{
		"settings":      parsed,
		"storage_used":  storageUsed,
		"storage_quota": storageQuota,
		"name":          name,
		"email":         email,
		"role":          role,
	}
	if apiKey != nil {
		result["api_key"] = *apiKey
	}
	return c.JSON(result)
}

func UpdateSettings(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	var body map[string]interface{}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}

	// If body contains a "settings" key with a JSON string, parse and use it
	var settingsJSON []byte
	if s, ok := body["settings"]; ok {
		if str, ok := s.(string); ok {
			// Validate it is valid JSON
			var parsed interface{}
			if json.Unmarshal([]byte(str), &parsed) == nil {
				settingsJSON = []byte(str)
			} else {
				settingsJSON, _ = json.Marshal(body)
			}
		} else {
			settingsJSON, _ = json.Marshal(s)
		}
	} else {
		settingsJSON, _ = json.Marshal(body)
	}

	_, err := db.Pool.Exec(context.Background(),
		"UPDATE users SET settings = $1, updated_at = NOW() WHERE id = $2",
		string(settingsJSON), userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to update settings"})
	}
	return c.JSON(fiber.Map{"message": "settings updated"})
}

func GetStorageInfo(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	var storageUsed, storageQuota int64
	err := db.Pool.QueryRow(context.Background(),
		"SELECT storage_used, storage_quota FROM users WHERE id = $1", userID,
	).Scan(&storageUsed, &storageQuota)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "user not found"})
	}
	var percentage float64
	if storageQuota > 0 {
		percentage = float64(storageUsed) / float64(storageQuota) * 100
	}
	return c.JSON(fiber.Map{
		"storage_used":       storageUsed,
		"storage_quota":      storageQuota,
		"percentage":         fmt.Sprintf("%.2f", percentage),
		"storage_used_human":  humanSize(storageUsed),
		"storage_quota_human": humanSize(storageQuota),
	})
}

func humanSize(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}

func ChangePassword(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	var body struct {
		OldPassword string `json:"old_password"`
		NewPassword string `json:"new_password"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}
	if body.OldPassword == "" || body.NewPassword == "" {
		return c.Status(400).JSON(fiber.Map{"error": "old_password and new_password are required"})
	}
	if len(body.NewPassword) < 8 {
		return c.Status(400).JSON(fiber.Map{"error": "new password must be at least 8 characters"})
	}
	if len(body.NewPassword) > 72 {
		return c.Status(400).JSON(fiber.Map{"error": "new password must be at most 72 characters"})
	}

	var currentHash string
	err := db.Pool.QueryRow(context.Background(),
		"SELECT password_hash FROM users WHERE id = $1", userID,
	).Scan(&currentHash)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "user not found"})
	}
	if err := bcrypt.CompareHashAndPassword([]byte(currentHash), []byte(body.OldPassword)); err != nil {
		return c.Status(401).JSON(fiber.Map{"error": "incorrect old password"})
	}

	newHash, err := bcrypt.GenerateFromPassword([]byte(body.NewPassword), 12)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "internal error"})
	}
	_, err = db.Pool.Exec(context.Background(),
		"UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2",
		string(newHash), userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to update password"})
	}
	return c.JSON(fiber.Map{"message": "password changed successfully"})
}

func GenerateNewAPIKey(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	newKey, err := auth.GenerateAPIKey()
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to generate API key"})
	}
	_, err = db.Pool.Exec(context.Background(),
		"UPDATE users SET api_key = $1, updated_at = NOW() WHERE id = $2",
		newKey, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to update API key"})
	}
	return c.JSON(fiber.Map{"api_key": newKey})
}
