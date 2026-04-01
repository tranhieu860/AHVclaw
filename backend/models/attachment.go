package models

import (
	"time"

	"github.com/google/uuid"
)

// Attachment represents an uploaded file
type Attachment struct {
	ID            uuid.UUID `json:"id"`
	UserID        uuid.UUID `json:"user_id"`
	Filename      string    `json:"filename"`
	OriginalName  string    `json:"original_name"`
	MimeType      string    `json:"mime_type"`
	FileSize      int64     `json:"file_size"`
	StoragePath   string    `json:"-"`
	ExtractedText *string   `json:"extracted_text,omitempty"`
	Width         *int      `json:"width,omitempty"`
	Height        *int      `json:"height,omitempty"`
	URL           string    `json:"url"`
	CreatedAt     time.Time `json:"created_at"`
}
