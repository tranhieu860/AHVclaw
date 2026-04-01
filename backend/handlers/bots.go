package handlers

import (
	"context"
	"encoding/json"

	"github.com/ahvholding/ahvclaw/channels"
	"github.com/ahvholding/ahvclaw/crypto"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/models"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

// ChannelManager is set from main.go after initialization.
var ChannelManager *channels.Manager

// ListBots returns all bots belonging to the current user.
func ListBots(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	rows, err := db.Pool.Query(ctx,
		`SELECT id, user_id, name, default_agent_id, channel, channel_config,
		        ai_settings, response_settings, access_settings, notification_settings,
		        is_active, stats, created_at, updated_at
		 FROM bots WHERE user_id = $1 ORDER BY created_at DESC`, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch bots"})
	}
	defer rows.Close()

	var bots []models.Bot
	for rows.Next() {
		var b models.Bot
		if err := rows.Scan(&b.ID, &b.UserID, &b.Name, &b.DefaultAgentID, &b.Channel,
			&b.ChannelConfig, &b.AISettings, &b.ResponseSettings, &b.AccessSettings,
			&b.NotificationSettings, &b.IsActive, &b.Stats, &b.CreatedAt, &b.UpdatedAt); err != nil {
			continue
		}
		// Redact sensitive config before sending
		b.ChannelConfig = redactConfig(b.ChannelConfig)
		bots = append(bots, b)
	}
	if bots == nil {
		bots = []models.Bot{}
	}
	return c.JSON(bots)
}

// CreateBot creates a new bot.
func CreateBot(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	var req models.BotCreateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}
	if req.Name == "" || req.Channel == "" {
		return c.Status(400).JSON(fiber.Map{"error": "name and channel are required"})
	}

	// Encrypt sensitive config fields
	encConfig, err := encryptConfig(req.ChannelConfig)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to encrypt config"})
	}

	ctx := context.Background()
	var b models.Bot
	err = db.Pool.QueryRow(ctx,
		`INSERT INTO bots (user_id, name, default_agent_id, channel, channel_config,
		                    ai_settings, response_settings, access_settings, notification_settings)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 RETURNING id, user_id, name, default_agent_id, channel, channel_config,
		           ai_settings, response_settings, access_settings, notification_settings,
		           is_active, stats, created_at, updated_at`,
		userID, req.Name, req.DefaultAgentID, req.Channel, encConfig,
		req.AISettings, req.ResponseSettings, req.AccessSettings, req.NotificationSettings,
	).Scan(&b.ID, &b.UserID, &b.Name, &b.DefaultAgentID, &b.Channel, &b.ChannelConfig,
		&b.AISettings, &b.ResponseSettings, &b.AccessSettings, &b.NotificationSettings,
		&b.IsActive, &b.Stats, &b.CreatedAt, &b.UpdatedAt)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to create bot: " + err.Error()})
	}

	b.ChannelConfig = redactConfig(b.ChannelConfig)
	return c.Status(201).JSON(b)
}

// GetBot returns a single bot.
func GetBot(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	botID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}

	ctx := context.Background()
	var b models.Bot
	err = db.Pool.QueryRow(ctx,
		`SELECT id, user_id, name, default_agent_id, channel, channel_config,
		        ai_settings, response_settings, access_settings, notification_settings,
		        is_active, stats, created_at, updated_at
		 FROM bots WHERE id = $1 AND user_id = $2`, botID, userID,
	).Scan(&b.ID, &b.UserID, &b.Name, &b.DefaultAgentID, &b.Channel, &b.ChannelConfig,
		&b.AISettings, &b.ResponseSettings, &b.AccessSettings, &b.NotificationSettings,
		&b.IsActive, &b.Stats, &b.CreatedAt, &b.UpdatedAt)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "bot not found"})
	}

	b.ChannelConfig = redactConfig(b.ChannelConfig)
	return c.JSON(b)
}

// UpdateBot updates a bot's configuration.
func UpdateBot(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	botID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}

	var req models.BotUpdateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}

	ctx := context.Background()

	// Verify ownership
	var ownerID uuid.UUID
	err = db.Pool.QueryRow(ctx, "SELECT user_id FROM bots WHERE id = $1", botID).Scan(&ownerID)
	if err != nil || ownerID != userID {
		return c.Status(404).JSON(fiber.Map{"error": "bot not found"})
	}

	// Encrypt config if provided
	var encConfig *json.RawMessage
	if req.ChannelConfig != nil {
		enc, err := encryptConfig(req.ChannelConfig)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "failed to encrypt config"})
		}
		encConfig = enc
	}

	_, err = db.Pool.Exec(ctx,
		`UPDATE bots SET
			name = COALESCE($2, name),
			default_agent_id = COALESCE($3, default_agent_id),
			channel = COALESCE($4, channel),
			channel_config = COALESCE($5, channel_config),
			ai_settings = COALESCE($6, ai_settings),
			response_settings = COALESCE($7, response_settings),
			access_settings = COALESCE($8, access_settings),
			notification_settings = COALESCE($9, notification_settings),
			is_active = COALESCE($10, is_active),
			updated_at = now()
		 WHERE id = $1`,
		botID, req.Name, req.DefaultAgentID, req.Channel,
		encConfig, req.AISettings, req.ResponseSettings,
		req.AccessSettings, req.NotificationSettings, req.IsActive)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to update bot: " + err.Error()})
	}

	return c.JSON(fiber.Map{"status": "updated"})
}

