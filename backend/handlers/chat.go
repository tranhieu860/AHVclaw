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
		"SELECT role, content, tool_calls, tool_call_id FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC", *convID)
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

	// Add tool definitions to the request
	toolDefs := tools.AllTools

	// Create executor for user workspace
	executor := tools.NewExecutor(fmt.Sprintf("/data/ahvclaw/workspaces/%s", userID.String()), userID.String())

	// Ensure workspace exists
	os.MkdirAll(executor.WorkspaceDir, 0755)

	// AI conversation loop (handles tool calls)
	maxToolRounds := 10
	for round := 0; round < maxToolRounds; round++ {
		var fullContent strings.Builder
		var accumulatedToolCalls []json.RawMessage
		var tokensIn, tokensOut int
		var finishReason string

		aiReq := ai.ChatCompletionRequest{
			Model:    req.Model,
			Messages: messages,
			Stream:   true,
			Tools:    convertToolDefs(toolDefs),
		}

		err = Router.StreamChat(aiReq, func(chunk ai.StreamChunk) {
			if len(chunk.Choices) > 0 {
				delta := chunk.Choices[0].Delta
				if delta.Content != "" {
					fullContent.WriteString(delta.Content)
					sendWSJSON(conn, "delta", models.StreamDelta{Content: delta.Content})
				}
				if delta.ToolCalls != nil {
					accumulatedToolCalls = append(accumulatedToolCalls, delta.ToolCalls)
				}
				if chunk.Choices[0].FinishReason != nil {
					finishReason = *chunk.Choices[0].FinishReason
				}
			}
			if chunk.Usage != nil {
				tokensIn = chunk.Usage.PromptTokens
				tokensOut = chunk.Usage.CompletionTokens
			}
		})

		if err != nil {
			log.Printf("Stream error: %v", err)
			sendWSError(conn, "AI streaming failed: "+err.Error())
			break
		}

		// If no tool calls, we're done
		if finishReason != "tool_calls" || len(accumulatedToolCalls) == 0 {
			// Save assistant message
			content := fullContent.String()
			_, _ = db.Pool.Exec(ctx,
				"INSERT INTO messages (conversation_id, role, content, tokens_in, tokens_out, model, source) VALUES ($1, 'assistant', $2, $3, $4, $5, 'web')",
				*convID, content, tokensIn, tokensOut, req.Model)

			// Auto-title if first exchange
			var msgCount int
			db.Pool.QueryRow(ctx,
				"SELECT COUNT(*) FROM messages WHERE conversation_id = $1", *convID).Scan(&msgCount)
			if msgCount <= 2 {
				title := req.Content
				if len(title) > 80 {
					title = title[:80] + "..."
				}
				db.Pool.Exec(ctx,
					"UPDATE conversations SET title = $1, updated_at = now() WHERE id = $2",
					title, *convID)
			} else {
				db.Pool.Exec(ctx,
					"UPDATE conversations SET updated_at = now() WHERE id = $1", *convID)
			}

			// Send done signal
			sendWSJSON(conn, "delta", models.StreamDelta{
				Done:      true,
				TokensIn:  tokensIn,
				TokensOut: tokensOut,
			})
			break
		}

		// Merge accumulated tool call deltas into complete tool calls
		mergedToolCallsJSON := mergeToolCallDeltas(accumulatedToolCalls)

		// Parse and execute tool calls
		var toolCalls []struct {
			ID       string          `json:"id"`
			Type     string          `json:"type"`
			Function struct {
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			} `json:"function"`
		}
		if err := json.Unmarshal(mergedToolCallsJSON, &toolCalls); err != nil {
			sendWSError(conn, "failed to parse tool calls")
			break
		}

		// Save assistant message with tool calls
		assistantContent := fullContent.String()
		_, _ = db.Pool.Exec(ctx,
			"INSERT INTO messages (conversation_id, role, content, tool_calls, tokens_in, tokens_out, model, source) VALUES ($1, 'assistant', $2, $3, $4, $5, $6, 'web')",
			*convID, assistantContent, mergedToolCallsJSON, tokensIn, tokensOut, req.Model)

		// Add assistant message to history
		messages = append(messages, ai.ChatMessage{
			Role:      "assistant",
			Content:   assistantContent,
			ToolCalls: mergedToolCallsJSON,
		})

		// Execute each tool call
		for _, tc := range toolCalls {
			// Send tool call info to frontend
			sendWSJSON(conn, "tool_call", fiber.Map{
				"id":        tc.ID,
				"name":      tc.Function.Name,
				"arguments": string(tc.Function.Arguments),
			})

			// Execute the tool
			result := executor.Execute(tc.Function.Name, tc.Function.Arguments)

			// Send tool result to frontend
			sendWSJSON(conn, "tool_result", fiber.Map{
				"id":      tc.ID,
				"name":    result.Name,
				"content": result.Content,
				"error":   result.Error,
			})

			// Add tool result to message history
			toolContent := result.Content
			if result.Error != "" {
				toolContent = "Error: " + result.Error
			}
			messages = append(messages, ai.ChatMessage{
				Role:       "tool",
				Content:    toolContent,
				ToolCallID: tc.ID,
			})

			// Save tool result to DB
			trJSON, _ := json.Marshal(result)
			_, _ = db.Pool.Exec(ctx,
				"INSERT INTO messages (conversation_id, role, content, tool_results, tool_call_id, source) VALUES ($1, 'tool', $2, $3, $4, 'web')",
				*convID, toolContent, trJSON, tc.ID)
		}

		// Loop continues - AI will process tool results and may call more tools or respond
		_ = round
	}
}

