package autonomous

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/ahvholding/ahvclaw/ai"
	"github.com/ahvholding/ahvclaw/cognitive"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/engine"
	"github.com/ahvholding/ahvclaw/memories"
	"github.com/google/uuid"
)

// ReflectionResult holds the structured AI analysis of a day's activity
type ReflectionResult struct {
	Lessons           []string `json:"lessons"`
	UserInsights      []string `json:"user_insights"`
	PromptSuggestions []string `json:"prompt_suggestions"`
	GoalsProgress     []struct {
		GoalTitle string `json:"goal_title"`
		Note      string `json:"note"`
		Progress  int    `json:"progress"`
	} `json:"goals_progress"`
	DetectedPatterns []struct {
		PatternType string  `json:"pattern_type"`
		Description string  `json:"description"`
		Confidence  float64 `json:"confidence"`
	} `json:"detected_patterns"`
	PerformanceScore float64 `json:"performance_score"`
}

// hasReflectedToday checks whether a reflection already exists for today
func hasReflectedToday(ctx context.Context, userID uuid.UUID, loc *time.Location) (bool, error) {
	today := time.Now().In(loc).Format("2006-01-02")
	var count int
	err := db.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM reflections WHERE user_id=$1 AND date=$2`,
		userID, today,
	).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// gatherDayContext builds a natural-language summary of the day for the AI prompt
func gatherDayContext(ctx context.Context, userID uuid.UUID, loc *time.Location) string {
	today := time.Now().In(loc).Format("2006-01-02")
	var sb strings.Builder

	sb.WriteString(fmt.Sprintf("Date: %s\n\n", today))

	// Today's autonomous actions
	actions, _ := ListActionsToday(ctx, userID, loc.String())
	if len(actions) > 0 {
		sb.WriteString("## Autonomous Actions Today\n")
		for _, a := range actions {
			statusMark := "✅"
			if a.Status == "skipped" {
				statusMark = "⏭"
			} else if a.Status != "executed" {
				statusMark = "❌"
			}
			sb.WriteString(fmt.Sprintf("  %s [%s] %s: %s\n", statusMark, a.ActionType, a.ActionPattern, a.Description))
			if a.Result != nil {
				sb.WriteString(fmt.Sprintf("     Result: %s\n", *a.Result))
			}
			if a.Error != nil {
				sb.WriteString(fmt.Sprintf("     Error: %s\n", *a.Error))
			}
		}
		sb.WriteString("\n")
	}

	// Recent conversation excerpts (last 10 user messages today)
	rows, err := db.Pool.Query(ctx,
		`SELECT m.role, LEFT(m.content, 300)
		 FROM messages m
		 JOIN conversations c ON c.id = m.conversation_id
		 WHERE c.user_id = $1
		   AND m.created_at >= $2::date
		   AND m.created_at <  $2::date + INTERVAL '1 day'
		   AND m.role IN ('user','assistant')
		 ORDER BY m.created_at ASC
		 LIMIT 20`,
		userID, today,
	)
	if err == nil {
		defer rows.Close()
		sb.WriteString("## Conversation Excerpts\n")
		count := 0
		for rows.Next() {
			var role, content string
			if rows.Scan(&role, &content) == nil {
				label := "User"
				if role == "assistant" {
					label = "Assistant"
				}
				sb.WriteString(fmt.Sprintf("  [%s]: %s\n", label, strings.ReplaceAll(content, "\n", " ")))
				count++
			}
		}
		if count == 0 {
			sb.WriteString("  (no conversations today)\n")
		}
		sb.WriteString("\n")
	}

	// Mood data
	moodSummary, _ := GetRecentMoodSummary(ctx, userID)
	if emotions, ok := moodSummary["emotions_7d"].(map[string]int); ok && len(emotions) > 0 {
		sb.WriteString("## Mood (7-day)\n")
		for e, c := range emotions {
			sb.WriteString(fmt.Sprintf("  %s: %dx\n", e, c))
		}
		sb.WriteString("\n")
	}

	// Goals
	goals, _ := ListGoals(ctx, userID)
	if len(goals) > 0 {
		sb.WriteString("## Active Goals\n")
		for _, g := range goals {
			if g.Status == "completed" || g.Status == "abandoned" {
				continue
			}
			sb.WriteString(fmt.Sprintf("  • [%s] %s – %d%% (%s)\n", g.Priority, g.Title, g.Progress, g.Status))
		}
		sb.WriteString("\n")
	}

	// Known patterns
	patterns, _ := ListPatterns(ctx, userID)
	if len(patterns) > 0 {
		sb.WriteString("## Known Patterns\n")
		for _, p := range patterns {
			if p.Status != "detected" {
				continue
			}
			sb.WriteString(fmt.Sprintf("  • [%s] %s (confidence %.0f%%)\n", p.PatternType, p.Description, p.Confidence*100))
		}
		sb.WriteString("\n")
	}

	// Load lessons from previous reflections so they inform future behavior
	lessonRows, lessonErr := db.Pool.Query(ctx,
		`SELECT lessons FROM reflections WHERE user_id=$1 AND date < $2::date ORDER BY date DESC LIMIT 3`,
		userID, today)
	if lessonErr == nil && lessonRows != nil {
		defer lessonRows.Close()
		var allLessons []string
		for lessonRows.Next() {
			var lessonsJSON []byte
			if lessonRows.Scan(&lessonsJSON) == nil && len(lessonsJSON) > 0 {
				var lessons []string
				if json.Unmarshal(lessonsJSON, &lessons) == nil {
					allLessons = append(allLessons, lessons...)
				}
			}
		}
		if len(allLessons) > 0 {
			sb.WriteString("## Lessons from Previous Reflections\n")
			for _, l := range allLessons {
				sb.WriteString(fmt.Sprintf("  • %s\n", l))
			}
			sb.WriteString("\n")
		}
	}

	return sb.String()
}

// saveReflectionToDB persists the parsed reflection to the reflections table
func saveReflectionToDB(ctx context.Context, userID uuid.UUID, loc *time.Location, res ReflectionResult, rawOutput string) error {
	today := time.Now().In(loc).Format("2006-01-02")

	lessonsJSON, _ := json.Marshal(res.Lessons)
	insightsJSON, _ := json.Marshal(res.UserInsights)
	suggestionsJSON, _ := json.Marshal(res.PromptSuggestions)
	goalsJSON, _ := json.Marshal(res.GoalsProgress)
	patternsJSON, _ := json.Marshal(res.DetectedPatterns)

	_, err := db.Pool.Exec(ctx,
		`INSERT INTO reflections
		 (user_id, date, lessons, user_insights, prompt_suggestions, goals_progress, detected_patterns, performance_score, raw_output)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 ON CONFLICT (user_id, date) DO UPDATE SET
		   lessons=$3, user_insights=$4, prompt_suggestions=$5,
		   goals_progress=$6, detected_patterns=$7, performance_score=$8, raw_output=$9`,
		userID, today,
		lessonsJSON, insightsJSON, suggestionsJSON, goalsJSON, patternsJSON,
		res.PerformanceScore, rawOutput,
	)
	return err
}

// applyLessons saves lessons as memory files and upserts detected patterns
func applyLessons(ctx context.Context, userID uuid.UUID, res ReflectionResult, dateStr string) {
	// Save lessons as memory files
	for i, lesson := range res.Lessons {
		if strings.TrimSpace(lesson) == "" {
			continue
		}
		key := fmt.Sprintf("lesson_%s_%d", dateStr, i+1)
		filename := fmt.Sprintf("lesson_%s_%d.md", dateStr, i+1)
		mem := &memories.Memory{
			MemoryFrontmatter: memories.MemoryFrontmatter{
				Type: "lesson",
				Key:  key,
			},
			Content:  lesson,
			Filename: filename,
		}
		if err := memories.SaveMemoryFile(userID.String(), mem); err != nil {
			log.Printf("[reflection] failed to save lesson memory %s: %v", key, err)
		}
	}

	// Upsert detected patterns
	for _, p := range res.DetectedPatterns {
		if strings.TrimSpace(p.Description) == "" {
			continue
		}
		evidenceJSON := []byte("[]")
		_, err := db.Pool.Exec(ctx,
			`INSERT INTO detected_patterns (user_id, pattern_type, description, evidence, confidence, status)
			 VALUES ($1, $2, $3, $4, $5, 'detected')
			 ON CONFLICT DO NOTHING`,
			userID, p.PatternType, p.Description, evidenceJSON, p.Confidence,
		)
		if err != nil {
			log.Printf("[reflection] failed to save pattern '%s': %v", p.Description, err)
		}
	}

	// Auto-accept high-confidence patterns (>= 0.80)
	for _, p := range res.DetectedPatterns {
		if p.Confidence >= 0.80 {
			db.Pool.Exec(ctx,
				`UPDATE detected_patterns SET status='accepted', updated_at=NOW()
				 WHERE user_id=$1 AND description=$2 AND status='detected'`,
				userID, p.Description)
			log.Printf("[reflection] auto-accepted pattern: %s (confidence=%.2f)", p.Description, p.Confidence)
		}
	}

	// Apply prompt suggestions to user settings for injection into future prompts
	if len(res.PromptSuggestions) > 0 {
		sugJSON, _ := json.Marshal(res.PromptSuggestions)
		db.Pool.Exec(ctx,
			`INSERT INTO user_settings (user_id, key, value) VALUES ($1, 'active_prompt_suggestions', $2)
			 ON CONFLICT (user_id, key) DO UPDATE SET value=$2`,
			userID, string(sugJSON))
		log.Printf("[reflection] saved %d prompt suggestions for user %s", len(res.PromptSuggestions), userID)
		// Log suggestion count for observability
		db.Pool.Exec(ctx,
			`UPDATE heartbeat_runs SET summary = COALESCE(summary,'') || ' [reflection: ' || $1 || ' suggestions]'
			 WHERE user_id=$2 AND started_at = (SELECT MAX(started_at) FROM heartbeat_runs WHERE user_id=$2)`,
			fmt.Sprintf("%d", len(res.PromptSuggestions)), userID)
	}
}

// applyReflectionToPlans modifies active plans and goals based on reflection results.
// If performance is poor, it cancels stalled plans and defers old stuck goals.
func applyReflectionToPlans(ctx context.Context, userID uuid.UUID, res ReflectionResult) {
	if res.PerformanceScore < 3.0 {
		// Cancel active plans that are pending/running/blocked
		result, err := db.Pool.Exec(ctx, `
			UPDATE execution_plans SET status='failed',
			result='Tự động hủy do performance thấp', updated_at=now()
			WHERE user_id=$1 AND status IN ('pending','running','blocked')`, userID)
		if err != nil {
			log.Printf("[reflection] failed to cancel stalled plans for user %s: %v", userID, err)
		} else {
			rows := result.RowsAffected()
			if rows > 0 {
				log.Printf("[reflection] cancelled %d stalled plans for user %s (performance=%.1f)",
					rows, userID, res.PerformanceScore)
			}
		}

		// Defer goals that have been in_progress for more than 3 days
		result, err = db.Pool.Exec(ctx, `
			UPDATE goals SET status='deferred', updated_at=now()
			WHERE user_id=$1 AND status='in_progress'
			AND updated_at < now() - interval '3 days'`, userID)
		if err != nil {
			log.Printf("[reflection] failed to defer old goals for user %s: %v", userID, err)
		} else {
			rows := result.RowsAffected()
			if rows > 0 {
				log.Printf("[reflection] deferred %d stale goals for user %s (performance=%.1f)",
					rows, userID, res.PerformanceScore)
			}
		}

		log.Printf("[reflection] low performance (%.1f) for user %s - cleaned up stalled plans and deferred old goals",
			res.PerformanceScore, userID)
	}
}

// getUserModel fetches the user's preferred AI model from settings
func getUserModel(ctx context.Context, userID uuid.UUID) string {
	var model string
	db.Pool.QueryRow(ctx,
		`SELECT value FROM user_settings WHERE user_id=$1 AND key='default_model'`,
		userID,
	).Scan(&model)
	if model == "" {
		model = "AHV-Holding"
	}
	return model
}

// RunReflection runs the end-of-day AI reflection for a user.
// It skips if a reflection already exists for today.
func RunReflection(ctx context.Context, userID uuid.UUID, tz string, router *ai.RouterClient) error {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = time.UTC
	}

	// 1. Skip if already reflected today
	done, err := hasReflectedToday(ctx, userID, loc)
	if err != nil {
		return fmt.Errorf("reflection check failed: %w", err)
	}
	if done {
		log.Printf("[reflection] user %s already reflected today, skipping", userID)
		return nil
	}

	// 2. Gather day context
	dayContext := gatherDayContext(ctx, userID, loc)
	today := time.Now().In(loc).Format("2006-01-02")

	// 3. Build AI prompt
	systemPrompt := `You are an autonomous AI agent performing end-of-day reflection for a user.
Analyze the day's activity and return a structured JSON object (no markdown fences, raw JSON only) with the following shape:
{
  "lessons": ["<what you learned>", ...],
  "user_insights": ["<observations about the user's work style, needs, or patterns>", ...],
  "prompt_suggestions": ["<suggestions for better prompts or workflows>", ...],
  "goals_progress": [{"goal_title": "...", "note": "...", "progress": 0-100}, ...],
  "detected_patterns": [{"pattern_type": "...", "description": "...", "confidence": 0.0-1.0}, ...],
  "performance_score": 0.0-10.0
}
Be concise. Return only valid JSON.`

	userMsg := fmt.Sprintf("Here is the activity data for %s:\n\n%s\n\nPlease reflect and return JSON.", today, dayContext)

	messages := []ai.ChatMessage{
		{Role: "system", Content: systemPrompt},
		{Role: "user", Content: userMsg},
	}

	// 4. Call engine.ProcessChat with no tools
	model := getUserModel(ctx, userID)
	result, err := engine.ProcessChat(ctx, engine.ChatConfig{
		AIRouter:         router,
		Model:            model,
		Messages:         messages,
		MaxToolRounds:    0,
		MaxContextTokens: 6000,
	})
	if err != nil {
		return fmt.Errorf("reflection AI call failed: %w", err)
	}

	rawOutput := strings.TrimSpace(result.Content)
	log.Printf("[reflection] user %s raw output (%d chars, %d tokens in, %d out)",
		userID, len(rawOutput), result.TokensIn, result.TokensOut)

	// 5. Parse JSON response
	var reflection ReflectionResult
	jsonStr := rawOutput
	// Strip markdown fences if the model added them anyway
	if idx := strings.Index(jsonStr, "{"); idx > 0 {
		jsonStr = jsonStr[idx:]
	}
	if idx := strings.LastIndex(jsonStr, "}"); idx >= 0 && idx < len(jsonStr)-1 {
		jsonStr = jsonStr[:idx+1]
	}
	if err := json.Unmarshal([]byte(jsonStr), &reflection); err != nil {
		log.Printf("[reflection] failed to parse JSON for user %s: %v\nRaw: %s", userID, err, rawOutput)
		// Still persist raw output so it isn't lost
		_, _ = db.Pool.Exec(ctx,
			`INSERT INTO reflections (user_id, date, raw_output)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (user_id, date) DO UPDATE SET raw_output=$3`,
			userID, today, rawOutput,
		)
		return fmt.Errorf("reflection JSON parse error: %w", err)
	}

	// 6. Save to reflections table
	if err := saveReflectionToDB(ctx, userID, loc, reflection, rawOutput); err != nil {
		return fmt.Errorf("reflection DB save failed: %w", err)
	}

	// 6b. Embed reflection in cognitive memory
	var reflectionID uuid.UUID
	err = db.Pool.QueryRow(ctx,
		`SELECT id FROM reflections WHERE user_id=$1 AND date=$2`,
		userID, today,
	).Scan(&reflectionID)
	if err == nil {
		go cognitive.EmbedReflection(context.Background(), userID, reflectionID, today, rawOutput)
	}

	// 7. Auto-apply lessons and patterns
	applyLessons(ctx, userID, reflection, today)

	// 8. Apply reflection results to active plans and goals
	applyReflectionToPlans(ctx, userID, reflection)

	// Extract/update goals from reflection
	ExtractGoalsFromReflection(ctx, userID, reflection, router)

	log.Printf("[reflection] user %s reflection complete: score=%.1f lessons=%d patterns=%d",
		userID, reflection.PerformanceScore, len(reflection.Lessons), len(reflection.DetectedPatterns))
	return nil
}
