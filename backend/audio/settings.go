package audio

import (
	"context"
	"log"

	"github.com/ahvholding/ahvclaw/crypto"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/google/uuid"
)

// VoiceSettings holds all voice-related settings for a user.
type VoiceSettings struct {
	Enabled        bool   `json:"voice_enabled"`
	MiniMaxKey     string `json:"minimax_api_key"`
	MiniMaxVoiceID string `json:"minimax_voice_id"`
	MiniMaxModel   string `json:"minimax_model"`
	AutoVoiceReply bool   `json:"auto_voice_reply"`
	STTProvider    string `json:"stt_provider"`
	STTAPIKey      string `json:"stt_api_key"`
}

func DefaultVoiceSettings() VoiceSettings {
	return VoiceSettings{
		Enabled:        false,
		MiniMaxVoiceID: "female-shaonv",
		MiniMaxModel:   "speech-02-hd",
		AutoVoiceReply: true,
	}
}

func LoadVoiceSettings(ctx context.Context, userID uuid.UUID) VoiceSettings {
	vs := DefaultVoiceSettings()

	rows, err := db.Pool.Query(ctx,
		"SELECT key, value FROM user_settings WHERE user_id = $1 AND (key LIKE 'voice_%' OR key LIKE 'minimax_%' OR key LIKE 'stt_%' OR key = 'auto_voice_reply')",
		userID)
	if err != nil {
		log.Printf("[audio/settings] load failed for user %s: %v", userID, err)
		return vs
	}
	defer rows.Close()

	for rows.Next() {
		var k, v string
		if rows.Scan(&k, &v) != nil {
			continue
		}
		switch k {
		case "voice_enabled":
			vs.Enabled = v == "true"
		case "minimax_api_key":
			if dec, err := crypto.Decrypt(v); err == nil {
				vs.MiniMaxKey = dec
			}
		case "minimax_voice_id":
			vs.MiniMaxVoiceID = v
		case "minimax_model":
			vs.MiniMaxModel = v
		case "auto_voice_reply":
			vs.AutoVoiceReply = v != "false"
		case "stt_provider":
			vs.STTProvider = v
		case "stt_api_key":
			if dec, err := crypto.Decrypt(v); err == nil {
				vs.STTAPIKey = dec
			}
		}
	}
	return vs
}

func SaveVoiceSetting(ctx context.Context, userID uuid.UUID, key string, value string) error {
	storeValue := value
	if key == "minimax_api_key" || key == "stt_api_key" {
		if value != "" {
			enc, err := crypto.Encrypt(value)
			if err != nil {
				return err
			}
			storeValue = enc
		}
	}

	_, err := db.Pool.Exec(ctx,
		`INSERT INTO user_settings (user_id, key, value) VALUES ($1, $2, $3)
		ON CONFLICT (user_id, key) DO UPDATE SET value = $3, updated_at = NOW()`,
		userID, key, storeValue)
	return err
}
