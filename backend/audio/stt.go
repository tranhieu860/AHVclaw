package audio

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"time"
)

// TranscribeAudio transcribes audio bytes to text.
// Priority: 1) 9router Whisper, 2) System STT key (from .env), 3) User's own STT key
func TranscribeAudio(ctx context.Context, audioData []byte, mimeType string, routerURL string, routerKey string, sttURL string, sttKey string, vs *VoiceSettings) (string, error) {
	if len(audioData) == 0 {
		return "", fmt.Errorf("empty audio data")
	}

	// 1. Try 9router (OpenAI Whisper proxy) — free
	text, err := transcribeWhisper(ctx, audioData, mimeType, routerURL+"/v1/audio/transcriptions", routerKey)
	if err == nil && text != "" {
		log.Printf("[audio/stt] 9router transcription OK: %d chars", len(text))
		return text, nil
	}
	if err != nil {
		log.Printf("[audio/stt] 9router STT failed: %v", err)
	}

	// 2. Try system STT key (Groq/OpenAI from .env)
	if sttURL != "" && sttKey != "" {
		text, err := transcribeWhisper(ctx, audioData, mimeType, sttURL, sttKey)
		if err == nil && text != "" {
			log.Printf("[audio/stt] system STT OK: %d chars", len(text))
			return text, nil
		}
		log.Printf("[audio/stt] system STT failed: %v", err)
	}

	// 3. Fallback to user's STT key
	if vs != nil && vs.STTProvider != "" && vs.STTAPIKey != "" {
		switch vs.STTProvider {
		case "openai":
			return transcribeWhisper(ctx, audioData, mimeType, "https://api.openai.com/v1/audio/transcriptions", vs.STTAPIKey)
		case "groq":
			return transcribeWhisper(ctx, audioData, mimeType, "https://api.groq.com/openai/v1/audio/transcriptions", vs.STTAPIKey)
		case "google":
			return transcribeGoogle(ctx, audioData, vs.STTAPIKey)
		default:
			return "", fmt.Errorf("unknown STT provider: %s", vs.STTProvider)
		}
	}

	return "", fmt.Errorf("STT failed: no working STT provider available")
}

func mimeToExt(mimeType string) string {
	switch mimeType {
	case "audio/ogg", "audio/opus":
		return ".ogg"
	case "audio/mpeg", "audio/mp3":
		return ".mp3"
	case "audio/wav", "audio/x-wav":
		return ".wav"
	case "audio/mp4", "audio/m4a":
		return ".m4a"
	default:
		return ".webm"
	}
}

func transcribeWhisper(ctx context.Context, audioData []byte, mimeType string, endpoint string, apiKey string) (string, error) {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)

	part, err := w.CreateFormFile("file", "audio"+mimeToExt(mimeType))
	if err != nil {
		return "", fmt.Errorf("create form file: %w", err)
	}
	part.Write(audioData)
	w.WriteField("model", "whisper-large-v3-turbo")
	w.WriteField("language", "vi")
	w.Close()

	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, &buf)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return "", fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("STT API %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return "", fmt.Errorf("parse STT response: %w", err)
	}
	return result.Text, nil
}

func transcribeGoogle(ctx context.Context, audioData []byte, apiKey string) (string, error) {
	payload := map[string]interface{}{
		"config": map[string]interface{}{
			"languageCode": "vi-VN",
			"model":        "default",
		},
		"audio": map[string]interface{}{
			"content": base64.StdEncoding.EncodeToString(audioData),
		},
	}

	body, _ := json.Marshal(payload)

	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	url := fmt.Sprintf("https://speech.googleapis.com/v1/speech:recognize?key=%s", apiKey)
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("Google STT %d: %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		Results []struct {
			Alternatives []struct {
				Transcript string `json:"transcript"`
			} `json:"alternatives"`
		} `json:"results"`
	}
	json.Unmarshal(respBody, &result)

	var text string
	for _, r := range result.Results {
		if len(r.Alternatives) > 0 {
			text += r.Alternatives[0].Transcript + " "
		}
	}
	return text, nil
}
