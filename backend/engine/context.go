package engine

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/ahvholding/ahvclaw/ai"
)

const (
	DefaultMaxTokens        = 8000
	MaxSingleMessageTokens  = 2000
	TokensPerChar           = 0.4
)

// EstimateTokens returns a rough token count for the given string.
func EstimateTokens(s string) int {
	return int(float64(utf8.RuneCountInString(s)) * TokensPerChar)
}

// TruncateToTokens truncates a string to approximately maxTokens worth of characters
// and appends a truncation indicator.
func TruncateToTokens(s string, maxTokens int) string {
	maxChars := int(float64(maxTokens) / TokensPerChar)
	runes := []rune(s)
	if len(runes) <= maxChars {
		return s
	}
	return string(runes[:maxChars]) + "\n...(truncated)"
}

// messageContent extracts text content from a ChatMessage's Content field,
// which may be a plain string or a multimodal []interface{} slice.
func messageContent(m ai.ChatMessage) string {
	if m.Content == nil {
		return ""
	}
	switch v := m.Content.(type) {
	case string:
		return v
	case []interface{}:
		var parts []string
		for _, item := range v {
			if m, ok := item.(map[string]interface{}); ok {
				if text, ok := m["text"].(string); ok {
					parts = append(parts, text)
				}
			}
		}
		return strings.Join(parts, " ")
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return ""
		}
		return string(b)
	}
}

// messageTokens returns the estimated token count for a single message.
func messageTokens(m ai.ChatMessage) int {
	tokens := EstimateTokens(messageContent(m))
	if len(m.ToolCalls) > 0 {
		tokens += EstimateTokens(string(m.ToolCalls))
	}
	return tokens
}

// toolCallIDs extracts all tool call IDs from an assistant message's ToolCalls field.
func toolCallIDs(m ai.ChatMessage) []string {
	if len(m.ToolCalls) == 0 {
		return nil
	}
	var calls []struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(m.ToolCalls, &calls); err != nil {
		return nil
	}
	ids := make([]string, 0, len(calls))
	for _, c := range calls {
		if c.ID != "" {
			ids = append(ids, c.ID)
		}
	}
	return ids
}

// TrimHistory trims conversation history to fit within maxTokens while preserving
// message coherence. It always keeps the system prompt (index 0) and the last user
// message. Tool call/result pairs are kept together to avoid orphaned references.
func TrimHistory(messages []ai.ChatMessage, maxTokens int) []ai.ChatMessage {
	if len(messages) == 0 {
		return messages
	}

	// First pass: truncate individual messages that exceed MaxSingleMessageTokens.
	// Skip the system message at index 0.
	for i := 1; i < len(messages); i++ {
		content := messageContent(messages[i])
		if EstimateTokens(content) > MaxSingleMessageTokens {
			truncated := TruncateToTokens(content, MaxSingleMessageTokens)
			messages[i].Content = truncated
		}
	}

	// Calculate total tokens after truncation.
	total := 0
	for _, m := range messages {
		total += messageTokens(m)
	}
	if total <= maxTokens {
		return messages
	}

	// We must trim. Always keep:
	// - system prompt at index 0
	// - last user message
	system := messages[0]
	systemTokens := messageTokens(system)

	// Find the last user message.
	lastUserIdx := -1
	for i := len(messages) - 1; i >= 1; i-- {
		if messages[i].Role == "user" {
			lastUserIdx = i
			break
		}
	}
	if lastUserIdx == -1 {
		// No user message found; just return system + everything that fits.
		lastUserIdx = len(messages) - 1
	}

	lastUser := messages[lastUserIdx]
	lastUserTokens := messageTokens(lastUser)

	budget := maxTokens - systemTokens - lastUserTokens
	if budget < 0 {
		// Even system + last user exceed budget; return just those two.
		return []ai.ChatMessage{system, lastUser}
	}

	// Build kept set from newest to oldest (excluding system and last user).
	// Indices 1..lastUserIdx-1, then lastUserIdx+1..len-1
	candidates := make([]int, 0, len(messages)-2)
	for i := 1; i < len(messages); i++ {
		if i == lastUserIdx {
			continue
		}
		candidates = append(candidates, i)
	}

	// Process from newest to oldest.
	kept := make(map[int]bool)
	keptToolResultIDs := make(map[string]bool) // tool_call_ids of kept tool results
	used := 0

	for i := len(candidates) - 1; i >= 0; i-- {
		idx := candidates[i]
		m := messages[idx]
		cost := messageTokens(m)

		if m.Role == "tool" {
			// Tool result message.
			if used+cost <= budget {
				kept[idx] = true
				used += cost
				if m.ToolCallID != "" {
					keptToolResultIDs[m.ToolCallID] = true
				}
			}
		} else if m.Role == "assistant" && len(m.ToolCalls) > 0 {
			// Assistant message with tool calls: only keep if ALL corresponding
			// tool results are also kept.
			ids := toolCallIDs(m)
			allKept := true
			for _, id := range ids {
				if !keptToolResultIDs[id] {
					allKept = false
					break
				}
			}
			if allKept && used+cost <= budget {
				kept[idx] = true
				used += cost
			} else if !allKept {
				// Remove any tool results whose assistant is being dropped,
				// to avoid orphaned tool results.
				for _, id := range ids {
					// Find and remove the tool result if it was kept.
					for j := range candidates {
						ci := candidates[j]
						if kept[ci] && messages[ci].Role == "tool" && messages[ci].ToolCallID == id {
							delete(kept, ci)
							used -= messageTokens(messages[ci])
							delete(keptToolResultIDs, id)
						}
					}
				}
			}
		} else {
			// Regular user/assistant message.
			if used+cost <= budget {
				kept[idx] = true
				used += cost
			}
		}
	}

	// Reconstruct in original order: system, kept messages, last user.
	result := []ai.ChatMessage{system}
	for _, idx := range candidates {
		if kept[idx] {
			result = append(result, messages[idx])
		}
	}
	result = append(result, lastUser)

	return result
}
