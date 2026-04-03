package autonomous

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/ahvholding/ahvclaw/ai"
	"github.com/ahvholding/ahvclaw/cognitive"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/engine"
	"github.com/ahvholding/ahvclaw/prompts"
	"github.com/ahvholding/ahvclaw/tools"
	"github.com/google/uuid"
)

// DeliverFunc is the callback for delivering heartbeat output to a user channel.
type DeliverFunc func(userID uuid.UUID, channel, chatID, text string)

// Daemon holds state for the heartbeat daemon.
type Daemon struct {
	router      *ai.RouterClient
	deliverFunc DeliverFunc
}

// NewDaemon creates a new heartbeat Daemon.
func NewDaemon(router *ai.RouterClient, deliver DeliverFunc) *Daemon {
	return &Daemon{router: router, deliverFunc: deliver}
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

		// Skip quiet hours (but trigger consolidation)
		if IsQuietHours(cfg) {
			// Run cognitive consolidation once per day during quiet hours
			var lastConsolidation *time.Time
			db.Pool.QueryRow(ctx,
				`SELECT MAX(started_at) FROM consolidation_runs WHERE user_id=$1 AND started_at > NOW() - INTERVAL '20 hours'`,
				e.userID).Scan(&lastConsolidation)
			if lastConsolidation == nil {
				go func(uid uuid.UUID) {
					cogCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
					defer cancel()
					if run, err := cognitive.RunConsolidation(cogCtx, d.router, uid); err != nil {
						log.Printf("[heartbeat] consolidation error for %s: %v", uid, err)
					} else if run != nil {
						log.Printf("[heartbeat] consolidation complete for %s: scanned=%d merged=%d pruned=%d crossrefs=%d",
							uid, run.EntriesScanned, run.DuplicatesMerged, run.StalePruned, run.NewCrossrefs)
					}
				}(e.userID)
			}
			log.Printf("[heartbeat] quiet hours for user %s, skipping heartbeat", e.userID)
			continue
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

		go d.runForUser(cfg)
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
	safeAITools := toAITools(tools.SafeToolsOnly())

	// Build executor for user workspace
	workspaceDir := fmt.Sprintf("/data/ahvclaw/workspaces/%s", cfg.UserID.String())
	os.MkdirAll(workspaceDir, 0755)
	executor := tools.NewExecutor(workspaceDir, cfg.UserID.String())

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

	// Build system prompt
	systemPrompt := buildHeartbeatPrompt(cfg)

	messages := []ai.ChatMessage{
		{Role: "system", Content: systemPrompt},
		{Role: "user", Content: buildHeartbeatTask(cfg)},
	}

	var outputBuf string
	tokensIn, tokensOut := 0, 0

	result, err := engine.ProcessChat(ctx, engine.ChatConfig{
		AIRouter:      d.router,
		Model:         model,
		FallbackModels: fallbackModels,
		Messages:      messages,
		Tools:         safeAITools,
		Executor:      executor,
		MaxToolRounds: 5,
		OnDone: func(in, out int) {
			tokensIn = in
			tokensOut = out
		},
	})

	if err != nil {
		log.Printf("[heartbeat] run %s ProcessChat error: %v", runID, err)
		db.Pool.Exec(context.Background(),
			`UPDATE heartbeat_runs SET finished_at=NOW(), summary=$1, tokens_used=$2 WHERE id=$3`,
			"error: "+err.Error(), 0, runID)
		return
	}

	outputBuf = result.Content
	_ = tokensIn

	// Deliver output if non-empty and delivery configured
	if outputBuf != "" && cfg.DeliveryChannel != "" {
		if d.deliverFunc != nil {
			d.deliverFunc(cfg.UserID, cfg.DeliveryChannel, cfg.DeliveryChatID, outputBuf)
		}
	}

	// Update run record
	db.Pool.Exec(context.Background(),
		`UPDATE heartbeat_runs SET finished_at=NOW(), tokens_used=$1, summary=$2 WHERE id=$3`,
		tokensOut, summarize(outputBuf, 500), runID,
	)

	// Log as action
	status := "executed"
	LogAction(context.Background(), cfg.UserID, &runID,
		"read", "heartbeat", "Heartbeat autonomous check", 10, status, ptr(outputBuf), nil)

	log.Printf("[heartbeat] run %s complete for user %s (%d tokens)", runID, cfg.UserID, tokensOut)
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
	return prompts.DefaultSystemPrompt + fmt.Sprintf(`

## Autonomous Heartbeat Mode
You are running in fully autonomous mode. The user is not present.
Your job: proactively check on things, surface insights, and take low-risk actions.
- Only use safe read/low-risk tools (file_read, file_list, file_search, http_request, memory_save, memory_search, server_status, knowledge_search)
- Do NOT write files, execute commands, or make external changes unless explicitly trusted
- Keep output concise (2-5 sentences or a short bullet list)
- Delivery channel: %s
`, cfg.DeliveryChannel)
}

// buildHeartbeatTask builds the user-turn prompt for a heartbeat run.
func buildHeartbeatTask(cfg HeartbeatConfig) string {
	loc, _ := time.LoadLocation(cfg.Timezone)
	now := time.Now().In(loc)
	return fmt.Sprintf(
		"[Autonomous heartbeat @ %s]\nReview recent context, check for anything noteworthy, and produce a brief status update or insight for the user.",
		now.Format("2006-01-02 15:04"),
	)
}

// summarize truncates text to maxLen bytes.
func summarize(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}

// ptr returns a pointer to the given string.
func ptr(s string) *string { return &s }
