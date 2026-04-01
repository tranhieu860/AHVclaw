package tools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/google/uuid"
)

func (e *Executor) delegateAgent(argsJSON json.RawMessage) *ToolResult {
	var args map[string]interface{}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "delegate_agent", Error: "invalid arguments"}
	}

	agentName := getString(args, "agent_name", "")
	reason := getString(args, "reason", "")

	if agentName == "" {
		return &ToolResult{Name: "delegate_agent", Error: "agent_name is required"}
	}

	ctx := context.Background()
	userID, err := uuid.Parse(e.UserID)
	if err != nil {
		return &ToolResult{Name: "delegate_agent", Error: "invalid user ID"}
	}

	// Look up agent by name for this user
	var agentID uuid.UUID
	var foundName string
	err = db.Pool.QueryRow(ctx,
		"SELECT id, name FROM agents WHERE (user_id = $1 OR is_public = true) AND LOWER(name) = LOWER($2)",
		userID, agentName).Scan(&agentID, &foundName)
	if err != nil {
		return &ToolResult{Name: "delegate_agent", Error: fmt.Sprintf("agent '%s' not found", agentName)}
	}

	// Get the conversation ID from executor context
	convIDStr := getString(args, "conversation_id", "")
	if convIDStr == "" {
		// If no conversation_id in args, return the agent info for the caller to handle
		result := fmt.Sprintf("Delegation requested to agent '%s' (ID: %s).", foundName, agentID.String())
		if reason != "" {
			result += fmt.Sprintf(" Reason: %s", reason)
		}
		return &ToolResult{Name: "delegate_agent", Content: result}
	}

	convID, err := uuid.Parse(convIDStr)
	if err != nil {
		return &ToolResult{Name: "delegate_agent", Error: "invalid conversation_id"}
	}

	// Update channel_conversations.current_agent_id
	_, err = db.Pool.Exec(ctx,
		"UPDATE channel_conversations SET current_agent_id = $1, updated_at = now() WHERE id = $2",
		agentID, convID)
	if err != nil {
		return &ToolResult{Name: "delegate_agent", Error: "failed to update conversation agent: " + err.Error()}
	}

	result := fmt.Sprintf("Successfully delegated conversation to agent '%s' (ID: %s).", foundName, agentID.String())
	if reason != "" {
		result += fmt.Sprintf(" Reason: %s", reason)
	}
	return &ToolResult{Name: "delegate_agent", Content: result}
}
