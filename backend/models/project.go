package models

import (
	"time"

	"github.com/google/uuid"
)

type Project struct {
	ID          uuid.UUID  `json:"id"`
	UserID      uuid.UUID  `json:"user_id"`
	Name        string     `json:"name"`
	Description *string    `json:"description"`
	Instructions *string   `json:"instructions"`
	Icon        string     `json:"icon"`
	IsArchived  bool       `json:"is_archived"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

type ProjectFile struct {
	ID        uuid.UUID `json:"id"`
	ProjectID uuid.UUID `json:"project_id"`
	Filename  string    `json:"filename"`
	Content   *string   `json:"content,omitempty"`
	FilePath  *string   `json:"file_path,omitempty"`
	FileSize  int64     `json:"file_size"`
	MimeType  string    `json:"mime_type"`
	CreatedAt time.Time `json:"created_at"`
}

type CreateProjectRequest struct {
	Name         string  `json:"name"`
	Description  *string `json:"description"`
	Instructions *string `json:"instructions"`
	Icon         string  `json:"icon"`
}

type UpdateProjectRequest struct {
	Name         *string `json:"name"`
	Description  *string `json:"description"`
	Instructions *string `json:"instructions"`
	Icon         *string `json:"icon"`
	IsArchived   *bool   `json:"is_archived"`
}
