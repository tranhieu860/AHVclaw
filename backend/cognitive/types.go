package cognitive

import (
	"time"

	"github.com/google/uuid"
)

// Source types for the unified embedding index
const (
	SourceMessage    = "message"
	SourceMemory     = "memory"
	SourceReflection = "reflection"
	SourcePattern    = "pattern"
	SourceGoal       = "goal"
	SourceMood       = "mood"
)

// CognitiveEntry is a row in cognitive_embeddings
type CognitiveEntry struct {
	ID             uuid.UUID              `json:"id"`
	UserID         uuid.UUID              `json:"user_id"`
	SourceType     string                 `json:"source_type"`
	SourceID       uuid.UUID              `json:"source_id"`
	ContentHash    string                 `json:"content_hash"`
	ContentPreview string                 `json:"content_preview"`
	Metadata       map[string]interface{} `json:"metadata"`
	CreatedAt      time.Time              `json:"created_at"`
	UpdatedAt      time.Time              `json:"updated_at"`
}

// SearchResult is a retrieval result with similarity score and time weight
type SearchResult struct {
	Entry      CognitiveEntry `json:"entry"`
	Similarity float64        `json:"similarity"`
	TimeWeight float64        `json:"time_weight"`
	FinalScore float64        `json:"final_score"`
}

// SearchOptions configures contextual retrieval
type SearchOptions struct {
	UserID      uuid.UUID
	Query       string
	Limit       int
	SourceTypes []string   // filter by source type, empty = all
	TimeAfter   *time.Time // temporal filter
	TimeBefore  *time.Time
	MinScore       float64    // minimum final_score threshold (default 0.3)
	ConversationID *uuid.UUID // filter messages by conversation (multi-user isolation)
}

// CrossRef is a relationship between two entities
type CrossRef struct {
	ID         uuid.UUID `json:"id"`
	UserID     uuid.UUID `json:"user_id"`
	SourceType string    `json:"source_type"`
	SourceID   uuid.UUID `json:"source_id"`
	TargetType string    `json:"target_type"`
	TargetID   uuid.UUID `json:"target_id"`
	Relation   string    `json:"relation"`
	Strength   float64   `json:"strength"`
	CreatedAt  time.Time `json:"created_at"`
}

// ConsolidationRun logs a consolidation cycle
type ConsolidationRun struct {
	ID               uuid.UUID  `json:"id"`
	UserID           uuid.UUID  `json:"user_id"`
	StartedAt        time.Time  `json:"started_at"`
	FinishedAt       *time.Time `json:"finished_at"`
	EntriesScanned   int        `json:"entries_scanned"`
	DuplicatesMerged int        `json:"duplicates_merged"`
	StalePruned      int        `json:"stale_pruned"`
	NewCrossrefs     int        `json:"new_crossrefs"`
	Summary          string     `json:"summary"`
}
