package models

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// ModelProvider represents a custom AI model provider
type ModelProvider struct {
	ID              uuid.UUID        `json:"id"`
	UserID          uuid.UUID        `json:"user_id"`
	Name            string           `json:"name"`
	APIURL          string           `json:"api_url"`
	APIKeyEncrypted string           `json:"-"`
	Models          *json.RawMessage `json:"models"`
	IsActive        bool             `json:"is_active"`
	CreatedAt       time.Time        `json:"created_at"`
	UpdatedAt       time.Time        `json:"updated_at"`
}

type ProviderCreateRequest struct {
	Name   string           `json:"name"`
	APIURL string           `json:"api_url"`
	APIKey string           `json:"api_key"`
	Models *json.RawMessage `json:"models"`
}

type ProviderUpdateRequest struct {
	Name     *string          `json:"name"`
	APIURL   *string          `json:"api_url"`
	APIKey   *string          `json:"api_key"`
	Models   *json.RawMessage `json:"models"`
	IsActive *bool            `json:"is_active"`
}