// mergeToolCallDeltas merges streaming tool call deltas into complete tool calls
func mergeToolCallDeltas(deltas []json.RawMessage) json.RawMessage {
	if len(deltas) == 1 {
		return deltas[0]
	}

	type toolCallDelta struct {
		Index    int    `json:"index"`
		ID       string `json:"id,omitempty"`
		Type     string `json:"type,omitempty"`
		Function struct {
			Name      string `json:"name,omitempty"`
			Arguments string `json:"arguments,omitempty"`
		} `json:"function,omitempty"`
	}

	type mergedTC struct {
		ID       string          `json:"id"`
		Type     string          `json:"type"`
		Function struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		} `json:"function"`
	}

	type accumEntry struct {
		ID        string
		Type      string
		Name      string
		Arguments strings.Builder
	}

	accumulated := make(map[int]*accumEntry)

	for _, deltaRaw := range deltas {
		var deltaList []toolCallDelta
		if err := json.Unmarshal(deltaRaw, &deltaList); err != nil {
			var single toolCallDelta
			if err2 := json.Unmarshal(deltaRaw, &single); err2 == nil {
				deltaList = []toolCallDelta{single}
			} else {
				continue
			}
		}
		for _, d := range deltaList {
			entry, ok := accumulated[d.Index]
			if !ok {
				entry = &accumEntry{}
				accumulated[d.Index] = entry
			}
			if d.ID != "" {
				entry.ID = d.ID
			}
			if d.Type != "" {
				entry.Type = d.Type
			}
			if d.Function.Name != "" {
				entry.Name = d.Function.Name
			}
			entry.Arguments.WriteString(d.Function.Arguments)
		}
	}

	var result []mergedTC
	for i := 0; i < len(accumulated); i++ {
		entry, ok := accumulated[i]
		if !ok {
			continue
		}
		tc := mergedTC{
			ID:   entry.ID,
			Type: entry.Type,
		}
		tc.Function.Name = entry.Name
		tc.Function.Arguments = json.RawMessage(entry.Arguments.String())
		result = append(result, tc)
	}

	out, _ := json.Marshal(result)
	return out
}

// convertToolDefs converts tools.ToolDef to ai.Tool
func convertToolDefs(defs []tools.ToolDef) []ai.Tool {
	var result []ai.Tool
	for _, d := range defs {
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
