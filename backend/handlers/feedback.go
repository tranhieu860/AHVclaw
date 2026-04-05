package handlers

import (
	"context"
	"time"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func HandleMessageFeedback(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	messageID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid message ID"})
	}

	var body struct {
		Rating int `json:"rating"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}
	if body.Rating != 1 && body.Rating != -1 && body.Rating != 0 {
		return c.Status(400).JSON(fiber.Map{"error": "rating must be 1, -1, or 0"})
	}

	ctx := context.Background()
	tag, err := db.Pool.Exec(ctx,
		`UPDATE messages SET feedback_rating = $1, feedback_at = $2
		 WHERE id = $3 AND conversation_id IN (SELECT id FROM conversations WHERE user_id = $4)`,
		body.Rating, time.Now(), messageID, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to save feedback"})
	}
	if tag.RowsAffected() == 0 {
		return c.Status(404).JSON(fiber.Map{"error": "message not found"})
	}

	return c.JSON(fiber.Map{"ok": true})
}

func HandleChannelFeedback(c *fiber.Ctx) error {
	convID, err := uuid.Parse(c.Params("conv_id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid conversation ID"})
	}

	var body struct {
		Rating int `json:"rating"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}

	ctx := context.Background()
	tag, err := db.Pool.Exec(ctx,
		`UPDATE messages SET feedback_rating = $1, feedback_at = now()
		 WHERE conversation_id = $2 AND role = 'assistant'
		 AND id = (SELECT id FROM messages WHERE conversation_id = $2 AND role = 'assistant' ORDER BY created_at DESC LIMIT 1)`,
		body.Rating, convID)
	if err != nil || tag.RowsAffected() == 0 {
		return c.Status(500).JSON(fiber.Map{"error": "failed to save feedback"})
	}

	return c.JSON(fiber.Map{"ok": true})
}
