package handlers

import (
	"context"
	"time"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/scheduler"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

type taskResponse struct {
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
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
	LastRunStatus   *string    `json:"last_run_status"`
	LastRunResult   *string    `json:"last_run_result"`
}

type taskRunResponse struct {
	ID         uuid.UUID  `json:"id"`
	TaskID     uuid.UUID  `json:"task_id"`
	Status     string     `json:"status"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
	Result     *string    `json:"result"`
	Error      *string    `json:"error"`
	TokensIn   int        `json:"tokens_in"`
	TokensOut  int        `json:"tokens_out"`
	CreatedAt  time.Time  `json:"created_at"`
}

func ListTasks(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	rows, err := db.Pool.Query(ctx,
		`SELECT t.id, t.user_id, t.agent_id, t.name, t.description, t.prompt,
		        t.schedule, t.schedule_human, t.timezone,
		        t.delivery_channel, t.delivery_chat_id, t.bot_id,
		        t.is_active, t.last_run_at, t.next_run_at,
		        t.run_count, t.error_count, t.created_at, t.updated_at,
		        lr.status, lr.result
		 FROM scheduled_tasks t
		 LEFT JOIN LATERAL (
		   SELECT status, result FROM task_runs
		   WHERE task_id = t.id ORDER BY started_at DESC LIMIT 1
		 ) lr ON true
		 WHERE t.user_id = $1
		 ORDER BY t.created_at DESC`, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch tasks"})
	}
	defer rows.Close()

	var tasks []taskResponse
	for rows.Next() {
		var t taskResponse
		if err := rows.Scan(&t.ID, &t.UserID, &t.AgentID, &t.Name, &t.Description, &t.Prompt,
			&t.Schedule, &t.ScheduleHuman, &t.Timezone,
			&t.DeliveryChannel, &t.DeliveryChatID, &t.BotID,
			&t.IsActive, &t.LastRunAt, &t.NextRunAt,
			&t.RunCount, &t.ErrorCount, &t.CreatedAt, &t.UpdatedAt,
			&t.LastRunStatus, &t.LastRunResult); err != nil {
			continue
		}
		tasks = append(tasks, t)
	}
	if tasks == nil {
		tasks = []taskResponse{}
	}
	return c.JSON(tasks)
}

func CreateTask(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	var body struct {
		Name            string     `json:"name"`
		Description     *string    `json:"description"`
		Prompt          string     `json:"prompt"`
		Schedule        string     `json:"schedule"`
		Timezone        string     `json:"timezone"`
		DeliveryChannel string     `json:"delivery_channel"`
		DeliveryChatID  *string    `json:"delivery_chat_id"`
		BotID           *uuid.UUID `json:"bot_id"`
		AgentID         *uuid.UUID `json:"agent_id"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request body"})
	}
	if body.Name == "" || body.Prompt == "" || body.Schedule == "" {
		return c.Status(400).JSON(fiber.Map{"error": "name, prompt, and schedule are required"})
	}
	if body.Timezone == "" {
		body.Timezone = "Asia/Ho_Chi_Minh"
	}
	if body.DeliveryChannel == "" {
		body.DeliveryChannel = "web"
	}

	if err := scheduler.ValidateSchedule(body.Schedule); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid schedule: " + err.Error()})
	}

	nextRun, err := scheduler.NextRunTime(body.Schedule, body.Timezone)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "cannot calculate next run: " + err.Error()})
	}

	scheduleHuman := scheduler.HumanReadableSchedule(body.Schedule)

	var task taskResponse
	err = db.Pool.QueryRow(ctx,
		`INSERT INTO scheduled_tasks (user_id, agent_id, name, description, prompt, schedule, schedule_human, timezone, delivery_channel, delivery_chat_id, bot_id, next_run_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
		 RETURNING id, user_id, agent_id, name, description, prompt, schedule, schedule_human, timezone, delivery_channel, delivery_chat_id, bot_id, is_active, last_run_at, next_run_at, run_count, error_count, created_at, updated_at`,
		userID, body.AgentID, body.Name, body.Description, body.Prompt, body.Schedule, scheduleHuman, body.Timezone, body.DeliveryChannel, body.DeliveryChatID, body.BotID, nextRun,
	).Scan(&task.ID, &task.UserID, &task.AgentID, &task.Name, &task.Description, &task.Prompt,
		&task.Schedule, &task.ScheduleHuman, &task.Timezone,
		&task.DeliveryChannel, &task.DeliveryChatID, &task.BotID,
		&task.IsActive, &task.LastRunAt, &task.NextRunAt,
		&task.RunCount, &task.ErrorCount, &task.CreatedAt, &task.UpdatedAt)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to create task: " + err.Error()})
	}
	return c.Status(201).JSON(task)
}

