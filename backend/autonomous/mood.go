package autonomous

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/ahvholding/ahvclaw/ai"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/engine"
	"github.com/google/uuid"
)

type MoodAnalysis struct {
	Sentiment  string  `json:"sentiment"`
	Urgency    string  `json:"urgency"`
	Energy     string  `json:"energy"`
	Emotion    string  `json:"emotion"`
	Confidence float64 `json:"confidence"`
}

// AnalyzeMood uses rule-based analysis to detect mood from message text
func AnalyzeMood(text string) MoodAnalysis {
	text = strings.ToLower(text)
	mood := MoodAnalysis{
		Sentiment:  "neutral",
		Urgency:    "low",
		Energy:     "normal",
		Emotion:    "neutral",
		Confidence: 0.6,
	}

	urgentWords := []string{"gấp", "urgent", "asap", "ngay", "khẩn", "nhanh", "immediately", "lỗi", "bug", "down", "sập"}
	for _, w := range urgentWords {
		if strings.Contains(text, w) {
			mood.Urgency = "high"
			mood.Confidence = 0.8
			break
		}
	}

	frustrationWords := []string{"sao lại", "tại sao", "không hiểu", "lỗi hoài", "vẫn sai", "lại bị", "wtf", "damn"}
	for _, w := range frustrationWords {
		if strings.Contains(text, w) {
			mood.Sentiment = "negative"
			mood.Emotion = "frustrated"
			mood.Confidence = 0.75
			break
		}
	}

	positiveWords := []string{"tuyệt", "ngon", "ok rồi", "perfect", "great", "nice", "cảm ơn", "thanks", "good"}
	for _, w := range positiveWords {
		if strings.Contains(text, w) {
			mood.Sentiment = "positive"
			mood.Emotion = "happy"
			mood.Confidence = 0.7
			break
		}
	}

	loc, _ := time.LoadLocation("Asia/Ho_Chi_Minh")
	hour := time.Now().In(loc).Hour()
	if hour >= 0 && hour < 6 {
		mood.Energy = "low"
	}

	if len(text) < 20 && (strings.Contains(text, "!") || strings.HasSuffix(text, "?!")) {
		mood.Urgency = "high"
	}

	return mood
}


// AnalyzeMoodLLM uses AI for more accurate mood detection.
// Falls back to keyword-based AnalyzeMood for short messages or on error.
func AnalyzeMoodLLM(ctx context.Context, text string, router *ai.RouterClient, userID uuid.UUID) MoodAnalysis {
	// Short messages: use fast keyword analysis
	if len(text) < 30 {
		return AnalyzeMood(text)
	}

	prompt := `Analyze the emotional tone of this message (may be Vietnamese or English). Return JSON only:
{"sentiment": "positive|negative|neutral", "urgency": "low|medium|high|critical", "energy": "low|normal|high", "emotion": "happy|frustrated|stressed|curious|excited|grateful|confused|neutral", "confidence": 0.0-1.0}

Message: ` + text

	model := getUserModel(ctx, userID)
	result, err := engine.ProcessChat(ctx, engine.ChatConfig{
		AIRouter:      router,
		Model:         model,
		Messages:      []ai.ChatMessage{{Role: "user", Content: prompt}},
		MaxToolRounds: 0,
	})
	if err != nil {
		log.Printf("[mood] LLM analysis error, falling back to keyword: %v", err)
		return AnalyzeMood(text)
	}

	raw := strings.TrimSpace(result.Content)
	if idx := strings.Index(raw, "{"); idx >= 0 {
		raw = raw[idx:]
	}
	if idx := strings.LastIndex(raw, "}"); idx >= 0 {
		raw = raw[:idx+1]
	}

	var mood MoodAnalysis
	if err := json.Unmarshal([]byte(raw), &mood); err != nil {
		log.Printf("[mood] LLM parse error, falling back to keyword: %v", err)
		return AnalyzeMood(text)
	}

	// Validate
	validEmotions := map[string]bool{"happy": true, "frustrated": true, "stressed": true, "curious": true, "excited": true, "grateful": true, "confused": true, "neutral": true, "exhausted": true}
	if !validEmotions[mood.Emotion] {
		mood.Emotion = "neutral"
	}

	return mood
}

