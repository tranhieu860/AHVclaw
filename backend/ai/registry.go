package ai

// ProviderTypeDef defines a known provider type with defaults
type ProviderTypeDef struct {
	Type        string   `json:"type"`
	Name        string   `json:"name"`
	DefaultURL  string   `json:"default_url"`
	APIFormat   string   `json:"api_format"`
	AuthTypes   []string `json:"auth_types"`
	AuthHeader  string   `json:"auth_header"`
	KnownModels []string `json:"known_models"`
	Icon        string   `json:"icon"`
	Description string   `json:"description"`
}

var ProviderRegistry = map[string]ProviderTypeDef{
	"openai": {
		Type: "openai", Name: "OpenAI",
		DefaultURL: "https://api.openai.com/v1",
		APIFormat: "openai", AuthTypes: []string{"api_key"},
		AuthHeader: "Authorization",
		KnownModels: []string{"gpt-4o", "gpt-4o-mini", "o3", "o4-mini", "gpt-4.1", "gpt-4.1-mini"},
		Icon: "openai", Description: "GPT-4o, o3, o4-mini",
	},
	"anthropic": {
		Type: "anthropic", Name: "Anthropic",
		DefaultURL: "https://api.anthropic.com",
		APIFormat: "anthropic", AuthTypes: []string{"api_key"},
		AuthHeader: "x-api-key",
		KnownModels: []string{"claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"},
		Icon: "anthropic", Description: "Claude Opus, Sonnet, Haiku",
	},
	"gemini": {
		Type: "gemini", Name: "Google Gemini",
		DefaultURL: "https://generativelanguage.googleapis.com/v1beta/openai",
		APIFormat: "openai", AuthTypes: []string{"api_key"},
		AuthHeader: "Authorization",
		KnownModels: []string{"gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"},
		Icon: "gemini", Description: "Gemini 2.5 Pro, Flash",
	},
	"minimax": {
		Type: "minimax", Name: "MiniMax (OpenAI)",
		DefaultURL: "https://api.minimax.chat/v1",
		APIFormat: "openai", AuthTypes: []string{"api_key"},
		AuthHeader: "Authorization",
		KnownModels: []string{"MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.5-highspeed", "MiniMax-M2.1", "MiniMax-M2.1-highspeed", "MiniMax-M2"},
		Icon: "minimax", Description: "MiniMax M2.7, M2.5 (OpenAI format)",
	},
	"minimax-anthropic": {
		Type: "minimax-anthropic", Name: "MiniMax (Anthropic)",
		DefaultURL: "https://api.minimax.io/anthropic",
		APIFormat: "anthropic", AuthTypes: []string{"api_key"},
		AuthHeader: "x-api-key",
		KnownModels: []string{"MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.5-highspeed", "MiniMax-M2.1", "MiniMax-M2.1-highspeed", "MiniMax-M2"},
		Icon: "minimax", Description: "MiniMax M2.7, M2.5 (Anthropic format)",
	},
	"deepseek": {
		Type: "deepseek", Name: "DeepSeek",
		DefaultURL: "https://api.deepseek.com/v1",
		APIFormat: "openai", AuthTypes: []string{"api_key"},
		AuthHeader: "Authorization",
		KnownModels: []string{"deepseek-chat", "deepseek-reasoner"},
		Icon: "deepseek", Description: "DeepSeek Chat, Reasoner",
	},
	"glm": {
		Type: "glm", Name: "GLM (Zhipu AI)",
		DefaultURL: "https://open.bigmodel.cn/api/paas/v4",
		APIFormat: "openai", AuthTypes: []string{"api_key"},
		AuthHeader: "Authorization",
		KnownModels: []string{"glm-4-plus", "glm-4-flash", "glm-4-long"},
		Icon: "glm", Description: "GLM-4 Plus, Flash",
	},
	"claude-proxy": {
		Type: "claude-proxy", Name: "Claude Code Proxy",
		DefaultURL: "http://localhost:3010",
		APIFormat: "anthropic", AuthTypes: []string{"api_key"},
		AuthHeader: "x-api-key",
		KnownModels: []string{"claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"},
		Icon: "claude", Description: "Local Claude CLI proxy",
	},
	"9router": {
		Type: "9router", Name: "9Router",
		DefaultURL: "http://localhost:8080",
		APIFormat: "openai", AuthTypes: []string{"api_key"},
		AuthHeader: "Authorization",
		KnownModels: []string{},
		Icon: "router", Description: "Multi-provider router",
	},
	"custom": {
		Type: "custom", Name: "Custom",
		DefaultURL: "",
		APIFormat: "openai", AuthTypes: []string{"api_key"},
		AuthHeader: "Authorization",
		KnownModels: []string{},
		Icon: "custom", Description: "OpenAI-compatible endpoint",
	},
}

func RegistryList() []ProviderTypeDef {
	order := []string{"openai", "anthropic", "gemini", "minimax", "minimax-anthropic", "deepseek", "glm", "claude-proxy", "9router", "custom"}
	var list []ProviderTypeDef
	for _, k := range order {
		if d, ok := ProviderRegistry[k]; ok {
			list = append(list, d)
		}
	}
	return list
}
