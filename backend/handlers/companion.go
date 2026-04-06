package handlers

import (
	"context"

	"github.com/ahvholding/ahvclaw/computeruse"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

// POST /api/companion/grant — register device grant
func CompanionGrant() fiber.Handler {
	return func(c *fiber.Ctx) error {
		userID := c.Locals("user_id").(uuid.UUID)

		var body struct {
			DeviceID  string `json:"device_id"`
			PublicKey string `json:"public_key"`
		}
		if err := c.BodyParser(&body); err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "invalid request body"})
		}
		if body.DeviceID == "" || body.PublicKey == "" {
			return c.Status(400).JSON(fiber.Map{"error": "device_id and public_key are required"})
		}

		grant, err := computeruse.CreateGrant(c.Context(), userID, body.DeviceID, body.PublicKey)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"error": err.Error()})
		}

		return c.JSON(grant)
	}
}

// POST /api/companion/revoke — revoke device grant
func CompanionRevoke() fiber.Handler {
	return func(c *fiber.Ctx) error {
		userID := c.Locals("user_id").(uuid.UUID)

		var body struct {
			DeviceID string `json:"device_id"`
		}
		if err := c.BodyParser(&body); err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "invalid request body"})
		}
		if body.DeviceID == "" {
			return c.Status(400).JSON(fiber.Map{"error": "device_id is required"})
		}

		if err := computeruse.RevokeGrant(c.Context(), userID, body.DeviceID); err != nil {
			return c.Status(500).JSON(fiber.Map{"error": err.Error()})
		}

		computeruse.Sessions.RevokeByUser(userID)

		return c.JSON(fiber.Map{"status": "revoked"})
	}
}

// POST /api/companion/kill — server-side kill switch
func CompanionKill() fiber.Handler {
	return func(c *fiber.Ctx) error {
		userID := c.Locals("user_id").(uuid.UUID)

		if err := computeruse.RevokeAllGrants(c.Context(), userID); err != nil {
			return c.Status(500).JSON(fiber.Map{"error": err.Error()})
		}

		computeruse.Sessions.RevokeByUser(userID)

		if computeruse.Hub.IsOnline(userID.String()) {
			_, _ = computeruse.Hub.SendCommand(userID.String(), computeruse.CUCommand{
				ID:     uuid.New().String(),
				Action: "kill",
			})
		}

		return c.JSON(fiber.Map{"status": "killed"})
	}
}

// POST /api/companion/audit — log action from helper
func CompanionAuditLog() fiber.Handler {
	return func(c *fiber.Ctx) error {
		userID := c.Locals("user_id").(uuid.UUID)

		var body struct {
			DeviceID      string      `json:"device_id"`
			SessionID     string      `json:"session_id"`
			Action        string      `json:"action"`
			URL           string      `json:"url"`
			TabID         *int        `json:"tab_id"`
			TabType       string      `json:"tab_type"`
			Params        interface{} `json:"params"`
			Result        string      `json:"result"`
			BlockedReason string      `json:"blocked_reason"`
		}
		if err := c.BodyParser(&body); err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "invalid request body"})
		}
		if body.Action == "" {
			return c.Status(400).JSON(fiber.Map{"error": "action is required"})
		}
		if body.Result == "" {
			body.Result = "logged"
		}

		ctx := context.Background()
		_, err := db.Pool.Exec(ctx,
			`INSERT INTO browser_audit_log
				(user_id, device_id, session_id, action, url, tab_id, tab_type, params, result, blocked_reason)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
			userID,
			nullableString(body.DeviceID),
			nullableString(body.SessionID),
			body.Action,
			nullableString(body.URL),
			body.TabID,
			nullableString(body.TabType),
			body.Params,
			body.Result,
			nullableString(body.BlockedReason),
		)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"error": err.Error()})
		}

		return c.JSON(fiber.Map{"status": "logged"})
	}
}

// nullableString returns nil for empty strings so the DB stores NULL instead of ''.
func nullableString(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}