func getTaskOwned(c *fiber.Ctx, ctx context.Context) (*taskResponse, error) {
	userID := c.Locals("user_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return nil, c.Status(400).JSON(fiber.Map{"error": "invalid task ID"})
	}
	var t taskResponse
	err = db.Pool.QueryRow(ctx,
		`SELECT id, user_id, agent_id, name, description, prompt, schedule, schedule_human, timezone,
		        delivery_channel, delivery_chat_id, bot_id, is_active, last_run_at, next_run_at,
		        run_count, error_count, created_at, updated_at
		 FROM scheduled_tasks WHERE id = $1 AND user_id = $2`, taskID, userID,
	).Scan(&t.ID, &t.UserID, &t.AgentID, &t.Name, &t.Description, &t.Prompt,
		&t.Schedule, &t.ScheduleHuman, &t.Timezone,
		&t.DeliveryChannel, &t.DeliveryChatID, &t.BotID,
		&t.IsActive, &t.LastRunAt, &t.NextRunAt,
		&t.RunCount, &t.ErrorCount, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return nil, c.Status(404).JSON(fiber.Map{"error": "task not found"})
	}
	return &t, nil
}

func GetTask(c *fiber.Ctx) error {
	ctx := context.Background()
	t, fErr := getTaskOwned(c, ctx)
	if fErr != nil {
		return fErr
	}

	runRows, err := db.Pool.Query(ctx,
		`SELECT id, task_id, status, started_at, finished_at, result, error, tokens_in, tokens_out, created_at
		 FROM task_runs WHERE task_id = $1 ORDER BY started_at DESC LIMIT 10`, t.ID)
	if err != nil {
		return c.JSON(fiber.Map{"task": t, "runs": []taskRunResponse{}})
	}
	defer runRows.Close()

	var runs []taskRunResponse
	for runRows.Next() {
		var r taskRunResponse
		if runRows.Scan(&r.ID, &r.TaskID, &r.Status, &r.StartedAt, &r.FinishedAt, &r.Result, &r.Error, &r.TokensIn, &r.TokensOut, &r.CreatedAt) == nil {
			runs = append(runs, r)
		}
	}
	if runs == nil {
		runs = []taskRunResponse{}
	}
	return c.JSON(fiber.Map{"task": t, "runs": runs})
}

