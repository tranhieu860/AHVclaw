package autonomous

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"log"
	"os"
	"time"

	"github.com/ahvholding/ahvclaw/ai"
	"strings"

	"github.com/ahvholding/ahvclaw/cognitive"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/engine"
	"github.com/ahvholding/ahvclaw/prompts"
	"github.com/ahvholding/ahvclaw/tools"
	"github.com/google/uuid"
)

var (
	heartbeatSem         = make(chan struct{}, 5) // max 5 concurrent heartbeat runs
	consolidationRunning sync.Map
	reflectionRunning    sync.Map
)

// DeliverFunc is the callback for delivering heartbeat output to a user channel.
type DeliverFunc func(userID uuid.UUID, channel, chatID, text string)

// Daemon holds state for the heartbeat daemon.
type Daemon struct {
	connPool    *ai.ConnectionPool
	router      *ai.RouterClient
	deliverFunc DeliverFunc
}

// NewDaemon creates a new heartbeat Daemon.
func NewDaemon(router *ai.RouterClient, connPool *ai.ConnectionPool, deliver DeliverFunc) *Daemon {
	return &Daemon{router: router, connPool: connPool, deliverFunc: deliver}
}

// Start launches the heartbeat ticker. It blocks; call in a goroutine.
func (d *Daemon) Start(ctx context.Context) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	log.Println("[heartbeat] daemon started")
	for {
		select {
		case <-ctx.Done():
			log.Println("[heartbeat] daemon stopping")
			return
		case <-ticker.C:
			d.tick(ctx)
		}
	}
}

