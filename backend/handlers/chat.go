package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/ahvholding/ahvclaw/ai"
	authpkg "github.com/ahvholding/ahvclaw/auth"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/engine"
	"github.com/ahvholding/ahvclaw/models"
	"github.com/ahvholding/ahvclaw/tools"
	"github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

var Router *ai.RouterClient

func WSUpgrade() fiber.Handler {
	return func(c *fiber.Ctx) error {
		if !websocket.IsWebSocketUpgrade(c) {
			return fiber.ErrUpgradeRequired
		}

		// Try ticket first (preferred)
		ticket := c.Query("ticket")
		if ticket != "" {
			userID, role, valid := ValidateWSTicket(ticket)
			if !valid {
				return c.Status(401).JSON(fiber.Map{"error": "invalid or expired ticket"})
			}
			c.Locals("user_id", userID)
			c.Locals("role", role)
			return c.Next()
		}

		// Fallback to token (backwards compatibility)
		token := c.Query("token")
		if token == "" {
			return c.Status(401).JSON(fiber.Map{"error": "ticket or token required"})
		}
		claims, err := authpkg.ParseAccessToken(token)
		if err != nil {
			return c.Status(401).JSON(fiber.Map{"error": "invalid token"})
		}
		c.Locals("user_id", claims.UserID)
		c.Locals("role", claims.Role)
		return c.Next()
	}
}

func WSChat() fiber.Handler {
	return websocket.New(func(conn *websocket.Conn) {
		userID, _ := conn.Locals("user_id").(uuid.UUID)
		defer conn.Close()

		for {
			_, msgBytes, err := conn.ReadMessage()
			if err != nil {
				break
			}

			var wsMsg models.WSMessage
			if err := json.Unmarshal(msgBytes, &wsMsg); err != nil {
				sendWSError(conn, "invalid message format")
				continue
			}

			switch wsMsg.Type {
			case "chat":
				handleChat(conn, userID, wsMsg.Data)
			default:
				sendWSError(conn, "unknown message type: "+wsMsg.Type)
			}
		}
	})
}

