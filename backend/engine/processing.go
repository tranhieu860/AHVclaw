package engine

import (
	"sync"
	"time"

	"github.com/google/uuid"
)

// processingConvs tracks conversations currently being processed by the AI engine.
var processingConvs sync.Map // uuid.UUID -> time.Time

// MarkProcessing marks a conversation as currently being processed.
func MarkProcessing(convID uuid.UUID) {
	processingConvs.Store(convID, time.Now())
}

// UnmarkProcessing removes the processing mark from a conversation.
func UnmarkProcessing(convID uuid.UUID) {
	processingConvs.Delete(convID)
}

// IsProcessing returns true if the conversation is currently being processed
// (started within the last 5 minutes — considers older marks as stale).
func IsProcessing(convID uuid.UUID) bool {
	v, ok := processingConvs.Load(convID)
	if !ok {
		return false
	}
	t := v.(time.Time)
	if time.Since(t) >= 5*time.Minute {
		processingConvs.Delete(convID) // Clean up stale entry
		return false
	}
	return true
}
