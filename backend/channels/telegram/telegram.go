package telegram

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ahvholding/ahvclaw/channels"
	"github.com/ahvholding/ahvclaw/db"
	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/google/uuid"
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

	// Register slash commands with Telegram
	commands := []tgbotapi.BotCommand{
		{Command: "start", Description: "Bat dau tro chuyen"},
		{Command: "new", Description: "Cuoc tro chuyen moi"},
		{Command: "models", Description: "Chon model AI"},
		{Command: "help", Description: "Huong dan su dung"},
		{Command: "agents", Description: "Chon agent"},
		{Command: "skills", Description: "Xem danh sach skill"},
		{Command: "memory", Description: "Xem memory da luu"},
		{Command: "status", Description: "Trang thai hien tai"},
	}
	cmdConfig := tgbotapi.NewSetMyCommands(commands...)
	if _, err := bot.Request(cmdConfig); err != nil {
		log.Printf("[telegram] bot %s: failed to set commands: %v", a.botID, err)
	}

	go func() {
		backoff := 1 * time.Second
		maxBackoff := 60 * time.Second

		for {
			u := tgbotapi.NewUpdate(0)
			u.Timeout = 30
			updates := a.api.GetUpdatesChan(u)

			// Process updates
			running := true
			for running {
				select {
				case <-a.stopCh:
					a.api.StopReceivingUpdates()
					log.Printf("[telegram] bot %s stopped", a.botID)
					return
				case update, ok := <-updates:
					if !ok {
						running = false // channel closed, need reconnect
						break
					}
					backoff = 1 * time.Second // reset on success
					a.processUpdate(update)
				}
			}

			// Reconnect with backoff
			log.Printf("[telegram] bot %s disconnected, reconnecting in %v", a.botID, backoff)
			select {
			case <-a.stopCh:
				return
			case <-time.After(backoff):
			}
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}

			// Recreate bot API
			bot, err := tgbotapi.NewBotAPI(a.config.BotToken)
			if err != nil {
				log.Printf("[telegram] bot %s reconnect failed: %v", a.botID, err)
				continue
			}
			a.api = bot
			log.Printf("[telegram] bot %s reconnected as @%s", a.botID, bot.Self.UserName)
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
	_, err = a.api.Request(action)
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

// sendText sends a plain text message to a chat ID (int64).
func (a *Adapter) sendText(chatID int64, text string) {
	msg := tgbotapi.NewMessage(chatID, text)
	_, err := a.api.Send(msg)
	if err != nil {
		log.Printf("[telegram] sendText error: %v", err)
	}
}

// sendTextWithKeyboard sends a message with an inline keyboard.
func (a *Adapter) sendTextWithKeyboard(chatID int64, text string, keyboard tgbotapi.InlineKeyboardMarkup) {
	msg := tgbotapi.NewMessage(chatID, text)
	msg.ReplyMarkup = keyboard
	_, err := a.api.Send(msg)
	if err != nil {
		log.Printf("[telegram] sendTextWithKeyboard error: %v", err)
	}
}

// getBotUserID returns the user_id for this bot from the DB.
func (a *Adapter) getBotUserID(ctx context.Context) (uuid.UUID, error) {
	botUUID, err := uuid.Parse(a.botID)
	if err != nil {
		return uuid.Nil, fmt.Errorf("invalid bot ID: %w", err)
	}
	var userID uuid.UUID
	err = db.Pool.QueryRow(ctx, `SELECT user_id FROM bots WHERE id = $1`, botUUID).Scan(&userID)
	if err != nil {
		return uuid.Nil, fmt.Errorf("bot not found: %w", err)
	}
	return userID, nil
}

// handleCommand processes a Telegram slash command.
func (a *Adapter) handleCommand(msg *tgbotapi.Message) {
	chatID := msg.Chat.ID
	ctx := context.Background()

	cmd := msg.Command()
	switch cmd {
	case "start":
		a.sendText(chatID, "Xin chao! Toi la tro ly AI cua ban.\n\nDung /help de xem danh sach lenh.")

	case "new":
		botUUID, err := uuid.Parse(a.botID)
		if err != nil {
			a.sendText(chatID, "Loi noi bo.")
			return
		}
		chatIDStr := strconv.FormatInt(msg.Chat.ID, 10)
		tag, err := db.Pool.Exec(ctx,
			`UPDATE conversations SET status='archived'
			 WHERE bot_id=$1 AND channel_chat_id=$2 AND status='active'`,
			botUUID, chatIDStr,
		)
		if err != nil {
			log.Printf("[telegram] /new error: %v", err)
			a.sendText(chatID, "Khong the tao cuoc tro chuyen moi.")
			return
		}
		archived := tag.RowsAffected()
		if archived > 0 {
			a.sendText(chatID, "Da luu tru cuoc tro chuyen cu. Bat dau cuoc tro chuyen moi!")
		} else {
			a.sendText(chatID, "Bat dau cuoc tro chuyen moi!")
		}

	case "models":
		userID, err := a.getBotUserID(ctx)
		if err != nil {
			a.sendText(chatID, "Loi noi bo.")
			return
		}
		rows, err := db.Pool.Query(ctx,
			`SELECT DISTINCT model FROM conversations
			 WHERE user_id=$1 AND model IS NOT NULL AND model != ''
			 LIMIT 10`,
			userID,
		)
		if err != nil {
			a.sendText(chatID, "Khong the lay danh sach model.")
			return
		}
		defer rows.Close()

		var models []string
		for rows.Next() {
			var m string
			if rows.Scan(&m) == nil && m != "" {
				models = append(models, m)
			}
		}

		if len(models) == 0 {
			a.sendText(chatID, "Chua co model nao duoc su dung.")
			return
		}

		var kbRows [][]tgbotapi.InlineKeyboardButton
		for _, m := range models {
			label := m
			if len(label) > 30 {
				label = label[:30] + "..."
			}
			kbRows = append(kbRows, tgbotapi.NewInlineKeyboardRow(
				tgbotapi.NewInlineKeyboardButtonData(label, "model:"+m),
			))
		}
		keyboard := tgbotapi.NewInlineKeyboardMarkup(kbRows...)
		a.sendTextWithKeyboard(chatID, "Chon model AI:", keyboard)

	case "help":
		help := "Danh sach lenh:\n\n" +
			"/start - Bat dau tro chuyen\n" +
			"/new - Tao cuoc tro chuyen moi\n" +
			"/models - Chon model AI\n" +
			"/agents - Chon agent\n" +
			"/skills - Xem danh sach skill\n" +
			"/memory - Xem memory da luu\n" +
			"/status - Trang thai hien tai\n" +
			"/help - Huong dan su dung"
		a.sendText(chatID, help)

	case "agents":
		userID, err := a.getBotUserID(ctx)
		if err != nil {
			a.sendText(chatID, "Loi noi bo.")
			return
		}
		rows, err := db.Pool.Query(ctx,
			`SELECT id, name FROM agents
			 WHERE user_id=$1 OR is_public=true
			 ORDER BY name ASC LIMIT 10`,
			userID,
		)
		if err != nil {
			a.sendText(chatID, "Khong the lay danh sach agent.")
			return
		}
		defer rows.Close()

		type agentRow struct {
			id   string
			name string
		}
		var agentList []agentRow
		for rows.Next() {
			var id uuid.UUID
			var name string
			if rows.Scan(&id, &name) == nil {
				agentList = append(agentList, agentRow{id: id.String(), name: name})
			}
		}

		if len(agentList) == 0 {
			a.sendText(chatID, "Chua co agent nao.")
			return
		}

		var kbRows [][]tgbotapi.InlineKeyboardButton
		for _, ag := range agentList {
			label := ag.name
			if len(label) > 30 {
				label = label[:30] + "..."
			}
			kbRows = append(kbRows, tgbotapi.NewInlineKeyboardRow(
				tgbotapi.NewInlineKeyboardButtonData(label, "agent:"+ag.id),
			))
		}
		keyboard := tgbotapi.NewInlineKeyboardMarkup(kbRows...)
		a.sendTextWithKeyboard(chatID, "Chon agent:", keyboard)

	case "skills":
		userID, err := a.getBotUserID(ctx)
		if err != nil {
			a.sendText(chatID, "Loi noi bo.")
			return
		}
		rows, err := db.Pool.Query(ctx,
			`SELECT s.name, us.enabled
			 FROM user_skills us
			 JOIN skills s ON s.id = us.skill_id
			 WHERE us.user_id = $1
			 ORDER BY s.name ASC LIMIT 20`,
			userID,
		)
		if err != nil {
			a.sendText(chatID, "Khong the lay danh sach skill.")
			return
		}
		defer rows.Close()

		var sb strings.Builder
		sb.WriteString("Danh sach skill cua ban:\n\n")
		count := 0
		for rows.Next() {
			var name string
			var enabled bool
			if rows.Scan(&name, &enabled) == nil {
				status := "[ON]"
				if !enabled {
					status = "[OFF]"
				}
				sb.WriteString(fmt.Sprintf("%s %s\n", status, name))
				count++
			}
		}
		if count == 0 {
			a.sendText(chatID, "Ban chua cai skill nao.")
			return
		}
		a.sendText(chatID, sb.String())

	case "memory":
		userID, err := a.getBotUserID(ctx)
		if err != nil {
			a.sendText(chatID, "Loi noi bo.")
			return
		}
		rows, err := db.Pool.Query(ctx,
			`SELECT key, content FROM memories
			 WHERE user_id=$1
			 ORDER BY updated_at DESC LIMIT 10`,
			userID,
		)
		if err != nil {
			a.sendText(chatID, "Khong the lay memory.")
			return
		}
		defer rows.Close()

		var sb strings.Builder
		sb.WriteString("Memory da luu:\n\n")
		count := 0
		for rows.Next() {
			var key, value string
			if rows.Scan(&key, &value) == nil {
				if len(value) > 100 {
					value = value[:100] + "..."
				}
				sb.WriteString(fmt.Sprintf("- %s: %s\n", key, value))
				count++
			}
		}
		if count == 0 {
			a.sendText(chatID, "Chua co memory nao duoc luu.")
			return
		}
		a.sendText(chatID, sb.String())

	case "status":
		botUUID, err := uuid.Parse(a.botID)
		if err != nil {
			a.sendText(chatID, "Loi noi bo.")
			return
		}
		chatIDStr := strconv.FormatInt(msg.Chat.ID, 10)

		var model *string
		var agentName *string
		var msgCount int

		err = db.Pool.QueryRow(ctx,
			`SELECT c.model,
			        (SELECT a.name FROM agents a WHERE a.id = c.current_agent_id) AS agent_name,
			        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS msg_count
			 FROM conversations c
			 WHERE c.bot_id=$1 AND c.channel_chat_id=$2 AND c.status='active'
			 ORDER BY c.updated_at DESC LIMIT 1`,
			botUUID, chatIDStr,
		).Scan(&model, &agentName, &msgCount)

		if err != nil {
			a.sendText(chatID, "Chua co cuoc tro chuyen nao dang hoat dong.")
			return
		}

		modelStr := "(chua dat)"
		if model != nil && *model != "" {
			modelStr = *model
		}
		agentStr := "(mac dinh)"
		if agentName != nil && *agentName != "" {
			agentStr = *agentName
		}

		status := fmt.Sprintf("Trang thai hien tai:\n\nModel: %s\nAgent: %s\nTin nhan: %d",
			modelStr, agentStr, msgCount)
		a.sendText(chatID, status)
	}
}

// handleCallbackQuery processes inline keyboard button presses.
func (a *Adapter) handleCallbackQuery(cq *tgbotapi.CallbackQuery) {
	ctx := context.Background()
	data := cq.Data
	chatID := cq.Message.Chat.ID

	// Acknowledge the callback immediately
	ack := tgbotapi.NewCallback(cq.ID, "")
	_, _ = a.api.Request(ack)

	botUUID, err := uuid.Parse(a.botID)
	if err != nil {
		return
	}
	chatIDStr := strconv.FormatInt(chatID, 10)

	if strings.HasPrefix(data, "model:") {
		newModel := strings.TrimPrefix(data, "model:")
		tag, err := db.Pool.Exec(ctx,
			`UPDATE conversations SET model=$1
			 WHERE bot_id=$2 AND channel_chat_id=$3 AND status='active'`,
			newModel, botUUID, chatIDStr,
		)
		if err != nil || tag.RowsAffected() == 0 {
			a.sendText(chatID, "Khong the cap nhat model.")
			return
		}
		a.sendText(chatID, fmt.Sprintf("Da chuyen sang model: %s", newModel))

	} else if strings.HasPrefix(data, "agent:") {
		agentIDStr := strings.TrimPrefix(data, "agent:")
		agentUUID, err := uuid.Parse(agentIDStr)
		if err != nil {
			a.sendText(chatID, "Agent khong hop le.")
			return
		}
		tag, err := db.Pool.Exec(ctx,
			`UPDATE conversations SET current_agent_id=$1
			 WHERE bot_id=$2 AND channel_chat_id=$3 AND status='active'`,
			agentUUID, botUUID, chatIDStr,
		)
		if err != nil || tag.RowsAffected() == 0 {
			a.sendText(chatID, "Khong the cap nhat agent.")
			return
		}
		// Get agent name for confirmation
		var agentName string
		_ = db.Pool.QueryRow(ctx, `SELECT name FROM agents WHERE id=$1`, agentUUID).Scan(&agentName)
		if agentName == "" {
			agentName = agentIDStr
		}
		a.sendText(chatID, fmt.Sprintf("Da chuyen sang agent: %s", agentName))
	}
}

// processUpdate handles a single Telegram update.
func (a *Adapter) processUpdate(update tgbotapi.Update) {
	// Handle callback queries (inline keyboard responses)
	if update.CallbackQuery != nil {
		a.handleCallbackQuery(update.CallbackQuery)
		return
	}

	if update.Message == nil {
		return
	}

	msg := update.Message

	// Handle slash commands before routing to AI
	if msg.IsCommand() {
		a.handleCommand(msg)
		return
	}

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

	// Handle photos - download and base64 encode for AI vision
	if msg.Photo != nil && len(msg.Photo) > 0 {
		// Use largest photo
		largest := msg.Photo[len(msg.Photo)-1]
		file := channels.InboundFile{
			FileID:   largest.FileID,
			MimeType: "image/jpeg",
			Size:     int64(largest.FileSize),
		}
		// Download photo data and base64 encode
		if b64, err := a.downloadFileBase64(largest.FileID); err == nil {
			file.Base64Data = b64
		} else {
			log.Printf("[telegram] failed to download photo %s: %v", largest.FileID, err)
		}
		inbound.Files = append(inbound.Files, file)
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

// downloadFileBase64 downloads a Telegram file and returns its base64-encoded content.
func (a *Adapter) downloadFileBase64(fileID string) (string, error) {
	fileURL, err := a.api.GetFileDirectURL(fileID)
	if err != nil {
		return "", fmt.Errorf("get file URL: %w", err)
	}

	resp, err := http.Get(fileURL)
	if err != nil {
		return "", fmt.Errorf("download file: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read file: %w", err)
	}

	return base64.StdEncoding.EncodeToString(data), nil
}
