package channels

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/ahvholding/ahvclaw/ai"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/tools"
	"github.com/google/uuid"
)

// Router handles inbound channel messages: contact resolution,
// conversation management, AI processing, and response delivery.
type Router struct {
	aiRouter *ai.RouterClient
}

// NewRouter creates a new channel message router.
func NewRouter(aiRouter *ai.RouterClient) *Router {
	return &Router{aiRouter: aiRouter}
}

// HandleInbound processes an inbound message from a channel adapter.
func (r *Router) HandleInbound(msg InboundMessage, adapter ChannelAdapter) {
	ctx := context.Background()

	// 1. Load bot config
	var botUserID uuid.UUID
	var defaultAgentID *uuid.UUID
	var aiSettingsRaw *json.RawMessage
	var responseSettingsRaw *json.RawMessage

	botUUID, err := uuid.Parse(msg.BotID)
	if err != nil {
		log.Printf("[router] invalid bot ID %s: %v", msg.BotID, err)
		return
	}

	err = db.Pool.QueryRow(ctx,
		`SELECT user_id, default_agent_id, ai_settings, response_settings
		 FROM bots WHERE id = $1 AND is_active = true`,
		botUUID,
	).Scan(&botUserID, &defaultAgentID, &aiSettingsRaw, &responseSettingsRaw)
	if err != nil {
		log.Printf("[router] bot %s not found or inactive: %v", msg.BotID, err)
		return
	}

	// 2. Find or create contact
	contact, err := r.findOrCreateContact(ctx, botUserID, msg)
	if err != nil {
		log.Printf("[router] contact error: %v", err)
		return
	}

	// 3. Find or create conversation
	conv, err := r.findOrCreateConversation(ctx, botUUID, contact.ID, msg)
	if err != nil {
		log.Printf("[router] conversation error: %v", err)
		return
	}

	// 4. Check takeover status - if a human has taken over, skip AI
	if conv.TakeoverBy != nil {
		log.Printf("[router] conversation %s is taken over, skipping AI", conv.ID)
		// Still save the inbound message
		r.saveChannelMessage(ctx, conv.ID, "inbound", "contact", &msg.ChannelUserID,
			msg.Text, nil, &msg.MessageID, nil)
		return
	}

	// 5. Build message text with file references
	msgText := msg.Text
	var imageBase64Files []InboundFile
	if len(msg.Files) > 0 {
		for _, f := range msg.Files {
			if f.Base64Data != "" && strings.HasPrefix(f.MimeType, "image/") {
				// Image with base64 data - will be sent as multimodal content
				imageBase64Files = append(imageBase64Files, f)
			} else if f.Filename != "" {
				msgText += "\n[File received: " + f.Filename + " (" + f.MimeType + "), file_id: " + f.FileID + "]"
			} else {
				msgText += "\n[Photo received from Telegram, file_id: " + f.FileID + "]"
			}
		}
	}

	// Save inbound message
	r.saveChannelMessage(ctx, conv.ID, "inbound", "contact", &msg.ChannelUserID,
		msgText, nil, &msg.MessageID, nil)

	// 5b. Send typing indicator
	if err := adapter.SendTyping(msg.ChatID); err != nil {
		log.Printf("[router] typing indicator error: %v", err)
	}

	// 6. Load agent config
	agentID := defaultAgentID
	if conv.CurrentAgentID != nil {
		agentID = conv.CurrentAgentID
	}

	var systemPrompt string
	var model string
	var fallbackModels string
	if agentID != nil {
		var agentFallback *string
		err = db.Pool.QueryRow(ctx,
			`SELECT system_prompt, model, COALESCE(fallback_models, '') FROM agents WHERE id = $1`, *agentID,
		).Scan(&systemPrompt, &model, &agentFallback)
		if agentFallback != nil && *agentFallback != "" && fallbackModels == "" {
			fallbackModels = *agentFallback
		}
		if err != nil {
			log.Printf("[router] agent %s not found: %v", agentID, err)
			systemPrompt = "Bạn là trợ lý AI thông minh. Luôn trả lời bằng tiếng Việt. Sử dụng công cụ (tools) khi cần thiết thay vì đoán."
			model = "AHV-Holding-TroLy"
		}
	} else {
		systemPrompt = "Bạn là trợ lý AI thông minh. Luôn trả lời bằng tiếng Việt. Sử dụng công cụ (tools) khi cần thiết thay vì đoán."
		model = "AHV-Holding-TroLy"
	}

	// Override model from AI settings if present
	if aiSettingsRaw != nil {
		var aiSettings struct {
			Model          string `json:"model"`
			FallbackModels string `json:"fallback_models"`
		}
		if json.Unmarshal(*aiSettingsRaw, &aiSettings) == nil {
			if aiSettings.Model != "" {
				model = aiSettings.Model
			}
			fallbackModels = aiSettings.FallbackModels
		}
	}

	// Load memories for context
	var memoryContext strings.Builder
	memRows, memErr := db.Pool.Query(ctx,
		`SELECT type, key, content FROM memories WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 10`,
		botUserID)
	if memErr == nil && memRows != nil {
		defer memRows.Close()
		for memRows.Next() {
			var mType, mKey, mContent string
			if memRows.Scan(&mType, &mKey, &mContent) == nil {
				memoryContext.WriteString(fmt.Sprintf("- [%s] %s: %s\n", mType, mKey, mContent))
			}
		}
	}
	if memoryContext.Len() > 0 {
		systemPrompt += "\n\n## Your memories about this user:\n" + memoryContext.String()
	}
	systemPrompt += "\n\nIMPORTANT: When you learn something about the user (name, preferences, etc.), use the memory_save tool to remember it. When asked about past conversations, use memory_search."

	// Parse response settings
	maxLength := 4096
	if responseSettingsRaw != nil {
		var respSettings struct {
			MaxLength int `json:"max_length"`
		}
		if json.Unmarshal(*responseSettingsRaw, &respSettings) == nil && respSettings.MaxLength > 0 {
			maxLength = respSettings.MaxLength
		}
	}

	// 7. Build message history
	messages := r.buildMessageHistory(ctx, conv.ID, systemPrompt)

	// 7b. If there are image files, make the last user message multimodal
	if len(imageBase64Files) > 0 && len(messages) > 0 {
		// Find the last user message and make it multimodal
		for i := len(messages) - 1; i >= 0; i-- {
			if messages[i].Role == "user" {
				// Build multimodal content parts
				contentParts := []map[string]interface{}{
					{"type": "text", "text": fmt.Sprintf("%v", messages[i].Content)},
				}
				for _, imgFile := range imageBase64Files {
					contentParts = append(contentParts, map[string]interface{}{
						"type": "image_url",
						"image_url": map[string]string{
							"url": "data:" + imgFile.MimeType + ";base64," + imgFile.Base64Data,
						},
					})
				}
				messages[i].Content = contentParts
				break
			}
		}
	}

	// 8. Call AI with tool loop - filter tools based on bot settings
	toolDefs := tools.AllTools
	if aiSettingsRaw != nil {
		var toolSettings struct {
			AllowedTools []string `json:"allowed_tools"`
			BlockedTools []string `json:"blocked_tools"`
		}
		if json.Unmarshal(*aiSettingsRaw, &toolSettings) == nil {
			if len(toolSettings.AllowedTools) > 0 {
				allowSet := make(map[string]bool)
				for _, t := range toolSettings.AllowedTools {
					allowSet[t] = true
				}
				var filtered []tools.ToolDef
				for _, t := range toolDefs {
					if allowSet[t.Function.Name] {
						filtered = append(filtered, t)
					}
				}
				toolDefs = filtered
			} else if len(toolSettings.BlockedTools) > 0 {
				blockSet := make(map[string]bool)
				for _, t := range toolSettings.BlockedTools {
					blockSet[t] = true
				}
				var filtered []tools.ToolDef
				for _, t := range toolDefs {
					if !blockSet[t.Function.Name] {
						filtered = append(filtered, t)
					}
				}
				toolDefs = filtered
			}
		}
	}

	// Add tool instructions to system prompt so AI knows it has tools
	if len(toolDefs) > 0 {
		toolNames := make([]string, 0)
		for _, t := range toolDefs {
			toolNames = append(toolNames, t.Function.Name)
		}
		systemPrompt += "\n\nYou have access to these tools: " + strings.Join(toolNames, ", ") + ". Use them when the user asks you to perform actions like checking servers, browsing the web, reading files, or managing data. Always prefer using tools over guessing."
		// Update the system message in messages slice
		if len(messages) > 0 && messages[0].Role == "system" {
			messages[0].Content = systemPrompt
		}
	}

	log.Printf("[router] Sending AI request with %d tools, model=%s", len(toolDefs), model)

	executor := tools.NewExecutor(
		fmt.Sprintf("/data/ahvclaw/workspaces/%s", botUserID.String()),
		botUserID.String(),
	)

	var finalResponse strings.Builder
	maxToolRounds := 10

	for round := 0; round < maxToolRounds; round++ {
		var fullContent strings.Builder
		var accumulatedToolCalls []json.RawMessage
		var finishReason string

		aiReq := ai.ChatCompletionRequest{
			Model:    model,
			Messages: messages,
			Stream:   true,
			Tools:    convertToolDefs(toolDefs),
		}

		err = r.aiRouter.StreamChat(aiReq, func(chunk ai.StreamChunk) {
			if len(chunk.Choices) > 0 {
				delta := chunk.Choices[0].Delta
				if delta.Content != "" {
					fullContent.WriteString(delta.Content)
				}
				if delta.ToolCalls != nil {
					accumulatedToolCalls = append(accumulatedToolCalls, delta.ToolCalls)
				}
				if chunk.Choices[0].FinishReason != nil {
					finishReason = *chunk.Choices[0].FinishReason
				}
			}
		})

		if err != nil && fallbackModels != "" {
			log.Printf("[router] AI stream error with model %s: %v, trying fallbacks", model, err)
			fallbacks := strings.Split(fallbackModels, ",")
			for _, fb := range fallbacks {
				fb = strings.TrimSpace(fb)
				if fb == "" {
					continue
				}
				log.Printf("[router] Trying fallback model: %s", fb)
				fullContent.Reset()
				accumulatedToolCalls = nil
				finishReason = ""
				aiReq.Model = fb
				err = r.aiRouter.StreamChat(aiReq, func(chunk ai.StreamChunk) {
					if len(chunk.Choices) > 0 {
						delta := chunk.Choices[0].Delta
						if delta.Content != "" {
							fullContent.WriteString(delta.Content)
						}
						if delta.ToolCalls != nil {
							accumulatedToolCalls = append(accumulatedToolCalls, delta.ToolCalls)
						}
						if chunk.Choices[0].FinishReason != nil {
							finishReason = *chunk.Choices[0].FinishReason
						}
					}
				})
				if err == nil {
					model = fb
					break
				}
				log.Printf("[router] Fallback model %s also failed: %v", fb, err)
			}
		}
		if err != nil {
			log.Printf("[router] AI stream error: %v", err)
			r.sendResponse(adapter, msg.ChatID, "Xin lỗi, đã xảy ra lỗi khi xử lý tin nhắn. Vui lòng thử lại.", maxLength)
			return
		}

		// No tool calls - we have the final response
		if finishReason != "tool_calls" || len(accumulatedToolCalls) == 0 {
			finalResponse.WriteString(fullContent.String())

			// Save assistant message
			content := fullContent.String()
			r.saveChannelMessage(ctx, conv.ID, "outbound", "ai", nil,
				sanitizeUTF8(content), nil, nil, agentID)

			break
		}

		// Process tool calls
		log.Printf("[router] AI requested %d tool call deltas, processing...", len(accumulatedToolCalls))
		mergedToolCallsJSON := mergeToolCallDeltas(accumulatedToolCalls)

		var toolCalls []struct {
			ID       string `json:"id"`
			Type     string `json:"type"`
			Function struct {
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			} `json:"function"`
		}
		if err := json.Unmarshal(mergedToolCallsJSON, &toolCalls); err != nil {
			log.Printf("[router] failed to parse tool calls: %v", err)
			break
		}

		// Save assistant message with tool calls
		assistantContent := fullContent.String()
		r.saveChannelMessage(ctx, conv.ID, "outbound", "ai", nil,
			assistantContent, &mergedToolCallsJSON, nil, agentID)

		// Add assistant message to history
		messages = append(messages, ai.ChatMessage{
			Role:      "assistant",
			Content:   assistantContent,
			ToolCalls: mergedToolCallsJSON,
		})

		// Send typing indicator before tool execution
		if err := adapter.SendTyping(msg.ChatID); err != nil {
			log.Printf("[router] typing indicator error: %v", err)
		}

		// Execute each tool call
		for _, tc := range toolCalls {
			log.Printf("[router] Executing tool: %s", tc.Function.Name)
			result := executor.Execute(tc.Function.Name, tc.Function.Arguments)

			toolContent := result.Content
			if result.Error != "" {
				toolContent = "Error: " + result.Error
			}

			messages = append(messages, ai.ChatMessage{
				Role:       "tool",
				Content:    toolContent,
				ToolCallID: tc.ID,
			})

			// Save tool result
			trJSON, _ := json.Marshal(result)
			trRaw := json.RawMessage(trJSON)
			r.saveChannelMessage(ctx, conv.ID, "outbound", "tool", nil,
				toolContent, &trRaw, nil, nil, tc.ID)
		}
	}

	// 9. Send response to channel
	responseText := finalResponse.String()
	if responseText == "" {
		responseText = "I processed your request."
	}

	r.sendResponse(adapter, msg.ChatID, responseText, maxLength)

	// Update conversation timestamp
	db.Pool.Exec(ctx, "UPDATE conversations SET updated_at = now() WHERE id = $1", conv.ID)
}

