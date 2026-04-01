package models

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// Bot represents a channel bot configuration
type Bot struct {
	ID                   uuid.UUID        `json:"id"`
	UserID               uuid.UUID        `json:"user_id"`
	Name                 string           `json:"name"`
	DefaultAgentID       *uuid.UUID       `json:"default_agent_id"`
	AllowedAgentIDs      []uuid.UUID      `json:"allowed_agent_ids"`
	Channel              string           `json:"channel"`
	ChannelConfig        *json.RawMessage `json:"channel_config"`
	AISettings           *json.RawMessage `json:"ai_settings"`
	ResponseSettings     *json.RawMessage `json:"response_settings"`
	AccessSettings       *json.RawMessage `json:"access_settings"`
	NotificationSettings *json.RawMessage `json:"notification_settings"`
	IsActive             bool             `json:"is_active"`
	Stats                *json.RawMessage `json:"stats"`
	CreatedAt            time.Time        `json:"created_at"`
	UpdatedAt            time.Time        `json:"updated_at"`
}

type BotCreateRequest struct {
	Name                 string           `json:"name"`
	DefaultAgentID       *uuid.UUID       `json:"default_agent_id"`
	AllowedAgentIDs      []uuid.UUID      `json:"allowed_agent_ids"`
	Channel              string           `json:"channel"`
	ChannelConfig        *json.RawMessage `json:"channel_config"`
	AISettings           *json.RawMessage `json:"ai_settings"`
	ResponseSettings     *json.RawMessage `json:"response_settings"`
	AccessSettings       *json.RawMessage `json:"access_settings"`
	NotificationSettings *json.RawMessage `json:"notification_settings"`
}

type BotUpdateRequest struct {
	Name                 *string          `json:"name"`
	DefaultAgentID       *uuid.UUID       `json:"default_agent_id"`
	AllowedAgentIDs      []uuid.UUID      `json:"allowed_agent_ids"`
	Channel              *string          `json:"channel"`
	ChannelConfig        *json.RawMessage `json:"channel_config"`
	AISettings           *json.RawMessage `json:"ai_settings"`
	ResponseSettings     *json.RawMessage `json:"response_settings"`
	AccessSettings       *json.RawMessage `json:"access_settings"`
	NotificationSettings *json.RawMessage `json:"notification_settings"`
	IsActive             *bool            `json:"is_active"`
}

// Contact represents a channel contact
type Contact struct {
	ID          uuid.UUID        `json:"id"`
	UserID      uuid.UUID        `json:"user_id"`
	Name        *string          `json:"name"`
	AvatarURL   *string          `json:"avatar_url"`
	Tags        []string         `json:"tags"`
	Notes       *string          `json:"notes"`
	Metadata    *json.RawMessage `json:"metadata"`
	FirstSeenAt time.Time        `json:"first_seen_at"`
	LastSeenAt  time.Time        `json:"last_seen_at"`
	CreatedAt   time.Time        `json:"created_at"`
	UpdatedAt   time.Time        `json:"updated_at"`
}

// ContactChannel represents a contact's channel identity
type ContactChannel struct {
	ID              uuid.UUID        `json:"id"`
	ContactID       uuid.UUID        `json:"contact_id"`
	Channel         string           `json:"channel"`
	ChannelUserID   string           `json:"channel_user_id"`
	ChannelUsername  *string          `json:"channel_username"`
	Metadata        *json.RawMessage `json:"metadata"`
}

// ContactDetail includes contact with their channels
type ContactDetail struct {
	Contact
	Channels []ContactChannel `json:"channels"`
}

type ContactUpdateRequest struct {
	Name     *string          `json:"name"`
	Tags     []string         `json:"tags"`
	Notes    *string          `json:"notes"`
	Metadata *json.RawMessage `json:"metadata"`
}

type ContactMergeRequest struct {
	SourceID uuid.UUID `json:"source_id"`
	TargetID uuid.UUID `json:"target_id"`
}

// ChannelConversation represents a conversation from a channel bot
type ChannelConversation struct {
	ID             uuid.UUID  `json:"id"`
	BotID          uuid.UUID  `json:"bot_id"`
	ContactID      uuid.UUID  `json:"contact_id"`
	Channel        string     `json:"channel"`
	ChannelChatID  *string    `json:"channel_chat_id"`
	CurrentAgentID *uuid.UUID `json:"current_agent_id"`
	Status         string     `json:"status"`
	TakeoverBy     *uuid.UUID `json:"takeover_by"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

// ChannelMessage represents a message in a channel conversation
type ChannelMessage struct {
	ID               uuid.UUID        `json:"id"`
	ConversationID   uuid.UUID        `json:"conversation_id"`
	Direction        string           `json:"direction"`
	SenderType       string           `json:"sender_type"`
	SenderID         *string          `json:"sender_id"`
	Content          *string          `json:"content"`
	Attachments      *json.RawMessage `json:"attachments"`
	ChannelMessageID *string          `json:"channel_message_id"`
	AgentID          *uuid.UUID       `json:"agent_id"`
	ToolCalls        *json.RawMessage `json:"tool_calls,omitempty"`
	ToolResults      *json.RawMessage `json:"tool_results,omitempty"`
	TokensIn         int              `json:"tokens_in"`
	TokensOut        int              `json:"tokens_out"`
	CreatedAt        time.Time        `json:"created_at"`
}

// InboxReplyRequest is used to reply to a channel conversation
type InboxReplyRequest struct {
	Content     string     `json:"content"`
	Attachments []string   `json:"attachments,omitempty"`
	AgentID     *uuid.UUID `json:"agent_id,omitempty"`
}

// InboxAssignRequest is used to assign an agent to a conversation
type InboxAssignRequest struct {
	AgentID    *uuid.UUID `json:"agent_id"`
	TakeoverBy *uuid.UUID `json:"takeover_by"`
}
