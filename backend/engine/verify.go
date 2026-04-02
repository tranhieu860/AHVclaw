package engine

import (
	"strings"
)

// VerifyResult holds the result of response verification.
type VerifyResult struct {
	Passed     bool
	FailReason string
	FixPrompt  string
}

// VerifyResponse checks AI response quality based on thinking block analysis.
// Only runs for medium/complex messages. Returns pass for simple.
func VerifyResponse(thinking ThinkingBlock, response string, toolsUsed []string, toolResults []string) VerifyResult {
	// Simple messages: always pass
	if thinking.Level == "simple" {
		return VerifyResult{Passed: true}
	}

	// Check 1: Low confidence without disclaimer
	if thinking.Confidence == "thấp" {
		hasDisclaimer := strings.Contains(response, "không chắc") ||
			strings.Contains(response, "chưa chắc") ||
			strings.Contains(response, "không rõ") ||
			strings.Contains(response, "cần kiểm tra")
		if !hasDisclaimer {
			return VerifyResult{
				Passed:     false,
				FailReason: "low_confidence_no_disclaimer",
				FixPrompt:  "Mức độ chắc chắn thấp nhưng câu trả lời không nói rõ. Hãy nói thẳng phần nào không chắc và đề xuất cách kiểm tra.",
			}
		}
	}

	// Check 2: Tools were used but response doesn't reference results
	if len(toolsUsed) > 0 && len(toolResults) > 0 {
		hasToolData := false
		for _, tr := range toolResults {
			if tr == "" {
				continue
			}
			words := extractSignificantWords(tr)
			for _, w := range words {
				if len(w) > 4 && strings.Contains(strings.ToLower(response), strings.ToLower(w)) {
					hasToolData = true
					break
				}
			}
			if hasToolData {
				break
			}
		}
		if !hasToolData && thinking.Level == "complex" {
			return VerifyResult{
				Passed:     false,
				FailReason: "tool_data_unused",
				FixPrompt:  "Đã dùng tool nhưng câu trả lời không tham khảo kết quả. Hãy đưa dữ liệu từ tool vào câu trả lời.",
			}
		}
	}

	// Check 3: Response is too short for complex questions
	if thinking.Level == "complex" && len([]rune(response)) < 50 {
		return VerifyResult{
			Passed:     false,
			FailReason: "too_shallow",
			FixPrompt:  "Câu hỏi phức tạp nhưng câu trả lời quá ngắn. Hãy phân tích chi tiết hơn.",
		}
	}

	return VerifyResult{Passed: true}
}

// extractSignificantWords pulls meaningful words from text (>4 chars, not common).
func extractSignificantWords(text string) []string {
	commonWords := map[string]bool{
		"không": true, "được": true, "trong": true, "những": true,
		"nhưng": true, "cũng": true, "này": true, "error": true,
		"false": true, "true": true, "null": true, "string": true,
	}

	words := strings.Fields(text)
	var significant []string
	seen := make(map[string]bool)
	for _, w := range words {
		w = strings.Trim(w, ".,;:!?\"'()[]{}")
		lower := strings.ToLower(w)
		if len(w) > 4 && !commonWords[lower] && !seen[lower] {
			significant = append(significant, w)
			seen[lower] = true
		}
		if len(significant) >= 20 {
			break
		}
	}
	return significant
}