// findOrCreateContact finds an existing contact by channel identity or creates a new one.
func (r *Router) findOrCreateContact(ctx context.Context, userID uuid.UUID, msg InboundMessage) (*contactResult, error) {
	// Try to find existing contact channel
	var contactID uuid.UUID
	err := db.Pool.QueryRow(ctx,
		`SELECT contact_id FROM contact_channels
		 WHERE channel = $1 AND channel_user_id = $2`,
		msg.Channel, msg.ChannelUserID,
	).Scan(&contactID)

	if err == nil {
		// Update last_seen
		db.Pool.Exec(ctx,
			"UPDATE contacts SET last_seen_at = now() WHERE id = $1", contactID)
		return &contactResult{ID: contactID}, nil
	}

	// Create new contact
	contactID = uuid.New()
	var name *string
	if msg.DisplayName != "" {
		name = &msg.DisplayName
	}

	_, err = db.Pool.Exec(ctx,
		`INSERT INTO contacts (id, user_id, name, first_seen_at, last_seen_at)
		 VALUES ($1, $2, $3, now(), now())`,
		contactID, userID, name)
	if err != nil {
		return nil, fmt.Errorf("create contact: %w", err)
	}

	// Create contact channel
	var username *string
	if msg.Username != "" {
		username = &msg.Username
	}
	_, err = db.Pool.Exec(ctx,
		`INSERT INTO contact_channels (contact_id, channel, channel_user_id, channel_username)
		 VALUES ($1, $2, $3, $4)`,
		contactID, msg.Channel, msg.ChannelUserID, username)
	if err != nil {
		return nil, fmt.Errorf("create contact channel: %w", err)
	}

	return &contactResult{ID: contactID}, nil
}

