package scheduler

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/google/uuid"
)

// TaskExecFunc runs AI with a prompt and returns the result.
type TaskExecFunc func(ctx context.Context, taskID, userID uuid.UUID, agentID *uuid.UUID, prompt string) (result string, tokensIn, tokensOut int, toolsUsed []string, err error)

// DeliverFunc delivers a result to a channel.
type DeliverFunc func(userID uuid.UUID, channel string, chatID *string, botID *uuid.UUID, content string) error

// Scheduler polls the DB for due tasks and dispatches them.
type Scheduler struct {
	execFn    TaskExecFunc
	deliverFn DeliverFunc
	stopCh    chan struct{}
	running   map[string]int // concurrent task count per user
	mu        sync.Mutex
}

// New creates a new Scheduler.
func New(execFn TaskExecFunc, deliverFn DeliverFunc) *Scheduler {
	return &Scheduler{
		execFn:    execFn,
		deliverFn: deliverFn,
		stopCh:    make(chan struct{}),
		running:   make(map[string]int),
	}
}

// Start begins the scheduler loop in a background goroutine.
func (s *Scheduler) Start() {
	go func() {
		log.Println("[scheduler] started")
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()

		// Run once immediately on start
		s.tick()

		for {
			select {
			case <-ticker.C:
				s.tick()
			case <-s.stopCh:
				log.Println("[scheduler] stopped")
				return
			}
		}
	}()
}

// Stop signals the scheduler to stop.
func (s *Scheduler) Stop() {
	close(s.stopCh)
}

// tick queries for due tasks and dispatches them.
func (s *Scheduler) tick() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	rows, err := db.Pool.Query(ctx,
		`SELECT id, user_id, agent_id, name, prompt, schedule, timezone,
		        delivery_channel, delivery_chat_id, bot_id, error_count
		 FROM scheduled_tasks
		 WHERE is_active = true AND next_run_at <= now()
		 ORDER BY next_run_at ASC
		 LIMIT 20`)
	if err != nil {
		log.Printf("[scheduler] tick query error: %v", err)
		return
	}
	defer rows.Close()

	type taskRow struct {
		ID              uuid.UUID
		UserID          uuid.UUID
		AgentID         *uuid.UUID
		Name            string
		Prompt          string
		Schedule        string
		Timezone        string
		DeliveryChannel string
		DeliveryChatID  *string
		BotID           *uuid.UUID
		ErrorCount      int
	}

	var tasks []taskRow
	for rows.Next() {
		var t taskRow
		if err := rows.Scan(&t.ID, &t.UserID, &t.AgentID, &t.Name, &t.Prompt,
			&t.Schedule, &t.Timezone, &t.DeliveryChannel, &t.DeliveryChatID,
			&t.BotID, &t.ErrorCount); err != nil {
			log.Printf("[scheduler] scan error: %v", err)
			continue
		}
		tasks = append(tasks, t)
	}

	for _, t := range tasks {
		userKey := t.UserID.String()

		s.mu.Lock()
		if s.running[userKey] >= 3 {
			s.mu.Unlock()
			log.Printf("[scheduler] user %s at concurrent limit, skipping task %s", userKey, t.Name)
			continue
		}
		s.running[userKey]++
		s.mu.Unlock()

		go s.executeTask(t.ID, t.UserID, t.AgentID, t.Name, t.Prompt,
			t.Schedule, t.Timezone, t.DeliveryChannel, t.DeliveryChatID,
			t.BotID, t.ErrorCount)
	}
}

// executeTask runs a single task: inserts a task_run, executes via execFn, updates results.
func (s *Scheduler) executeTask(
	taskID, userID uuid.UUID, agentID *uuid.UUID,
	name, prompt, schedule, timezone, deliveryChannel string,
	deliveryChatID *string, botID *uuid.UUID, errorCount int,
) {
	userKey := userID.String()
	defer func() {
		s.mu.Lock()
		s.running[userKey]--
		if s.running[userKey] <= 0 {
			delete(s.running, userKey)
		}
		s.mu.Unlock()
	}()

	ctx := context.Background()
	runID := uuid.New()
	now := time.Now()

	// Insert task_run with status='running'
	_, err := db.Pool.Exec(ctx,
		"INSERT INTO task_runs (id, task_id, status, started_at) VALUES ($1, $2, 'running', $3)",
		runID, taskID, now)
	if err != nil {
		log.Printf("[scheduler] failed to insert task_run for %s: %v", name, err)
		return
	}

	log.Printf("[scheduler] executing task '%s' (id=%s)", name, taskID)

	// Execute with 5-minute timeout
	execCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	result, tokensIn, tokensOut, toolsUsed, execErr := s.execFn(execCtx, taskID, userID, agentID, prompt)

	finishedAt := time.Now()
	status := "success"
	var errText *string
	newErrorCount := 0

	if execErr != nil {
		status = "failed"
		errStr := execErr.Error()
		errText = &errStr
		newErrorCount = errorCount + 1
		log.Printf("[scheduler] task '%s' failed: %v", name, execErr)
	} else {
		log.Printf("[scheduler] task '%s' completed (tokens: %d/%d)", name, tokensIn, tokensOut)
	}

	// Marshal tools_used
	toolsJSON, _ := json.Marshal(toolsUsed)
	if toolsUsed == nil {
		toolsJSON = []byte("[]")
	}

	// Update task_run
	_, _ = db.Pool.Exec(ctx,
		"UPDATE task_runs SET status=$1, finished_at=$2, result=$3, error=$4, tokens_in=$5, tokens_out=$6, tools_used=$7 WHERE id=$8",
		status, finishedAt, result, errText, tokensIn, tokensOut, toolsJSON, runID)

	// Calculate next run time
	nextRun, nextErr := NextRunTimeAfter(schedule, timezone, time.Now())
	if nextErr != nil {
		log.Printf("[scheduler] failed to calculate next run for '%s': %v", name, nextErr)
	}

	// Auto-pause after 5 consecutive failures
	isActive := true
	if newErrorCount >= 5 {
		isActive = false
		log.Printf("[scheduler] auto-pausing task '%s' after %d consecutive failures", name, newErrorCount)
	}

	if execErr != nil {
		// Update with incremented error_count
		_, _ = db.Pool.Exec(ctx,
			"UPDATE scheduled_tasks SET last_run_at=$1, next_run_at=$2, run_count=run_count+1, error_count=$3, is_active=$4, updated_at=now() WHERE id=$5",
			now, nextRun, newErrorCount, isActive, taskID)
	} else {
		// Reset error_count on success
		_, _ = db.Pool.Exec(ctx,
			"UPDATE scheduled_tasks SET last_run_at=$1, next_run_at=$2, run_count=run_count+1, error_count=0, is_active=$3, updated_at=now() WHERE id=$4",
			now, nextRun, isActive, taskID)
	}

	// Deliver result
	if execErr == nil && s.deliverFn != nil {
		deliveryContent := fmt.Sprintf("[Task: %s]\n\n%s", name, result)
		if dErr := s.deliverFn(userID, deliveryChannel, deliveryChatID, botID, deliveryContent); dErr != nil {
			log.Printf("[scheduler] delivery failed for task '%s': %v", name, dErr)
		}
	}
}
