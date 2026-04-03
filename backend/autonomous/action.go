package autonomous

import (
	"context"
	"time"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/google/uuid"
)

type AutonomousAction struct {
	ID               uuid.UUID  `json:"id"`
	UserID           uuid.UUID  `json:"user_id"`
	HeartbeatRunID   *uuid.UUID `json:"heartbeat_run_id"`
	ActionType       string     `json:"action_type"`
	ActionPattern    string     `json:"action_pattern"`
	Description      string     `json:"description"`
	TrustScoreAtTime int        `json:"trust_score_at_time"`
	Status           string     `json:"status"`
	Result           *string    `json:"result"`
	Error            *string    `json:"error"`
	CreatedAt        time.Time  `json:"created_at"`
}

// LogAction records an autonomous action
func LogAction(ctx context.Context, userID uuid.UUID, heartbeatRunID *uuid.UUID,
	actionType, actionPattern, description string, trustScore int, status string, result, errMsg *string) error {
	_, err := db.Pool.Exec(ctx,
		`INSERT INTO autonomous_actions (user_id, heartbeat_run_id, action_type, action_pattern,
		  description, trust_score_at_time, status, result, error)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		userID, heartbeatRunID, actionType, actionPattern, description, trustScore, status, result, errMsg,
	)
	return err
}

// CountActionsThisHour returns how many actions were executed in the last hour
func CountActionsThisHour(ctx context.Context, userID uuid.UUID) (int, error) {
	var count int
	err := db.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM autonomous_actions
		 WHERE user_id=$1 AND status='executed' AND created_at > NOW() - INTERVAL '1 hour'`,
		userID,
	).Scan(&count)
	return count, err
}

// CountRecentRejections returns consecutive rejections in the last hour
func CountRecentRejections(ctx context.Context, userID uuid.UUID) (int, error) {
	var count int
	err := db.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM (
		   SELECT status FROM autonomous_actions
		   WHERE user_id=$1 AND created_at > NOW() - INTERVAL '1 hour'
		   ORDER BY created_at DESC LIMIT 10
		 ) sub WHERE status='rejected'`,
		userID,
	).Scan(&count)
	return count, err
}

// ListActionsToday returns all actions for today for a user
func ListActionsToday(ctx context.Context, userID uuid.UUID, tz string) ([]AutonomousAction, error) {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = time.UTC
	}
	now := time.Now().In(loc)
	startOfDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)

	rows, err := db.Pool.Query(ctx,
		`SELECT id, user_id, heartbeat_run_id, action_type, action_pattern, description,
		        trust_score_at_time, status, result, error, created_at
		 FROM autonomous_actions WHERE user_id=$1 AND created_at >= $2 ORDER BY created_at DESC`,
		userID, startOfDay,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var actions []AutonomousAction
	for rows.Next() {
		var a AutonomousAction
		if err := rows.Scan(&a.ID, &a.UserID, &a.HeartbeatRunID, &a.ActionType, &a.ActionPattern,
			&a.Description, &a.TrustScoreAtTime, &a.Status, &a.Result, &a.Error, &a.CreatedAt); err != nil {
			continue
		}
		actions = append(actions, a)
	}
	return actions, nil
}
