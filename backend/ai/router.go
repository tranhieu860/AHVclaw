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
	"time"
)

type AIError struct {
	StatusCode int
	Message    string
	Retryable  bool
}

func (e *AIError) Error() string {
	return fmt.Sprintf("AI error %d: %s", e.StatusCode, e.Message)
}

type RouterClient struct {
	BaseURL string
	APIKey  string
	Client  *http.Client
}

func NewRouterClient(baseURL, apiKey string) *RouterClient {
	return &RouterClient{
		BaseURL: baseURL,
		APIKey:  apiKey,
		Client:  &http.Client{Timeout: 120 * time.Second},
	}
}

type ChatMessage struct {
	Role       string          `json:"role"`
	Content    interface{}     `json:"content"`
	ToolCalls  json.RawMessage `json:"tool_calls,omitempty"`
	ToolCallID string          `json:"tool_call_id,omitempty"`
}

type ChatCompletionRequest struct {
	Model       string        `json:"model"`
	Messages    []ChatMessage `json:"messages"`
	Stream      bool          `json:"stream"`
	Tools       []Tool        `json:"tools,omitempty"`
	Temperature *float64      `json:"temperature,omitempty"`
	MaxTokens   *int          `json:"max_tokens,omitempty"`
}

type Tool struct {
	Type     string       `json:"type"`
	Function ToolFunction `json:"function"`
}

type ToolFunction struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

type StreamChunk struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Choices []struct {
		Delta struct {
			Content   string          `json:"content,omitempty"`
			ToolCalls json.RawMessage `json:"tool_calls,omitempty"`
			Role      string          `json:"role,omitempty"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
}

func (r *RouterClient) StreamChat(req ChatCompletionRequest, onChunk func(StreamChunk)) error {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	return r.StreamChatWithContext(ctx, req, onChunk)
}

func (r *RouterClient) StreamChatWithContext(ctx context.Context, req ChatCompletionRequest, onChunk func(StreamChunk)) error {
	req.Stream = true
	body, err := json.Marshal(req)
	if err != nil {
		return err
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", r.BaseURL+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if r.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+r.APIKey)
	}

	resp, err := r.Client.Do(httpReq)
	if err != nil {
		if ctx.Err() != nil {
			return &AIError{StatusCode: 0, Message: "timeout", Retryable: true}
		}
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(resp.Body)
		return &AIError{
			StatusCode: resp.StatusCode,
			Message:    string(respBody),
			Retryable:  resp.StatusCode == 429 || resp.StatusCode >= 500,
		}
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 256*1024), 256*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")
		if data == "[DONE]" {
			break
		}
		var chunk StreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		onChunk(chunk)
	}
	if err := scanner.Err(); err != nil {
		return &AIError{StatusCode: 0, Message: err.Error(), Retryable: true}
	}
	return nil
}

func (r *RouterClient) ListModels() (json.RawMessage, error) {
	req, err := http.NewRequest("GET", r.BaseURL+"/v1/models", nil)
	if err != nil {
		return nil, err
	}
	if r.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+r.APIKey)
	}
	resp, err := r.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	return body, err
}

// StreamWithFormat dispatches to the correct streaming client based on API format.
func (r *RouterClient) StreamWithFormat(ctx context.Context, format string, req ChatCompletionRequest, onChunk func(StreamChunk)) error {
	if format == "anthropic" {
		return r.StreamAnthropicChat(ctx, req, onChunk)
	}
	return r.StreamChatWithContext(ctx, req, onChunk)
}
