package handlers

import (
	"context"
	"encoding/json"
	"time"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

// GetAutonomousStatus returns config + recent run count for the calling user.
func GetAutonomousStatus(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	type configRow struct {
		UserID          uuid.UUID `json:"user_id"`
		Enabled         bool      `json:"enabled"`
		IntervalMin     int       `json:"interval_min"`
		QuietHoursStart string    `json:"quiet_hours_start"`
		QuietHoursEnd   string    `json:"quiet_hours_end"`
		MaxActionsHour  int       `json:"max_actions_per_hour"`
		Timezone        string    `json:"timezone"`
		ReflectionTime  string    `json:"reflection_time"`
		DigestTime      string    `json:"digest_time"`
		DeliveryChannel string    `json:"delivery_channel"`
		DeliveryChatID  string    `json:"delivery_chat_id"`
		UpdatedAt       time.Time `json:"updated_at"`
	}

	cfg := configRow{
		UserID:          userID,
		Enabled:         true,
		IntervalMin:     5,
		QuietHoursStart: "23:00",
		QuietHoursEnd:   "07:00",
		MaxActionsHour:  20,
		Timezone:        "Asia/Ho_Chi_Minh",
		ReflectionTime:  "23:00",
		DigestTime:      "21:00",
		DeliveryChannel: "telegram",
	}

	db.Pool.QueryRow(ctx,
		`SELECT enabled, interval_min, quiet_hours_start::text, quiet_hours_end::text, max_actions_per_hour,
		        timezone, reflection_time::text, digest_time::text, delivery_channel, COALESCE(delivery_chat_id,''), updated_at
		 FROM heartbeat_config WHERE user_id=$1`, userID,
	).Scan(&cfg.Enabled, &cfg.IntervalMin, &cfg.QuietHoursStart, &cfg.QuietHoursEnd, &cfg.MaxActionsHour,
		&cfg.Timezone, &cfg.ReflectionTime, &cfg.DigestTime, &cfg.DeliveryChannel, &cfg.DeliveryChatID, &cfg.UpdatedAt)

	var runCount int
	db.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM heartbeat_runs WHERE user_id=$1 AND started_at > NOW() - INTERVAL '24 hours'`,
		userID,
	).Scan(&runCount)

	return c.JSON(fiber.Map{
		"config":        cfg,
		"runs_last_24h": runCount,
	})
}

// UpdateAutonomousConfig parses and saves heartbeat config.
func UpdateAutonomousConfig(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	var body struct {
		Enabled         bool   `json:"enabled"`
		IntervalMin     int    `json:"interval_min"`
		QuietHoursStart string `json:"quiet_hours_start"`
		QuietHoursEnd   string `json:"quiet_hours_end"`
		MaxActionsHour  int    `json:"max_actions_per_hour"`
		Timezone        string `json:"timezone"`
		ReflectionTime  string `json:"reflection_time"`
		DigestTime      string `json:"digest_time"`
		DeliveryChannel string `json:"delivery_channel"`
		DeliveryChatID  string `json:"delivery_chat_id"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}

	_, err := db.Pool.Exec(ctx,
		`INSERT INTO heartbeat_config (user_id, enabled, interval_min, quiet_hours_start, quiet_hours_end,
		  max_actions_per_hour, timezone, reflection_time, digest_time, delivery_channel, delivery_chat_id, updated_at)
		 VALUES ($1,$2,$3,$4::time,$5::time,$6,$7,$8::time,$9::time,$10,$11,NOW())
		 ON CONFLICT (user_id) DO UPDATE SET
		   enabled=$2, interval_min=$3, quiet_hours_start=$4::time, quiet_hours_end=$5::time,
		   max_actions_per_hour=$6, timezone=$7, reflection_time=$8::time, digest_time=$9::time,
		   delivery_channel=$10, delivery_chat_id=$11, updated_at=NOW()`,
		userID, body.Enabled, body.IntervalMin, body.QuietHoursStart, body.QuietHoursEnd,
		body.MaxActionsHour, body.Timezone, body.ReflectionTime, body.DigestTime,
		body.DeliveryChannel, body.DeliveryChatID,
	)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to save config"})
	}
	return c.JSON(fiber.Map{"ok": true})
}

// StopAutonomous disables heartbeat for the calling user.
func StopAutonomous(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	_, err := db.Pool.Exec(context.Background(),
		`INSERT INTO heartbeat_config (user_id, enabled, updated_at) VALUES ($1, false, NOW())
		 ON CONFLICT (user_id) DO UPDATE SET enabled=false, updated_at=NOW()`, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to stop autonomous"})
	}
	return c.JSON(fiber.Map{"enabled": false})
}

