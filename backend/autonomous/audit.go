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

// AuditLog is the global audit logging function that can be called from any package.
// It inserts a comprehensive audit entry into autonomous_actions with all 18 fields.
func AuditLog(ctx context.Context, entry AuditEntry) error {
	// Default artifacts to empty JSON array if nil
	artifacts := entry.Artifacts
	if artifacts == nil {
		artifacts, _ = json.Marshal([]interface{}{})
	}

	// Convert empty strings to nil for nullable fields
	var result, errMsg *string
	if entry.Result != "" {
		r := entry.Result
		result = &r
	}
	if entry.Error != "" {
		e := entry.Error
		errMsg = &e
	}

	_, err := db.Pool.Exec(ctx,
		`INSERT INTO autonomous_actions
		 (id, user_id, heartbeat_run_id, agent_id, goal_id, plan_step_id,
		  action_type, action_pattern, tool_id, description,
		  trust_score_at_time, status, sandbox_id, approval_source,
		  latency_ms, exit_status, result, error, artifacts, created_at)
		 VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9,
		         $10, $11, $12, $13, $14, $15, $16, $17, $18, now())`,
		entry.UserID, entry.HeartbeatRunID, entry.AgentID, entry.GoalID,
		entry.PlanStepID, entry.ActionType, entry.ActionPattern, entry.ToolID,
		entry.Description, entry.TrustScore, entry.Status, entry.SandboxID,
		entry.ApprovalSource, entry.LatencyMs, entry.ExitStatus, result,
		errMsg, artifacts)
	if err != nil {
		log.Printf("[audit] failed to log action: %v", err)
		return err
	}
	return nil
}

// LogAutonomousAction records a comprehensive audit entry for an autonomous action.
// Kept for backward compatibility; delegates to AuditLog.
func LogAutonomousAction(ctx context.Context, params AuditEntry) {
	AuditLog(ctx, params)
}

// LogTrustDecision logs a trust system decision with score.
func LogTrustDecision(ctx context.Context, userID uuid.UUID, toolName, actionType, decision string, score int) {
	AuditLog(ctx, AuditEntry{
		UserID:      userID,
		ActionType:  "trust_decision",
		ActionPattern: actionType,
		ToolID:      toolName,
		Description: decision + " (score=" + intToStr(score) + ")",
		TrustScore:  score,
		Status:      decision,
	})
}

// LogPlanEvent logs planner lifecycle events (created, advanced, completed, failed).
func LogPlanEvent(ctx context.Context, userID uuid.UUID, goalID *uuid.UUID, planID uuid.UUID, event, description string) {
	pid := planID
	AuditLog(ctx, AuditEntry{
		UserID:      userID,
		GoalID:      goalID,
		PlanStepID:  &pid,
		ActionType:  event,
		ActionPattern: "planner",
		ToolID:      "planner",
		Description: description,
		Status:      "logged",
	})
}

func intToStr(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	neg := false
	if n < 0 {
		neg = true
		n = -n
	}
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	if neg {
		s = "-" + s
	}
	return s
}
