package handlers

import (
	"encoding/json"
	"fmt"

	"github.com/ahvholding/ahvclaw/tools"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func TerminalExec(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)

	var req struct {
		Command string `json:"command"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}
	if req.Command == "" {
		return c.Status(400).JSON(fiber.Map{"error": "command is required"})
	}

	executor := tools.NewExecutor(
		fmt.Sprintf("/data/ahvclaw/workspaces/%s", userID.String()),
		userID.String(),
	)

	argsJSON, _ := json.Marshal(map[string]interface{}{"command": req.Command})
	result := executor.Execute("terminal_exec", argsJSON)

	if result.Error != "" {
		return c.JSON(fiber.Map{"error": result.Error})
	}
	return c.JSON(fiber.Map{"output": result.Content})
}
