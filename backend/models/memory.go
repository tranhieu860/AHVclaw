package models

import (
	"time"

	"github.com/google/uuid"
)

type Memory struct {
	ID                   uuid.UUID  `json:"id"`
	UserID               uuid.UUID  `json:"user_id"`
	Type                 string     `json:"type"`
	Key                  string     `json:"key"`
	Content              string     `json:"content"`
	SourceConversationID *uuid.UUID `json:"source_conversation_id,omitempty"`
	CreatedAt            time.Time  `json:"created_at"`
	UpdatedAt            time.Time  `json:"updated_at"`
}

type MemoryCreateRequest struct {
	Type    string `json:"type"`
	Key     string `json:"key"`
	Content string `json:"content"`
}

type MemoryUpdateRequest struct {
	Content string `json:"content"`
}

type MemorySearchRequest struct {
	Query string `json:"query"`
	Type  string `json:"type,omitempty"`
	Limit int    `json:"limit,omitempty"`
}
