package models

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

type Conversation struct {
	ID        uuid.UUID  `json:"id"`
	UserID    uuid.UUID  `json:"user_id"`
	Title     *string    `json:"title"`
	Model     *string    `json:"model"`
	AgentID   *uuid.UUID `json:"agent_id"`
	Pinned    bool       `json:"pinned"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	Channel   *string    `json:"channel,omitempty"`
}

type Message struct {
	ID             uuid.UUID        `json:"id"`
	ConversationID uuid.UUID        `json:"conversation_id"`
	Role           string           `json:"role"`
	Content        *string          `json:"content"`
	ToolCalls      *json.RawMessage `json:"tool_calls,omitempty"`
	ToolResults    *json.RawMessage `json:"tool_results,omitempty"`
	TokensIn       int              `json:"tokens_in"`
	TokensOut      int              `json:"tokens_out"`
	Model          *string          `json:"model"`
	CreatedAt      time.Time        `json:"created_at"`
	Source         *string          `json:"source,omitempty"`
}

// WebSocket message types
type WSMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type ChatRequest struct {
	ConversationID *uuid.UUID `json:"conversation_id"`
	Content        string     `json:"content"`
	Model          string     `json:"model"`
	AgentID        *uuid.UUID `json:"agent_id"`
}

type StreamDelta struct {
	Content   string           `json:"content,omitempty"`
	ToolCalls *json.RawMessage `json:"tool_calls,omitempty"`
	Done      bool             `json:"done"`
	TokensIn  int              `json:"tokens_in,omitempty"`
	TokensOut int              `json:"tokens_out,omitempty"`
}
