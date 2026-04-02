package engine

import (
	"context"
	"log"
	"time"

	"github.com/ahvholding/ahvclaw/ai"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/prompts"
	"github.com/google/uuid"
)

const (
	SummaryTriggerCount = 40 // First summary at 40 messages
	SummaryRefreshCount = 30 // Re-summarize every 30 new messages
)

// CheckAndSummarize checks if a conversation needs summarization and triggers it.
// Call this after saving a new message.
func CheckAndSummarize(ctx context.Context, convID uuid.UUID, messageCount int, aiRouter *ai.RouterClient, model string) {
	var summaryAt *time.Time
	db.Pool.QueryRow(ctx, "SELECT summary_at FROM conversations WHERE id = $1", convID).Scan(&summaryAt)

	needsSummary := false
	if summaryAt == nil && messageCount >= SummaryTriggerCount {
		needsSummary = true
	} else if summaryAt != nil {
		var countSince int
		db.Pool.QueryRow(ctx,
			"SELECT COUNT(*) FROM messages WHERE conversation_id = $1 AND created_at > $2",
			convID, *summaryAt).Scan(&countSince)
		if countSince >= SummaryRefreshCount {
			needsSummary = true
		}
	}

	if !needsSummary {
		return
	}

	go func() {
		summarizeCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := generateSummary(summarizeCtx, convID, aiRouter, model); err != nil {
			log.Printf("[summarize] failed for conversation %s: %v", convID, err)
		}
	}()
}

func generateSummary(ctx context.Context, convID uuid.UUID, aiRouter *ai.RouterClient, model string) error {
	rows, err := db.Pool.Query(ctx,
		`SELECT role, content FROM messages
		 WHERE conversation_id = $1 AND role IN ('user', 'assistant') AND content != ''
		 ORDER BY created_at ASC LIMIT 100`, convID)
	if err != nil {
		return err
	}
	defer rows.Close()

	var chatHistory string
	for rows.Next() {
		var role, content string
		if err := rows.Scan(&role, &content); err != nil {
			continue
		}
		if role == "user" {
			chatHistory += "User: " + content + "\n"
		} else {
			chatHistory += "AI: " + content + "\n"
		}
	}

	if chatHistory == "" {
		return nil
	}

	messages := []ai.ChatMessage{
		{Role: "system", Content: prompts.SummarizePrompt},
		{Role: "user", Content: chatHistory},
	}

	var summary string
	err = aiRouter.StreamChat(ai.ChatCompletionRequest{
		Model:    model,
		Messages: messages,
		Stream:   true,
	}, func(chunk ai.StreamChunk) {
		if len(chunk.Choices) > 0 && chunk.Choices[0].Delta.Content != "" {
			summary += chunk.Choices[0].Delta.Content
		}
	})
	if err != nil {
		return err
	}

	_, err = db.Pool.Exec(ctx,
		"UPDATE conversations SET summary = $1, summary_at = now() WHERE id = $2",
		summary, convID)
	return err
}
