package autonomous

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/ahvholding/ahvclaw/ai"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/engine"
	"github.com/google/uuid"
)

// PlanStep represents a single step in an execution plan.
type PlanStep struct {
	Description string `json:"description"`
	ToolName    string `json:"tool_name"`
	ToolArgs    string `json:"tool_args"`
	Status      string `json:"status"` // pending, running, done, failed, skipped, blocked
	Output      string `json:"output"`
	RetryCount  int    `json:"retry_count"`
	MaxRetries  int    `json:"max_retries"`
	Blocker     string `json:"blocker,omitempty"`
}

// ExecutionPlan represents a multi-step autonomous action plan.
type ExecutionPlan struct {
	ID          uuid.UUID  `json:"id"`
	UserID      uuid.UUID  `json:"user_id"`
	GoalID      *uuid.UUID `json:"goal_id"`
	Title       string     `json:"title"`
	Steps       []PlanStep `json:"steps"`
	CurrentStep int        `json:"current_step"`
	Status      string     `json:"status"` // pending, running, completed, failed, blocked
	Result      string     `json:"result"`
}

// CreatePlan asks the AI to break a goal into executable steps.
func CreatePlan(ctx context.Context, userID uuid.UUID, goalID uuid.UUID, goalTitle, goalDesc string, router *ai.RouterClient) (*ExecutionPlan, error) {
	prompt := fmt.Sprintf(`Hãy chia nhỏ mục tiêu này thành 2-5 bước cụ thể có thể thực thi.
Mục tiêu: %s
Mô tả: %s

Trả về JSON array:
[{"description": "mô tả bước", "tool_name": "tên tool", "tool_args": "{\"arg\": \"value\"}"}]

Các tool có thể dùng: memory_search, memory_save, file_read, file_write, file_list, terminal_exec, http_request, knowledge_search
Mỗi bước là một tool call duy nhất. Viết cụ thể các tham số.`, goalTitle, goalDesc)

	model := getUserModel(ctx, userID)
	if model == "" {
		model = "AHV-Holding-TroLy"
	}

	result, err := engine.ProcessChat(ctx, engine.ChatConfig{
		AIRouter: router,
		Model:    model,
		Messages: []ai.ChatMessage{
			{Role: "system", Content: "Bạn là planning agent. Chỉ trả về JSON array hợp lệ, không có text khác."},
			{Role: "user", Content: prompt},
		},
		MaxToolRounds: 0,
	})
	if err != nil {
		return nil, fmt.Errorf("plan creation failed: %w", err)
	}

	jsonStr := extractPlanJSON(result.Content)
	var steps []PlanStep
	if err := json.Unmarshal([]byte(jsonStr), &steps); err != nil {
		return nil, fmt.Errorf("failed to parse plan JSON: %w", err)
	}

	if len(steps) == 0 {
		return nil, fmt.Errorf("AI returned empty plan")
	}
	if len(steps) > 10 {
		steps = steps[:10]
	}

	for i := range steps {
		steps[i].Status = "pending"
		steps[i].MaxRetries = 2
	}

	plan := &ExecutionPlan{
		ID:     uuid.New(),
		UserID: userID,
		GoalID: &goalID,
		Title:  goalTitle,
		Steps:  steps,
		Status: "pending",
	}

	stepsJSON, _ := json.Marshal(steps)
	_, err = db.Pool.Exec(ctx,
		`INSERT INTO execution_plans (id, user_id, goal_id, title, steps, status, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, now())`,
		plan.ID, userID, goalID, goalTitle, stepsJSON, "pending")
	if err != nil {
		return nil, fmt.Errorf("failed to save plan: %w", err)
	}

	log.Printf("[planner] created plan %s with %d steps for user %s", goalTitle, len(steps), userID)
	return plan, nil
}

