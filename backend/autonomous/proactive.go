package autonomous

import (
	"context"
	"time"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/google/uuid"
)

type Goal struct {
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

type Pattern struct {
	ID          uuid.UUID `json:"id"`
	UserID      uuid.UUID `json:"user_id"`
	PatternType string    `json:"pattern_type"`
	Description string    `json:"description"`
	Confidence  float64   `json:"confidence"`
	Status      string    `json:"status"`
	ActionTaken *string   `json:"action_taken"`
	CreatedAt   time.Time `json:"created_at"`
}

func ListGoals(ctx context.Context, userID uuid.UUID) ([]Goal, error) {
	rows, err := db.Pool.Query(ctx,
		`SELECT id, user_id, title, description, status, priority, source, parent_goal_id,
		        deadline, progress, created_at, updated_at, completed_at
		 FROM goals WHERE user_id=$1 ORDER BY
		   CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
		   created_at DESC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var goals []Goal
	for rows.Next() {
		var g Goal
		if err := rows.Scan(&g.ID, &g.UserID, &g.Title, &g.Description, &g.Status, &g.Priority,
			&g.Source, &g.ParentGoalID, &g.Deadline, &g.Progress, &g.CreatedAt, &g.UpdatedAt, &g.CompletedAt); err != nil {
			continue
		}
		goals = append(goals, g)
	}
	return goals, nil
}

func CreateGoal(ctx context.Context, userID uuid.UUID, title, description, priority, source string, parentID *uuid.UUID, deadline *time.Time) (*Goal, error) {
	var g Goal
	err := db.Pool.QueryRow(ctx,
		`INSERT INTO goals (user_id, title, description, priority, source, parent_goal_id, deadline)
		 VALUES ($1,$2,$3,$4,$5,$6,$7)
		 RETURNING id, user_id, title, description, status, priority, source, parent_goal_id, deadline, progress, created_at, updated_at, completed_at`,
		userID, title, description, priority, source, parentID, deadline,
	).Scan(&g.ID, &g.UserID, &g.Title, &g.Description, &g.Status, &g.Priority, &g.Source,
		&g.ParentGoalID, &g.Deadline, &g.Progress, &g.CreatedAt, &g.UpdatedAt, &g.CompletedAt)
	if err != nil {
		return nil, err
	}
	return &g, nil
}

func UpdateGoal(ctx context.Context, userID, goalID uuid.UUID, updates map[string]interface{}) error {
	if status, ok := updates["status"].(string); ok {
		var err error
		if status == "completed" {
			_, err = db.Pool.Exec(ctx,
				`UPDATE goals SET status=$1, completed_at=NOW(), updated_at=NOW() WHERE id=$2 AND user_id=$3`,
				status, goalID, userID)
		} else {
			_, err = db.Pool.Exec(ctx,
				`UPDATE goals SET status=$1, completed_at=NULL, updated_at=NOW() WHERE id=$2 AND user_id=$3`,
				status, goalID, userID)
		}
		if err != nil {
			return err
		}
	}
	if progress, ok := updates["progress"].(float64); ok {
		db.Pool.Exec(ctx, `UPDATE goals SET progress=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3`,
			int(progress), goalID, userID)
	}
	if title, ok := updates["title"].(string); ok {
		db.Pool.Exec(ctx, `UPDATE goals SET title=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3`,
			title, goalID, userID)
	}
	if priority, ok := updates["priority"].(string); ok {
		db.Pool.Exec(ctx, `UPDATE goals SET priority=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3`,
			priority, goalID, userID)
	}
	return nil
}

func DeleteGoal(ctx context.Context, userID, goalID uuid.UUID) error {
	_, err := db.Pool.Exec(ctx, `DELETE FROM goals WHERE id=$1 AND user_id=$2`, goalID, userID)
	return err
}

func ListPatterns(ctx context.Context, userID uuid.UUID) ([]Pattern, error) {
	rows, err := db.Pool.Query(ctx,
		`SELECT id, user_id, pattern_type, description, confidence, status, action_taken, created_at
		 FROM detected_patterns WHERE user_id=$1 ORDER BY confidence DESC, created_at DESC LIMIT 50`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var patterns []Pattern
	for rows.Next() {
		var p Pattern
		if err := rows.Scan(&p.ID, &p.UserID, &p.PatternType, &p.Description, &p.Confidence,
			&p.Status, &p.ActionTaken, &p.CreatedAt); err != nil {
			continue
		}
		patterns = append(patterns, p)
	}
	return patterns, nil
}

func AcceptPattern(ctx context.Context, userID, patternID uuid.UUID) error {
	_, err := db.Pool.Exec(ctx,
		`UPDATE detected_patterns SET status='accepted', updated_at=NOW() WHERE id=$1 AND user_id=$2`,
		patternID, userID)
	return err
}

func RejectPattern(ctx context.Context, userID, patternID uuid.UUID) error {
	_, err := db.Pool.Exec(ctx,
		`UPDATE detected_patterns SET status='rejected', updated_at=NOW() WHERE id=$1 AND user_id=$2`,
		patternID, userID)
	return err
}
