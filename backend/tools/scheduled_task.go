package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/scheduler"
	"github.com/google/uuid"
)

type scheduledTaskArgs struct {
	Action          string  `json:"action"`
	Name            *string `json:"name,omitempty"`
	Prompt          *string `json:"prompt,omitempty"`
	Schedule        *string `json:"schedule,omitempty"`
	DeliveryChannel *string `json:"delivery_channel,omitempty"`
	Timezone        *string `json:"timezone,omitempty"`
	TaskID          *string `json:"task_id,omitempty"`
	Description     *string `json:"description,omitempty"`
	AgentID         *string `json:"agent_id,omitempty"`
}

func (e *Executor) manageScheduledTask(argsJSON json.RawMessage) *ToolResult {
	var args scheduledTaskArgs
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "manage_scheduled_task", Error: "invalid arguments: " + err.Error()}
	}

	userID, err := uuid.Parse(e.UserID)
	if err != nil {
		return &ToolResult{Name: "manage_scheduled_task", Error: "invalid user ID"}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	switch args.Action {
	case "create":
		return e.createTask(ctx, userID, args)
	case "list":
		return e.listTasks(ctx, userID)
	case "update":
		return e.updateTask(ctx, userID, args)
	case "delete":
		return e.deleteTask(ctx, userID, args)
	case "pause":
		return e.pauseResumeTask(ctx, userID, args, false)
	case "resume":
		return e.pauseResumeTask(ctx, userID, args, true)
	default:
		return &ToolResult{Name: "manage_scheduled_task", Error: fmt.Sprintf("unknown action: %s. Use create/list/update/delete/pause/resume", args.Action)}
	}
}

func (e *Executor) createTask(ctx context.Context, userID uuid.UUID, args scheduledTaskArgs) *ToolResult {
	if args.Name == nil || *args.Name == "" {
		return &ToolResult{Name: "manage_scheduled_task", Error: "name is required for create"}
	}
	if args.Prompt == nil || *args.Prompt == "" {
		return &ToolResult{Name: "manage_scheduled_task", Error: "prompt is required for create"}
	}
	if args.Schedule == nil || *args.Schedule == "" {
		return &ToolResult{Name: "manage_scheduled_task", Error: "schedule (cron expression) is required for create"}
	}

	if err := scheduler.ValidateSchedule(*args.Schedule); err != nil {
		return &ToolResult{Name: "manage_scheduled_task", Error: "invalid schedule: " + err.Error()}
	}

	tz := "Asia/Ho_Chi_Minh"
	if args.Timezone != nil && *args.Timezone != "" {
		tz = *args.Timezone
	}

	channel := "web"
	if args.DeliveryChannel != nil && *args.DeliveryChannel != "" {
		channel = *args.DeliveryChannel
	}

	nextRun, err := scheduler.NextRunTime(*args.Schedule, tz)
	if err != nil {
		return &ToolResult{Name: "manage_scheduled_task", Error: "failed to calculate next run: " + err.Error()}
	}

	human := scheduler.HumanReadableSchedule(*args.Schedule)

	var agentID *uuid.UUID
	if args.AgentID != nil && *args.AgentID != "" {
		parsed, err := uuid.Parse(*args.AgentID)
		if err == nil {
			agentID = &parsed
		}
	}

	taskID := uuid.New()
	_, err = db.Pool.Exec(ctx,
		"INSERT INTO scheduled_tasks (id, user_id, agent_id, name, description, prompt, schedule, schedule_human, timezone, delivery_channel, next_run_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
		taskID, userID, agentID, *args.Name, args.Description, *args.Prompt,
		*args.Schedule, human, tz, channel, nextRun)
	if err != nil {
		return &ToolResult{Name: "manage_scheduled_task", Error: "failed to create task: " + err.Error()}
	}

	result := map[string]interface{}{
		"id":             taskID.String(),
		"name":           *args.Name,
		"schedule":       *args.Schedule,
		"schedule_human": human,
		"timezone":       tz,
		"next_run_at":    nextRun.Format(time.RFC3339),
		"status":         "created and active",
	}
	out, _ := json.MarshalIndent(result, "", "  ")
	return &ToolResult{Name: "manage_scheduled_task", Content: string(out)}
}

