package handlers

import (
	"encoding/json"
	"io"
	"log"

	"github.com/ahvholding/ahvclaw/channels/zalo"
	"github.com/gofiber/fiber/v2"
)

func ZaloWebhook(c *fiber.Ctx) error {
	botID := c.Params("botID")
	if botID == "" {
		return c.Status(400).JSON(fiber.Map{"error": "missing bot ID"})
	}

	if ChannelManager == nil {
		return c.Status(500).JSON(fiber.Map{"error": "channel manager not initialized"})
	}

	// Handle GET for webhook verification
	if c.Method() == "GET" {
		challenge := c.Query("challenge")
		if challenge != "" {
			return c.SendString(challenge)
		}
		return c.JSON(fiber.Map{"status": "ok"})
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

	body := c.Body()
	if len(body) == 0 {
		var err error
		body, err = io.ReadAll(c.Request().BodyStream())
		if err != nil || len(body) == 0 {
			return c.Status(400).JSON(fiber.Map{"error": "empty body"})
		}
	}

	var event map[string]interface{}
	json.Unmarshal(body, &event)
	log.Printf("[zalo-webhook] bot %s received event: %v", botID, event)

	if err := zaloAdapter.HandleWebhook(body); err != nil {
		log.Printf("[zalo-webhook] error handling webhook for bot %s: %v", botID, err)
		return c.Status(500).JSON(fiber.Map{"error": "webhook processing failed"})
	}

	return c.JSON(fiber.Map{"status": "ok"})
}
