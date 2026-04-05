package autonomous

import (
	"context"
	"log"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/google/uuid"
)

const maxUnproductiveRuns = 5

// IsGoalStuck checks if recent heartbeat runs for a goal show no progress.
// It looks at the last N runs that mention the goal title and checks if summaries are repetitive.
func IsGoalStuck(ctx context.Context, userID uuid.UUID, goalTitle string) bool {
	var recentRuns int
	var uniqueSummaries int

	err := db.Pool.QueryRow(ctx, `
		WITH recent AS (
			SELECT summary FROM heartbeat_runs
			WHERE user_id = $1
			  AND summary ILIKE '%' || $2 || '%'
			  AND created_at > now() - interval '24 hours'
			ORDER BY created_at DESC
			LIMIT $3
		)
		SELECT COUNT(*), COUNT(DISTINCT LEFT(summary, 200)) FROM recent`,
		userID, goalTitle, maxUnproductiveRuns).Scan(&recentRuns, &uniqueSummaries)

	if err != nil {
		return false
	}

	// If N+ runs but <=2 unique summaries, it's stuck in a loop
	if recentRuns >= maxUnproductiveRuns && uniqueSummaries <= 2 {
		log.Printf("[loop_breaker] goal '%s' is stuck: %d runs with only %d unique summaries", goalTitle, recentRuns, uniqueSummaries)
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
