package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"runtime/debug"
	"strings"

	"github.com/ahvholding/ahvclaw/ai"
	authpkg "github.com/ahvholding/ahvclaw/auth"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/embeddings"
	"github.com/ahvholding/ahvclaw/engine"
	"github.com/ahvholding/ahvclaw/models"
	"github.com/ahvholding/ahvclaw/prompts"
	"github.com/ahvholding/ahvclaw/tools"
	"github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

var Router *ai.RouterClient
var ConnPool *ai.ConnectionPool

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
		role, _ := conn.Locals("role").(string)
		if role == "" {
			role = "user"
		}
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
				handleChat(conn, userID, role, wsMsg.Data)
			default:
				sendWSError(conn, "unknown message type: "+wsMsg.Type)
			}
		}
	})
}

func handleChat(conn *websocket.Conn, userID uuid.UUID, role string, data json.RawMessage) {
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("[PANIC] web-chat handler: %v\nStack: %s", rec, debug.Stack())
			sendWSError(conn, "Internal error occurred, please try again")
		}
	}()

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
		"SELECT role, content, tool_calls, tool_call_id FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 50", *convID)
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

	// Build system prompt from centralized default
	systemPrompt := prompts.DefaultSystemPrompt

	// Inject user identity so the AI knows who it is talking to
	var userName, userEmail string
	db.Pool.QueryRow(ctx, "SELECT name, email FROM users WHERE id = $1", userID).Scan(&userName, &userEmail)
	if userName != "" {
		systemPrompt += fmt.Sprintf("\n\n## User Identity\nYou are talking to: %s (email: %s)\nUser ID: %s\nAlways address them by name when appropriate.", userName, userEmail, userID.String())
	}

	// Load agent config if conversation has an agent
	var agentID *uuid.UUID
	var projectID *uuid.UUID
	_ = db.Pool.QueryRow(ctx,
		"SELECT current_agent_id, project_id FROM conversations WHERE id = $1", *convID,
	).Scan(&agentID, &projectID)

	if agentID != nil {
		var agentPrompt *string
		db.Pool.QueryRow(ctx,
			"SELECT system_prompt FROM agents WHERE id = $1 AND user_id = $2", *agentID, userID,
		).Scan(&agentPrompt)
		if agentPrompt != nil && *agentPrompt != "" {
			systemPrompt = *agentPrompt
		}
	}

	// Load project context if conversation has a project
	if projectID != nil {
		var projInstructions *string
		db.Pool.QueryRow(ctx,
			"SELECT instructions FROM projects WHERE id = $1 AND user_id = $2", *projectID, userID,
		).Scan(&projInstructions)
		if projInstructions != nil && *projInstructions != "" {
			systemPrompt += "\n\n## Project Instructions:\n" + *projInstructions
		}

		// Load project files as context
		pfRows, pfErr := db.Pool.Query(ctx,
			`SELECT filename, content FROM project_files WHERE project_id = $1 AND project_id IN (SELECT id FROM projects WHERE user_id = $2) AND content IS NOT NULL AND content != '' LIMIT 5`,
			*projectID, userID)
		if pfErr == nil && pfRows != nil {
			defer pfRows.Close()
			var projFiles strings.Builder
			for pfRows.Next() {
				var fname, fcontent string
				if pfRows.Scan(&fname, &fcontent) == nil {
					projFiles.WriteString(fmt.Sprintf("\n### File: %s\n%s\n", fname, fcontent))
				}
			}
			if projFiles.Len() > 0 {
				systemPrompt += "\n\n## Project Files:" + projFiles.String()
			}
		}
	}

	// Load server context if conversation is linked to a server
	var serverID *uuid.UUID
	db.Pool.QueryRow(ctx,
		"SELECT server_id FROM conversations WHERE id = $1", *convID,
	).Scan(&serverID)
	if serverID != nil {
		var serverName, serverHost, serverEnv string
		var serverPort int
		err := db.Pool.QueryRow(ctx,
			`SELECT name, host, port, environment FROM servers WHERE id = $1 AND user_id = $2`,
			*serverID, userID,
		).Scan(&serverName, &serverHost, &serverPort, &serverEnv)
		if err == nil {
			// Sanitize server name to prevent prompt injection
			safeName := sanitizeForPrompt(serverName)
			safeHost := sanitizeForPrompt(serverHost)
			safeEnv := sanitizeForPrompt(serverEnv)
			systemPrompt += fmt.Sprintf(`

## Server Context — ISOLATED SERVER CONVERSATION
You are managing server: %s (%s:%d)
Environment: %s

This conversation is EXCLUSIVELY about this server. You have full access to:
- server_ssh_exec: Execute any command on this server
- server_status: Check CPU, memory, disk, processes
- All other tools for development, deployment, and management

Use server_ssh_exec with server_name="%s" for all remote operations.
For destructive operations (rm -rf, DROP, format, systemctl stop critical services),
always confirm with the user first.
`, safeName, safeHost, serverPort, safeEnv, safeName)
		}
	}

	// Load servers.md for bot context
	serversMdPath := fmt.Sprintf("/data/ahvclaw/users/%s/servers.md", userID.String())
	if serversData, err := os.ReadFile(serversMdPath); err == nil && len(serversData) > 0 {
		systemPrompt += "\n\n## Your Managed Servers\n"
		systemPrompt += "You can read/write this file at: " + serversMdPath + "\n"
		systemPrompt += "Use server_ssh_exec with the server name to execute commands.\n"
		systemPrompt += "Use server_list to see all registered servers.\n\n"
		serversMd := string(serversData)
		if len(serversMd) > 2000 {
			serversMd = serversMd[:2000] + "\n...(truncated)"
		}
		systemPrompt += serversMd
	}

	// Always load personal/identity memories first (these define who the user is)
	var memoryContext strings.Builder
	personalRows, personalErr := db.Pool.Query(ctx,
		`SELECT type, key, content FROM memories
		 WHERE user_id = $1 AND type IN ('user','profile','preference','feedback','correction')
		 ORDER BY updated_at DESC LIMIT 15`, userID)
	if personalErr == nil && personalRows != nil {
		defer personalRows.Close()
		for personalRows.Next() {
			var mType, mKey, mContent string
			if personalRows.Scan(&mType, &mKey, &mContent) == nil {
				memoryContext.WriteString(fmt.Sprintf("- [%s] %s: %s\n", mType, mKey, mContent))
			}
		}
	}

	// Then add contextual memories via semantic search
	semanticResults, semErr := embeddings.SearchByEmbedding(userID.String(), req.Content, 10)
	if semErr == nil && len(semanticResults) > 0 {
		for _, r := range semanticResults {
			memoryContext.WriteString(fmt.Sprintf("- [%s] %s: %s\n",
				r["type"], r["key"], r["content"]))
		}
	} else {
		memRows, memErr := db.Pool.Query(ctx,
			`SELECT type, key, content FROM memories WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 10`,
			userID)
		if memErr == nil && memRows != nil {
			defer memRows.Close()
			for memRows.Next() {
				var mType, mKey, mContent string
				if memRows.Scan(&mType, &mKey, &mContent) == nil {
					memoryContext.WriteString(fmt.Sprintf("- [%s] %s: %s\n", mType, mKey, mContent))
				}
			}
		}
	}
	if memoryContext.Len() > 0 {
		systemPrompt += "\n\n## Your memories about this user:\n" + memoryContext.String()
	}

	systemPrompt += prompts.ThinkingInstructions

	// Prepend system message and conversation summary
	var fullMessages []ai.ChatMessage
	fullMessages = append(fullMessages, ai.ChatMessage{Role: "system", Content: systemPrompt})

	var summary *string
	db.Pool.QueryRow(ctx, "SELECT summary FROM conversations WHERE id = $1", *convID).Scan(&summary)
	if summary != nil && *summary != "" {
		fullMessages = append(fullMessages, ai.ChatMessage{
			Role:    "system",
			Content: "## Previous conversation summary:\n" + *summary,
		})
	}

	fullMessages = append(fullMessages, messages...)
	messages = fullMessages

	// Create executor for user workspace
	executor := tools.NewExecutor(fmt.Sprintf("/data/ahvclaw/workspaces/%s", userID.String()), userID.String())
	executor.BroadcastFn = func(uid string, eventType string, data interface{}) {
		Hub.BroadcastToUser(uid, Event{Type: eventType, Data: data})
	}

	// Ensure workspace exists
	os.MkdirAll(executor.WorkspaceDir, 0755)

	// Look up user fallback models
	var userFallback *string
	db.Pool.QueryRow(ctx, "SELECT value FROM user_settings WHERE user_id = $1 AND key = 'fallback_models'", userID).Scan(&userFallback)
	fallbackStr := ""
	if userFallback != nil {
		fallbackStr = *userFallback
	}

	// Resolve per-user AI connection (falls back to default Router if none found)
	resolved := ConnPool.Resolve(ctx, userID, req.Model)
	activeRouter := resolved.CreateClient()

	// Use per-user connection for AI loop
	result, err := engine.ProcessChat(ctx, engine.ChatConfig{
		AIRouter:         activeRouter,
		APIFormat:        resolved.APIFormat,
		ConnectionID:     resolved.ConnectionID,
		Model:            resolved.Model,
		FallbackModels:   fallbackStr,
		Messages:         messages,
		Tools:            toolsForRoleAsAI(role),
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
		// Send done signal so the client stops waiting
		sendWSJSON(conn, "delta", models.StreamDelta{Done: true})
		return
	}

	// Parse thinking and send as WS event
	thinking, cleanResponse := engine.ParseThinking(result.Content)
	// Safety: if ParseThinking stripped everything but original had content, keep original
	if cleanResponse == "" && result.Content != "" {
		cleanResponse = result.Content
	}
	if thinking.Raw != "" {
		sendWSJSON(conn, "thinking", fiber.Map{
			"content": thinking.Raw,
			"level":   thinking.Level,
		})
	}

	// Run verification on medium/complex responses
	verification := engine.VerifyResponse(thinking, cleanResponse, nil, nil)
	if !verification.Passed {
		log.Printf("[web-chat] verification failed (%s): %s", verification.FailReason, verification.FixPrompt)
		// Retry once with fix prompt
		retryMessages := append(result.Messages, ai.ChatMessage{
			Role:    "user",
			Content: fmt.Sprintf(prompts.VerificationRetryPrompt, verification.FixPrompt),
		})
		retryResult, retryErr := engine.ProcessChat(ctx, engine.ChatConfig{
			AIRouter:         Router,
			Model:            req.Model,
			FallbackModels:   fallbackStr,
			Messages:         retryMessages,
			Tools:            toolsForRoleAsAI(role),
			Executor:         executor,
			MaxToolRounds:    5,
			MaxContextTokens: 8000,
			OnDelta: func(content string) {
				sendWSJSON(conn, "delta", models.StreamDelta{Content: content})
			},
			OnDone: func(tokensIn, tokensOut int) {
				sendWSJSON(conn, "delta", models.StreamDelta{Done: true, TokensIn: tokensIn, TokensOut: tokensOut})
			},
		})
		if retryErr == nil && retryResult.Content != "" {
			_, retryClean := engine.ParseThinking(retryResult.Content)
			cleanResponse = retryClean
			result = retryResult
		}
	}

	// Use clean response (without <thinking> tags)
	result.Content = cleanResponse

	// Save intermediate tool messages from engine history.
	historyLen := len(messages)
	newMsgCount := 0
	for i := historyLen; i < len(result.Messages); i++ {
		msg := result.Messages[i]
		if msg.Role == "assistant" && len(msg.ToolCalls) > 0 {
			_, _ = db.Pool.Exec(ctx,
				"INSERT INTO messages (conversation_id, role, content, tool_calls, model, source) VALUES ($1, 'assistant', $2, $3, $4, 'web')",
				*convID, msg.Content, msg.ToolCalls, req.Model)
			newMsgCount++
		} else if msg.Role == "tool" {
			_, _ = db.Pool.Exec(ctx,
				"INSERT INTO messages (conversation_id, role, content, tool_call_id, source) VALUES ($1, 'tool', $2, $3, 'web')",
				*convID, msg.Content, msg.ToolCallID)
			newMsgCount++
		}
	}

	// Save final assistant response to DB
	_, _ = db.Pool.Exec(ctx,
		"INSERT INTO messages (conversation_id, role, content, source, tokens_in, tokens_out, model) VALUES ($1, 'assistant', $2, 'web', $3, $4, $5)",
		*convID, result.Content, result.TokensIn, result.TokensOut, req.Model)
	newMsgCount += 2 // +1 for user message saved earlier, +1 for assistant

	// Update message count and trigger summarization
	var msgCount int
	db.Pool.QueryRow(ctx,
		"UPDATE conversations SET message_count = message_count + $1, updated_at = now() WHERE id = $2 RETURNING message_count",
		newMsgCount, *convID).Scan(&msgCount)
	engine.CheckAndSummarize(ctx, *convID, msgCount, Router, req.Model)

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
			"UPDATE conversations SET title = $1, updated_at = now() WHERE id = $2 AND user_id = $3",
			title, *convID, userID)
		// Notify client of auto-generated title
		sendWSJSON(conn, "title_update", map[string]string{"conversation_id": (*convID).String(), "title": title})
	} else {
		db.Pool.Exec(ctx,
			"UPDATE conversations SET updated_at = now() WHERE id = $1 AND user_id = $2", *convID, userID)
	}
}

// toolsForRoleAsAI returns AI tool definitions filtered by user role. ([]tools.ToolDef) to []ai.Tool.
func toolsForRoleAsAI(role string) []ai.Tool {
	var result []ai.Tool
	for _, d := range tools.ToolsForRole(role) {
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

// sanitizeForPrompt strips characters that could be used for prompt injection.
func sanitizeForPrompt(s string) string {
	var sb strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') ||
			r == ' ' || r == '-' || r == '_' || r == '.' || r == '#' || r == ':' || r == '(' || r == ')' {
			sb.WriteRune(r)
		}
	}
	result := sb.String()
	if len(result) > 100 {
		result = result[:100]
	}
	return result
}
