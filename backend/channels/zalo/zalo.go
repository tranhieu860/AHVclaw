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
		Error   int    `json:"error"`
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
// Supports both old Zalo OA format and v3 API event format.
func (a *Adapter) HandleWebhook(body []byte) error {
	var raw map[string]interface{}
	if err := json.Unmarshal(body, &raw); err != nil {
		return fmt.Errorf("parse webhook event: %w", err)
	}

	eventNameVal, ok := raw["event_name"]
	if !ok {
		return fmt.Errorf("missing event_name in webhook")
	}
	eventName, ok := eventNameVal.(string)
	if !ok {
		return fmt.Errorf("event_name is not a string")
	}

	log.Printf("[zalo] received event: %s", eventName)

	var senderID, displayName, text, messageID, chatID string
	var files []channels.InboundFile

	switch eventName {
	// ---- v3 format ----
	case "message.text.received", "message.image.received", "message.file.received",
		"message.video.received", "message.audio.received", "message.sticker.received":

		msgRaw, ok := raw["message"].(map[string]interface{})
		if !ok {
			return fmt.Errorf("v3 event missing message object")
		}

		if from, ok := msgRaw["from"].(map[string]interface{}); ok {
			if id, ok := from["id"].(string); ok {
				senderID = id
			}
			if dn, ok := from["display_name"].(string); ok {
				displayName = dn
			}
		}

		if t, ok := msgRaw["text"].(string); ok {
			text = t
		}
		if mid, ok := msgRaw["message_id"].(string); ok {
			messageID = mid
		}

		chatID = senderID
		if chat, ok := msgRaw["chat"].(map[string]interface{}); ok {
			if cid, ok := chat["id"].(string); ok {
				chatID = cid
			}
		}

		// Handle v3 image/file attachments
		if eventName == "message.image.received" {
			fileEntry := channels.InboundFile{MimeType: "image/jpeg"}
			if u, ok := msgRaw["url"].(string); ok {
				fileEntry.URL = u
			} else if u, ok := msgRaw["thumb"].(string); ok {
				fileEntry.URL = u
			}
			if fileEntry.URL != "" {
				files = append(files, fileEntry)
			}
		}
		if eventName == "message.file.received" {
			fileEntry := channels.InboundFile{MimeType: "application/octet-stream"}
			if u, ok := msgRaw["url"].(string); ok {
				fileEntry.URL = u
			}
			if fn, ok := msgRaw["file_name"].(string); ok {
				fileEntry.Filename = fn
			}
			if fileEntry.URL != "" {
				files = append(files, fileEntry)
			}
		}

	// ---- old format ----
	case "user_send_text", "user_send_image", "user_send_file",
		"user_send_audio", "user_send_video", "user_send_sticker",
		"user_send_gif", "user_send_location":

		if sender, ok := raw["sender"].(map[string]interface{}); ok {
			if id, ok := sender["id"].(string); ok {
				senderID = id
			}
		}

		if msgRaw, ok := raw["message"].(map[string]interface{}); ok {
			if t, ok := msgRaw["text"].(string); ok {
				text = t
			}
			if mid, ok := msgRaw["msg_id"].(string); ok {
				messageID = mid
			}
			// Old format attachments
			if atts, ok := msgRaw["attachments"].([]interface{}); ok {
				for _, attRaw := range atts {
					att, ok := attRaw.(map[string]interface{})
					if !ok {
						continue
					}
					mimeType := "application/octet-stream"
					if attType, ok := att["type"].(string); ok {
						switch attType {
						case "image":
							mimeType = "image/jpeg"
						case "video":
							mimeType = "video/mp4"
						case "audio":
							mimeType = "audio/mpeg"
						}
					}
					if payload, ok := att["payload"].(map[string]interface{}); ok {
						fileEntry := channels.InboundFile{MimeType: mimeType}
						if u, ok := payload["url"].(string); ok {
							fileEntry.URL = u
						} else if u, ok := payload["thumbnail"].(string); ok {
							fileEntry.URL = u
						}
						if fileEntry.URL != "" {
							files = append(files, fileEntry)
						}
					}
				}
			}
		}
		chatID = senderID

	default:
		log.Printf("[zalo] ignoring event: %s", eventName)
		return nil
	}

	if senderID == "" {
		return fmt.Errorf("could not determine sender ID from event %s", eventName)
	}

	inbound := channels.InboundMessage{
		BotID:         a.botID,
		Channel:       "zalo",
		ChannelUserID: senderID,
		ChatID:        chatID,
		MessageID:     messageID,
		Text:          text,
		DisplayName:   displayName,
		Files:         files,
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
