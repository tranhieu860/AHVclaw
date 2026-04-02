package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

// InboxConversationRow is the joined result for inbox listing
type InboxConversationRow struct {
	ID             uuid.UUID  `json:"id"`
	BotID          uuid.UUID  `json:"bot_id"`
	ContactID      uuid.UUID  `json:"contact_id"`
	Channel        string     `json:"channel"`
	ChannelChatID  *string    `json:"channel_chat_id"`
	CurrentAgentID *uuid.UUID `json:"current_agent_id"`
	Status         string     `json:"status"`
	TakeoverBy     *uuid.UUID `json:"takeover_by"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
	ContactName    *string    `json:"contact_name"`
	BotName        string     `json:"bot_name"`
	LastMessage    *string    `json:"last_message"`
	LastMessageAt  *time.Time `json:"last_message_at"`
}

// InboxMessageRow is a message in inbox conversation
type InboxMessageRow struct {
	ID               uuid.UUID        `json:"id"`
	ConversationID   uuid.UUID        `json:"conversation_id"`
	Direction        string           `json:"direction"`
	SenderType       string           `json:"sender_type"`
	SenderID         *string          `json:"sender_id"`
	Content          *string          `json:"content"`
	Attachments      *json.RawMessage `json:"attachments"`
	ChannelMessageID *string          `json:"channel_message_id"`
	AgentID          *uuid.UUID       `json:"agent_id"`
	ToolCalls        *json.RawMessage `json:"tool_calls,omitempty"`
	ToolResults      *json.RawMessage `json:"tool_results,omitempty"`
	TokensIn         int              `json:"tokens_in"`
	TokensOut        int              `json:"tokens_out"`
	CreatedAt        time.Time        `json:"created_at"`
}

func ListInboxConversations(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	status := strings.TrimSpace(c.Query("status"))
	channel := strings.TrimSpace(c.Query("channel"))
	botIDStr := strings.TrimSpace(c.Query("bot_id"))

	query := `SELECT cc.id, cc.bot_id, cc.contact_id, cc.channel, cc.channel_chat_id,
		cc.current_agent_id, cc.status, cc.takeover_by, cc.created_at, cc.updated_at,
		ct.name AS contact_name, b.name AS bot_name,
		(SELECT content FROM messages WHERE conversation_id = cc.id ORDER BY created_at DESC LIMIT 1) AS last_message,
		(SELECT created_at FROM messages WHERE conversation_id = cc.id ORDER BY created_at DESC LIMIT 1) AS last_message_at
	FROM conversations cc
	JOIN bots b ON b.id = cc.bot_id
	LEFT JOIN contacts ct ON ct.id = cc.contact_id
	WHERE b.user_id = $1 AND cc.channel IS NOT NULL`

	args := []interface{}{userID}
	argIdx := 2

	if status != "" {
		query += fmt.Sprintf(" AND cc.status = $%d", argIdx)
		args = append(args, status)
		argIdx++
	}
	if channel != "" {
		query += fmt.Sprintf(" AND cc.channel = $%d", argIdx)
		args = append(args, channel)
		argIdx++
	}
	if botIDStr != "" {
		botID, err := uuid.Parse(botIDStr)
		if err == nil {
			query += fmt.Sprintf(" AND cc.bot_id = $%d", argIdx)
			args = append(args, botID)
			argIdx++
		}
	}
	_ = argIdx

	query += " ORDER BY cc.updated_at DESC LIMIT 100"

	rows, err := db.Pool.Query(ctx, query, args...)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch inbox: " + err.Error()})
	}
	defer rows.Close()

	var convos []InboxConversationRow
	for rows.Next() {
		var r InboxConversationRow
		if err := rows.Scan(&r.ID, &r.BotID, &r.ContactID, &r.Channel, &r.ChannelChatID,
			&r.CurrentAgentID, &r.Status, &r.TakeoverBy, &r.CreatedAt, &r.UpdatedAt,
			&r.ContactName, &r.BotName, &r.LastMessage, &r.LastMessageAt); err != nil {
			continue
		}
		convos = append(convos, r)
	}
	if convos == nil {
		convos = []InboxConversationRow{}
	}
	return c.JSON(convos)
}

func GetInboxConversation(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	convID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	ctx := context.Background()

	var botUserID uuid.UUID
	err = db.Pool.QueryRow(ctx,
		"SELECT b.user_id FROM conversations cc JOIN bots b ON b.id = cc.bot_id WHERE cc.id = $1", convID).Scan(&botUserID)
	if err != nil || botUserID != userID {
		return c.Status(404).JSON(fiber.Map{"error": "conversation not found"})
	}

	rows, err := db.Pool.Query(ctx,
		"SELECT id, conversation_id, role, role, source, content, attachments, NULL, NULL, tool_calls, tool_results, tokens_in, tokens_out, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC",
		convID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch messages"})
	}
	defer rows.Close()

	var messages []InboxMessageRow
	for rows.Next() {
		var m InboxMessageRow
		if err := rows.Scan(&m.ID, &m.ConversationID, &m.Direction, &m.SenderType, &m.SenderID,
			&m.Content, &m.Attachments, &m.ChannelMessageID, &m.AgentID,
			&m.ToolCalls, &m.ToolResults, &m.TokensIn, &m.TokensOut, &m.CreatedAt); err != nil {
			continue
		}
		messages = append(messages, m)
	}
	if messages == nil {
		messages = []InboxMessageRow{}
	}
	return c.JSON(messages)
}

func ReplyToConversation(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	convID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}

	type ReplyReq struct {
		Content string `json:"content"`
	}
	var req ReplyReq
	if err := c.BodyParser(&req); err != nil || req.Content == "" {
		return c.Status(400).JSON(fiber.Map{"error": "content is required"})
	}

	ctx := context.Background()

	var botUserID uuid.UUID
	err = db.Pool.QueryRow(ctx,
		"SELECT b.user_id FROM conversations cc JOIN bots b ON b.id = cc.bot_id WHERE cc.id = $1",
		convID).Scan(&botUserID)
	if err != nil || botUserID != userID {
		return c.Status(404).JSON(fiber.Map{"error": "conversation not found"})
	}

	// Set status to takeover
	_, err = db.Pool.Exec(ctx,
		"UPDATE conversations SET status = 'takeover', takeover_by = $2, updated_at = now() WHERE id = $1",
		convID, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to update conversation status"})
	}

	// Insert message as human reply
	var msgID uuid.UUID
	err = db.Pool.QueryRow(ctx,
		"INSERT INTO messages (conversation_id, role, content, source) VALUES ($1, 'assistant', $2, 'web') RETURNING id",
		convID, req.Content).Scan(&msgID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to save message"})
	}

	// Deliver message via channel adapter
	delivered := false
	deliveryErr := ""
	if ChannelManager != nil {
		var convChannel string
		var channelChatID *string
		var botID uuid.UUID
		err = db.Pool.QueryRow(ctx,
			"SELECT channel, channel_chat_id, bot_id FROM conversations WHERE id = $1",
			convID).Scan(&convChannel, &channelChatID, &botID)
		if err != nil {
			log.Printf("[inbox] failed to query conversation for delivery: %v", err)
			deliveryErr = "failed to query conversation"
		} else if channelChatID == nil || *channelChatID == "" {
			deliveryErr = "no channel_chat_id for conversation"
		} else {
			adapter, ok := ChannelManager.GetAdapter(botID.String())
			if !ok {
				deliveryErr = "adapter not running for bot"
			} else {
				if sendErr := adapter.SendMessage(*channelChatID, req.Content); sendErr != nil {
					log.Printf("[inbox] failed to deliver reply via %s: %v", convChannel, sendErr)
					deliveryErr = sendErr.Error()
				} else {
					delivered = true
				}
			}
		}
	} else {
		deliveryErr = "channel manager not initialized"
	}

	return c.JSON(fiber.Map{
		"message_id":   msgID,
		"status":       "sent",
		"delivered":    delivered,
		"delivery_err": deliveryErr,
	})
}

func TakeoverConversation(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	convID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	ctx := context.Background()

	var botUserID uuid.UUID
	err = db.Pool.QueryRow(ctx,
		"SELECT b.user_id FROM conversations cc JOIN bots b ON b.id = cc.bot_id WHERE cc.id = $1", convID).Scan(&botUserID)
	if err != nil || botUserID != userID {
		return c.Status(404).JSON(fiber.Map{"error": "conversation not found"})
	}

	_, err = db.Pool.Exec(ctx,
		"UPDATE conversations SET status = 'takeover', takeover_by = $2, updated_at = now() WHERE id = $1",
		convID, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to takeover"})
	}
	return c.JSON(fiber.Map{"status": "takeover"})
}

func ReleaseConversation(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	convID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	ctx := context.Background()

	var botUserID uuid.UUID
	err = db.Pool.QueryRow(ctx,
		"SELECT b.user_id FROM conversations cc JOIN bots b ON b.id = cc.bot_id WHERE cc.id = $1", convID).Scan(&botUserID)
	if err != nil || botUserID != userID {
		return c.Status(404).JSON(fiber.Map{"error": "conversation not found"})
	}

	_, err = db.Pool.Exec(ctx,
		"UPDATE conversations SET status = 'active', takeover_by = NULL, updated_at = now() WHERE id = $1",
		convID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to release"})
	}
	return c.JSON(fiber.Map{"status": "active"})
}

func AssignAgent(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	convID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}

	type AssignReq struct {
		AgentID *uuid.UUID `json:"agent_id"`
	}
	var req AssignReq
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}

	ctx := context.Background()

	var botUserID uuid.UUID
	err = db.Pool.QueryRow(ctx,
		"SELECT b.user_id FROM conversations cc JOIN bots b ON b.id = cc.bot_id WHERE cc.id = $1", convID).Scan(&botUserID)
	if err != nil || botUserID != userID {
		return c.Status(404).JSON(fiber.Map{"error": "conversation not found"})
	}

	_, err = db.Pool.Exec(ctx,
		"UPDATE conversations SET current_agent_id = $2, updated_at = now() WHERE id = $1",
		convID, req.AgentID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to assign agent"})
	}
	return c.JSON(fiber.Map{"assigned": true, "agent_id": req.AgentID})
}

func ArchiveConversation(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	convID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	ctx := context.Background()

	var botUserID uuid.UUID
	err = db.Pool.QueryRow(ctx,
		"SELECT b.user_id FROM conversations cc JOIN bots b ON b.id = cc.bot_id WHERE cc.id = $1", convID).Scan(&botUserID)
	if err != nil || botUserID != userID {
		return c.Status(404).JSON(fiber.Map{"error": "conversation not found"})
	}

	_, err = db.Pool.Exec(ctx,
		"UPDATE conversations SET status = 'archived', updated_at = now() WHERE id = $1", convID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to archive"})
	}
	return c.JSON(fiber.Map{"status": "archived"})
}
