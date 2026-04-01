package discord

import (
	"encoding/json"
	"fmt"
	"log"

	"github.com/ahvholding/ahvclaw/channels"
	"github.com/bwmarrin/discordgo"
)

// DiscordConfig holds configuration for a Discord bot.
type DiscordConfig struct {
	BotToken string `json:"bot_token"`
	GuildID  string `json:"guild_id"`
}

// Adapter implements channels.ChannelAdapter for Discord.
type Adapter struct {
	botID   string
	config  DiscordConfig
	router  channels.InboundHandler
	session *discordgo.Session
}

// NewAdapter creates a new Discord adapter.
func NewAdapter(botID string, configJSON []byte, router channels.InboundHandler) (channels.ChannelAdapter, error) {
	var cfg DiscordConfig
	if err := json.Unmarshal(configJSON, &cfg); err != nil {
		return nil, fmt.Errorf("parse discord config: %w", err)
	}
	return &Adapter{
		botID:  botID,
		config: cfg,
		router: router,
	}, nil
}

func (a *Adapter) Name() string { return "discord" }

func (a *Adapter) ValidateConfig() error {
	if a.config.BotToken == "" {
		return fmt.Errorf("bot_token is required")
	}
	return nil
}

func (a *Adapter) Start() error {
	session, err := discordgo.New("Bot " + a.config.BotToken)
	if err != nil {
		return fmt.Errorf("create discord session: %w", err)
	}

	session.Identify.Intents = discordgo.IntentsGuildMessages | discordgo.IntentsDirectMessages | discordgo.IntentMessageContent

	session.AddHandler(a.handleMessage)

	if err := session.Open(); err != nil {
		return fmt.Errorf("open discord gateway: %w", err)
	}

	a.session = session
	log.Printf("[discord] bot %s connected as %s#%s", a.botID, session.State.User.Username, session.State.User.Discriminator)
	return nil
}

func (a *Adapter) Stop() error {
	if a.session != nil {
		if err := a.session.Close(); err != nil {
			return fmt.Errorf("close discord session: %w", err)
		}
		a.session = nil
		log.Printf("[discord] bot %s disconnected", a.botID)
	}
	return nil
}

func (a *Adapter) SendMessage(chatID string, text string) error {
	if a.session == nil {
		return fmt.Errorf("discord session not connected")
	}

	// Discord has a 2000 char limit per message
	for len(text) > 0 {
		chunk := text
		if len(chunk) > 2000 {
			chunk = text[:2000]
			text = text[2000:]
		} else {
			text = ""
		}
		if _, err := a.session.ChannelMessageSend(chatID, chunk); err != nil {
			return fmt.Errorf("send discord message: %w", err)
		}
	}
	return nil
}

func (a *Adapter) SendTyping(chatID string) error {
	if a.session != nil {
		a.session.ChannelTyping(chatID)
	}
	return nil
}

func (a *Adapter) SendFile(chatID string, file channels.FileRef) error {
	if a.session == nil {
		return fmt.Errorf("discord session not connected")
	}

	// Send file URL as a message
	text := file.URL
	if file.Filename != "" {
		text = fmt.Sprintf("%s\n%s", file.Filename, file.URL)
	}
	_, err := a.session.ChannelMessageSend(chatID, text)
	return err
}

func (a *Adapter) GetProfile(channelUserID string) (*channels.ContactProfile, error) {
	if a.session == nil {
		return nil, fmt.Errorf("discord session not connected")
	}

	user, err := a.session.User(channelUserID)
	if err != nil {
		return nil, fmt.Errorf("get discord user: %w", err)
	}

	displayName := user.Username
	if user.GlobalName != "" {
		displayName = user.GlobalName
	}

	return &channels.ContactProfile{
		ChannelUserID: channelUserID,
		Username:      user.Username + "#" + user.Discriminator,
		DisplayName:   displayName,
		AvatarURL:     user.AvatarURL(""),
	}, nil
}

// handleMessage is the discordgo event handler for incoming messages.
func (a *Adapter) handleMessage(s *discordgo.Session, m *discordgo.MessageCreate) {
	// Ignore messages from the bot itself
	if m.Author.ID == s.State.User.ID {
		return
	}
	// Ignore bot messages
	if m.Author.Bot {
		return
	}

	// If guild-specific, only handle messages in that guild
	if a.config.GuildID != "" && m.GuildID != a.config.GuildID {
		return
	}

	displayName := m.Author.Username
	if m.Author.GlobalName != "" {
		displayName = m.Author.GlobalName
	} else if m.Member != nil && m.Member.Nick != "" {
		displayName = m.Member.Nick
	}

	inbound := channels.InboundMessage{
		BotID:         a.botID,
		Channel:       "discord",
		ChannelUserID: m.Author.ID,
		ChatID:        m.ChannelID,
		MessageID:     m.ID,
		Text:          m.Content,
		Username:      m.Author.Username,
		DisplayName:   displayName,
	}

	// Handle attachments
	for _, att := range m.Attachments {
		inbound.Files = append(inbound.Files, channels.InboundFile{
			FileID:   att.ID,
			URL:      att.URL,
			Filename: att.Filename,
			MimeType: att.ContentType,
			Size:     int64(att.Size),
		})
	}

	// Skip empty messages
	if inbound.Text == "" && len(inbound.Files) == 0 {
		return
	}
	if inbound.Text == "" {
		inbound.Text = "[file attached]"
	}

	go a.router.HandleInbound(inbound, a)
}
