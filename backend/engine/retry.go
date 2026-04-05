package engine

import (
	"context"
	"errors"
	"log"
	"strings"
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
	return RetryableStreamChatWithContext(context.Background(), aiRouter, "openai", req, onChunk, cfg)
}

// RetryableStreamChatWithContext is like RetryableStreamChat but respects a
// caller-supplied context and API format (for non-OpenAI providers).
func RetryableStreamChatWithContext(
	ctx context.Context,
	aiRouter *ai.RouterClient,
	apiFormat string,
	req ai.ChatCompletionRequest,
	onChunk func(ai.StreamChunk),
	cfg RetryConfig,
) error {
	if apiFormat == "" {
		apiFormat = "openai"
	}
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

		lastErr = aiRouter.StreamWithFormat(ctx, apiFormat, req, onChunk)
		if lastErr == nil {
			return nil
		}

		var aiErr *ai.AIError
		if errors.As(lastErr, &aiErr) && !aiErr.Retryable {
			// Upstream provider auth errors (OAuth expired, token invalid) should be retried
			// as the router may fall back to a different provider on retry
			msg := strings.ToLower(aiErr.Message)
			isUpstreamAuth := strings.Contains(msg, "oauth token has expired") ||
				strings.Contains(msg, "token has expired") ||
				strings.Contains(msg, "invalid_api_key") ||
				strings.Contains(msg, "authentication_error")
			if isUpstreamAuth {
				log.Printf("[retry] upstream auth error from model %q (will retry): %v", primaryModel, aiErr)
			} else {
				log.Printf("[retry] non-retryable error from model %q: %v", primaryModel, aiErr)
				return lastErr
			}
		}

		// On 429 rate limit, skip remaining retries and go straight to fallbacks
		if errors.As(lastErr, &aiErr) && aiErr.StatusCode == 429 && len(cfg.FallbackModels) > 0 {
			log.Printf("[retry] 429 rate limit on %q, skipping to fallback models", primaryModel)
			break
		}

		log.Printf("[retry] retryable error from model %q (attempt %d/%d): %v", primaryModel, i+1, attempts, lastErr)
	}

	// Primary model exhausted — try fallback models.
	for _, model := range cfg.FallbackModels {
		log.Printf("[retry] falling back to model %q", model)
		req.Model = model
		err := aiRouter.StreamWithFormat(ctx, apiFormat, req, onChunk)
		if err == nil {
			return nil
		}
		log.Printf("[retry] fallback model %q failed: %v", model, err)
		lastErr = err
	}

	return lastErr
}