func (e *Executor) listTasks(ctx context.Context, userID uuid.UUID) *ToolResult {
	rows, err := db.Pool.Query(ctx,
		"SELECT id, name, description, schedule, schedule_human, timezone, delivery_channel, is_active, last_run_at, next_run_at, run_count, error_count FROM scheduled_tasks WHERE user_id = $1 ORDER BY created_at DESC", userID)
	if err != nil {
		return &ToolResult{Name: "manage_scheduled_task", Error: "query failed: " + err.Error()}
	}
	defer rows.Close()

	var tasks []map[string]interface{}
	for rows.Next() {
		var (
			id, name, sched, tz, channel string
			desc, human                  *string
			isActive                     bool
			lastRun, nextRun             *time.Time
			runCount, errCount           int
		)
		if err := rows.Scan(&id, &name, &desc, &sched, &human, &tz,
			&channel, &isActive, &lastRun, &nextRun, &runCount, &errCount); err != nil {
			continue
		}
		t := map[string]interface{}{
			"id":          id,
			"name":        name,
			"schedule":    sched,
			"timezone":    tz,
			"channel":     channel,
			"is_active":   isActive,
			"run_count":   runCount,
			"error_count": errCount,
		}
		if desc != nil {
			t["description"] = *desc
		}
		if human != nil {
			t["schedule_human"] = *human
		}
		if lastRun != nil {
			t["last_run_at"] = lastRun.Format(time.RFC3339)
		}
		if nextRun != nil {
			t["next_run_at"] = nextRun.Format(time.RFC3339)
		}
		tasks = append(tasks, t)
	}
	if tasks == nil {
		tasks = []map[string]interface{}{}
	}
	out, _ := json.MarshalIndent(tasks, "", "  ")
	return &ToolResult{Name: "manage_scheduled_task", Content: string(out)}
}

func (e *Executor) updateTask(ctx context.Context, userID uuid.UUID, args scheduledTaskArgs) *ToolResult {
	if args.TaskID == nil || *args.TaskID == "" {
		return &ToolResult{Name: "manage_scheduled_task", Error: "task_id is required for update"}
	}
	taskID, err := uuid.Parse(*args.TaskID)
	if err != nil {
		return &ToolResult{Name: "manage_scheduled_task", Error: "invalid task_id"}
	}

	var ownerID uuid.UUID
	err = db.Pool.QueryRow(ctx, "SELECT user_id FROM scheduled_tasks WHERE id = $1", taskID).Scan(&ownerID)
	if err != nil {
		return &ToolResult{Name: "manage_scheduled_task", Error: "task not found"}
	}
	if ownerID != userID {
		return &ToolResult{Name: "manage_scheduled_task", Error: "access denied"}
	}

	updates := []string{}
	params := []interface{}{}
	idx := 1

	if args.Name != nil {
		updates = append(updates, fmt.Sprintf("name=$%d", idx))
		params = append(params, *args.Name)
		idx++
	}
	if args.Prompt != nil {
		updates = append(updates, fmt.Sprintf("prompt=$%d", idx))
		params = append(params, *args.Prompt)
		idx++
	}
	if args.Description != nil {
		updates = append(updates, fmt.Sprintf("description=$%d", idx))
		params = append(params, *args.Description)
		idx++
	}
	if args.Schedule != nil {
		if err := scheduler.ValidateSchedule(*args.Schedule); err != nil {
			return &ToolResult{Name: "manage_scheduled_task", Error: "invalid schedule: " + err.Error()}
		}
		updates = append(updates, fmt.Sprintf("schedule=$%d", idx))
		params = append(params, *args.Schedule)
		idx++

		human := scheduler.HumanReadableSchedule(*args.Schedule)
		updates = append(updates, fmt.Sprintf("schedule_human=$%d", idx))
		params = append(params, human)
		idx++

		tz := "Asia/Ho_Chi_Minh"
		if args.Timezone != nil {
			tz = *args.Timezone
		}
		nextRun, _ := scheduler.NextRunTime(*args.Schedule, tz)
		updates = append(updates, fmt.Sprintf("next_run_at=$%d", idx))
		params = append(params, nextRun)
		idx++
	}
	if args.Timezone != nil {
		updates = append(updates, fmt.Sprintf("timezone=$%d", idx))
		params = append(params, *args.Timezone)
		idx++
	}
	if args.DeliveryChannel != nil {
		updates = append(updates, fmt.Sprintf("delivery_channel=$%d", idx))
		params = append(params, *args.DeliveryChannel)
		idx++
	}

	if len(updates) == 0 {
		return &ToolResult{Name: "manage_scheduled_task", Error: "no fields to update"}
	}

	updates = append(updates, "updated_at=now()")
	params = append(params, taskID)

	query := fmt.Sprintf("UPDATE scheduled_tasks SET %s WHERE id=$%d",
		joinStrings(updates, ", "), idx)
	_, err = db.Pool.Exec(ctx, query, params...)
	if err != nil {
		return &ToolResult{Name: "manage_scheduled_task", Error: "update failed: " + err.Error()}
	}

	return &ToolResult{Name: "manage_scheduled_task", Content: fmt.Sprintf("Task %s updated successfully", taskID)}
}