type contactResult struct {
	ID uuid.UUID
}

type convResult struct {
	ID             uuid.UUID
	CurrentAgentID *uuid.UUID
	TakeoverBy     *uuid.UUID
}

// findOrCreateConversation finds an active conversation or creates a new one.
// Uses unified conversations table instead of channel_conversations.
func (r *Router) findOrCreateConversation(ctx context.Context, botID, contactID uuid.UUID, msg InboundMessage) (*convResult, error) {
	// Try to find active conversation in unified table
	var conv convResult
	err := db.Pool.QueryRow(ctx,
		`SELECT id, current_agent_id, takeover_by FROM conversations
		 WHERE bot_id = $1 AND contact_id = $2 AND status = 'active'
		 ORDER BY updated_at DESC LIMIT 1`,
		botID, contactID,
	).Scan(&conv.ID, &conv.CurrentAgentID, &conv.TakeoverBy)

	if err == nil {
		return &conv, nil
	}

	// Create new conversation in unified table
	conv.ID = uuid.New()
	chatID := msg.ChatID
	_, err = db.Pool.Exec(ctx,
		`INSERT INTO conversations (id, user_id, bot_id, contact_id, channel, channel_chat_id, status)
		 VALUES ($1, (SELECT user_id FROM bots WHERE id = $2), $2, $3, $4, $5, 'active')`,
		conv.ID, botID, contactID, msg.Channel, chatID)
	if err != nil {
		return nil, fmt.Errorf("create conversation: %w", err)
	}

	return &conv, nil
}

