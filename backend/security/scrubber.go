package security

import (
	"regexp"
	"strings"
)

// Scrubber removes credentials and sensitive data from AI output before sending to users.

var credentialPatterns = []*regexp.Regexp{
	regexp.MustCompile("(?i)(api[_-]?key|apikey|secret|token|password|passwd|auth)\\s*[:=]\\s*['\"]?([a-zA-Z0-9_\\-./+=]{8,})['\"]?"),
	regexp.MustCompile("(?i)bearer\\s+[a-zA-Z0-9_\\-./+=]{20,}"),
	regexp.MustCompile("sk-[a-zA-Z0-9]{20,}"),                        // OpenAI keys
	regexp.MustCompile("sk-ant-[a-zA-Z0-9\\-]{20,}"),                 // Anthropic keys
	regexp.MustCompile("(?i)AKIA[0-9A-Z]{16}"),                       // AWS access key
	regexp.MustCompile("(?i)(ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}"), // GitHub tokens
	regexp.MustCompile("xoxb-[0-9]{10,}-[a-zA-Z0-9]{20,}"),          // Slack bot tokens
	// Database connection strings
	regexp.MustCompile("postgres(ql)?://[^\\s]+:[^\\s]+@[^\\s]+"),
	// Private keys
	regexp.MustCompile("-----BEGIN[A-Z ]+PRIVATE KEY-----"),
	// Telegram bot tokens
	regexp.MustCompile("[0-9]{8,10}:[A-Za-z0-9_-]{35}"),
}

// ScrubCredentials replaces detected credentials in text with [REDACTED].
func ScrubCredentials(text string) string {
	result := text
	for _, p := range credentialPatterns {
		result = p.ReplaceAllStringFunc(result, func(match string) string {
			// Keep the key name, redact the value
			parts := strings.SplitN(match, "=", 2)
			if len(parts) == 2 {
				return parts[0] + "=[REDACTED]"
			}
			parts = strings.SplitN(match, ":", 2)
			if len(parts) == 2 {
				return parts[0] + ":[REDACTED]"
			}
			// For bare tokens, show first 4 chars
			if len(match) > 8 {
				return match[:4] + "...[REDACTED]"
			}
			return "[REDACTED]"
		})
	}
	return result
}

// ContainsCredentials checks if text likely contains credentials.
func ContainsCredentials(text string) bool {
	for _, p := range credentialPatterns {
		if p.MatchString(text) {
			return true
		}
	}
	return false
}
