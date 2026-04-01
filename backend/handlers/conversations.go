package handlers

import (
	"context"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/models"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func ListConversations(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)

	rows, err := db.Pool.Query(context.Background(),
		`SELECT id, user_id, title, model, agent_id, pinned, created_at, updated_at
		 FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50`, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to list conversations"})
	}
	defer rows.Close()

	var convos []models.Conversation
	for rows.Next() {
		var conv models.Conversation
		if err := rows.Scan(&conv.ID, &conv.UserID, &conv.Title, &conv.Model,
			&conv.AgentID, &conv.Pinned, &conv.CreatedAt, &conv.UpdatedAt); err != nil {
			continue
		}
		convos = append(convos, conv)
	}
	if convos == nil {
		convos = []models.Conversation{}
	}
	return c.JSON(convos)
}

func GetConversation(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	convID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid conversation id"})
	}

	rows, err := db.Pool.Query(context.Background(),
		`SELECT id, conversation_id, role, content, tool_calls, tool_results,
		        tokens_in, tokens_out, model, created_at
		 FROM messages WHERE conversation_id = $1
		 AND conversation_id IN (SELECT id FROM conversations WHERE user_id = $2)
		 ORDER BY created_at ASC`, convID, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to get messages"})
	}
	defer rows.Close()

	var messages []models.Message
	for rows.Next() {
		var msg models.Message
		if err := rows.Scan(&msg.ID, &msg.ConversationID, &msg.Role, &msg.Content,
			&msg.ToolCalls, &msg.ToolResults, &msg.TokensIn, &msg.TokensOut,
			&msg.Model, &msg.CreatedAt); err != nil {
			continue
		}
		messages = append(messages, msg)
	}
	if messages == nil {
		messages = []models.Message{}
	}
	return c.JSON(messages)
}

func DeleteConversation(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	convID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid conversation id"})
	}

	result, err := db.Pool.Exec(context.Background(),
		"DELETE FROM conversations WHERE id = $1 AND user_id = $2", convID, userID)
	if err != nil || result.RowsAffected() == 0 {
		return c.Status(404).JSON(fiber.Map{"error": "conversation not found"})
	}
	return c.JSON(fiber.Map{"ok": true})
}
