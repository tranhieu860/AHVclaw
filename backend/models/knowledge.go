package models

import (
	"time"

	"github.com/google/uuid"
)

type KnowledgeBase struct {
	ID          uuid.UUID `json:"id"`
	UserID      uuid.UUID `json:"user_id"`
	Name        string    `json:"name"`
	Description *string   `json:"description"`
	CreatedAt   time.Time `json:"created_at"`
}

type Document struct {
	ID          uuid.UUID `json:"id"`
	KbID        uuid.UUID `json:"kb_id"`
	Filename    string    `json:"filename"`
	ContentHash *string   `json:"content_hash"`
	FileSize    *int64    `json:"file_size"`
	ChunksCount int       `json:"chunks_count"`
	CreatedAt   time.Time `json:"created_at"`
}

type Skill struct {
	ID            uuid.UUID  `json:"id"`
	Name          string     `json:"name"`
	Slug          string     `json:"slug"`
	Description   *string    `json:"description"`
	Version       string     `json:"version"`
	AuthorID      *uuid.UUID `json:"author_id"`
	Config        string     `json:"config"`
	IsPublic      bool       `json:"is_public"`
	InstallsCount int        `json:"installs_count"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

type Agent struct {
	ID           uuid.UUID `json:"id"`
	UserID       uuid.UUID `json:"user_id"`
	Name         string    `json:"name"`
	AvatarURL    *string   `json:"avatar_url"`
	Model        string    `json:"model"`
	SystemPrompt string    `json:"system_prompt"`
	MemoryScope  string    `json:"memory_scope"`
	IsPublic     bool      `json:"is_public"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type KBCreateRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

type DocumentCreateRequest struct {
	Filename string `json:"filename"`
	Content  string `json:"content"`
}

type KBSearchRequest struct {
	Query string `json:"query"`
	Limit int    `json:"limit"`
}

type SkillCreateRequest struct {
	Name        string `json:"name"`
	Slug        string `json:"slug"`
	Description string `json:"description"`
	Config      string `json:"config"`
	IsPublic    bool   `json:"is_public"`
}

type AgentCreateRequest struct {
	Name         string `json:"name"`
	Model        string `json:"model"`
	SystemPrompt string `json:"system_prompt"`
	MemoryScope  string `json:"memory_scope"`
	IsPublic     bool   `json:"is_public"`
}