func handleChat(conn *websocket.Conn, userID uuid.UUID, data json.RawMessage) {
	log.Printf("[web-chat] handleChat called for user %s", userID)
	var req models.ChatRequest
	if err := json.Unmarshal(data, &req); err != nil {
		sendWSError(conn, "invalid chat request")
		return
	}

	ctx := context.Background()

	// Process attachments
	userContent := req.Content
	var attachmentsJSON []byte
	if len(req.Attachments) > 0 {
		var atts []map[string]interface{}
		for _, attID := range req.Attachments {
			var mimeType string
			var extractedText *string
			var storagePath string
			var originalName string
			err := db.Pool.QueryRow(ctx,
				"SELECT mime_type, extracted_text, storage_path, original_name FROM attachments WHERE id = $1 AND user_id = $2",
				attID, userID).Scan(&mimeType, &extractedText, &storagePath, &originalName)
			if err != nil {
				continue
			}
			if extractedText != nil && *extractedText != "" {
				userContent += "\n\n[Attached file: " + originalName + "]\n" + *extractedText
			} else if strings.HasPrefix(mimeType, "image/") {
				// Read file and base64 encode for AI vision
				fileData, err := os.ReadFile(storagePath)
				if err == nil {
					b64 := base64.StdEncoding.EncodeToString(fileData)
					userContent += "\n\n[Image attached: " + originalName + ", base64_data: data:" + mimeType + ";base64," + b64 + "]"
				} else {
					userContent += "\n\n[Image attached: " + originalName + " (could not read file)]"
				}
			}
			atts = append(atts, map[string]interface{}{
				"id": attID, "filename": originalName, "mime_type": mimeType,
				"url": "/api/uploads/" + attID,
			})
		}
		if len(atts) > 0 {
			attachmentsJSON, _ = json.Marshal(atts)
		}
	}

	convID := req.ConversationID

	// Create conversation if new
	if convID == nil {
		newID := uuid.New()
		_, err := db.Pool.Exec(ctx,
			"INSERT INTO conversations (id, user_id, model) VALUES ($1, $2, $3)",
			newID, userID, req.Model)
		if err != nil {
			sendWSError(conn, "failed to create conversation")
			return
		}
		convID = &newID

		// Send conversation ID to client
		sendWSJSON(conn, "conversation_id", newID.String())
	} else {
		// Verify ownership
		var ownerID uuid.UUID
		err := db.Pool.QueryRow(ctx, "SELECT user_id FROM conversations WHERE id = $1", *convID).Scan(&ownerID)
		if err != nil || ownerID != userID {
			sendWSError(conn, "conversation not found")
			return
		}
	}

	log.Printf("[web-chat] Using conversation %s", *convID)
	// Save user message with attachments
	var attJSONForDB interface{} = nil
	if len(attachmentsJSON) > 0 {
		attJSONForDB = attachmentsJSON
	}
	_, _ = db.Pool.Exec(ctx,
		"INSERT INTO messages (conversation_id, role, content, model, source, attachments) VALUES ($1, 'user', $2, $3, 'web', $4)",
		*convID, userContent, req.Model, attJSONForDB)

	// Load conversation history
	rows, err := db.Pool.Query(ctx,
		"SELECT role, content, tool_calls, tool_call_id FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 30", *convID)
	if err != nil {
		sendWSError(conn, "failed to load history")
		return
	}
	defer rows.Close()

	var messages []ai.ChatMessage
	for rows.Next() {
		var role string
		var content *string
		var toolCalls *json.RawMessage
		var toolCallID *string
		rows.Scan(&role, &content, &toolCalls, &toolCallID)

		msg := ai.ChatMessage{Role: role}
		if content != nil {
			msg.Content = *content
		}
		if toolCalls != nil {
			msg.ToolCalls = *toolCalls
		}
		if toolCallID != nil {
			msg.ToolCallID = *toolCallID
		}
		messages = append(messages, msg)
	}

	// Reverse to chronological order (we loaded DESC)
	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}

	// Create executor for user workspace
	executor := tools.NewExecutor(fmt.Sprintf("/data/ahvclaw/workspaces/%s", userID.String()), userID.String())

	// Ensure workspace exists
	os.MkdirAll(executor.WorkspaceDir, 0755)

	// Look up user fallback models
	var userFallback *string
	db.Pool.QueryRow(ctx, "SELECT value FROM user_settings WHERE user_id = $1 AND key = 'fallback_models'", userID).Scan(&userFallback)
	fallbackStr := ""
	if userFallback != nil {
		fallbackStr = *userFallback
	}

	// Use shared engine for AI loop
	result, err := engine.ProcessChat(ctx, engine.ChatConfig{
		AIRouter:         Router,
		Model:            req.Model,
		FallbackModels:   fallbackStr,
		Messages:         messages,
		Tools:            allToolsAsAI(),
		Executor:         executor,
		MaxToolRounds:    10,
		MaxContextTokens: 8000,
		OnDelta: func(content string) {
			sendWSJSON(conn, "delta", models.StreamDelta{Content: content})
		},
		OnToolCall: func(name, args string) {
			sendWSJSON(conn, "tool_call", fiber.Map{"name": name, "arguments": args})
		},
		OnToolResult: func(name, content, errStr string) {
			sendWSJSON(conn, "tool_result", fiber.Map{"name": name, "content": content, "error": errStr})
		},
		OnDone: func(tokensIn, tokensOut int) {
			sendWSJSON(conn, "delta", models.StreamDelta{Done: true, TokensIn: tokensIn, TokensOut: tokensOut})
		},
		OnError: func(err error) {
			sendWSError(conn, "AI error: "+err.Error())
		},
	})

	if err != nil {
		log.Printf("[web-chat] ProcessChat error: %v", err)
		return
	}

	// Save intermediate tool messages from engine history.
	// The engine returns the full message history including assistant messages
	// with tool_calls and tool result messages. We need to save those that were
	// generated during this invocation (i.e., beyond what we loaded from DB).
	// The loaded history length tells us where new messages start.
	historyLen := len(messages)
	for i := historyLen; i < len(result.Messages); i++ {
		msg := result.Messages[i]
		if msg.Role == "assistant" && len(msg.ToolCalls) > 0 {
			_, _ = db.Pool.Exec(ctx,
				"INSERT INTO messages (conversation_id, role, content, tool_calls, model, source) VALUES ($1, 'assistant', $2, $3, $4, 'web')",
				*convID, msg.Content, msg.ToolCalls, req.Model)
		} else if msg.Role == "tool" {
			_, _ = db.Pool.Exec(ctx,
				"INSERT INTO messages (conversation_id, role, content, tool_call_id, source) VALUES ($1, 'tool', $2, $3, 'web')",
				*convID, msg.Content, msg.ToolCallID)
		}
	}

	// Save final assistant response to DB
	_, _ = db.Pool.Exec(ctx,
		"INSERT INTO messages (conversation_id, role, content, source, tokens_in, tokens_out, model) VALUES ($1, 'assistant', $2, 'web', $3, $4, $5)",
		*convID, result.Content, result.TokensIn, result.TokensOut, req.Model)

	// Auto-title if conversation has no title yet
	var existingTitle *string
	db.Pool.QueryRow(ctx,
		"SELECT title FROM conversations WHERE id = $1", *convID).Scan(&existingTitle)
	if existingTitle == nil || *existingTitle == "" {
		title := req.Content
		runes := []rune(title)
		if len(runes) > 60 {
			title = string(runes[:60]) + "..."
		}
		db.Pool.Exec(ctx,
			"UPDATE conversations SET title = $1, updated_at = now() WHERE id = $2",
			title, *convID)
		// Notify client of auto-generated title
		sendWSJSON(conn, "title_update", map[string]string{"conversation_id": (*convID).String(), "title": title})
	} else {
		db.Pool.Exec(ctx,
			"UPDATE conversations SET updated_at = now() WHERE id = $1", *convID)
	}
}

// allToolsAsAI converts tools.AllTools ([]tools.ToolDef) to []ai.Tool.
func allToolsAsAI() []ai.Tool {
	var result []ai.Tool
	for _, d := range tools.AllTools {
		result = append(result, ai.Tool{
			Type: d.Type,
			Function: ai.ToolFunction{
				Name:        d.Function.Name,
				Description: d.Function.Description,
				Parameters:  d.Function.Parameters,
			},
		})
	}
	return result
}

func sendWSJSON(conn *websocket.Conn, msgType string, data interface{}) {
	raw, _ := json.Marshal(data)
	msg := models.WSMessage{Type: msgType, Data: raw}
	bytes, _ := json.Marshal(msg)
	conn.WriteMessage(websocket.TextMessage, bytes)
}

func sendWSError(conn *websocket.Conn, errMsg string) {
	sendWSJSON(conn, "error", map[string]string{"message": errMsg})
}