// saveChannelMessage saves a message in the unified messages table with source indicator.
func sanitizeUTF8(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r != 0xFFFD {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func (r *Router) saveChannelMessage(ctx context.Context, convID uuid.UUID, direction, senderType string,
	senderID *string, content string, toolData *json.RawMessage, channelMsgID *string, agentID *uuid.UUID, toolCallID ...string) {

	// Map direction/senderType to role for unified messages table
	role := "user"
	if direction == "outbound" {
		if senderType == "ai" {
			role = "assistant"
		} else if senderType == "tool" {
			role = "tool"
		} else {
			role = "assistant" // human takeover replies
		}
	}

	// Determine source from conversation channel
	source := "web"
	var ch *string
	_ = db.Pool.QueryRow(ctx, "SELECT channel FROM conversations WHERE id = $1", convID).Scan(&ch)
	if ch != nil && *ch != "" {
		source = *ch
	}

	var tcID *string
	if len(toolCallID) > 0 && toolCallID[0] != "" {
		tcID = &toolCallID[0]
	}

	_, err := db.Pool.Exec(ctx,
		`INSERT INTO messages (conversation_id, role, content, tool_calls, source, tool_call_id)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		convID, role, content, toolData, source, tcID)
	if err != nil {
		log.Printf("[router] failed to save message: %v", err)
	}
}

// buildMessageHistory loads past messages from the unified messages table.
func (r *Router) buildMessageHistory(ctx context.Context, convID uuid.UUID, systemPrompt string) []ai.ChatMessage {
	messages := []ai.ChatMessage{
		{Role: "system", Content: systemPrompt},
	}

	rows, err := db.Pool.Query(ctx,
		`SELECT role, content, tool_calls, COALESCE(tool_call_id, '')
		 FROM messages
		 WHERE conversation_id = $1
		 ORDER BY created_at ASC
		 LIMIT 20`,
		convID)
	if err != nil {
		return messages
	}
	defer rows.Close()

	for rows.Next() {
		var role string
		var content *string
		var toolCallsRaw *json.RawMessage
		var toolCallID string

		if err := rows.Scan(&role, &content, &toolCallsRaw, &toolCallID); err != nil {
			continue
		}

		text := ""
		if content != nil {
			text = *content
		}

		if role == "user" {
			messages = append(messages, ai.ChatMessage{Role: "user", Content: text})
		} else if role == "assistant" {
			msg := ai.ChatMessage{Role: "assistant", Content: text}
			if toolCallsRaw != nil {
				msg.ToolCalls = *toolCallsRaw
			}
			messages = append(messages, msg)
		} else if role == "tool" {
			if toolCallID == "" {
				continue // skip orphan tool results
			}
			msg := ai.ChatMessage{Role: "tool", Content: text}
			if toolCallID != "" {
				msg.ToolCallID = toolCallID
			}
			messages = append(messages, msg)
		}
	}

	return messages
}

// sendResponse sends the AI response to the channel, splitting if necessary.
func (r *Router) sendResponse(adapter ChannelAdapter, chatID string, text string, maxLength int) {
	parts := splitMessage(text, maxLength)
	for _, part := range parts {
		if err := adapter.SendMessage(chatID, part); err != nil {
			log.Printf("[router] failed to send message: %v", err)
		}
		if len(parts) > 1 {
			time.Sleep(200 * time.Millisecond)
		}
	}
}

// splitMessage splits a long message into chunks respecting maxLength.
func splitMessage(text string, maxLength int) []string {
	if maxLength <= 0 {
		maxLength = 4096
	}
	if len(text) <= maxLength {
		return []string{text}
	}

	var parts []string
	for len(text) > 0 {
		if len(text) <= maxLength {
			parts = append(parts, text)
			break
		}
		// Try to split at newline
		cutAt := maxLength
		if idx := strings.LastIndex(text[:maxLength], "\n"); idx > maxLength/2 {
			cutAt = idx + 1
		}
		parts = append(parts, text[:cutAt])
		text = text[cutAt:]
	}
	return parts
}

// mergeToolCallDeltas merges streaming tool call deltas into complete tool calls.
// This mirrors the logic in handlers/chat.go.
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
		ID       string `json:"id"`
		Type     string `json:"type"`
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

// convertToolDefs converts tools.ToolDef to ai.Tool.
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
