package models

import (
	"time"

	"github.com/google/uuid"
)

type ScheduledTask struct {
	ID              uuid.UUID  `json:"id"`
	UserID          uuid.UUID  `json:"user_id"`
	AgentID         *uuid.UUID `json:"agent_id"`
	Name            string     `json:"name"`
	Description     *string    `json:"description"`
	Prompt          string     `json:"prompt"`
	Schedule        string     `json:"schedule"`
	ScheduleHuman   *string    `json:"schedule_human"`
	Timezone        string     `json:"timezone"`
	DeliveryChannel string     `json:"delivery_channel"`
	DeliveryChatID  *string    `json:"delivery_chat_id"`
	BotID           *uuid.UUID `json:"bot_id"`
	IsActive        bool       `json:"is_active"`
	LastRunAt       *time.Time `json:"last_run_at"`
	NextRunAt       *time.Time `json:"next_run_at"`
	RunCount        int        `json:"run_count"`
	ErrorCount      int        `json:"error_count"`
	MaxRetries      int        `json:"max_retries"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

type TaskRun struct {
	ID         uuid.UUID  `json:"id"`
	TaskID     uuid.UUID  `json:"task_id"`
	Status     string     `json:"status"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
	Result     *string    `json:"result"`
	Error      *string    `json:"error"`
	TokensIn   int        `json:"tokens_in"`
	TokensOut  int        `json:"tokens_out"`
	ToolsUsed  string     `json:"tools_used"`
	CreatedAt  time.Time  `json:"created_at"`
}

type TaskCreateRequest struct {
	AgentID         *uuid.UUID `json:"agent_id"`
	Name            string     `json:"name" validate:"required"`
	Description     *string    `json:"description"`
	Prompt          string     `json:"prompt" validate:"required"`
	Schedule        string     `json:"schedule" validate:"required"`
	ScheduleHuman   *string    `json:"schedule_human"`
	Timezone        string     `json:"timezone"`
	DeliveryChannel string     `json:"delivery_channel" validate:"required"`
	DeliveryChatID  *string    `json:"delivery_chat_id"`
	BotID           *uuid.UUID `json:"bot_id"`
	MaxRetries      *int       `json:"max_retries"`
}

type TaskUpdateRequest struct {
	AgentID         *uuid.UUID `json:"agent_id"`
	Name            *string    `json:"name"`
	Description     *string    `json:"description"`
	Prompt          *string    `json:"prompt"`
	Schedule        *string    `json:"schedule"`
	ScheduleHuman   *string    `json:"schedule_human"`
	Timezone        *string    `json:"timezone"`
	DeliveryChannel *string    `json:"delivery_channel"`
	DeliveryChatID  *string    `json:"delivery_chat_id"`
	BotID           *uuid.UUID `json:"bot_id"`
	IsActive        *bool      `json:"is_active"`
	MaxRetries      *int       `json:"max_retries"`
}
