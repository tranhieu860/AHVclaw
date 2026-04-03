package audio

import (
	"bufio"
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

const minimaxTTSURL = "https://api.minimax.io/v1/t2a_v2"

type TTSClient struct {
	APIKey  string
	Model   string
	VoiceID string
}

func NewTTSClient(vs VoiceSettings) *TTSClient {
	model := vs.MiniMaxModel
	if model == "" {
		model = "speech-02-hd"
	}
	voiceID := vs.MiniMaxVoiceID
	if voiceID == "" {
		voiceID = "female-shaonv"
	}
	return &TTSClient{
		APIKey:  vs.MiniMaxKey,
		Model:   model,
		VoiceID: voiceID,
	}
}

func (c *TTSClient) Synthesize(ctx context.Context, text string) ([]byte, error) {
	if c.APIKey == "" {
		return nil, fmt.Errorf("MiniMax API key not configured")
	}
	if text == "" {
		return nil, fmt.Errorf("empty text")
	}
	if len(text) > 8000 {
		text = text[:8000]
	}

	payload := map[string]interface{}{
		"model":  c.Model,
		"text":   text,
		"stream": false,
		"voice_setting": map[string]interface{}{
			"voice_id": c.VoiceID,
			"speed":    1.0,
			"vol":      1,
			"pitch":    0,
		},
		"audio_setting": map[string]interface{}{
			"sample_rate": 32000,
			"bitrate":     128000,
			"format":      "mp3",
			"channel":     1,
		},
	}

	body, _ := json.Marshal(payload)

	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "POST", minimaxTTSURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.APIKey)

	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("TTS request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("MiniMax TTS %d: %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		BaseResp struct {
			StatusCode int    `json:"status_code"`
			StatusMsg  string `json:"status_msg"`
		} `json:"base_resp"`
		Data struct {
			Audio string `json:"audio"`
		} `json:"data"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("parse TTS response: %w", err)
	}
	if result.BaseResp.StatusCode != 0 {
		return nil, fmt.Errorf("MiniMax error %d: %s", result.BaseResp.StatusCode, result.BaseResp.StatusMsg)
	}
	if result.Data.Audio == "" {
		return nil, fmt.Errorf("no audio data in response")
	}

	audioBytes, err := hex.DecodeString(result.Data.Audio)
	if err != nil {
		return nil, fmt.Errorf("decode audio hex: %w", err)
	}

	log.Printf("[audio/tts] synthesized %d chars → %d bytes MP3", len(text), len(audioBytes))
	return audioBytes, nil
}

func (c *TTSClient) SynthesizeStream(ctx context.Context, text string, onChunk func([]byte)) error {
	if c.APIKey == "" {
		return fmt.Errorf("MiniMax API key not configured")
	}
	if len(text) > 8000 {
		text = text[:8000]
	}

	payload := map[string]interface{}{
		"model":  c.Model,
		"text":   text,
		"stream": true,
		"voice_setting": map[string]interface{}{
			"voice_id": c.VoiceID,
			"speed":    1.0,
			"vol":      1,
			"pitch":    0,
		},
		"audio_setting": map[string]interface{}{
			"sample_rate": 32000,
			"bitrate":     128000,
			"format":      "mp3",
			"channel":     1,
		},
	}

	body, _ := json.Marshal(payload)

	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "POST", minimaxTTSURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.APIKey)

	resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("TTS stream request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("MiniMax TTS stream %d: %s", resp.StatusCode, string(respBody))
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 512*1024), 512*1024)

	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimPrefix(line, "data:")
		data = strings.TrimSpace(data)

		var event struct {
			Data struct {
				Audio  string `json:"audio"`
				Status int    `json:"status"`
			} `json:"data"`
		}
		if json.Unmarshal([]byte(data), &event) != nil {
			continue
		}
		if event.Data.Status == 1 && event.Data.Audio != "" {
			audioBytes, err := hex.DecodeString(event.Data.Audio)
			if err == nil && len(audioBytes) > 0 {
				onChunk(audioBytes)
			}
		}
	}
	return scanner.Err()
}