// tick checks all enabled users and spawns goroutines for those due.
func (d *Daemon) tick(ctx context.Context) {
	rows, err := db.Pool.Query(ctx,
		`SELECT user_id, interval_min FROM heartbeat_config WHERE enabled = true`)
	if err != nil {
		log.Printf("[heartbeat] query heartbeat_config error: %v", err)
		return
	}
	defer rows.Close()

	type entry struct {
		userID      uuid.UUID
		intervalMin int
	}
	var entries []entry
	for rows.Next() {
		var e entry
		if err := rows.Scan(&e.userID, &e.intervalMin); err != nil {
			continue
		}
		entries = append(entries, e)
	}

	for _, e := range entries {
		// Check if enough time has elapsed since last run
		if !d.isDue(ctx, e.userID, e.intervalMin) {
			continue
		}

		// Load full config for quiet hours etc.
		cfg, err := LoadConfig(ctx, e.userID)
		if err != nil {
			log.Printf("[heartbeat] load config for %s: %v", e.userID, err)
			continue
		}

		// Skip quiet hours (but trigger reflection + consolidation)
		if IsQuietHours(cfg) {
			// Run daily reflection during quiet hours (before consolidation)
			var lastReflection *time.Time
			db.Pool.QueryRow(ctx,
				`SELECT MAX(created_at) FROM reflections WHERE user_id=$1 AND created_at > NOW() - INTERVAL '20 hours'`,
				e.userID).Scan(&lastReflection)
			if lastReflection == nil {
				if _, loaded := reflectionRunning.LoadOrStore(e.userID, true); !loaded {
					go func(uid uuid.UUID, tz string) {
						defer reflectionRunning.Delete(uid)
						refCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
						defer cancel()
						if err := RunReflection(refCtx, uid, tz, d.connPool.Resolve(refCtx, uid, "AHV-Holding").CreateClient()); err != nil {
							log.Printf("[heartbeat] reflection error for %s: %v", uid, err)
						} else {
							log.Printf("[heartbeat] reflection complete for %s", uid)
						}
					}(e.userID, cfg.Timezone)
				}
			}

			// Run cognitive consolidation once per day during quiet hours
			var lastConsolidation *time.Time
			db.Pool.QueryRow(ctx,
				`SELECT MAX(started_at) FROM consolidation_runs WHERE user_id=$1 AND started_at > NOW() - INTERVAL '20 hours'`,
				e.userID).Scan(&lastConsolidation)
			if lastConsolidation == nil {
				if _, loaded := consolidationRunning.LoadOrStore(e.userID, true); !loaded {
					go func(uid uuid.UUID) {
						defer consolidationRunning.Delete(uid)
						log.Printf("[heartbeat] starting consolidation for %s (background, 5m timeout)", uid)
						// Uses context.Background() intentionally: consolidation should finish even on daemon shutdown
						cogCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
						defer cancel()
						if run, err := cognitive.RunConsolidation(cogCtx, d.connPool.Resolve(cogCtx, uid, "AHV-Holding").CreateClient(), uid); err != nil {
						log.Printf("[heartbeat] consolidation error for %s: %v", uid, err)
					} else if run != nil {
							log.Printf("[heartbeat] consolidation complete for %s: scanned=%d merged=%d pruned=%d crossrefs=%d",
								uid, run.EntriesScanned, run.DuplicatesMerged, run.StalePruned, run.NewCrossrefs)
						}
					}(e.userID)
				}
			}
			log.Printf("[heartbeat] quiet hours for user %s, skipping heartbeat", e.userID)
			continue
		}

		// Catch-up: run reflection if it was missed during quiet hours
		{
			var reflToday int
			db.Pool.QueryRow(ctx,
				`SELECT COUNT(*) FROM reflections WHERE user_id=$1 AND date=CURRENT_DATE`,
				e.userID).Scan(&reflToday)
			if reflToday == 0 {
				catchupLoc, _ := time.LoadLocation(cfg.Timezone)
				nowLocal := time.Now().In(catchupLoc)
				if nowLocal.Hour() >= 8 { // Past morning — reflection should have run
					if _, loaded := reflectionRunning.LoadOrStore(e.userID, true); !loaded {
						go func(uid uuid.UUID, tz string) {
							defer reflectionRunning.Delete(uid)
							refCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
							defer cancel()
							if err := RunReflection(refCtx, uid, tz, d.connPool.Resolve(refCtx, uid, "AHV-Holding").CreateClient()); err != nil {
								log.Printf("[heartbeat] catch-up reflection error for %s: %v", uid, err)
							} else {
								log.Printf("[heartbeat] catch-up reflection complete for %s", uid)
							}
						}(e.userID, cfg.Timezone)
					}
				}
			}
		}

		// Catch-up: run consolidation if missed
		{
			var consolToday int
			db.Pool.QueryRow(ctx,
				`SELECT COUNT(*) FROM consolidation_runs WHERE user_id=$1 AND started_at > CURRENT_DATE`,
				e.userID).Scan(&consolToday)
			if consolToday == 0 {
				catchupLoc, _ := time.LoadLocation(cfg.Timezone)
				nowLocal := time.Now().In(catchupLoc)
				if nowLocal.Hour() >= 9 {
					if _, loaded := consolidationRunning.LoadOrStore(e.userID, true); !loaded {
						go func(uid uuid.UUID) {
							defer consolidationRunning.Delete(uid)
							cogCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
							defer cancel()
							if run, err := cognitive.RunConsolidation(cogCtx, d.connPool.Resolve(cogCtx, uid, "AHV-Holding").CreateClient(), uid); err != nil {
								log.Printf("[heartbeat] catch-up consolidation error for %s: %v", uid, err)
							} else if run != nil {
								log.Printf("[heartbeat] catch-up consolidation for %s: scanned=%d merged=%d",
									uid, run.EntriesScanned, run.DuplicatesMerged)
							}
						}(e.userID)
					}
				}
			}
		}

		// Check rate limit
		count, err := CountActionsThisHour(ctx, e.userID)
		if err == nil && count >= cfg.MaxActionsHour {
			log.Printf("[heartbeat] rate limit reached for user %s (%d/%d)", e.userID, count, cfg.MaxActionsHour)
			continue
		}

		// Auto-pause on 3+ recent rejections
		rejections, err := CountRecentRejections(ctx, e.userID)
		if err == nil && rejections >= 3 {
			log.Printf("[heartbeat] auto-pause for user %s (recent rejections=%d)", e.userID, rejections)
			continue
		}

		go func(c HeartbeatConfig) {
			heartbeatSem <- struct{}{}
			defer func() { <-heartbeatSem }()
			d.runForUser(c)
		}(cfg)
	}
}

// isDue returns true if enough time has passed since the last heartbeat run.
func (d *Daemon) isDue(ctx context.Context, userID uuid.UUID, intervalMin int) bool {
	var lastRun time.Time
	err := db.Pool.QueryRow(ctx,
		`SELECT started_at FROM heartbeat_runs WHERE user_id=$1 ORDER BY started_at DESC LIMIT 1`,
		userID,
	).Scan(&lastRun)
	if err != nil {
		// No previous run → due immediately
		return true
	}
	return time.Since(lastRun) >= time.Duration(intervalMin)*time.Minute
}

