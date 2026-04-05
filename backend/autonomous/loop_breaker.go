package autonomous

import (
	"context"
	"log"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/google/uuid"
)

const maxUnproductiveRuns = 5

// IsGoalStuck checks if recent autonomous actions show no progress.
// Uses outcome-based heuristics instead of text matching:
// 1. Action signature repetition (same tools called in same order)
// 2. No new artifacts produced (memories, files)
// 3. Token budget burned with no state change
func IsGoalStuck(ctx context.Context, userID uuid.UUID, goalTitle string) bool {
	var totalRuns int
	var distinctToolSets int
	var distinctNewKeys int

	err := db.Pool.QueryRow(ctx, `
		WITH recent_runs AS (
			SELECT id, created_at FROM heartbeat_runs
			WHERE user_id = $1 AND created_at > now() - interval '24 hours'
			ORDER BY created_at DESC LIMIT $2
		),
		run_tools AS (
			SELECT hr.id, string_agg(DISTINCT tl.tool_name, ',' ORDER BY tl.tool_name) as tool_set
			FROM recent_runs hr
			LEFT JOIN tool_logs tl ON tl.source = 'heartbeat' AND tl.user_id = $1
				AND tl.created_at BETWEEN hr.created_at - interval '1 minute' AND hr.created_at + interval '10 minutes'
			GROUP BY hr.id
		)
		SELECT
			(SELECT COUNT(*) FROM recent_runs),
			(SELECT COUNT(DISTINCT tool_set) FROM run_tools),
			(SELECT COUNT(DISTINCT key) FROM memories WHERE user_id = $1 AND type = 'knowledge' AND created_at > now() - interval '24 hours')
	`, userID, maxUnproductiveRuns).Scan(&totalRuns, &distinctToolSets, &distinctNewKeys)

	if err != nil {
		log.Printf("[loop_breaker] outcome query error for user %s: %v", userID, err)
		return false
	}

	// Stuck = many runs + same tool pattern + few distinct new memory keys
	// Using DISTINCT keys so saving the same "cpu-goal" 100 times counts as 1
	if totalRuns >= maxUnproductiveRuns && distinctToolSets <= 2 && distinctNewKeys <= 3 {
		log.Printf("[loop_breaker] user %s is stuck: %d runs, %d distinct tool sets, %d distinct new memory keys",
			userID, totalRuns, distinctToolSets, distinctNewKeys)
		return true
	}
	return false
}

// MarkGoalStuck sets a goal's status to 'stuck' so it gets skipped.
func MarkGoalStuck(ctx context.Context, userID, goalID uuid.UUID) {
	_, err := db.Pool.Exec(ctx,
		"UPDATE goals SET status='stuck', updated_at=now() WHERE id=$1 AND user_id=$2",
		goalID, userID)
	if err != nil {
		log.Printf("[loop_breaker] failed to mark goal %s as stuck: %v", goalID, err)
	} else {
		log.Printf("[loop_breaker] marked goal %s as stuck", goalID)
	}

	// Also cancel any active plans tied to this goal
	_, err = db.Pool.Exec(ctx,
		`UPDATE execution_plans SET status='failed', result='Tự động hủy - mục tiêu bị stuck', updated_at=now()
		 WHERE user_id=$1 AND goal_id=$2 AND status IN ('pending','running','blocked')`,
		userID, goalID)
	if err != nil {
		log.Printf("[loop_breaker] failed to cancel plans for stuck goal %s: %v", goalID, err)
	}
}

// CheckAndSkipStuckGoals iterates active goals for a user and marks any stuck ones.
// Returns the number of goals marked as stuck.
func CheckAndSkipStuckGoals(ctx context.Context, userID uuid.UUID) int {
	goals, err := ListGoals(ctx, userID)
	if err != nil {
		return 0
	}

	stuckCount := 0
	for _, g := range goals {
		if g.Status != "active" && g.Status != "in_progress" {
			continue
		}
		if IsGoalStuck(ctx, userID, g.Title) {
			MarkGoalStuck(ctx, userID, g.ID)
			stuckCount++
		}
	}
	return stuckCount
}
