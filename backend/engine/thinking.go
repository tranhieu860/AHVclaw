package engine

import (
	"regexp"
	"strings"
)

// ThinkingBlock holds parsed thinking data from AI response.
type ThinkingBlock struct {
	Raw        string // full <thinking>...</thinking> content
	Level      string // simple, medium, complex
	Intent     string // what user wants
	NeedsTool  bool
	Confidence string // cao, trung bình, thấp
}

var thinkingRegex = regexp.MustCompile(`(?s)<thinking>(.*?)</thinking>`)

// ParseThinking extracts <thinking> block from AI response.
// Returns the thinking block, the clean response (without thinking), and parsed data.
func ParseThinking(content string) (ThinkingBlock, string) {
	matches := thinkingRegex.FindStringSubmatch(content)
	if len(matches) < 2 {
		return ThinkingBlock{Level: "simple", Confidence: "cao"}, content
	}

	raw := strings.TrimSpace(matches[1])
	response := strings.TrimSpace(thinkingRegex.ReplaceAllString(content, ""))

	block := ThinkingBlock{Raw: raw}

	// Parse level
	if strings.Contains(raw, "complex") {
		block.Level = "complex"
	} else if strings.Contains(raw, "medium") {
		block.Level = "medium"
	} else {
		block.Level = "simple"
	}

	// Parse intent
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "- User muốn gì:") || strings.HasPrefix(line, "- User muốn") {
			block.Intent = strings.TrimPrefix(line, "- User muốn gì:")
			block.Intent = strings.TrimPrefix(block.Intent, "- User muốn")
			block.Intent = strings.TrimSpace(block.Intent)
		}
		if strings.Contains(line, "Cần tool") {
			block.NeedsTool = strings.Contains(line, "có") || strings.Contains(line, "Có")
		}
		if strings.Contains(line, "chắc chắn:") || strings.Contains(line, "Mức độ") {
			if strings.Contains(line, "thấp") {
				block.Confidence = "thấp"
			} else if strings.Contains(line, "trung bình") {
				block.Confidence = "trung bình"
			} else {
				block.Confidence = "cao"
			}
		}
	}

	if block.Confidence == "" {
		block.Confidence = "cao"
	}

	return block, response
}

// FormatThinkingForTelegram converts a thinking block into a short
// natural-language message suitable for Telegram.
// Returns empty string for simple messages (no thinking shown).
func FormatThinkingForTelegram(block ThinkingBlock) string {
	if block.Level == "simple" {
		return ""
	}

	if block.Intent != "" {
		if block.NeedsTool {
			return "💭 " + block.Intent + " — để tớ kiểm tra..."
		}
		return "💭 " + block.Intent
	}

	if block.NeedsTool {
		return "💭 Để tớ kiểm tra..."
	}
	return "💭 Đang suy nghĩ..."
}

// ExtractThinkingFromStream detects <thinking> tags in streaming content.
// Returns: isInThinking (currently inside tag), thinkingComplete (tag closed).
func ExtractThinkingFromStream(accumulated string) (isInThinking bool, thinkingComplete bool) {
	hasOpen := strings.Contains(accumulated, "<thinking>")
	hasClose := strings.Contains(accumulated, "</thinking>")

	if hasOpen && !hasClose {
		return true, false
	}
	if hasOpen && hasClose {
		return false, true
	}
	return false, false
}