// runForUser executes a heartbeat run for one user.
func (d *Daemon) runForUser(cfg HeartbeatConfig) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	runID := uuid.New()
	startedAt := time.Now()

	// Insert heartbeat_runs row
	_, err := db.Pool.Exec(ctx,
		`INSERT INTO heartbeat_runs (id, user_id, started_at) VALUES ($1, $2, $3)`,
		runID, cfg.UserID, startedAt,
	)
	if err != nil {
		log.Printf("[heartbeat] failed to insert run row for %s: %v", cfg.UserID, err)
		return
	}

	log.Printf("[heartbeat] starting run %s for user %s", runID, cfg.UserID)

	// Build safe tool list converted to ai.Tool
	safeAITools := toAITools(tools.AutonomousToolsOnly())

	// Build executor for user workspace
	workspaceDir := fmt.Sprintf("/data/ahvclaw/workspaces/%s", cfg.UserID.String())
	os.MkdirAll(workspaceDir, 0755)
	executor := tools.NewExecutor(workspaceDir, cfg.UserID.String())
	executor.IsAutonomous = true
	userID := cfg.UserID
	executor.TrustCheckFunc = func(category, toolName string) (string, error) {
		decision, _, err := CheckTrust(context.Background(), userID, category, toolName)
		return decision, err
	}
	if d.deliverFunc != nil && cfg.DeliveryChatID != "" {
		executor.DeliverFunc = func(text string) {
			d.deliverFunc(cfg.UserID, cfg.DeliveryChannel, cfg.DeliveryChatID, text)
		}
	}

	// Wire up comprehensive audit logging for autonomous actions
	executor.AuditFunc = func(toolName, actionType, status string, trustScore, latencyMs, exitStatus int, result, errMsg string) {
		LogAutonomousAction(context.Background(), AuditEntry{
			UserID:         userID,
			HeartbeatRunID: &runID,
			ActionType:     actionType,
			ActionPattern:  toolName,
			ToolID:         toolName,
			Description:    fmt.Sprintf("Autonomous exec: %s", toolName),
			TrustScore:     trustScore,
			Status:         status,
			LatencyMs:      latencyMs,
			ExitStatus:     exitStatus,
			Result:         result,
			Error:          errMsg,
		})
	}

	// Look up user's preferred model
	model := "AHV-Holding"
	var userModel string
	db.Pool.QueryRow(ctx,
		`SELECT value FROM user_settings WHERE user_id=$1 AND key='default_model'`,
		cfg.UserID).Scan(&userModel)
	if userModel != "" {
		model = userModel
	}

	// Look up fallback models
	var fallbackModels string
	db.Pool.QueryRow(ctx,
		`SELECT value FROM user_settings WHERE user_id=$1 AND key='fallback_models'`,
		cfg.UserID).Scan(&fallbackModels)

	// Check for stuck goals before building prompt (loop breaker)
	hbResolved := d.connPool.Resolve(ctx, userID, model)
	hbRouter := hbResolved.CreateClient()

	stuckCount := CheckAndSkipStuckGoals(ctx, cfg.UserID)
	if stuckCount > 0 {
		log.Printf("[heartbeat] loop_breaker marked %d stuck goals for user %s", stuckCount, cfg.UserID)
	}

	// Build system prompt
	systemPrompt := buildHeartbeatPrompt(cfg)

	// Check for active execution plan and inject context
	plan, planErr := GetActivePlan(ctx, cfg.UserID)

	// If no active plan, check if we should create one for a complex goal
	if planErr != nil || plan == nil {
		topGoal := pickTopGoalForPlanning(ctx, cfg.UserID)
		if topGoal != nil {
			log.Printf("[heartbeat] no active plan for user %s, creating plan for goal: %s", cfg.UserID, topGoal.Title)
			desc := ""
			if topGoal.Description != nil {
				desc = *topGoal.Description
			}
			newPlan, createErr := CreatePlan(ctx, cfg.UserID, topGoal.ID, topGoal.Title, desc, hbRouter)
			if createErr != nil {
				log.Printf("[heartbeat] failed to create plan for goal %s: %v", topGoal.Title, createErr)
			} else {
				plan = newPlan
				planErr = nil
				log.Printf("[heartbeat] created plan %s with %d steps for goal %s", newPlan.ID, len(newPlan.Steps), topGoal.Title)
				// Mark goal as in_progress
				db.Pool.Exec(ctx, `UPDATE goals SET status='in_progress', updated_at=now() WHERE id=$1`, topGoal.ID)
			}
		}
	}

	if planErr == nil && plan != nil && plan.CurrentStep < len(plan.Steps) {
		step := plan.Steps[plan.CurrentStep]
		log.Printf("[heartbeat] active plan for user %s: step %d/%d - %s (tool: %s)",
			cfg.UserID, plan.CurrentStep+1, len(plan.Steps), step.Description, step.ToolName)
		plan.Status = "running"
		savePlanState(ctx, plan)
		systemPrompt += fmt.Sprintf(
			"\n\nKẾ HOẠCH ĐANG THỰC HIỆN: %s\nBước tiếp theo (%d/%d): %s\nTool: %s\nArgs: %s\nHãy thực hiện bước này ngay.",
			plan.Title, plan.CurrentStep+1, len(plan.Steps),
			step.Description, step.ToolName, step.ToolArgs)
	}

	messages := []ai.ChatMessage{
		{Role: "system", Content: systemPrompt},
		{Role: "user", Content: buildHeartbeatTask(cfg)},
	}

	var outputBuf string
	tokensIn, tokensOut := 0, 0
	var actionCount int

	result, err := engine.ProcessChat(ctx, engine.ChatConfig{
		AIRouter:       hbRouter,
		Model:          hbResolved.Model,
		FallbackModels: fallbackModels,
		Messages:       messages,
		Tools:          safeAITools,
		Executor:       executor,
		MaxToolRounds:  5,
		OnToolCall: func(name, args string) {
			log.Printf("[heartbeat] tool call: %s", name)
		},
		OnToolResult: func(name, content, errStr string) {
			actionCount++
			status := "success"
			if errStr != "" {
				status = "error"
			}
			db.Pool.Exec(context.Background(),
				`INSERT INTO tool_logs (user_id, tool_name, input, output, status, duration_ms, source)
				 VALUES ($1, $2, '{}'::jsonb, to_jsonb($3::text), $4, 0, 'heartbeat')`,
				cfg.UserID, name, truncateStr(content, 2000), status)
			log.Printf("[heartbeat] tool result: %s (status=%s)", name, status)
		},
		OnDone: func(in, out int) {
			tokensIn = in
			tokensOut = out
		},
	})

	if err != nil {
		log.Printf("[heartbeat] run %s ProcessChat error: %v", runID, err)
		// Advance plan on error (mark step failed, allow retry)
		if planErr == nil && plan != nil && plan.Status == "running" && plan.CurrentStep < len(plan.Steps) {
			AdvancePlan(ctx, plan, "", err)
			log.Printf("[heartbeat] plan step failed for %s: %v (retry=%v)", plan.Title, err, plan.Steps[plan.CurrentStep].Status == "pending")
		}
		db.Pool.Exec(context.Background(),
			`UPDATE heartbeat_runs SET finished_at=NOW(), summary=$1, tokens_used=$2 WHERE id=$3`,
			"error: "+err.Error(), 0, runID)
		return
	}

	outputBuf = result.Content
	_ = tokensIn

	// Advance active plan if one was being executed
	if planErr == nil && plan != nil && plan.Status == "running" && plan.CurrentStep < len(plan.Steps) {
		if actionCount > 0 {
			// At least one tool was called - consider step done
			AdvancePlan(ctx, plan, summarize(outputBuf, 500), nil)
			log.Printf("[heartbeat] advanced plan %s to step %d/%d (status=%s)",
				plan.Title, plan.CurrentStep+1, len(plan.Steps), plan.Status)
		} else if err != nil {
			// ProcessChat returned error - mark step failed (with retry)
			AdvancePlan(ctx, plan, "", err)
			log.Printf("[heartbeat] plan step failed for %s: %v", plan.Title, err)
		}
	}

	// Deliver output if non-empty and delivery configured
	if outputBuf != "" && cfg.DeliveryChannel != "" {
		if d.deliverFunc != nil {
			d.deliverFunc(cfg.UserID, cfg.DeliveryChannel, cfg.DeliveryChatID, outputBuf)
		}
	}

	// Update run record
	_, updateErr := db.Pool.Exec(context.Background(),
		`UPDATE heartbeat_runs SET finished_at=NOW(), tokens_used=$1, summary=$2, actions_taken=$3 WHERE id=$4`,
		tokensOut, summarize(outputBuf, 500), actionCount, runID,
	)
	if updateErr != nil {
		log.Printf("[heartbeat] failed to update run %s: %v", runID, updateErr)
	} else {
		log.Printf("[heartbeat] updated run %s: actions=%d tokens=%d", runID, actionCount, tokensOut)
	}

	// Log as action
	status := "executed"
	LogAction(context.Background(), cfg.UserID, &runID,
		"read", "heartbeat", "Heartbeat autonomous check", 10, status, ptr(outputBuf), nil)

	// Evaluate alerts from heartbeat results
	if outputBuf != "" {
		alerts := EvaluateAlerts(cfg.UserID, "heartbeat", outputBuf)
		for _, alert := range alerts {
			if d.deliverFunc != nil && cfg.DeliveryChatID != "" {
				emoji := "\u2139\ufe0f"
				if alert.Severity == "critical" {
					emoji = "\U0001f6a8"
				} else if alert.Severity == "warning" {
					emoji = "\u26a0\ufe0f"
				}
				msg := fmt.Sprintf("%s *[%s] %s*\n%s", emoji, strings.ToUpper(alert.Severity), alert.Rule, alert.Message)
				d.deliverFunc(cfg.UserID, cfg.DeliveryChannel, cfg.DeliveryChatID, msg)
			}
		}
	}

	log.Printf("[heartbeat] run %s complete for user %s (%d tokens)", runID, cfg.UserID, tokensOut)
}

