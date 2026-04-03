package cognitive

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/embeddings"
	"github.com/google/uuid"
)

var embedSem = make(chan struct{}, 20) // max 20 concurrent embedding goroutines

// EmbedContent generates an embedding and stores it in cognitive_embeddings.
// Skips if content_hash already exists (idempotent).
func EmbedContent(ctx context.Context, userID uuid.UUID, sourceType string, sourceID uuid.UUID, content string, metadata map[string]interface{}) error {
	if len(content) < 10 {
		return nil // skip trivially short content
	}

	hash := hashContent(content)

	// Check if already embedded with same hash
	var exists bool
	db.Pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM cognitive_embeddings WHERE user_id=$1 AND source_type=$2 AND source_id=$3 AND content_hash=$4)`,
		userID, sourceType, sourceID, hash,
	).Scan(&exists)
	if exists {
		return nil
	}

	// Generate embedding
	vec, err := embeddings.GenerateEmbedding(content)
	if err != nil {
		return fmt.Errorf("embedding generation failed: %w", err)
	}

	// Build preview (first 200 chars)
	preview := content
	if len(preview) > 200 {
		preview = preview[:200] + "..."
	}

	metaJSON, _ := json.Marshal(metadata)
	vecStr := pgvectorString(vec)

	// Upsert: update if source changed, insert if new
	_, err = db.Pool.Exec(ctx,
		`INSERT INTO cognitive_embeddings (user_id, source_type, source_id, content_hash, content_preview, embedding, metadata)
		 VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
		 ON CONFLICT (user_id, source_type, source_id) DO UPDATE SET
		   content_hash = $4, content_preview = $5, embedding = $6::vector, metadata = $7, updated_at = NOW()
		 WHERE cognitive_embeddings.content_hash != $4`,
		userID, sourceType, sourceID, hash, preview, vecStr, metaJSON,
	)
	return err
}

// EmbedMessageAsync embeds a chat message in the background
func EmbedMessageAsync(userID uuid.UUID, messageID uuid.UUID, role, content string, conversationID uuid.UUID) {
	go func() {
		embedSem <- struct{}{}
		defer func() { <-embedSem }()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		meta := map[string]interface{}{
			"role":            role,
			"conversation_id": conversationID.String(),
			"timestamp":       time.Now().Format(time.RFC3339),
		}
		if err := EmbedContent(ctx, userID, SourceMessage, messageID, content, meta); err != nil {
			log.Printf("[cognitive] embed message %s error: %v", messageID, err)
		}
	}()
}

// EmbedMemoryAsync embeds a memory file in the background
func EmbedMemoryAsync(userID uuid.UUID, memoryID uuid.UUID, memType, key, content string) {
	go func() {
		embedSem <- struct{}{}
		defer func() { <-embedSem }()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		meta := map[string]interface{}{
			"memory_type": memType,
			"key":         key,
		}
		if err := EmbedContent(ctx, userID, SourceMemory, memoryID, content, meta); err != nil {
			log.Printf("[cognitive] embed memory %s error: %v", key, err)
		}
	}()
}

// EmbedReflection embeds a reflection's lessons and insights
func EmbedReflection(ctx context.Context, userID uuid.UUID, reflectionID uuid.UUID, date string, rawOutput string) error {
	meta := map[string]interface{}{"date": date}
	return EmbedContent(ctx, userID, SourceReflection, reflectionID, rawOutput, meta)
}

// EmbedGoal embeds a goal
func EmbedGoal(ctx context.Context, userID uuid.UUID, goalID uuid.UUID, title, description, status string) error {
	content := fmt.Sprintf("Goal: %s\nDescription: %s\nStatus: %s", title, description, status)
	meta := map[string]interface{}{"status": status}
	return EmbedContent(ctx, userID, SourceGoal, goalID, content, meta)
}

// EmbedPattern embeds a detected pattern
func EmbedPattern(ctx context.Context, userID uuid.UUID, patternID uuid.UUID, patternType, description string, confidence float64) error {
	content := fmt.Sprintf("Pattern (%s): %s (confidence: %.0f%%)", patternType, description, confidence*100)
	meta := map[string]interface{}{"pattern_type": patternType, "confidence": confidence}
	return EmbedContent(ctx, userID, SourcePattern, patternID, content, meta)
}

// BackfillMessages embeds recent un-embedded messages for a user
func BackfillMessages(ctx context.Context, userID uuid.UUID, limit int) (int, error) {
	rows, err := db.Pool.Query(ctx,
		`SELECT m.id, m.role, m.content, m.conversation_id
		 FROM messages m
		 JOIN conversations c ON c.id = m.conversation_id
		 WHERE c.user_id = $1 AND m.role IN ('user','assistant') AND m.content IS NOT NULL AND LENGTH(m.content) > 10
		   AND NOT EXISTS (SELECT 1 FROM cognitive_embeddings ce WHERE ce.user_id=$1 AND ce.source_type='message' AND ce.source_id=m.id)
		 ORDER BY m.created_at DESC LIMIT $2`,
		userID, limit,
	)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		var msgID, convID uuid.UUID
		var role, content string
		if rows.Scan(&msgID, &role, &content, &convID) != nil {
			continue
		}
		meta := map[string]interface{}{
			"role":            role,
			"conversation_id": convID.String(),
		}
		if err := EmbedContent(ctx, userID, SourceMessage, msgID, content, meta); err != nil {
			log.Printf("[cognitive] backfill embed error for %s: %v", msgID, err)
			continue
		}
		count++
	}
	return count, nil
}

func hashContent(content string) string {
	h := sha256.Sum256([]byte(content))
	return hex.EncodeToString(h[:16]) // 32-char hex
}

func pgvectorString(vec []float32) string {
	s := "["
	for i, v := range vec {
		if i > 0 {
			s += ","
		}
		s += fmt.Sprintf("%f", v)
	}
	s += "]"
	return s
}
