package handlers

import (
	"github.com/ahvholding/ahvclaw/browser"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func BrowserAction(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)

	var req browser.BrowserRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}

	req.UserID = userID.String()

	if req.Action == "" {
		return c.Status(400).JSON(fiber.Map{"error": "action is required"})
	}

	result, err := browser.Execute(req)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}

	return c.JSON(result)
}
