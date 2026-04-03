package autonomous

import (
	"context"
	"time"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/google/uuid"
)

type HeartbeatConfig struct {
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

func DefaultConfig(userID uuid.UUID) HeartbeatConfig {
	return HeartbeatConfig{
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
}

// LoadConfig returns heartbeat config for a user, creating default if not exists
func LoadConfig(ctx context.Context, userID uuid.UUID) (HeartbeatConfig, error) {
	cfg := DefaultConfig(userID)
	var qhs, qhe, rt, dt string
	err := db.Pool.QueryRow(ctx,
		`SELECT enabled, interval_min, quiet_hours_start, quiet_hours_end, max_actions_per_hour,
		        timezone, reflection_time, digest_time, delivery_channel, COALESCE(delivery_chat_id,''), updated_at
		 FROM heartbeat_config WHERE user_id=$1`, userID,
	).Scan(&cfg.Enabled, &cfg.IntervalMin, &qhs, &qhe, &cfg.MaxActionsHour,
		&cfg.Timezone, &rt, &dt, &cfg.DeliveryChannel, &cfg.DeliveryChatID, &cfg.UpdatedAt)
	if err != nil {
		return cfg, nil // return default
	}
	cfg.QuietHoursStart = qhs
	cfg.QuietHoursEnd = qhe
	cfg.ReflectionTime = rt
	cfg.DigestTime = dt
	return cfg, nil
}

// SaveConfig upserts heartbeat config
func SaveConfig(ctx context.Context, cfg HeartbeatConfig) error {
	_, err := db.Pool.Exec(ctx,
		`INSERT INTO heartbeat_config (user_id, enabled, interval_min, quiet_hours_start, quiet_hours_end,
		  max_actions_per_hour, timezone, reflection_time, digest_time, delivery_channel, delivery_chat_id, updated_at)
		 VALUES ($1,$2,$3,$4::time,$5::time,$6,$7,$8::time,$9::time,$10,$11,NOW())
		 ON CONFLICT (user_id) DO UPDATE SET
		   enabled=$2, interval_min=$3, quiet_hours_start=$4::time, quiet_hours_end=$5::time,
		   max_actions_per_hour=$6, timezone=$7, reflection_time=$8::time, digest_time=$9::time,
		   delivery_channel=$10, delivery_chat_id=$11, updated_at=NOW()`,
		cfg.UserID, cfg.Enabled, cfg.IntervalMin, cfg.QuietHoursStart, cfg.QuietHoursEnd,
		cfg.MaxActionsHour, cfg.Timezone, cfg.ReflectionTime, cfg.DigestTime,
		cfg.DeliveryChannel, cfg.DeliveryChatID,
	)
	return err
}

// IsQuietHours checks if current time is within quiet hours for a user
func IsQuietHours(cfg HeartbeatConfig) bool {
	loc, err := time.LoadLocation(cfg.Timezone)
	if err != nil {
		loc = time.UTC
	}
	now := time.Now().In(loc)
	nowMinutes := now.Hour()*60 + now.Minute()

	start := parseTimeMinutes(cfg.QuietHoursStart)
	end := parseTimeMinutes(cfg.QuietHoursEnd)

	if start < end {
		return nowMinutes >= start && nowMinutes < end
	}
	// Crosses midnight (e.g., 23:00 - 07:00)
	return nowMinutes >= start || nowMinutes < end
}

func parseTimeMinutes(t string) int {
	parsed, err := time.Parse("15:04", t)
	if err != nil {
		return 0
	}
	return parsed.Hour()*60 + parsed.Minute()
}