// pickTopGoalForPlanning finds the best active goal that needs an execution plan.
// It selects goals that: have no existing plan, are active/in_progress, and appear complex.
func pickTopGoalForPlanning(ctx context.Context, userID uuid.UUID) *Goal {
	goals, err := ListGoals(ctx, userID)
	if err != nil || len(goals) == 0 {
		return nil
	}

	for _, g := range goals {
		if g.Status != "active" && g.Status != "in_progress" {
			continue
		}

		// Check if this goal already has a plan (any status)
		var planCount int
		db.Pool.QueryRow(ctx,
			`SELECT COUNT(*) FROM execution_plans WHERE goal_id=$1`, g.ID).Scan(&planCount)
		if planCount > 0 {
			continue
		}

		// Check if goal is complex enough to warrant a plan:
		// - has a description with multiple parts (contains "and", commas, numbered steps)
		// - or has been attempted before (heartbeat ran but progress is still 0)
		desc := ""
		if g.Description != nil {
			desc = *g.Description
		}

		isComplex := len(desc) > 50 ||
			strings.Contains(desc, " and ") ||
			strings.Contains(desc, ", ") ||
			strings.Contains(g.Title, " and ") ||
			g.Progress == 0

		if isComplex {
			goal := g // copy
			return &goal
		}
	}
	return nil
}