func (e *Executor) deleteTask(ctx context.Context, userID uuid.UUID, args scheduledTaskArgs) *ToolResult {
	if args.TaskID == nil || *args.TaskID == "" {
		return &ToolResult{Name: "manage_scheduled_task", Error: "task_id is required for delete"}
	}
	taskID, err := uuid.Parse(*args.TaskID)
	if err != nil {
		return &ToolResult{Name: "manage_scheduled_task", Error: "invalid task_id"}
	}

	result, err := db.Pool.Exec(ctx,
		"DELETE FROM scheduled_tasks WHERE id = $1 AND user_id = $2", taskID, userID)
	if err != nil {
		return &ToolResult{Name: "manage_scheduled_task", Error: "delete failed: " + err.Error()}
	}
	if result.RowsAffected() == 0 {
		return &ToolResult{Name: "manage_scheduled_task", Error: "task not found or access denied"}
	}
	return &ToolResult{Name: "manage_scheduled_task", Content: fmt.Sprintf("Task %s deleted", taskID)}
}

func (e *Executor) pauseResumeTask(ctx context.Context, userID uuid.UUID, args scheduledTaskArgs, activate bool) *ToolResult {
	if args.TaskID == nil || *args.TaskID == "" {
		return &ToolResult{Name: "manage_scheduled_task", Error: "task_id is required"}
	}
	taskID, err := uuid.Parse(*args.TaskID)
	if err != nil {
		return &ToolResult{Name: "manage_scheduled_task", Error: "invalid task_id"}
	}

	action := "paused"
	if activate {
		action = "resumed"
		var sched, tz string
		err := db.Pool.QueryRow(ctx,
			"SELECT schedule, timezone FROM scheduled_tasks WHERE id = $1 AND user_id = $2",
			taskID, userID).Scan(&sched, &tz)
		if err != nil {
			return &ToolResult{Name: "manage_scheduled_task", Error: "task not found or access denied"}
		}
		nextRun, _ := scheduler.NextRunTime(sched, tz)
		_, err = db.Pool.Exec(ctx,
			"UPDATE scheduled_tasks SET is_active=true, error_count=0, next_run_at=$1, updated_at=now() WHERE id=$2 AND user_id=$3",
			nextRun, taskID, userID)
		if err != nil {
			return &ToolResult{Name: "manage_scheduled_task", Error: "resume failed: " + err.Error()}
		}
	} else {
		_, err = db.Pool.Exec(ctx,
			"UPDATE scheduled_tasks SET is_active=false, updated_at=now() WHERE id=$1 AND user_id=$2",
			taskID, userID)
		if err != nil {
			return &ToolResult{Name: "manage_scheduled_task", Error: "pause failed: " + err.Error()}
		}
	}

	return &ToolResult{Name: "manage_scheduled_task", Content: fmt.Sprintf("Task %s %s", taskID, action)}
}

func joinStrings(strs []string, sep string) string {
	result := ""
	for i, s := range strs {
		if i > 0 {
			result += sep
		}
		result += s
	}
	return result
}
