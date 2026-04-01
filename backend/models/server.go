package models

import (
	"time"

	"github.com/google/uuid"
)

type Server struct {
	ID              uuid.UUID  `json:"id"`
	UserID          uuid.UUID  `json:"user_id"`
	Name            string     `json:"name"`
	Host            string     `json:"host"`
	Port            int        `json:"port"`
	Username        string     `json:"username"`
	AuthType        string     `json:"auth_type"`
	Environment     string     `json:"environment"`
	Tags            []string   `json:"tags"`
	LastConnectedAt *time.Time `json:"last_connected_at"`
	CreatedAt       time.Time  `json:"created_at"`
}

type ServerCreateRequest struct {
	Name        string   `json:"name"`
	Host        string   `json:"host"`
	Port        int      `json:"port"`
	Username    string   `json:"username"`
	AuthType    string   `json:"auth_type"`
	Credentials string   `json:"credentials"`
	Environment string   `json:"environment"`
	Tags        []string `json:"tags"`
}

type ServerExecRequest struct {
	Command string `json:"command"`
}

type ServerExecResponse struct {
	Output   string `json:"output"`
	ExitCode int    `json:"exit_code"`
}