// ResumeAutonomous re-enables heartbeat for the calling user.
func ResumeAutonomous(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	_, err := db.Pool.Exec(context.Background(),
		`INSERT INTO heartbeat_config (user_id, enabled, updated_at) VALUES ($1, true, NOW())
		 ON CONFLICT (user_id) DO UPDATE SET enabled=true, updated_at=NOW()`, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to resume autonomous"})
	}
	return c.JSON(fiber.Map{"enabled": true})
}

// TrustEntry is returned by ListTrustPermissions.
type TrustEntry struct {
	ID            uuid.UUID  `json:"id"`
	UserID        uuid.UUID  `json:"user_id"`
	ActionType    string     `json:"action_type"`
	ActionPattern string     `json:"action_pattern"`
	TrustScore    int        `json:"trust_score"`
	ApproveCount  int        `json:"approve_count"`
	RejectCount   int        `json:"reject_count"`
	LastUsedAt    *time.Time `json:"last_used_at"`
	CreatedAt     time.Time  `json:"created_at"`
}

// ListTrustPermissions returns all trust entries for the calling user.
func ListTrustPermissions(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	rows, err := db.Pool.Query(ctx,
		`SELECT id, user_id, action_type, action_pattern, trust_score, approve_count, reject_count, last_used_at, created_at
		 FROM action_trust WHERE user_id=$1 ORDER BY action_type, action_pattern`, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to list trust"})
	}
	defer rows.Close()

	var entries []TrustEntry
	for rows.Next() {
		var e TrustEntry
		if err := rows.Scan(&e.ID, &e.UserID, &e.ActionType, &e.ActionPattern, &e.TrustScore,
			&e.ApproveCount, &e.RejectCount, &e.LastUsedAt, &e.CreatedAt); err != nil {
			continue
		}
		entries = append(entries, e)
	}
	if entries == nil {
		entries = []TrustEntry{}
	}
	return c.JSON(entries)
}

// UpdateTrustScore adjusts a trust entry via escalate/deescalate.
func UpdateTrustScore(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	var body struct {
		ActionType    string `json:"action_type"`
		ActionPattern string `json:"action_pattern"`
		Direction     string `json:"direction"` // "up" or "down"
	}
	if err := c.BodyParser(&body); err != nil || body.ActionType == "" || body.ActionPattern == "" {
		return c.Status(400).JSON(fiber.Map{"error": "action_type and action_pattern required"})
	}

	categoryDefaults := map[string]int{
		"read": 10, "write_low": 5, "write_high": 3, "critical": 0,
	}
	def := categoryDefaults[body.ActionType]

	var err error
	if body.Direction == "up" {
		_, err = db.Pool.Exec(ctx,
			`INSERT INTO action_trust (user_id, action_type, action_pattern, trust_score, approve_count, last_used_at)
			 VALUES ($1, $2, $3, LEAST($4 + 2, 10), 1, NOW())
			 ON CONFLICT (user_id, action_type, action_pattern) DO UPDATE SET
			   trust_score = LEAST(action_trust.trust_score + 2, 10),
			   approve_count = action_trust.approve_count + 1,
			   last_used_at = NOW(), updated_at = NOW()`,
			userID, body.ActionType, body.ActionPattern, def,
		)
	} else {
		_, err = db.Pool.Exec(ctx,
			`INSERT INTO action_trust (user_id, action_type, action_pattern, trust_score, reject_count, last_used_at)
			 VALUES ($1, $2, $3, GREATEST($4 - 3, 0), 1, NOW())
			 ON CONFLICT (user_id, action_type, action_pattern) DO UPDATE SET
			   trust_score = GREATEST(action_trust.trust_score - 3, 0),
			   reject_count = action_trust.reject_count + 1,
			   last_used_at = NOW(), updated_at = NOW()`,
			userID, body.ActionType, body.ActionPattern, def,
		)
	}
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to update trust score"})
	}
	return c.JSON(fiber.Map{"ok": true})
}

// ReflectionRow is a lightweight representation for listing.
type ReflectionRow struct {
	UserID           uuid.UUID       `json:"user_id"`
	Date             string          `json:"date"`
	PerformanceScore float64         `json:"performance_score"`
	Lessons          json.RawMessage `json:"lessons"`
	UserInsights     json.RawMessage `json:"user_insights"`
	CreatedAt        time.Time       `json:"created_at"`
}