// GetActivePlan returns the current in-progress plan for a user.
func GetActivePlan(ctx context.Context, userID uuid.UUID) (*ExecutionPlan, error) {
	var plan ExecutionPlan
	var stepsJSON []byte
	var goalID *uuid.UUID
	var result *string

	err := db.Pool.QueryRow(ctx, `
		SELECT id, user_id, goal_id, title, steps, current_step, status, result
		FROM execution_plans
		WHERE user_id=$1 AND status IN ('pending','running','blocked')
		ORDER BY created_at DESC LIMIT 1`,
		userID).Scan(&plan.ID, &plan.UserID, &goalID, &plan.Title,
		&stepsJSON, &plan.CurrentStep, &plan.Status, &result)
	if err != nil {
		return nil, err
	}

	plan.GoalID = goalID
	if result != nil {
		plan.Result = *result
	}
	json.Unmarshal(stepsJSON, &plan.Steps)
	return &plan, nil
}

// AdvancePlan moves the plan forward by marking current step complete and updating state.
func AdvancePlan(ctx context.Context, plan *ExecutionPlan, stepOutput string, stepErr error) {
	if plan.CurrentStep >= len(plan.Steps) {
		return
	}

	step := &plan.Steps[plan.CurrentStep]
	if stepErr != nil {
		step.Status = "failed"
		step.Output = stepErr.Error()
		// Try retry before marking plan as failed
		if !RetryStep(plan) {
			plan.Status = "failed"
			plan.Result = fmt.Sprintf("Thất bại ở bước %d: %s", plan.CurrentStep+1, stepErr.Error())
		}
	} else {
		step.Status = "done"
		if len(stepOutput) > 2000 {
			stepOutput = stepOutput[:2000] + "...(truncated)"
		}
		step.Output = stepOutput
		plan.CurrentStep++
		if plan.CurrentStep >= len(plan.Steps) {
			plan.Status = "completed"
			plan.Result = "Tất cả các bước đã hoàn thành."
		} else {
			plan.Status = "running"
		}
	}

	savePlanState(ctx, plan)
}

// RetryStep resets a failed step for retry if under max_retries.
func RetryStep(plan *ExecutionPlan) bool {
	if plan.CurrentStep >= len(plan.Steps) {
		return false
	}
	step := &plan.Steps[plan.CurrentStep]
	if step.Status != "failed" {
		return false
	}
	if step.RetryCount >= step.MaxRetries {
		return false
	}
	step.RetryCount++
	step.Status = "pending"
	step.Blocker = ""
	plan.Status = "running"
	return true
}

// SkipStep marks current step as skipped and moves to next.
func SkipStep(plan *ExecutionPlan, reason string) {
	if plan.CurrentStep >= len(plan.Steps) {
		return
	}
	step := &plan.Steps[plan.CurrentStep]
	step.Status = "skipped"
	step.Blocker = reason
	plan.CurrentStep++
	if plan.CurrentStep >= len(plan.Steps) {
		plan.Status = "completed"
		plan.Result = "Hoàn thành (một số bước đã bỏ qua)"
	}
}

// BlockStep marks current step as blocked.
func BlockStep(plan *ExecutionPlan, reason string) {
	if plan.CurrentStep >= len(plan.Steps) {
		return
	}
	step := &plan.Steps[plan.CurrentStep]
	step.Status = "blocked"
	step.Blocker = reason
	plan.Status = "blocked"
	plan.Result = fmt.Sprintf("Bị chặn ở bước %d: %s", plan.CurrentStep+1, reason)
}

func savePlanState(ctx context.Context, plan *ExecutionPlan) {
	stepsJSON, _ := json.Marshal(plan.Steps)
	db.Pool.Exec(ctx,
		`UPDATE execution_plans SET steps=$1, current_step=$2, status=$3, result=$4, updated_at=now()
		 WHERE id=$5`,
		stepsJSON, plan.CurrentStep, plan.Status, plan.Result, plan.ID)
}

func extractPlanJSON(s string) string {
	start := -1
	end := -1
	for i, c := range s {
		if c == 0x5B && start == -1 {
			start = i
		}
		if c == 0x5D {
			end = i
		}
	}
	if start >= 0 && end > start {
		return s[start : end+1]
	}
	return "[]"
}
