package autonomous

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/ahvholding/ahvclaw/ai"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/engine"
	"github.com/google/uuid"
)

// PlannedTask is the AI-generated task breakdown for a goal.
type PlannedTask struct {
	Name          string   `json:"name"`
	ScheduleHuman string   `json:"schedule_human"`
	Schedule      string   `json:"schedule"`      // cron expression
	Prompt        string   `json:"prompt"`
	AgentTools    []string `json:"agent_tools"`
}

// isValidCron checks if a cron expression has 5 fields with valid characters.
func isValidCron(expr string) bool {
	fields := strings.Fields(expr)
	if len(fields) != 5 {
		return false
	}
	for _, f := range fields {
		for _, c := range f {
			if !((c >= '0' && c <= '9') || c == '*' || c == '/' || c == '-' || c == ',' || c == '?') {
				return false
			}
		}
	}
	return true
}

// isExcessiveCron checks if cron runs more often than every 5 minutes.
func isExcessiveCron(expr string) bool {
	fields := strings.Fields(expr)
	if len(fields) < 1 {
		return true
	}
	minute := fields[0]
	// */1, */2, */3, */4 are too frequent
	if strings.HasPrefix(minute, "*/") {
		val := strings.TrimPrefix(minute, "*/")
		if len(val) == 1 && val[0] >= '1' && val[0] <= '4' {
			return true
		}
	}
	// Every minute
	if minute == "*" {
		return true
	}
	return false
}

// PlanGoal analyzes a goal and creates scheduled_tasks to achieve it.
func PlanGoal(ctx context.Context, userID uuid.UUID, goalID uuid.UUID, goalTitle, goalDesc string, router *ai.RouterClient) error {
	// Check if tasks already exist for this goal
	var existingCount int
	db.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM scheduled_tasks WHERE user_id=$1 AND goal_id=$2`,
		userID, goalID).Scan(&existingCount)
	if existingCount > 0 {
		log.Printf("[auto-plan] goal %s already has %d tasks, skipping", goalID, existingCount)
		return nil
	}

	prompt := fmt.Sprintf(`You are an autonomous AI planner. A user has set a goal that needs to be broken into recurring scheduled tasks.

Goal: %s
Description: %s

Available tools: web_search, server_status, server_ssh_exec, http_request, memory_save, memory_search, knowledge_search, file_read, file_write, file_list

Return a JSON array of tasks needed to achieve this goal. Each task should be a recurring check or action.
Use standard cron expressions for the schedule field.

Example output:
[
  {"name": "Check server CPU", "schedule_human": "every 30 minutes", "schedule": "*/30 * * * *", "prompt": "Check the server CPU and memory usage using server_status tool. Report if any metric is above 80%%.", "agent_tools": ["server_status"]},
  {"name": "Daily disk cleanup check", "schedule_human": "daily at 9am", "schedule": "0 9 * * *", "prompt": "Check disk usage on the server. If above 85%%, identify large files that can be cleaned.", "agent_tools": ["server_ssh_exec", "server_status"]}
]

Rules:
- Maximum 5 tasks per goal
- Each task must be actionable with the available tools
- Schedule must be a valid cron expression
- Return raw JSON array only, no markdown fences
- Be practical — don't create tasks more frequent than needed`, goalTitle, goalDesc)

	model := getUserModel(ctx, userID)
	result, err := engine.ProcessChat(ctx, engine.ChatConfig{
		AIRouter:      router,
		Model:         model,
		Messages:      []ai.ChatMessage{{Role: "user", Content: prompt}},
		MaxToolRounds: 0,
	})
	if err != nil {
		return fmt.Errorf("auto-plan AI call failed: %w", err)
	}

	raw := strings.TrimSpace(result.Content)
	if idx := strings.Index(raw, "["); idx >= 0 {
		raw = raw[idx:]
	}
	if idx := strings.LastIndex(raw, "]"); idx >= 0 {
		raw = raw[:idx+1]
	}

	var tasks []PlannedTask
	if err := json.Unmarshal([]byte(raw), &tasks); err != nil {
		log.Printf("[auto-plan] JSON parse error for goal %s: %v", goalID, err)
		return fmt.Errorf("auto-plan parse error: %w", err)
	}

	if len(tasks) > 5 {
		tasks = tasks[:5]
	}

	// Get user delivery config
	var deliveryChannel, deliveryChatID string
	var botID *uuid.UUID
	db.Pool.QueryRow(ctx,
		`SELECT delivery_channel, delivery_chat_id FROM heartbeat_config WHERE user_id=$1`,
		userID).Scan(&deliveryChannel, &deliveryChatID)
	if deliveryChannel == "" {
		deliveryChannel = "telegram"
	}

	// Get default bot
	var defaultBotID uuid.UUID
	err = db.Pool.QueryRow(ctx,
		`SELECT id FROM bots WHERE is_active=true ORDER BY created_at ASC LIMIT 1`,
	).Scan(&defaultBotID)
	if err == nil {
		botID = &defaultBotID
	}

	// Insert tasks
	created := 0
	for _, t := range tasks {
		if t.Name == "" || t.Schedule == "" || t.Prompt == "" {
			continue
		}
		// Validate cron expression
		if !isValidCron(t.Schedule) {
			log.Printf("[auto-plan] invalid cron '%s' for task '%s', skipping", t.Schedule, t.Name)
			continue
		}
		// Prevent overly frequent schedules (minimum 5 minutes apart)
		if isExcessiveCron(t.Schedule) {
			log.Printf("[auto-plan] cron '%s' too frequent for task '%s', skipping", t.Schedule, t.Name)
			continue
		}
		taskID := uuid.New()
		_, err := db.Pool.Exec(ctx,
			`INSERT INTO scheduled_tasks
			 (id, user_id, name, description, prompt, schedule, schedule_human, timezone,
			  delivery_channel, delivery_chat_id, bot_id, goal_id, is_active, next_run_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, 'Asia/Ho_Chi_Minh', $8, $9, $10, $11, true, $12)`,
			taskID, userID, t.Name,
			fmt.Sprintf("Auto-created for goal: %s", goalTitle),
			t.Prompt, t.Schedule, t.ScheduleHuman,
			deliveryChannel, deliveryChatID, botID, goalID,
			time.Now().Add(5*time.Minute), // first run in 5 minutes
		)
		if err != nil {
			log.Printf("[auto-plan] failed to create task '%s': %v", t.Name, err)
			continue
		}
		created++
		log.Printf("[auto-plan] created task '%s' (schedule: %s) for goal %s", t.Name, t.Schedule, goalID)
	}

	// Update goal status to in_progress
	if created > 0 {
		db.Pool.Exec(ctx,
			`UPDATE goals SET status='in_progress', updated_at=NOW() WHERE id=$1 AND status IN ('proposed','active')`,
			goalID)
		log.Printf("[auto-plan] created %d tasks for goal %s, status->in_progress", created, goalID)
	}

	return nil
}