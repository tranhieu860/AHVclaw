package engine

import (
	"context"
	"log"
	"runtime/debug"
	"time"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/google/uuid"
)

// RetryFunc is called when an unanswered message is found.
type RetryFunc func(convID uuid.UUID, content string, channel string, chatID string, botID uuid.UUID)

// FallbackFunc sends a fallback message when all retries are exhausted.
type FallbackFunc func(channel string, chatID string, botID uuid.UUID, text string)

// SilenceDetector periodically checks for unanswered user messages
// and triggers retry or sends fallback.
// IsProcessingFunc checks if a chat is currently being processed.
type IsProcessingFunc func(chatID string) bool

type SilenceDetector struct {
	retryFn        RetryFunc
	fallbackFn     FallbackFunc
	isProcessingFn IsProcessingFunc
	stopCh         chan struct{}
}

func NewSilenceDetector(retryFn RetryFunc, fallbackFn FallbackFunc, isProcessingFn IsProcessingFunc) *SilenceDetector {
	return &SilenceDetector{
		retryFn:        retryFn,
		fallbackFn:     fallbackFn,
		isProcessingFn: isProcessingFn,
		stopCh:         make(chan struct{}),
	}
}

func (s *SilenceDetector) Start() {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[silence-detector] PANIC: %v\n%s", r, debug.Stack())
			}
		}()

		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()

		log.Println("[silence-detector] started, checking every 60s")

		for {
			select {
			case <-ticker.C:
				s.check()
			case <-s.stopCh:
				log.Println("[silence-detector] stopped")
				return
			}
		}
	}()
}

func (s *SilenceDetector) Stop() {
	close(s.stopCh)
}

func (s *SilenceDetector) check() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	rows, err := db.Pool.Query(ctx, `
		SELECT m.id, m.conversation_id, m.content, m.retry_count,
		       c.channel, COALESCE(c.channel_chat_id, ''), c.bot_id
		FROM messages m
		JOIN conversations c ON m.conversation_id = c.id
		WHERE m.role = 'user'
		  AND m.created_at > now() - interval '10 minutes'
		  AND m.created_at < now() - interval '5 minutes'
		  AND c.channel != '' AND c.channel != 'web'
		  AND COALESCE(c.channel_chat_id, '') != ''
		  AND NOT EXISTS (
		      SELECT 1 FROM messages m2
		      WHERE m2.conversation_id = m.conversation_id
		        AND m2.role = 'assistant'
		        AND m2.created_at > m.created_at
		  )
		  AND m.retry_count < 2
	`)
	if err != nil {
		log.Printf("[silence-detector] query error: %v", err)
		return
	}
	defer rows.Close()

	for rows.Next() {
		var msgID, convID uuid.UUID
		var content, channel, chatID string
		var retryCount int
		var botID uuid.UUID

		if err := rows.Scan(&msgID, &convID, &content, &retryCount, &channel, &chatID, &botID); err != nil {
			log.Printf("[silence-detector] scan error: %v", err)
			continue
		}

		if s.isProcessingFn != nil && s.isProcessingFn(chatID) {
			log.Printf("[silence-detector] message %s chat %s still processing, skipping", msgID, chatID)
			continue
		}

		log.Printf("[silence-detector] unanswered message %s (retry %d) in conv %s channel=%s", msgID, retryCount, convID, channel)

		// Atomic: CAS increment + re-verify no assistant reply in one UPDATE
		// This closes the race window between double-check and CAS
		tag, err := db.Pool.Exec(ctx, `
			UPDATE messages SET retry_count = $1
			WHERE id = $2
			  AND retry_count = $3
			  AND NOT EXISTS (
			      SELECT 1 FROM messages m2
			      WHERE m2.conversation_id = $4
			        AND m2.role = 'assistant'
			        AND m2.created_at > (SELECT created_at FROM messages WHERE id = $2)
			  )
		`, retryCount+1, msgID, retryCount, convID)
		if err != nil || tag.RowsAffected() == 0 {
			log.Printf("[silence-detector] atomic CAS failed for message %s (reply arrived or concurrent update), skipping", msgID)
			continue
		}

		if retryCount >= 1 {
			// Max retries reached - attempt fallback FIRST, then mark handled
			log.Printf("[silence-detector] max retries for message %s, sending fallback", msgID)
			fallbackSent := false
			if s.fallbackFn != nil && chatID != "" {
				func() {
					defer func() {
						if r := recover(); r != nil {
							log.Printf("[silence-detector] fallback panic for message %s: %v", msgID, r)
						}
					}()
					s.fallbackFn(channel, chatID, botID, "⚠️ Tớ không xử lý được tin nhắn này. Cậu thử nhắn lại nhé!")
					fallbackSent = true
				}()
			}

			if fallbackSent {
				// Fallback delivered - mark as permanently handled
				db.Pool.Exec(ctx, "UPDATE messages SET retry_count = 99 WHERE id = $1", msgID)
			} else {
				// Fallback failed - set retry_count = 98 (won't re-enter loop since < 2 check,
				// but distinguishable from 99 = success for debugging)
				log.Printf("[silence-detector] fallback FAILED for message %s, marking as send_failed (98)", msgID)
				db.Pool.Exec(ctx, "UPDATE messages SET retry_count = 98 WHERE id = $1", msgID)
			}
			continue
		}

		// Retry processing
		if s.retryFn != nil {
			log.Printf("[silence-detector] retrying message %s", msgID)
			go s.retryFn(convID, content, channel, chatID, botID)
		}
	}
}