// SaveMood logs a mood analysis to the database
func SaveMood(ctx context.Context, userID, convID uuid.UUID, msgID *uuid.UUID, mood MoodAnalysis) {
	_, err := db.Pool.Exec(ctx,
		`INSERT INTO mood_log (user_id, conversation_id, message_id, sentiment, urgency, energy, emotion, confidence)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		userID, convID, msgID, mood.Sentiment, mood.Urgency, mood.Energy, mood.Emotion, mood.Confidence,
	)
	if err != nil {
		log.Printf("[mood] save error: %v", err)
	}
}

// GetMoodContext returns a system prompt snippet about current user mood
func GetMoodContext(ctx context.Context, userID uuid.UUID) string {
	var sentiment, urgency, energy, emotion string
	err := db.Pool.QueryRow(ctx,
		`SELECT sentiment, urgency, energy, emotion FROM mood_log
		 WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,
		userID,
	).Scan(&sentiment, &urgency, &energy, &emotion)
	if err != nil {
		return ""
	}

	hints := map[string]string{
		"frustrated": "User seems frustrated. Be concise, solution-oriented. Acknowledge the difficulty.",
		"stressed":   "User appears stressed. Keep responses short and actionable.",
		"exhausted":  "User is tired (late night). Offer to handle things autonomously. Suggest rest.",
		"happy":      "User is in a good mood. Match their energy.",
		"curious":    "User is curious. Provide extra detail and context.",
	}

	hint := hints[emotion]
	if hint == "" {
		return ""
	}

	if urgency == "high" || urgency == "critical" {
		hint += " This is URGENT - prioritize speed over completeness."
	}

	return fmt.Sprintf("\n[Mood context: %s, urgency=%s, energy=%s]\n%s", emotion, urgency, energy, hint)
}

// GetMoodContextForConversation returns mood context scoped to a specific conversation
func GetMoodContextForConversation(ctx context.Context, userID uuid.UUID, conversationID uuid.UUID) string {
	var sentiment, urgency, energy, emotion string
	err := db.Pool.QueryRow(ctx,
		`SELECT sentiment, urgency, energy, emotion FROM mood_log
		 WHERE user_id=$1 AND conversation_id=$2 ORDER BY created_at DESC LIMIT 1`,
		userID, conversationID,
	).Scan(&sentiment, &urgency, &energy, &emotion)
	if err != nil {
		return ""
	}

	hints := map[string]string{
		"frustrated": "User seems frustrated. Be concise, solution-oriented. Acknowledge the difficulty.",
		"stressed":   "User appears stressed. Keep responses short and actionable.",
		"exhausted":  "User is tired (late night). Offer to handle things autonomously. Suggest rest.",
		"happy":      "User is in a good mood. Match their energy.",
		"curious":    "User is curious. Provide extra detail and context.",
	}

	hint := hints[emotion]
	if hint == "" {
		return ""
	}

	if urgency == "high" || urgency == "critical" {
		hint += " This is URGENT - prioritize speed over completeness."
	}

	return fmt.Sprintf("\n[Mood context: %s, urgency=%s, energy=%s]\n%s", emotion, urgency, energy, hint)
}

// GetRecentMoodSummary returns mood stats for dashboard
func GetRecentMoodSummary(ctx context.Context, userID uuid.UUID) (map[string]interface{}, error) {
	rows, err := db.Pool.Query(ctx,
		`SELECT emotion, COUNT(*) FROM mood_log
		 WHERE user_id=$1 AND created_at > NOW() - INTERVAL '7 days'
		 GROUP BY emotion ORDER BY COUNT(*) DESC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	emotions := map[string]int{}
	for rows.Next() {
		var e string
		var c int
		if rows.Scan(&e, &c) == nil {
			emotions[e] = c
		}
	}
	return map[string]interface{}{"emotions_7d": emotions}, nil
}
