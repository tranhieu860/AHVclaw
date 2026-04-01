package handlers

import (
	"io"
	"log"

	"github.com/ahvholding/ahvclaw/channels/zalo"
	"github.com/gofiber/fiber/v2"
)

// ZaloWebhook handles incoming Zalo OA webhook events.
func ZaloWebhook(c *fiber.Ctx) error {
	botID := c.Params("botID")
	if botID == "" {
		return c.Status(400).JSON(fiber.Map{"error": "missing bot ID"})
	}

	if ChannelManager == nil {
		return c.Status(500).JSON(fiber.Map{"error": "channel manager not initialized"})
	}

	adapter, ok := ChannelManager.GetAdapter(botID)
	if !ok {
		log.Printf("[zalo-webhook] bot %s not found or not running", botID)
		return c.Status(404).JSON(fiber.Map{"error": "bot not found or not running"})
	}

	zaloAdapter, ok := adapter.(*zalo.Adapter)
	if !ok {
		return c.Status(400).JSON(fiber.Map{"error": "bot is not a Zalo adapter"})
	}

	body, err := io.ReadAll(c.Request().BodyStream())
	if err != nil {
		// Fallback: use c.Body()
		body = c.Body()
	}
	if len(body) == 0 {
		body = c.Body()
	}

	if err := zaloAdapter.HandleWebhook(body); err != nil {
		log.Printf("[zalo-webhook] error handling webhook for bot %s: %v", botID, err)
		return c.Status(500).JSON(fiber.Map{"error": "webhook processing failed"})
	}

	return c.JSON(fiber.Map{"status": "ok"})
}