// toAITools converts []tools.ToolDef to []ai.Tool
func toAITools(defs []tools.ToolDef) []ai.Tool {
	var result []ai.Tool
	for _, d := range defs {
		result = append(result, ai.Tool{
			Type: d.Type,
			Function: ai.ToolFunction{
				Name:        d.Function.Name,
				Description: d.Function.Description,
				Parameters:  d.Function.Parameters,
			},
		})
	}
	return result
}

// buildHeartbeatPrompt builds the system prompt for heartbeat runs.
func buildHeartbeatPrompt(cfg HeartbeatConfig) string {
	prompt := prompts.DefaultSystemPrompt + fmt.Sprintf(`

## Autonomous Heartbeat Mode — TOOL EXECUTION REQUIRED
You are running autonomously. The user is not present.

CRITICAL INSTRUCTION: You MUST use at least one tool in every heartbeat run.
Do NOT just describe what you would do — actually DO it by calling tools.

Available tools and when to use them:
- memory_search: Search your long-term memory (USE THIS FIRST to recall context)
- knowledge_search: Search knowledge base
- server_status: Check server health metrics (CPU, memory, disk)
- http_request: Make HTTP requests to check services
- file_list: List files in workspace
- file_read: Read file contents
- file_search: Search for files by pattern
- memory_save: Save important findings to memory

WORKFLOW:
1. Read your active goals below
2. Pick the highest priority goal
3. Call memory_search or knowledge_search to gather relevant context
4. Take a concrete action toward the goal
5. If you find something important, call memory_save to remember it
6. Report findings briefly (2-5 sentences)

If no goals exist, proactively check server health using server_status.

Delivery channel: %s
`, cfg.DeliveryChannel)

	// Load and inject prompt suggestions from reflections
	var suggestionsJSON string
	db.Pool.QueryRow(context.Background(),
		`SELECT value FROM user_settings WHERE user_id=$1 AND key='active_prompt_suggestions'`,
		cfg.UserID).Scan(&suggestionsJSON)
	if suggestionsJSON != "" {
		var suggestions []string
		if json.Unmarshal([]byte(suggestionsJSON), &suggestions) == nil && len(suggestions) > 0 {
			prompt += "\n## Self-improvement notes from reflection:\n"
			for _, s := range suggestions {
				prompt += "- " + s + "\n"
			}
		}
	}

	// Always inject personal memories so the bot knows user identity & preferences
	var personalMems strings.Builder
	pRows, pErr := db.Pool.Query(context.Background(),
		`SELECT type, key, content FROM memories
		 WHERE user_id = $1 AND type IN ('user','profile','preference','feedback','correction')
		 ORDER BY updated_at DESC LIMIT 15`, cfg.UserID)
	if pErr == nil && pRows != nil {
		defer pRows.Close()
		for pRows.Next() {
			var mType, mKey, mContent string
			if pRows.Scan(&mType, &mKey, &mContent) == nil {
				personalMems.WriteString(fmt.Sprintf("- [%s] %s: %s\n", mType, mKey, mContent))
			}
		}
	}
	if personalMems.Len() > 0 {
		prompt += "\n## User identity & preferences (ALWAYS follow these):\n" + personalMems.String()
	}

	// Inject user name for personalization
	var userName string
	db.Pool.QueryRow(context.Background(), "SELECT name FROM users WHERE id = $1", cfg.UserID).Scan(&userName)
	if userName != "" {
		prompt += fmt.Sprintf("\nYou are talking to: %s\n", userName)
	}

	return prompt
}

