package autonomous

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/google/uuid"
)

// GenerateDigest creates the daily digest text for a user
func GenerateDigest(ctx context.Context, userID uuid.UUID, tz string) (string, error) {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = time.UTC
	}
	now := time.Now().In(loc)
	dateStr := now.Format("02/01/2006")

	var b strings.Builder
	b.WriteString(fmt.Sprintf("📊 Báo cáo ngày %s\n\n", dateStr))

	// Autonomous actions summary
	actions, _ := ListActionsToday(ctx, userID, tz)
	executed, skipped, failed := 0, 0, 0
	for _, a := range actions {
		switch a.Status {
		case "executed":
			executed++
		case "skipped":
			skipped++
		default:
			failed++
		}
	}
	total := executed + skipped + failed
	if total > 0 {
		b.WriteString(fmt.Sprintf("🤖 Autonomous Actions: %d\n", total))
		b.WriteString(fmt.Sprintf("  ✅ %d thành công | ⏭ %d skipped | ❌ %d failed\n\n", executed, skipped, failed))
	} else {
		b.WriteString("🤖 Autonomous Actions: 0\n\n")
	}

	// Goals progress
	goals, _ := ListGoals(ctx, userID)
	activeGoals := 0
	for _, g := range goals {
		if g.Status != "completed" && g.Status != "abandoned" {
			activeGoals++
		}
	}
	if activeGoals > 0 {
		b.WriteString(fmt.Sprintf("🎯 Goals: %d active\n", activeGoals))
		for _, g := range goals {
			if g.Status == "completed" || g.Status == "abandoned" {
				continue
			}
			b.WriteString(fmt.Sprintf("  • %s: %d%%\n", g.Title, g.Progress))
		}
		b.WriteString("\n")
	}

	// Mood summary
	moodSummary, _ := GetRecentMoodSummary(ctx, userID)
	if emotions, ok := moodSummary["emotions_7d"].(map[string]int); ok && len(emotions) > 0 {
		b.WriteString("😊 Mood tuần này:\n")
		for e, c := range emotions {
			b.WriteString(fmt.Sprintf("  • %s: %dx\n", e, c))
		}
		b.WriteString("\n")
	}

	// Detected patterns
	patterns, _ := ListPatterns(ctx, userID)
	newPatterns := 0
	for _, p := range patterns {
		if p.Status == "detected" {
			newPatterns++
		}
	}
	if newPatterns > 0 {
		b.WriteString(fmt.Sprintf("💡 %d pattern mới phát hiện:\n", newPatterns))
		for _, p := range patterns {
			if p.Status != "detected" {
				continue
			}
			b.WriteString(fmt.Sprintf("  • %s (%.0f%%)\n", p.Description, p.Confidence*100))
		}
		b.WriteString("\n")
	}

	// Reflection score
	var score *float64
	db.Pool.QueryRow(ctx,
		`SELECT performance_score FROM reflections WHERE user_id=$1 AND date=$2`,
		userID, now.Format("2006-01-02"),
	).Scan(&score)
	if score != nil {
		b.WriteString(fmt.Sprintf("⭐ Performance score: %.1f/10\n", *score))
	}

	return b.String(), nil
}
