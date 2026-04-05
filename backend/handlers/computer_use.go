package handlers

import (
	"encoding/json"

	"github.com/ahvholding/ahvclaw/computeruse"
	"github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func WSComputerUse() func(*websocket.Conn) {
	return computeruse.WSHandler(
		func(userID string, msg []byte) {
			Hub.BroadcastToUser(userID, Event{
				Type: "browser_update",
				Data: json.RawMessage(msg),
			})
		},
		func(userID string, online bool) {
			Hub.BroadcastToUser(userID, Event{
				Type: "extension_status",
				Data: map[string]interface{}{"online": online},
			})
		},
	)
}

func ComputerUseStatus(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	online := computeruse.Hub.IsOnline(userID.String())
	return c.JSON(fiber.Map{
		"online": online,
	})
}