// buildHeartbeatTask builds the user-turn prompt for a heartbeat run.
// It queries active goals, patterns, and mood to create a goal-directed prompt.
func buildHeartbeatTask(cfg HeartbeatConfig) string {
	loc, _ := time.LoadLocation(cfg.Timezone)
	now := time.Now().In(loc)
	ctx := context.Background()

	// Query active goals
	goalsText := "No active goals"
	goals, err := ListGoals(ctx, cfg.UserID)
	if err == nil && len(goals) > 0 {
		var gb []string
		for _, g := range goals {
			if g.Status == "active" || g.Status == "in_progress" {
				gb = append(gb, fmt.Sprintf("- [%s] %s (%d%%) — %s", g.Priority, g.Title, g.Progress, derefStr(g.Description)))
			}
		}
		if len(gb) > 0 {
			goalsText = ""
			for _, line := range gb {
				goalsText += line + "\n"
			}
		}
	}

	// Query recent accepted patterns
	patternsText := "No patterns detected yet"
	patterns, err := ListPatterns(ctx, cfg.UserID)
	if err == nil && len(patterns) > 0 {
		var pb []string
		for _, p := range patterns {
			if p.Status == "accepted" {
				pb = append(pb, fmt.Sprintf("- [%s] %s", p.PatternType, p.Description))
			}
		}
		if len(pb) > 0 {
			patternsText = ""
			for _, line := range pb {
				patternsText += line + "\n"
			}
		}
	}

	// Query recent mood
	moodText := "unknown"
	moodSummary, _ := GetRecentMoodSummary(ctx, cfg.UserID)
	if dominant, ok := moodSummary["dominant_mood"].(string); ok && dominant != "" {
		moodText = dominant
	}

	return fmt.Sprintf(`[Autonomous heartbeat @ %s]

Active goals:
%s
Recent patterns:
%s
Recent mood: %s

Your task:
1. If there are active goals, pick the highest priority one and take a concrete step toward it using your available tools
2. If no goals, proactively check for anything the user might need (server health, pending items, etc.)
3. Keep your action brief and focused — one goal, one action
4. Report what you did and any findings`,
		now.Format("2006-01-02 15:04"),
		goalsText,
		patternsText,
		moodText,
	)
}

// summarize truncates text to maxLen bytes.
func summarize(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}

func truncateStr(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

// ptr returns a pointer to the given string.
func ptr(s string) *string { return &s }
func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