// ListReflections returns up to 30 past reflections for the calling user.
func ListReflections(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	rows, err := db.Pool.Query(ctx,
		`SELECT user_id, date::text, COALESCE(performance_score,0),
		        COALESCE(lessons,'[]'::jsonb), COALESCE(user_insights,'[]'::jsonb), created_at
		 FROM reflections WHERE user_id=$1 ORDER BY date DESC LIMIT 30`,
		userID,
	)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to list reflections"})
	}
	defer rows.Close()

	var result []ReflectionRow
	for rows.Next() {
		var r ReflectionRow
		if err := rows.Scan(&r.UserID, &r.Date, &r.PerformanceScore,
			&r.Lessons, &r.UserInsights, &r.CreatedAt); err != nil {
			continue
		}
		result = append(result, r)
	}
	if result == nil {
		result = []ReflectionRow{}
	}
	return c.JSON(result)
}

// FullReflectionRow is a full representation including all jsonb fields.
type FullReflectionRow struct {
	UserID            uuid.UUID       `json:"user_id"`
	Date              string          `json:"date"`
	PerformanceScore  float64         `json:"performance_score"`
	Lessons           json.RawMessage `json:"lessons"`
	UserInsights      json.RawMessage `json:"user_insights"`
	PromptSuggestions json.RawMessage `json:"prompt_suggestions"`
	GoalsProgress     json.RawMessage `json:"goals_progress"`
	DetectedPatterns  json.RawMessage `json:"detected_patterns"`
	RawOutput         *string         `json:"raw_output"`
	CreatedAt         time.Time       `json:"created_at"`
}

// GetReflection returns one reflection by date string (YYYY-MM-DD).
func GetReflection(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	date := c.Params("date")
	ctx := context.Background()

	var r FullReflectionRow
	err := db.Pool.QueryRow(ctx,
		`SELECT user_id, date::text, COALESCE(performance_score,0),
		        COALESCE(lessons,'[]'::jsonb), COALESCE(user_insights,'[]'::jsonb),
		        COALESCE(prompt_suggestions,'[]'::jsonb), COALESCE(goals_progress,'[]'::jsonb),
		        COALESCE(detected_patterns,'[]'::jsonb), raw_output, created_at
		 FROM reflections WHERE user_id=$1 AND date=$2`,
		userID, date,
	).Scan(&r.UserID, &r.Date, &r.PerformanceScore,
		&r.Lessons, &r.UserInsights, &r.PromptSuggestions,
		&r.GoalsProgress, &r.DetectedPatterns, &r.RawOutput, &r.CreatedAt)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "reflection not found"})
	}
	return c.JSON(r)
}

// PatternRow is returned by ListDetectedPatterns.
type PatternRow struct {
	ID          uuid.UUID  `json:"id"`
	UserID      uuid.UUID  `json:"user_id"`
	PatternType string     `json:"pattern_type"`
	Description string     `json:"description"`
	Confidence  float64    `json:"confidence"`
	Status      string     `json:"status"`
	ActionTaken *string    `json:"action_taken"`
	CreatedAt   time.Time  `json:"created_at"`
}

// ListDetectedPatterns returns detected patterns for the calling user.
func ListDetectedPatterns(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	rows, err := db.Pool.Query(ctx,
		`SELECT id, user_id, pattern_type, description, confidence, status, action_taken, created_at
		 FROM detected_patterns WHERE user_id=$1 ORDER BY confidence DESC, created_at DESC LIMIT 50`,
		userID,
	)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to list patterns"})
	}
	defer rows.Close()

	var patterns []PatternRow
	for rows.Next() {
		var p PatternRow
		if err := rows.Scan(&p.ID, &p.UserID, &p.PatternType, &p.Description,
			&p.Confidence, &p.Status, &p.ActionTaken, &p.CreatedAt); err != nil {
			continue
		}
		patterns = append(patterns, p)
	}
	if patterns == nil {
		patterns = []PatternRow{}
	}
	return c.JSON(patterns)
}

// AcceptPattern marks a pattern as accepted.
func AcceptPattern(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	patternID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid pattern id"})
	}
	_, err = db.Pool.Exec(context.Background(),
		`UPDATE detected_patterns SET status='accepted', updated_at=NOW() WHERE id=$1 AND user_id=$2`,
		patternID, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to accept pattern"})
	}
	return c.JSON(fiber.Map{"ok": true})
}

// RejectPattern marks a pattern as rejected.
func RejectPattern(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	patternID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid pattern id"})
	}
	_, err = db.Pool.Exec(context.Background(),
		`UPDATE detected_patterns SET status='rejected', updated_at=NOW() WHERE id=$1 AND user_id=$2`,
		patternID, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to reject pattern"})
	}
	return c.JSON(fiber.Map{"ok": true})
}
