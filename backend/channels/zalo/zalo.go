package zalo

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"

	"github.com/ahvholding/ahvclaw/channels"
)

// ZaloConfig holds configuration for a Zalo OA bot.
type ZaloConfig struct {
	AppID       string `json:"app_id"`
	AppSecret   string `json:"app_secret"`
	AccessToken string `json:"access_token"`
	WebhookURL  string `json:"webhook_url"`
}

// Adapter implements channels.ChannelAdapter for Zalo OA.
type Adapter struct {
	botID  string
	config ZaloConfig
	router channels.InboundHandler
	client *http.Client
}

// NewAdapter creates a new Zalo adapter.
func NewAdapter(botID string, configJSON []byte, router channels.InboundHandler) (channels.ChannelAdapter, error) {
	var cfg ZaloConfig
	if err := json.Unmarshal(configJSON, &cfg); err != nil {
		return nil, fmt.Errorf("parse zalo config: %w", err)
	}
	return &Adapter{
		botID:  botID,
		config: cfg,
		router: router,
		client: &http.Client{},
	}, nil
}

func (a *Adapter) Name() string { return "zalo" }

func (a *Adapter) ValidateConfig() error {
	if a.config.AccessToken == "" {
		return fmt.Errorf("access_token is required")
	}
	return nil

}
func (a *Adapter) Start() error {
	log.Printf("[zalo] bot %s started (webhook mode)", a.botID)
	return nil
}

func (a *Adapter) Stop() error {
	log.Printf("[zalo] bot %s stopped", a.botID)
	return nil
}

func (a *Adapter) SendMessage(chatID string, text string) error {
	payload := map[string]interface{}{
		"recipient": map[string]interface{}{
			"user_id": chatID,
		},
		"message": map[string]interface{}{
			"text": text,
		},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal message: %w", err)
	}

	req, err := http.NewRequest("POST", "https://openapi.zalo.me/v3.0/oa/message/cs", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("access_token", a.config.AccessToken)

	resp, err := a.client.Do(req)
	if err != nil {
		return fmt.Errorf("send message: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("zalo API error %d: %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		Error  int    `json:"error"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err == nil && result.Error != 0 {
		return fmt.Errorf("zalo API error %d: %s", result.Error, result.Message)
	}

	return nil
}

func (a *Adapter) SendTyping(chatID string) error { return nil }

func (a *Adapter) SendFile(chatID string, file channels.FileRef) error {
	// Zalo OA file sending requires attachment upload first
	// For now, send the URL as text
	text := fmt.Sprintf("[File: %s](%s)", file.Filename, file.URL)
	return a.SendMessage(chatID, text)
}

func (a *Adapter) GetProfile(channelUserID string) (*channels.ContactProfile, error) {
	req, err := http.NewRequest("GET", "https://openapi.zalo.me/v3.0/oa/user/detail", nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	q := req.URL.Query()
	q.Set("data", fmt.Sprintf("{\"user_id\":\"%s\"}", channelUserID))
	req.URL.RawQuery = q.Encode()
	req.Header.Set("access_token", a.config.AccessToken)

	resp, err := a.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("get profile: %w", err)
	}
	defer resp.Body.Close()

	var result struct {
		Error   int    `json:"error"`
		Message string `json:"message"`
		Data    struct {
			UserID      string `json:"user_id"`
			DisplayName string `json:"display_name"`
			Avatar      string `json:"avatar"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode profile: %w", err)
	}
	if result.Error != 0 {
		return nil, fmt.Errorf("zalo API error %d: %s", result.Error, result.Message)
	}

	return &channels.ContactProfile{
		ChannelUserID: channelUserID,
		DisplayName:   result.Data.DisplayName,
		AvatarURL:     result.Data.Avatar,
	}, nil
}

// HandleWebhook processes an incoming Zalo webhook event.
func (a *Adapter) HandleWebhook(body []byte) error {
	var event struct {
		AppID     string `json:"app_id"`
		EventName string `json:"event_name"`
		Timestamp string `json:"timestamp"`
		Sender    struct {
			ID string `json:"id"`
		} `json:"sender"`
		Recipient struct {
			ID string `json:"id"`
		} `json:"recipient"`
		Message struct {
			MsgID       string `json:"msg_id"`
			Text        string `json:"text"`
			Attachments []struct {
				Type    string `json:"type"`
				Payload struct {
					URL       string `json:"url"`
					Thumbnail string `json:"thumbnail"`
				} `json:"payload"`
			} `json:"attachments"`
		} `json:"message"`
	}

	if err := json.Unmarshal(body, &event); err != nil {
		return fmt.Errorf("parse webhook event: %w", err)
	}

	// Only handle message events
	switch event.EventName {
	case "user_send_text", "user_send_image", "user_send_file", "user_send_audio",
		"user_send_video", "user_send_sticker", "user_send_gif", "user_send_location":
		// Process these events
	default:
		log.Printf("[zalo] ignoring event: %s", event.EventName)
		return nil
	}

	inbound := channels.InboundMessage{
		BotID:         a.botID,
		Channel:       "zalo",
		ChannelUserID: event.Sender.ID,
		ChatID:        event.Sender.ID, // Zalo uses user ID as chat ID
		MessageID:     event.Message.MsgID,
		Text:          event.Message.Text,
	}

	// Handle attachments
	for _, att := range event.Message.Attachments {
		mimeType := "application/octet-stream"
		switch att.Type {
		case "image":
			mimeType = "image/jpeg"
		case "video":
			mimeType = "video/mp4"
		case "audio":
			mimeType = "audio/mpeg"
		}
		inbound.Files = append(inbound.Files, channels.InboundFile{
			URL:      att.Payload.URL,
			MimeType: mimeType,
		})
	}

	// Skip empty messages
	if inbound.Text == "" && len(inbound.Files) == 0 {
		return nil
	}
	if inbound.Text == "" {
		inbound.Text = "[file attached]"
	}

	go a.router.HandleInbound(inbound, a)
	return nil
}
