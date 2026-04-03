package handlers

import (
	"context"
	"encoding/base64"
	"io"
	"strings"

	"github.com/ahvholding/ahvclaw/audio"
	"github.com/ahvholding/ahvclaw/config"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func GetVoiceSettings(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	vs := audio.LoadVoiceSettings(context.Background(), userID)

	maskedMinimax := ""
	if vs.MiniMaxKey != "" {
		if len(vs.MiniMaxKey) >= 10 {
			maskedMinimax = vs.MiniMaxKey[:4] + "****" + vs.MiniMaxKey[len(vs.MiniMaxKey)-4:]
		} else {
			maskedMinimax = "****"
		}
	}
	maskedSTT := ""
	if vs.STTAPIKey != "" {
		if len(vs.STTAPIKey) >= 6 {
			maskedSTT = vs.STTAPIKey[:4] + "****"
		} else {
			maskedSTT = "****"
		}
	}

	return c.JSON(fiber.Map{
		"voice_enabled":    vs.Enabled,
		"minimax_api_key":  maskedMinimax,
		"minimax_voice_id": vs.MiniMaxVoiceID,
		"minimax_model":    vs.MiniMaxModel,
		"auto_voice_reply": vs.AutoVoiceReply,
		"stt_provider":     vs.STTProvider,
		"stt_api_key":      maskedSTT,
		"has_minimax_key":  vs.MiniMaxKey != "",
		"has_stt_key":      vs.STTAPIKey != "",
	})
}

func UpdateVoiceSettings(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	var req map[string]string
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}

	allowedKeys := map[string]bool{
		"voice_enabled": true, "minimax_api_key": true, "minimax_voice_id": true,
		"minimax_model": true, "auto_voice_reply": true, "stt_provider": true, "stt_api_key": true,
	}

	for k, v := range req {
		if !allowedKeys[k] {
			continue
		}
		if err := audio.SaveVoiceSetting(ctx, userID, k, v); err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "failed to save " + k})
		}
	}

	return c.JSON(fiber.Map{"message": "voice settings updated"})
}

func TestTTS(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	vs := audio.LoadVoiceSettings(context.Background(), userID)

	if vs.MiniMaxKey == "" {
		return c.Status(400).JSON(fiber.Map{"error": "MiniMax API key not configured"})
	}

	tts := audio.NewTTSClient(vs)
	mp3Data, err := tts.Synthesize(context.Background(), "Xin chào, đây là giọng nói thử nghiệm từ AHVclaw.")
	if err != nil {
		return c.JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{
		"success":    true,
		"audio_b64":  base64.StdEncoding.EncodeToString(mp3Data),
		"audio_size": len(mp3Data),
		"format":     "mp3",
	})
}

func TestSTT(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	vs := audio.LoadVoiceSettings(context.Background(), userID)
	cfg := config.Load()

	file, err := c.FormFile("audio")
	var audioData []byte
	var mimeType string

	if err == nil && file != nil {
		f, _ := file.Open()
		defer f.Close()
		audioData, _ = io.ReadAll(f)
		mimeType = file.Header.Get("Content-Type")
	} else {
		var req struct {
			Audio    string `json:"audio"`
			MimeType string `json:"mime_type"`
		}
		if err := c.BodyParser(&req); err == nil && req.Audio != "" {
			audioData, _ = base64.StdEncoding.DecodeString(req.Audio)
			mimeType = req.MimeType
		}
	}

	if len(audioData) == 0 {
		return c.Status(400).JSON(fiber.Map{"error": "no audio data provided"})
	}
	if mimeType == "" {
		mimeType = "audio/webm"
	}

	text, err := audio.TranscribeAudio(context.Background(), audioData, mimeType, cfg.RouterURL, cfg.RouterAPIKey, cfg.STTURL, cfg.STTAPIKey, &vs)
	if err != nil {
		return c.JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "text": text})
}

func TranscribeAudioHandler(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	vs := audio.LoadVoiceSettings(context.Background(), userID)
	cfg := config.Load()

	file, err := c.FormFile("audio")
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "audio file required"})
	}

	if file.Size > 25*1024*1024 {
		return c.Status(400).JSON(fiber.Map{"error": "audio too large (max 25MB)"})
	}

	f, _ := file.Open()
	defer f.Close()
	audioData, _ := io.ReadAll(f)

	mimeType := file.Header.Get("Content-Type")
	if mimeType == "" {
		if strings.HasSuffix(file.Filename, ".ogg") {
			mimeType = "audio/ogg"
		} else if strings.HasSuffix(file.Filename, ".mp3") {
			mimeType = "audio/mpeg"
		} else {
			mimeType = "audio/webm"
		}
	}

	text, err := audio.TranscribeAudio(context.Background(), audioData, mimeType, cfg.RouterURL, cfg.RouterAPIKey, cfg.STTURL, cfg.STTAPIKey, &vs)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"text": text})
}

func SynthesizeAudioHandler(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	vs := audio.LoadVoiceSettings(context.Background(), userID)

	if vs.MiniMaxKey == "" {
		return c.Status(400).JSON(fiber.Map{"error": "MiniMax API key not configured"})
	}

	var req struct {
		Text string `json:"text"`
	}
	if err := c.BodyParser(&req); err != nil || req.Text == "" {
		return c.Status(400).JSON(fiber.Map{"error": "text is required"})
	}

	tts := audio.NewTTSClient(vs)
	mp3Data, err := tts.Synthesize(context.Background(), req.Text)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}

	c.Set("Content-Type", "audio/mpeg")
	c.Set("Content-Disposition", "inline; filename=response.mp3")
	return c.Send(mp3Data)
}
