package telegram

import (
	"encoding/json"
	"fmt"
	"log"
	"strconv"

	"github.com/ahvholding/ahvclaw/channels"
	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

// TelegramConfig holds configuration for a Telegram bot.
type TelegramConfig struct {
	BotToken    string `json:"bot_token"`
	WebhookMode bool   `json:"webhook_mode"`
}

// Adapter implements channels.ChannelAdapter for Telegram.
type Adapter struct {
	botID  string
	config TelegramConfig
	router channels.InboundHandler
	api    *tgbotapi.BotAPI
	stopCh chan struct{}
}

// NewAdapter creates a new Telegram adapter.
// This matches the channels.AdapterFactory signature.
func NewAdapter(botID string, configJSON []byte, router channels.InboundHandler) (channels.ChannelAdapter, error) {
	var cfg TelegramConfig
	if err := json.Unmarshal(configJSON, &cfg); err != nil {
		return nil, fmt.Errorf("parse telegram config: %w", err)
	}
	return &Adapter{
		botID:  botID,
		config: cfg,
		router: router,
		stopCh: make(chan struct{}),
	}, nil
}

func (a *Adapter) Name() string { return "telegram" }

func (a *Adapter) ValidateConfig() error {
	if a.config.BotToken == "" {
		return fmt.Errorf("bot_token is required")
	}
	return nil
}

func (a *Adapter) Start() error {
	bot, err := tgbotapi.NewBotAPI(a.config.BotToken)
	if err != nil {
		return fmt.Errorf("create telegram bot: %w", err)
	}
	a.api = bot
	log.Printf("[telegram] bot %s authorized as @%s", a.botID, bot.Self.UserName)

	// Long polling mode
	u := tgbotapi.NewUpdate(0)
	u.Timeout = 30

	updates := a.api.GetUpdatesChan(u)

	go func() {
		for {
			select {
			case <-a.stopCh:
				a.api.StopReceivingUpdates()
				log.Printf("[telegram] bot %s polling stopped", a.botID)
				return
			case update := <-updates:
				a.processUpdate(update)
			}
		}
	}()

	return nil
}

func (a *Adapter) Stop() error {
	select {
	case <-a.stopCh:
		// Already stopped
	default:
		close(a.stopCh)
	}
	return nil
}

func (a *Adapter) SendMessage(chatID string, text string) error {
	id, err := strconv.ParseInt(chatID, 10, 64)
	if err != nil {
		return fmt.Errorf("invalid chat ID: %w", err)
	}
	msg := tgbotapi.NewMessage(id, text)
	msg.ParseMode = "Markdown"
	_, err = a.api.Send(msg)
	if err != nil {
		// Retry without markdown in case of parse errors
		msg.ParseMode = ""
		_, err = a.api.Send(msg)
	}
	return err
}

func (a *Adapter) SendTyping(chatID string) error {
	id, err := strconv.ParseInt(chatID, 10, 64)
	if err != nil {
		return err
	}
	action := tgbotapi.NewChatAction(id, tgbotapi.ChatTyping)
	_, err = a.api.Send(action)
	return err
}

func (a *Adapter) SendFile(chatID string, file channels.FileRef) error {
	id, err := strconv.ParseInt(chatID, 10, 64)
	if err != nil {
		return fmt.Errorf("invalid chat ID: %w", err)
	}

	if file.FileID != "" {
		doc := tgbotapi.NewDocument(id, tgbotapi.FileID(file.FileID))
		_, err = a.api.Send(doc)
		return err
	}

	if file.URL != "" {
		doc := tgbotapi.NewDocument(id, tgbotapi.FileURL(file.URL))
		_, err = a.api.Send(doc)
		return err
	}

	return fmt.Errorf("no file source provided")
}

func (a *Adapter) GetProfile(channelUserID string) (*channels.ContactProfile, error) {
	uid, err := strconv.ParseInt(channelUserID, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("invalid user ID: %w", err)
	}

	chatCfg := tgbotapi.ChatInfoConfig{
		ChatConfig: tgbotapi.ChatConfig{ChatID: uid},
	}
	chat, err := a.api.GetChat(chatCfg)
	if err != nil {
		return nil, err
	}

	displayName := chat.FirstName
	if chat.LastName != "" {
		displayName += " " + chat.LastName
	}

	return &channels.ContactProfile{
		ChannelUserID: channelUserID,
		Username:      chat.UserName,
		DisplayName:   displayName,
	}, nil
}

// processUpdate handles a single Telegram update.
func (a *Adapter) processUpdate(update tgbotapi.Update) {
	if update.Message == nil {
		return
	}

	msg := update.Message

	// Build inbound message
	inbound := channels.InboundMessage{
		BotID:         a.botID,
		Channel:       "telegram",
		ChannelUserID: strconv.FormatInt(msg.From.ID, 10),
		ChatID:        strconv.FormatInt(msg.Chat.ID, 10),
		MessageID:     strconv.Itoa(msg.MessageID),
		Text:          msg.Text,
		Username:      msg.From.UserName,
	}

	// Display name
	displayName := msg.From.FirstName
	if msg.From.LastName != "" {
		displayName += " " + msg.From.LastName
	}
	inbound.DisplayName = displayName

	// Handle caption for photos/documents
	if msg.Caption != "" && inbound.Text == "" {
		inbound.Text = msg.Caption
	}

	// Handle photos
	if msg.Photo != nil && len(msg.Photo) > 0 {
		// Use largest photo
		largest := msg.Photo[len(msg.Photo)-1]
		inbound.Files = append(inbound.Files, channels.InboundFile{
			FileID:   largest.FileID,
			MimeType: "image/jpeg",
			Size:     int64(largest.FileSize),
		})
	}

	// Handle documents
	if msg.Document != nil {
		inbound.Files = append(inbound.Files, channels.InboundFile{
			FileID:   msg.Document.FileID,
			Filename: msg.Document.FileName,
			MimeType: msg.Document.MimeType,
			Size:     int64(msg.Document.FileSize),
		})
	}

	// Skip empty messages
	if inbound.Text == "" && len(inbound.Files) == 0 {
		return
	}

	// If text is still empty but has files, add a placeholder
	if inbound.Text == "" {
		inbound.Text = "[file attached]"
	}

	// Route to handler
	go a.router.HandleInbound(inbound, a)
}
