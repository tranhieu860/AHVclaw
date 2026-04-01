package channels

// ChannelAdapter is the interface that all channel adapters must implement.
type ChannelAdapter interface {
	// Start begins listening for inbound messages.
	Start() error
	// Stop gracefully shuts down the adapter.
	Stop() error
	// SendMessage sends a text message to a channel user/chat.
	SendMessage(chatID string, text string) error
	// SendFile sends a file to a channel user/chat.
	SendFile(chatID string, file FileRef) error
	// GetProfile fetches the contact profile for a channel user.
	GetProfile(channelUserID string) (*ContactProfile, error)
	// ValidateConfig checks whether the adapter config is valid.
	ValidateConfig() error
	// SendTyping sends a typing indicator to the chat.
	SendTyping(chatID string) error
	// Name returns the channel name (e.g. "telegram", "zalo", "discord").
	Name() string
}

// OutboundMessage represents a message to be sent to a channel.
type OutboundMessage struct {
	ChatID       string    `json:"chat_id"`
	Text         string    `json:"text"`
	Files        []FileRef `json:"files,omitempty"`
	ReplyToMsgID string    `json:"reply_to_msg_id,omitempty"`
}

// FileRef represents a file attachment.
type FileRef struct {
	URL      string `json:"url"`
	Filename string `json:"filename"`
	MimeType string `json:"mime_type"`
	Size     int64  `json:"size"`
	FileID   string `json:"file_id,omitempty"`
}

// ContactProfile holds info about a channel contact.
type ContactProfile struct {
	ChannelUserID string `json:"channel_user_id"`
	Username      string `json:"username,omitempty"`
	DisplayName   string `json:"display_name,omitempty"`
	AvatarURL     string `json:"avatar_url,omitempty"`
	Language      string `json:"language,omitempty"`
}

// InboundMessage represents a message received from a channel.
type InboundMessage struct {
	BotID         string        `json:"bot_id"`
	Channel       string        `json:"channel"`
	ChannelUserID string        `json:"channel_user_id"`
	ChatID        string        `json:"chat_id"`
	MessageID     string        `json:"message_id"`
	Text          string        `json:"text"`
	Files         []InboundFile `json:"files,omitempty"`
	Username      string        `json:"username,omitempty"`
	DisplayName   string        `json:"display_name,omitempty"`
}

// InboundHandler is the interface for routing inbound messages.
type InboundHandler interface {
	HandleInbound(msg InboundMessage, adapter ChannelAdapter)
}

// InboundFile represents a file received from a channel.
type InboundFile struct {
	FileID   string `json:"file_id"`
	URL      string `json:"url,omitempty"`
	Filename string `json:"filename,omitempty"`
	MimeType string `json:"mime_type,omitempty"`
	Size       int64  `json:"size,omitempty"`
	Base64Data string `json:"base64_data,omitempty"`
}
