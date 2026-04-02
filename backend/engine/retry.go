package engine

import (
	"errors"
	"log"
	"time"

	"github.com/ahvholding/ahvclaw/ai"
)

// RetryConfig controls retry behavior and fallback models.
type RetryConfig struct {
	MaxRetries     int
	InitialDelay   time.Duration
	MaxDelay       time.Duration
	FallbackModels []string
}

// DefaultRetryConfig returns a sensible default configuration.
func DefaultRetryConfig() RetryConfig {
	return RetryConfig{
		MaxRetries:   3,
		InitialDelay: 1 * time.Second,
		MaxDelay:     10 * time.Second,
	}
}

// RetryableStreamChat calls aiRouter.StreamChat with retry and exponential
// backoff. After exhausting retries on the primary model it tries each
// FallbackModel once.
func RetryableStreamChat(
	aiRouter *ai.RouterClient,
	req ai.ChatCompletionRequest,
	onChunk func(ai.StreamChunk),
	cfg RetryConfig,
) error {
	primaryModel := req.Model
	attempts := cfg.MaxRetries + 1

	// Try the primary model with retries.
	var lastErr error
	for i := 0; i < attempts; i++ {
		if i > 0 {
			delay := cfg.InitialDelay * (1 << (i - 1))
			if delay > cfg.MaxDelay {
				delay = cfg.MaxDelay
			}
			log.Printf("[retry] attempt %d/%d for model %q, backing off %v", i+1, attempts, primaryModel, delay)
			time.Sleep(delay)
		}

		lastErr = aiRouter.StreamChat(req, onChunk)
		if lastErr == nil {
			return nil
		}

		var aiErr *ai.AIError
		if errors.As(lastErr, &aiErr) && !aiErr.Retryable {
			log.Printf("[retry] non-retryable error from model %q: %v", primaryModel, aiErr)
			return lastErr
		}

		log.Printf("[retry] retryable error from model %q (attempt %d/%d): %v", primaryModel, i+1, attempts, lastErr)
	}

	// Primary model exhausted — try fallback models.
	for _, model := range cfg.FallbackModels {
		log.Printf("[retry] falling back to model %q", model)
		req.Model = model
		err := aiRouter.StreamChat(req, onChunk)
		if err == nil {
			return nil
		}
		log.Printf("[retry] fallback model %q failed: %v", model, err)
		lastErr = err
	}

	return lastErr
}