// DeleteBot deletes a bot (stops it first if running).
func DeleteBot(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	botID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}

	ctx := context.Background()

	// Verify ownership
	var ownerID uuid.UUID
	err = db.Pool.QueryRow(ctx, "SELECT user_id FROM bots WHERE id = $1", botID).Scan(&ownerID)
	if err != nil || ownerID != userID {
		return c.Status(404).JSON(fiber.Map{"error": "bot not found"})
	}

	// Stop bot if running
	if ChannelManager != nil && ChannelManager.IsRunning(botID.String()) {
		ChannelManager.StopBot(botID.String())
	}

	_, err = db.Pool.Exec(ctx, "DELETE FROM bots WHERE id = $1", botID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to delete bot"})
	}

	return c.JSON(fiber.Map{"status": "deleted"})
}

// StartBot starts a bot's channel adapter.
func StartBot(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	botID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}

	if ChannelManager == nil {
		return c.Status(500).JSON(fiber.Map{"error": "channel manager not initialized"})
	}

	ctx := context.Background()

	// Load bot
	var channel string
	var configEncrypted *json.RawMessage
	var ownerID uuid.UUID
	err = db.Pool.QueryRow(ctx,
		"SELECT user_id, channel, channel_config FROM bots WHERE id = $1", botID,
	).Scan(&ownerID, &channel, &configEncrypted)
	if err != nil || ownerID != userID {
		return c.Status(404).JSON(fiber.Map{"error": "bot not found"})
	}

	// Decrypt config
	configJSON, err := decryptConfig(configEncrypted)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to decrypt config"})
	}

	// Start the bot
	if err := ChannelManager.StartBot(botID.String(), channel, configJSON); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to start bot: " + err.Error()})
	}

	// Mark as active
	db.Pool.Exec(ctx, "UPDATE bots SET is_active = true, updated_at = now() WHERE id = $1", botID)

	return c.JSON(fiber.Map{"status": "started"})
}

// StopBot stops a running bot.
func StopBot(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	botID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}

	if ChannelManager == nil {
		return c.Status(500).JSON(fiber.Map{"error": "channel manager not initialized"})
	}

	ctx := context.Background()

	// Verify ownership
	var ownerID uuid.UUID
	err = db.Pool.QueryRow(ctx, "SELECT user_id FROM bots WHERE id = $1", botID).Scan(&ownerID)
	if err != nil || ownerID != userID {
		return c.Status(404).JSON(fiber.Map{"error": "bot not found"})
	}

	if err := ChannelManager.StopBot(botID.String()); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}

	// Mark as inactive
	db.Pool.Exec(ctx, "UPDATE bots SET is_active = false, updated_at = now() WHERE id = $1", botID)

	return c.JSON(fiber.Map{"status": "stopped"})
}

// BotStatus returns the running status of a bot.
func BotStatus(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	botID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}

	ctx := context.Background()

	// Verify ownership
	var ownerID uuid.UUID
	var isActive bool
	err = db.Pool.QueryRow(ctx,
		"SELECT user_id, is_active FROM bots WHERE id = $1", botID,
	).Scan(&ownerID, &isActive)
	if err != nil || ownerID != userID {
		return c.Status(404).JSON(fiber.Map{"error": "bot not found"})
	}

	running := false
	if ChannelManager != nil {
		running = ChannelManager.IsRunning(botID.String())
	}

	return c.JSON(fiber.Map{
		"bot_id":    botID,
		"is_active": isActive,
		"running":   running,
	})
}

// encryptConfig encrypts the bot_token field in channel config.
func encryptConfig(raw *json.RawMessage) (*json.RawMessage, error) {
	if raw == nil {
		return nil, nil
	}

	var cfg map[string]interface{}
	if err := json.Unmarshal(*raw, &cfg); err != nil {
		return raw, nil
	}

	if token, ok := cfg["bot_token"].(string); ok && token != "" {
		encrypted, err := crypto.Encrypt(token)
		if err != nil {
			return nil, err
		}
		cfg["bot_token"] = encrypted
	}

	result, err := json.Marshal(cfg)
	if err != nil {
		return nil, err
	}
	rm := json.RawMessage(result)
	return &rm, nil
}

// decryptConfig decrypts the bot_token field in channel config.
func decryptConfig(raw *json.RawMessage) ([]byte, error) {
	if raw == nil {
		return []byte("{}"), nil
	}

	var cfg map[string]interface{}
	if err := json.Unmarshal(*raw, &cfg); err != nil {
		return *raw, nil
	}

	if token, ok := cfg["bot_token"].(string); ok && token != "" {
		decrypted, err := crypto.Decrypt(token)
		if err != nil {
			return nil, err
		}
		cfg["bot_token"] = decrypted
	}

	return json.Marshal(cfg)
}

// redactConfig removes sensitive fields from config for API responses.
func redactConfig(raw *json.RawMessage) *json.RawMessage {
	if raw == nil {
		return nil
	}

	var cfg map[string]interface{}
	if err := json.Unmarshal(*raw, &cfg); err != nil {
		return raw
	}

	if token, ok := cfg["bot_token"].(string); ok && len(token) > 8 {
		cfg["bot_token"] = token[:4] + "****" + token[len(token)-4:]
	}

	result, _ := json.Marshal(cfg)
	rm := json.RawMessage(result)
	return &rm
}
