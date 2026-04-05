package autonomous

import (
	"context"
	"encoding/json"
	"log"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/google/uuid"
)

// AuditEntry contains all fields for a comprehensive autonomous action audit log.
type AuditEntry struct {
	UserID         uuid.UUID  `json:"user_id"`
	HeartbeatRunID *uuid.UUID `json:"heartbeat_run_id,omitempty"`
	AgentID        *uuid.UUID `json:"agent_id,omitempty"`
	GoalID         *uuid.UUID `json:"goal_id,omitempty"`
	PlanStepID     *uuid.UUID `json:"plan_step_id,omitempty"`
	ActionType     string     `json:"action_type"`
	ActionPattern  string     `json:"action_pattern"`
	ToolID         string     `json:"tool_id"`
	Description    string     `json:"description"`
	TrustScore     int        `json:"trust_score"`
	Status         string     `json:"status"`
	SandboxID      string     `json:"sandbox_id,omitempty"`
	ApprovalSource string     `json:"approval_source,omitempty"`
	LatencyMs      int        `json:"latency_ms"`
	ExitStatus     int        `json:"exit_status"`
	Result         string     `json:"result,omitempty"`
	Error          string     `json:"error,omitempty"`
	Artifacts      []byte     `json:"artifacts,omitempty"`
}

// LogAutonomousAction records a comprehensive audit entry for an autonomous action.
func LogAutonomousAction(ctx context.Context, params AuditEntry) {
	// Default artifacts to empty JSON array if nil
	artifacts := params.Artifacts
	if artifacts == nil {
		artifacts, _ = json.Marshal([]interface{}{})
	}

	// Convert empty strings to nil for nullable fields
	var result, errMsg *string
	if params.Result != "" {
		result = &params.Result
	}
	if params.Error != "" {
		errMsg = &params.Error
	}

	_, err := db.Pool.Exec(ctx,
		`INSERT INTO autonomous_actions
		 (id, user_id, heartbeat_run_id, agent_id, goal_id, plan_step_id,
		  action_type, action_pattern, tool_id, description,
		  trust_score_at_time, status, sandbox_id, approval_source,
		  latency_ms, exit_status, result, error, artifacts, created_at)
		 VALUES (gen_random_uuid(), , , , , , , , , ,
		         0, 1, 2, 3, 4, 5, 6, 7, 8, now())`,
		params.UserID, params.HeartbeatRunID, params.AgentID, params.GoalID,
		params.PlanStepID, params.ActionType, params.ActionPattern, params.ToolID,
		params.Description, params.TrustScore, params.Status, params.SandboxID,
		params.ApprovalSource, params.LatencyMs, params.ExitStatus, result,
		errMsg, artifacts)
	if err != nil {
		log.Printf("[audit] failed to log autonomous action: %v", err)
	}
}
