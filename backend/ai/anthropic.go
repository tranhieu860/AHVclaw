package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Anthropic request/response types
type AnthropicRequest struct {
	Model       string          `json:"model"`
	MaxTokens   int             `json:"max_tokens"`
	System      string          `json:"system,omitempty"`
	Messages    []AnthropicMsg  `json:"messages"`
	Tools       []AnthropicTool `json:"tools,omitempty"`
	Stream      bool            `json:"stream"`
	Temperature *float64        `json:"temperature,omitempty"`
}

type AnthropicMsg struct {
	Role    string      `json:"role"`
	Content interface{} `json:"content"`
}

type AnthropicTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"input_schema"`
}

type AnthropicStreamEvent struct {
	Type  string          `json:"type"`
	Index int             `json:"index,omitempty"`
	Delta json.RawMessage `json:"delta,omitempty"`
}

type AnthropicDelta struct {
	Type        string `json:"type"`
	Text        string `json:"text,omitempty"`
	PartialJSON string `json:"partial_json,omitempty"`
}

type AnthropicUsage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

type AnthropicMessageDelta struct {
	StopReason string          `json:"stop_reason,omitempty"`
	Usage      *AnthropicUsage `json:"usage,omitempty"`
}

// toAnthropicMessages converts OpenAI-style ChatMessages to Anthropic format.
// System messages are extracted and returned separately.
func toAnthropicMessages(msgs []ChatMessage) (string, []AnthropicMsg) {
	var systemParts []string
	var out []AnthropicMsg

	for _, m := range msgs {
		if m.Role == "system" {
			if s, ok := m.Content.(string); ok && s != "" {
				systemParts = append(systemParts, s)
			}
			continue
		}
		// Anthropic only accepts "user" and "assistant" roles
		role := m.Role
		if role == "tool" {
			role = "user"
			// Wrap tool result for Anthropic format
			tcID := m.ToolCallID
			if tcID == "" {
				tcID = "unknown"
			}
			out = append(out, AnthropicMsg{
				Role: role,
				Content: []map[string]interface{}{
					{"type": "tool_result", "tool_use_id": tcID, "content": m.Content},
				},
			})
			continue
		}
		if role != "user" && role != "assistant" {
			continue
		}
		out = append(out, AnthropicMsg{
			Role:    role,
			Content: m.Content,
		})
	}
	return strings.Join(systemParts, "\n\n"), out
}

// toAnthropicTools converts OpenAI-style tools to Anthropic format.
func toAnthropicTools(tools []Tool) []AnthropicTool {
	if len(tools) == 0 {
		return nil
	}
	var out []AnthropicTool
	for _, t := range tools {
		if t.Function.Name == "" {
			continue
		}
		schema := t.Function.Parameters
		if schema == nil {
			schema = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		out = append(out, AnthropicTool{
			Name:        t.Function.Name,
			Description: t.Function.Description,
			InputSchema: schema,
		})
	}
	return out
}

// StreamAnthropicChat streams a chat completion using the Anthropic Messages API
// and converts events to OpenAI StreamChunk format for engine compatibility.
func (r *RouterClient) StreamAnthropicChat(ctx context.Context, req ChatCompletionRequest, onChunk func(StreamChunk)) error {
	system, msgs := toAnthropicMessages(req.Messages)

	maxTokens := 4096
	if req.MaxTokens != nil && *req.MaxTokens > 0 {
		maxTokens = *req.MaxTokens
	}

	areq := AnthropicRequest{
		Model:       req.Model,
		MaxTokens:   maxTokens,
		System:      system,
		Messages:    msgs,
		Tools:       toAnthropicTools(req.Tools),
		Stream:      true,
		Temperature: req.Temperature,
	}

	body, err := json.Marshal(areq)
	if err != nil {
		return fmt.Errorf("marshal anthropic request: %w", err)
	}

	url := strings.TrimRight(r.BaseURL, "/") + "/v1/messages"
	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create anthropic request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("anthropic-version", "2023-06-01")
	httpReq.Header.Set("x-api-key", r.APIKey)
	httpReq.Header.Set("Authorization", "Bearer "+r.APIKey)

	resp, err := r.Client.Do(httpReq)
	if err != nil {
		return fmt.Errorf("anthropic request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("anthropic error %d: %s", resp.StatusCode, string(respBody))
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 256*1024), 256*1024)

	// Track tool_use blocks being built
	type toolBlock struct {
		ID    string
		Name  string
		Input strings.Builder
	}
	var activeTools = make(map[int]*toolBlock)

	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")
		if data == "[DONE]" {
			break
		}

		var event AnthropicStreamEvent
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			continue
		}

		switch event.Type {
		case "content_block_start":
			// Parse the content_block field to detect tool_use blocks
			var blockStart struct {
				ContentBlock struct {
					Type  string `json:"type"`
					ID    string `json:"id"`
					Name  string `json:"name"`
					Text  string `json:"text"`
				} `json:"content_block"`
			}
			// event.Delta may actually be the raw event, re-parse from data
			if json.Unmarshal([]byte(data), &blockStart) == nil && blockStart.ContentBlock.Type == "tool_use" {
				activeTools[event.Index] = &toolBlock{
					ID:   blockStart.ContentBlock.ID,
					Name: blockStart.ContentBlock.Name,
				}
			}

		case "content_block_delta":
			var delta AnthropicDelta
			if err := json.Unmarshal(event.Delta, &delta); err != nil {
				continue
			}
			if delta.Type == "input_json_delta" && delta.PartialJSON != "" {
				// Accumulate tool input JSON
				if tb, ok := activeTools[event.Index]; ok {
					tb.Input.WriteString(delta.PartialJSON)
				}
			} else {
				text := delta.Text
				if text != "" {
					chunk := StreamChunk{}
					chunk.Choices = append(chunk.Choices, struct {
						Delta struct {
							Content   string          `json:"content,omitempty"`
							ToolCalls json.RawMessage `json:"tool_calls,omitempty"`
							Role      string          `json:"role,omitempty"`
						} `json:"delta"`
						FinishReason *string `json:"finish_reason"`
					}{})
					chunk.Choices[0].Delta.Content = text
					onChunk(chunk)
				}
			}

		case "content_block_stop":
			// If this was a tool_use block, emit it as an OpenAI-format tool call
			if tb, ok := activeTools[event.Index]; ok {
				toolCall := []map[string]interface{}{
					{
						"index": event.Index,
						"id":    tb.ID,
						"type":  "function",
						"function": map[string]string{
							"name":      tb.Name,
							"arguments": tb.Input.String(),
						},
					},
				}
				tcJSON, _ := json.Marshal(toolCall)
				chunk := StreamChunk{}
				chunk.Choices = append(chunk.Choices, struct {
					Delta struct {
						Content   string          `json:"content,omitempty"`
						ToolCalls json.RawMessage `json:"tool_calls,omitempty"`
						Role      string          `json:"role,omitempty"`
					} `json:"delta"`
					FinishReason *string `json:"finish_reason"`
				}{})
				chunk.Choices[0].Delta.ToolCalls = tcJSON
				onChunk(chunk)
				delete(activeTools, event.Index)
			}

		case "message_delta":
			var md AnthropicMessageDelta
			if err := json.Unmarshal(event.Delta, &md); err != nil {
				continue
			}
			if md.StopReason != "" {
				reason := "stop"
				if md.StopReason == "tool_use" {
					reason = "tool_calls"
				}
				chunk := StreamChunk{}
				chunk.Choices = append(chunk.Choices, struct {
					Delta struct {
						Content   string          `json:"content,omitempty"`
						ToolCalls json.RawMessage `json:"tool_calls,omitempty"`
						Role      string          `json:"role,omitempty"`
					} `json:"delta"`
					FinishReason *string `json:"finish_reason"`
				}{})
				chunk.Choices[0].FinishReason = &reason
				onChunk(chunk)
			}
		}
	}

	return scanner.Err()
}
