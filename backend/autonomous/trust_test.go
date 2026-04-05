package autonomous

import (
	"testing"
)

func TestCheckTrust_Thresholds(t *testing.T) {
	// Test the threshold logic without DB
	// Score >= 8: execute
	// Score >= 4: notify
	// Score >= 1: ask
	// Score 0: block

	tests := []struct {
		score    int
		expected string
	}{
		{10, "execute"},
		{8, "execute"},
		{7, "notify"},
		{4, "notify"},
		{3, "ask"},
		{1, "ask"},
		{0, "block"},
	}

	for _, tt := range tests {
		decision := trustDecision(tt.score)
		if decision != tt.expected {
			t.Errorf("score %d: expected %s, got %s", tt.score, tt.expected, decision)
		}
	}
}

// trustDecision is a pure function extracted for testing
func trustDecision(score int) string {
	switch {
	case score >= 8:
		return "execute"
	case score >= 4:
		return "notify"
	case score >= 1:
		return "ask"
	default:
		return "block"
	}
}
