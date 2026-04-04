package autonomous

import (
	"context"
	"encoding/json"
	"log"
	"strings"

	"github.com/ahvholding/ahvclaw/ai"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/engine"
	"github.com/google/uuid"
)

type ExtractedGoal struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Priority    string `json:"priority"`
}

// ExtractGoalsFromConversation analyzes messages and creates goals if detected.
func ExtractGoalsFromConversation(ctx context.Context, userID uuid.UUID, userMessage, assistantResponse string, router *ai.RouterClient) {
	if len(userMessage) < 50 {
		return
	}

	prompt := `Analyze this conversation and extract any implicit or explicit goals/tasks the user wants accomplished.
Return JSON array (empty [] if no goals detected):
[{"title": "short title", "description": "what needs to be done", "priority": "high|medium|low"}]

Rules:
- Only extract clear, actionable goals (not vague wishes or greetings)
- Don't extract goals already completed in this conversation
- Priority: high = urgent/important, medium = normal, low = nice-to-have
- Return raw JSON only, no markdown fences
- Maximum 3 goals per conversation

User message: ` + userMessage + `
Assistant response: ` + assistantResponse

	model := getUserModel(ctx, userID)
	result, err := engine.ProcessChat(ctx, engine.ChatConfig{
		AIRouter:      router,
		Model:         model,
		Messages:      []ai.ChatMessage{{Role: "user", Content: prompt}},
		MaxToolRounds: 0,
	})
	if err != nil {
		log.Printf("[goals] extraction error: %v", err)
		return
	}

	raw := strings.TrimSpace(result.Content)
	if idx := strings.Index(raw, "["); idx >= 0 {
		raw = raw[idx:]
	}
	if idx := strings.LastIndex(raw, "]"); idx >= 0 {
		raw = raw[:idx+1]
	}

	var goals []ExtractedGoal
	if err := json.Unmarshal([]byte(raw), &goals); err != nil {
		log.Printf("[goals] parse error: %v", err)
		return
	}

	for _, g := range goals {
		if g.Title == "" {
			continue
		}
		// Validate priority
		switch g.Priority {
		case "high", "medium", "low", "critical":
		default:
			g.Priority = "medium"
		}
		// Check for duplicate
		var exists int
		db.Pool.QueryRow(ctx,
			`SELECT COUNT(*) FROM goals WHERE user_id=$1 AND title=$2 AND status NOT IN ('completed','abandoned')`,
			userID, g.Title).Scan(&exists)
		if exists > 0 {
			continue
		}
		created, err := CreateGoal(ctx, userID, g.Title, g.Description, g.Priority, "conversation", nil, nil)
		if err != nil {
			log.Printf("[goals] create error: %v", err)
		} else {
			log.Printf("[goals] extracted: %s (priority=%s, id=%s)", g.Title, g.Priority, created.ID)
			// Auto-plan: create scheduled tasks for this goal
			go PlanGoal(context.Background(), userID, created.ID, g.Title, g.Description, router)
		}
	}
}

// ExtractGoalsFromReflection creates or updates goals from reflection results.
func ExtractGoalsFromReflection(ctx context.Context, userID uuid.UUID, reflection ReflectionResult, router ...*ai.RouterClient) {
	for _, gp := range reflection.GoalsProgress {
		if gp.GoalTitle == "" {
			continue
		}
		var goalID uuid.UUID
		err := db.Pool.QueryRow(ctx,
			`SELECT id FROM goals WHERE user_id=$1 AND title=$2 LIMIT 1`,
			userID, gp.GoalTitle).Scan(&goalID)
		if err != nil {
			// Goal doesn't exist, create it
			created, err := CreateGoal(ctx, userID, gp.GoalTitle, gp.Note, "medium", "reflection", nil, nil)
			if err != nil {
				log.Printf("[goals] reflection goal create error: %v", err)
			} else {
				log.Printf("[goals] created goal from reflection: %s", gp.GoalTitle)
				if len(router) > 0 && router[0] != nil {
					go PlanGoal(context.Background(), userID, created.ID, gp.GoalTitle, gp.Note, router[0])
				}
			}
		} else if gp.Progress > 0 {
			UpdateGoal(ctx, userID, goalID, map[string]interface{}{"progress": float64(gp.Progress)})
			log.Printf("[goals] updated goal progress: %s -> %d%%", gp.GoalTitle, gp.Progress)
		}
	}
}