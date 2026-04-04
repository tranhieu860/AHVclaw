package models

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

type ProviderConnection struct {
	ID           uuid.UUID `json:"id"`
	UserID       uuid.UUID `json:"user_id"`
	ProviderType string    `json:"provider_type"`
	AuthType     string    `json:"auth_type"`
	Name         string    `json:"name"`
	Priority     int       `json:"priority"`
	APIURL       string    `json:"api_url"`
	APIFormat    string    `json:"api_format"`

	APIKeyEncrypted       string `json:"-"`
	AccessTokenEncrypted  string `json:"-"`
	RefreshTokenEncrypted string `json:"-"`

	TokenExpiresAt *time.Time `json:"token_expires_at,omitempty"`

	IsActive     bool       `json:"is_active"`
	TestStatus   string     `json:"test_status"`
	ErrorCode    int        `json:"error_code"`
	LastError    string     `json:"last_error"`
	LastErrorAt  *time.Time `json:"last_error_at,omitempty"`
	BackoffLevel int        `json:"backoff_level"`

	Models       *json.RawMessage `json:"models"`
	ProviderData *json.RawMessage `json:"provider_data,omitempty"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type ModelCombo struct {
	ID       uuid.UUID        `json:"id"`
	UserID   uuid.UUID        `json:"user_id"`
	Name     string           `json:"name"`
	Models   *json.RawMessage `json:"models"`
	Strategy string           `json:"strategy"`
	IsActive bool             `json:"is_active"`
	CreatedAt time.Time       `json:"created_at"`
	UpdatedAt time.Time       `json:"updated_at"`
}

type ConnectionCreateRequest struct {
	ProviderType string           `json:"provider_type"`
	AuthType     string           `json:"auth_type"`
	Name         string           `json:"name"`
	Priority     int              `json:"priority"`
	APIURL       string           `json:"api_url"`
	APIKey       string           `json:"api_key,omitempty"`
	AccessToken  string           `json:"access_token,omitempty"`
	RefreshToken string           `json:"refresh_token,omitempty"`
	Models       *json.RawMessage `json:"models,omitempty"`
}

type ComboCreateRequest struct {
	Name     string           `json:"name"`
	Models   *json.RawMessage `json:"models"`
	Strategy string           `json:"strategy"`
}
