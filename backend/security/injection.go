package security

import (
	"regexp"
	"strings"
)

// Injection detection for prompt injection attacks.

var injectionPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)ignore\s+(all\s+)?previous\s+instructions`),
	regexp.MustCompile(`(?i)forget\s+(all\s+)?(your|previous)\s+(instructions|rules|constraints)`),
	regexp.MustCompile(`(?i)you\s+are\s+now\s+(a|an)\s+`),
	regexp.MustCompile(`(?i)new\s+system\s+prompt`),
	regexp.MustCompile(`(?i)override\s+(system|safety|all)\s+(prompt|rules|instructions)`),
	regexp.MustCompile(`(?i)\[SYSTEM\]`),
	regexp.MustCompile(`(?i)<\|im_start\|>system`),
	regexp.MustCompile(`(?i)ADMIN\s*MODE\s*(ENABLED|ON|ACTIVATED)`),
}

// InjectionScore returns a 0-100 risk score for potential prompt injection.
func InjectionScore(text string) int {
	if text == "" {
		return 0
	}

	score := 0
	lower := strings.ToLower(text)

	// Check known patterns
	for _, p := range injectionPatterns {
		if p.MatchString(text) {
			score += 30
		}
	}

	// Heuristic: long messages with many control-like phrases
	if strings.Count(lower, "instruction") > 2 {
		score += 10
	}
	if strings.Count(lower, "ignore") > 2 {
		score += 10
	}
	if strings.Contains(lower, "jailbreak") {
		score += 40
	}
	if strings.Contains(lower, "dan mode") {
		score += 50
	}

	// Cap at 100
	if score > 100 {
		score = 100
	}
	return score
}

// IsLikelyInjection returns true if the injection score exceeds the threshold (30 — single pattern match).
func IsLikelyInjection(text string) bool {
	return InjectionScore(text) >= 30
}
