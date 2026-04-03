package handlers

import (
	"context"
	"time"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

// GoalRow is returned by goals handlers.
type GoalRow struct {
	ID           uuid.UUID  `json:"id"`
	UserID       uuid.UUID  `json:"user_id"`
	Title        string     `json:"title"`
	Description  *string    `json:"description"`
	Status       string     `json:"status"`
	Priority     string     `json:"priority"`
	Source       string     `json:"source"`
	ParentGoalID *uuid.UUID `json:"parent_goal_id"`
	Deadline     *time.Time `json:"deadline"`
	Progress     int        `json:"progress"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
	CompletedAt  *time.Time `json:"completed_at"`
}

// ListGoals returns all goals for the calling user.
func ListGoals(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	rows, err := db.Pool.Query(ctx,
		`SELECT id, user_id, title, description, status, priority, source, parent_goal_id,
		        deadline, progress, created_at, updated_at, completed_at
		 FROM goals WHERE user_id=$1 ORDER BY
		   CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
		   created_at DESC`,
		userID,
	)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to list goals"})
	}
	defer rows.Close()

	var goals []GoalRow
	for rows.Next() {
		var g GoalRow
		if err := rows.Scan(&g.ID, &g.UserID, &g.Title, &g.Description, &g.Status, &g.Priority,
			&g.Source, &g.ParentGoalID, &g.Deadline, &g.Progress, &g.CreatedAt, &g.UpdatedAt, &g.CompletedAt); err != nil {
			continue
		}
		goals = append(goals, g)
	}
	if goals == nil {
		goals = []GoalRow{}
	}
	return c.JSON(goals)
}

// CreateGoal creates a new goal for the calling user.
func CreateGoal(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	var body struct {
		Title        string     `json:"title"`
		Description  *string    `json:"description"`
		Priority     string     `json:"priority"`
		Source       string     `json:"source"`
		ParentGoalID *uuid.UUID `json:"parent_goal_id"`
		Deadline     *time.Time `json:"deadline"`
	}
	if err := c.BodyParser(&body); err != nil || body.Title == "" {
		return c.Status(400).JSON(fiber.Map{"error": "title is required"})
	}

	priority := body.Priority
	if priority == "" {
		priority = "medium"
	}
	source := body.Source
	if source == "" {
		source = "manual"
	}

	var g GoalRow
	err := db.Pool.QueryRow(ctx,
		`INSERT INTO goals (user_id, title, description, priority, source, parent_goal_id, deadline)
		 VALUES ($1,$2,$3,$4,$5,$6,$7)
		 RETURNING id, user_id, title, description, status, priority, source, parent_goal_id,
		           deadline, progress, created_at, updated_at, completed_at`,
		userID, body.Title, body.Description, priority, source, body.ParentGoalID, body.Deadline,
	).Scan(&g.ID, &g.UserID, &g.Title, &g.Description, &g.Status, &g.Priority, &g.Source,
		&g.ParentGoalID, &g.Deadline, &g.Progress, &g.CreatedAt, &g.UpdatedAt, &g.CompletedAt)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to create goal"})
	}
	return c.Status(201).JSON(g)
}

// UpdateGoalHandler updates fields of an existing goal.
func UpdateGoalHandler(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	goalID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid goal id"})
	}
	ctx := context.Background()

	var body map[string]interface{}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}

	if status, ok := body["status"].(string); ok {
		if status == "completed" {
			db.Pool.Exec(ctx,
				`UPDATE goals SET status=$1, completed_at=NOW(), updated_at=NOW() WHERE id=$2 AND user_id=$3`,
				status, goalID, userID)
		} else {
			db.Pool.Exec(ctx,
				`UPDATE goals SET status=$1, completed_at=NULL, updated_at=NOW() WHERE id=$2 AND user_id=$3`,
				status, goalID, userID)
		}
	}
	if progress, ok := body["progress"].(float64); ok {
		db.Pool.Exec(ctx, `UPDATE goals SET progress=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3`,
			int(progress), goalID, userID)
	}
	if title, ok := body["title"].(string); ok {
		db.Pool.Exec(ctx, `UPDATE goals SET title=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3`,
			title, goalID, userID)
	}
	if priority, ok := body["priority"].(string); ok {
		db.Pool.Exec(ctx, `UPDATE goals SET priority=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3`,
			priority, goalID, userID)
	}

	return c.JSON(fiber.Map{"ok": true})
}

// DeleteGoalHandler deletes a goal by id.
func DeleteGoalHandler(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	goalID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid goal id"})
	}
	_, err = db.Pool.Exec(context.Background(),
		`DELETE FROM goals WHERE id=$1 AND user_id=$2`, goalID, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to delete goal"})
	}
	return c.JSON(fiber.Map{"ok": true})
}
