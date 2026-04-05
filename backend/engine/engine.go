package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"github.com/ahvholding/ahvclaw/ai"
	"github.com/ahvholding/ahvclaw/tools"
	"github.com/google/uuid"
)

// ChatConfig holds all parameters for a unified AI chat processing loop.
type ChatConfig struct {
	AIRouter         *ai.RouterClient
	Model            string
	FallbackModels   string // comma-separated
	Messages         []ai.ChatMessage
	Tools            []ai.Tool
	Executor         *tools.Executor
	MaxToolRounds    int // default 10
	MaxContextTokens int // default 8000

	// Connection-pool fields (optional)
	APIFormat    string    // e.g. "openai" or "anthropic"; defaults to "openai"
	ConnectionID uuid.UUID // non-nil when using a user connection (for health tracking)

	// Real-time callbacks (all optional)
	OnDelta      func(content string)
	OnToolCall   func(name string, args string)
	OnToolResult func(name string, content string, errStr string)
	OnDone       func(tokensIn int, tokensOut int)
	OnError      func(err error)
}

// ChatResult holds the output of a ProcessChat invocation.
type ChatResult struct {
	Content   string
	TokensIn  int
	TokensOut int
	Model     string
	Messages  []ai.ChatMessage // Updated history including new messages
}

// toolCall is an internal struct for parsed tool calls.
type toolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	} `json:"function"`
}

const maxToolResultChars = 8000

// ProcessChat runs the unified AI chat loop with tool execution, context
// trimming, and retry/fallback logic. It streams responses via callbacks and
// returns the final result.
func ProcessChat(ctx context.Context, cfg ChatConfig) (*ChatResult, error) {
	// Set defaults.
	if cfg.MaxToolRounds <= 0 {
		cfg.MaxToolRounds = 10
	}
	if cfg.MaxContextTokens <= 0 {
		cfg.MaxContextTokens = DefaultMaxTokens
	}

	// Build retry config from FallbackModels.
	retryCfg := DefaultRetryConfig()
	if cfg.FallbackModels != "" {
		for _, m := range strings.Split(cfg.FallbackModels, ",") {
			m = strings.TrimSpace(m)
			if m != "" {
				retryCfg.FallbackModels = append(retryCfg.FallbackModels, m)
			}
		}
	}

	messages := cfg.Messages
	model := cfg.Model
	var totalIn, totalOut int

	for round := 0; round < cfg.MaxToolRounds; round++ {
		// Trim history before each AI call.
		messages = TrimHistory(messages, cfg.MaxContextTokens)

		var fullContent strings.Builder
		var accumulatedToolCalls []json.RawMessage
		var finishReason string // kept for logging
		var usageIn, usageOut int

		aiReq := ai.ChatCompletionRequest{
			Model:    model,
			Messages: messages,
			Stream:   true,
			Tools:    cfg.Tools,
		}

		apiFormat := cfg.APIFormat
		if apiFormat == "" {
			apiFormat = "openai"
		}
		err := RetryableStreamChatWithContext(ctx, cfg.AIRouter, apiFormat, aiReq, func(chunk ai.StreamChunk) {
			if len(chunk.Choices) > 0 {
				delta := chunk.Choices[0].Delta
				if delta.Content != "" {
					fullContent.WriteString(delta.Content)
					if cfg.OnDelta != nil {
						cfg.OnDelta(delta.Content)
					}
				}
				if delta.ToolCalls != nil {
					accumulatedToolCalls = append(accumulatedToolCalls, delta.ToolCalls)
				}
				if chunk.Choices[0].FinishReason != nil {
					finishReason = *chunk.Choices[0].FinishReason
				}
			}
			if chunk.Usage != nil {
				usageIn = chunk.Usage.PromptTokens
				usageOut = chunk.Usage.CompletionTokens
			}
		}, retryCfg)

		if err != nil {
			if cfg.OnError != nil {
				cfg.OnError(err)
			}
			return nil, fmt.Errorf("AI stream error on round %d: %w", round+1, err)
		}

		totalIn += usageIn
		totalOut += usageOut

		// Check if we have tool calls — process them regardless of finish_reason.
		// Some providers (9Router) don't set finish_reason to "tool_calls".
		hasToolCalls := len(accumulatedToolCalls) > 0
		_ = finishReason // used by logging below
		if !hasToolCalls {
			content := SanitizeUTF8(fullContent.String())

			// Strip <thinking> tags before checking if response is truly empty
			_, strippedContent := ParseThinking(content)
			if strippedContent != "" {
				content = strippedContent
			}

			// Guard: truly empty response (even after stripping thinking). Retry max once.
			if content == "" && round == 0 {
				log.Printf("[engine] WARNING: empty response on round %d, retrying once", round+1)
				messages = append(messages, ai.ChatMessage{
					Role:    "assistant",
					Content: "",
				})
				messages = append(messages, ai.ChatMessage{
					Role:    "user",
					Content: "Your previous response was empty. Please provide your answer directly without using <thinking> tags.",
				})
				continue
			}

			// Add assistant message to history.
			messages = append(messages, ai.ChatMessage{
				Role:    "assistant",
				Content: content,
			})

			if cfg.OnDone != nil {
				cfg.OnDone(totalIn, totalOut)
			}

			return &ChatResult{
				Content:   content,
				TokensIn:  totalIn,
				TokensOut: totalOut,
				Model:     model,
				Messages:  messages,
			}, nil
		}

		// Process tool calls.
		log.Printf("[engine] round %d: AI requested tool calls, processing...", round+1)
		mergedToolCallsJSON := mergeToolCallDeltas(accumulatedToolCalls)

		var toolCalls []toolCall
		if err := json.Unmarshal(mergedToolCallsJSON, &toolCalls); err != nil {
			return nil, fmt.Errorf("failed to parse tool calls: %w", err)
		}

		// Add assistant message with tool calls to history.
		assistantContent := fullContent.String()
		messages = append(messages, ai.ChatMessage{
			Role:      "assistant",
			Content:   assistantContent,
			ToolCalls: mergedToolCallsJSON,
		})

		// Execute each tool call.
		for _, tc := range toolCalls {
			log.Printf("[engine] executing tool: %s", tc.Function.Name)

			if cfg.OnToolCall != nil {
				cfg.OnToolCall(tc.Function.Name, string(tc.Function.Arguments))
			}

			result := cfg.Executor.Execute(tc.Function.Name, tc.Function.Arguments)

			toolContent := result.Content
			errStr := result.Error
			if errStr != "" {
				toolContent = "Error: " + errStr
			}

			// Truncate long tool results.
			if len(toolContent) > maxToolResultChars {
				toolContent = toolContent[:maxToolResultChars] + "\n...(truncated)"
			}
			toolContent = SanitizeUTF8(toolContent)

			if cfg.OnToolResult != nil {
				cfg.OnToolResult(tc.Function.Name, toolContent, errStr)
			}

			messages = append(messages, ai.ChatMessage{
				Role:       "tool",
				Content:    toolContent,
				ToolCallID: tc.ID,
			})
		}
	}

	// Exhausted all tool rounds without a final response.
	return nil, fmt.Errorf("exceeded maximum tool rounds (%d)", cfg.MaxToolRounds)
}

// SanitizeUTF8 removes Unicode replacement characters from a string.
func SanitizeUTF8(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r != 0xFFFD {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// mergeToolCallDeltas merges streaming tool call delta chunks into a single
// complete JSON array of tool calls.
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