func UpdateTask(c *fiber.Ctx) error {
	ctx := context.Background()
	t, fErr := getTaskOwned(c, ctx)
	if fErr != nil {
		return fErr
	}

	var body struct {
		Name            *string    `json:"name"`
		Description     *string    `json:"description"`
		Prompt          *string    `json:"prompt"`
		Schedule        *string    `json:"schedule"`
		Timezone        *string    `json:"timezone"`
		DeliveryChannel *string    `json:"delivery_channel"`
		DeliveryChatID  *string    `json:"delivery_chat_id"`
		BotID           *uuid.UUID `json:"bot_id"`
		AgentID         *uuid.UUID `json:"agent_id"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request body"})
	}

	name := t.Name
	if body.Name != nil {
		name = *body.Name
	}
	prompt := t.Prompt
	if body.Prompt != nil {
		prompt = *body.Prompt
	}
	sched := t.Schedule
	if body.Schedule != nil {
		sched = *body.Schedule
	}
	tz := t.Timezone
	if body.Timezone != nil {
		tz = *body.Timezone
	}
	dc := t.DeliveryChannel
	if body.DeliveryChannel != nil {
		dc = *body.DeliveryChannel
	}
	desc := t.Description
	if body.Description != nil {
		desc = body.Description
	}
	dcid := t.DeliveryChatID
	if body.DeliveryChatID != nil {
		dcid = body.DeliveryChatID
	}
	botID := t.BotID
	if body.BotID != nil {
		botID = body.BotID
	}
	agentID := t.AgentID
	if body.AgentID != nil {
		agentID = body.AgentID
	}

	if body.Schedule != nil {
		if err := scheduler.ValidateSchedule(sched); err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "invalid schedule: " + err.Error()})
		}
	}

	nextRun := t.NextRunAt
	if body.Schedule != nil || body.Timezone != nil {
		nr, err := scheduler.NextRunTime(sched, tz)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "cannot calculate next run"})
		}
		nextRun = &nr
	}

	schedHuman := scheduler.HumanReadableSchedule(sched)

	_, err := db.Pool.Exec(ctx,
		`UPDATE scheduled_tasks SET name=$1, description=$2, prompt=$3, schedule=$4, schedule_human=$5,
		 timezone=$6, delivery_channel=$7, delivery_chat_id=$8, bot_id=$9, agent_id=$10, next_run_at=$11, updated_at=now()
		 WHERE id=$12`,
		name, desc, prompt, sched, schedHuman, tz, dc, dcid, botID, agentID, nextRun, t.ID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to update task"})
	}
	return c.JSON(fiber.Map{"message": "task updated"})
}

func DeleteTask(c *fiber.Ctx) error {
	ctx := context.Background()
	t, fErr := getTaskOwned(c, ctx)
	if fErr != nil {
		return fErr
	}
	_, err := db.Pool.Exec(ctx, "DELETE FROM scheduled_tasks WHERE id = $1", t.ID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to delete task"})
	}
	return c.JSON(fiber.Map{"message": "task deleted"})
}

func PauseTask(c *fiber.Ctx) error {
	ctx := context.Background()
	t, fErr := getTaskOwned(c, ctx)
	if fErr != nil {
		return fErr
	}
	_, err := db.Pool.Exec(ctx, "UPDATE scheduled_tasks SET is_active = false, updated_at = now() WHERE id = $1", t.ID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to pause task"})
	}
	return c.JSON(fiber.Map{"message": "task paused"})
}

func ResumeTask(c *fiber.Ctx) error {
	ctx := context.Background()
	t, fErr := getTaskOwned(c, ctx)
	if fErr != nil {
		return fErr
	}
	nextRun, err := scheduler.NextRunTime(t.Schedule, t.Timezone)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "cannot calculate next run"})
	}
	_, err = db.Pool.Exec(ctx,
		"UPDATE scheduled_tasks SET is_active = true, next_run_at = $1, error_count = 0, updated_at = now() WHERE id = $2",
		nextRun, t.ID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to resume task"})
	}
	return c.JSON(fiber.Map{"message": "task resumed", "next_run_at": nextRun})
}

func RunTaskNow(c *fiber.Ctx) error {
	ctx := context.Background()
	t, fErr := getTaskOwned(c, ctx)
	if fErr != nil {
		return fErr
	}
	now := time.Now()
	_, err := db.Pool.Exec(ctx,
		"UPDATE scheduled_tasks SET next_run_at = $1, is_active = true, updated_at = now() WHERE id = $2",
		now, t.ID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to trigger task"})
	}
	return c.JSON(fiber.Map{"message": "task will run shortly", "next_run_at": now})
}

func ListTaskRuns(c *fiber.Ctx) error {
	ctx := context.Background()
	t, fErr := getTaskOwned(c, ctx)
	if fErr != nil {
		return fErr
	}

	limit := c.QueryInt("limit", 20)
	offset := c.QueryInt("offset", 0)
	if limit > 100 {
		limit = 100
	}

	rows, err := db.Pool.Query(ctx,
		`SELECT id, task_id, status, started_at, finished_at, result, error, tokens_in, tokens_out, created_at
		 FROM task_runs WHERE task_id = $1 ORDER BY started_at DESC LIMIT $2 OFFSET $3`,
		t.ID, limit, offset)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch runs"})
	}
	defer rows.Close()

	var runs []taskRunResponse
	for rows.Next() {
		var r taskRunResponse
		if rows.Scan(&r.ID, &r.TaskID, &r.Status, &r.StartedAt, &r.FinishedAt, &r.Result, &r.Error, &r.TokensIn, &r.TokensOut, &r.CreatedAt) == nil {
			runs = append(runs, r)
		}
	}
	if runs == nil {
		runs = []taskRunResponse{}
	}
	return c.JSON(runs)
}
