package handlers

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/ahvholding/ahvclaw/crypto"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

var oauthProviders = map[string]struct {
	RouterName string
	APIURL     string
	APIFormat  string
	Models     []string // default models for this provider
}{
	"claude": {"claude", "https://api.anthropic.com", "anthropic", []string{
		"claude-sonnet-4-5-20250514", "claude-sonnet-4-20250514", "claude-opus-4-20250514",
		"claude-haiku-4-5-20251001", "claude-3-5-sonnet-20241022",
	}},
	"openai": {"codex", "https://api.openai.com/v1", "openai", []string{
		"gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
		"gpt-4o", "gpt-4o-mini", "o3", "o4-mini", "codex-mini",
	}},
	"gemini": {"gemini-cli", "https://generativelanguage.googleapis.com", "google", []string{
		"gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash",
	}},
}

type oauthState struct {
	UserID       uuid.UUID
	Provider     string
	CodeVerifier string
	RedirectURI  string
	CreatedAt    time.Time
}

var (
	pendingOAuth   = make(map[string]*oauthState)
	pendingOAuthMu sync.Mutex
)

func cleanupPendingOAuth() {
	pendingOAuthMu.Lock()
	defer pendingOAuthMu.Unlock()
	cutoff := time.Now().Add(-15 * time.Minute)
	for k, v := range pendingOAuth {
		if v.CreatedAt.Before(cutoff) {
			delete(pendingOAuth, k)
		}
	}
}

func generatePKCE() (verifier, challenge, state string) {
	// Generate code_verifier (43-128 chars, base64url)
	vBytes := make([]byte, 32)
	rand.Read(vBytes)
	verifier = strings.TrimRight(base64.URLEncoding.EncodeToString(vBytes), "=")

	// Generate code_challenge = base64url(sha256(verifier))
	hash := sha256.Sum256([]byte(verifier))
	challenge = strings.TrimRight(base64.URLEncoding.EncodeToString(hash[:]), "=")

	// Generate state
	sBytes := make([]byte, 32)
	rand.Read(sBytes)
	state = strings.TrimRight(base64.URLEncoding.EncodeToString(sBytes), "=")
	return
}

func OAuthAuthorize(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	provider := c.Params("provider")

	info, ok := oauthProviders[provider]
	if !ok {
		return c.Status(400).JSON(fiber.Map{"error": fmt.Sprintf("unsupported provider: %s", provider)})
	}

	if provider == "openai" {
		return oauthAuthorizeOpenAI(c, userID, info)
	}

	// Claude/Gemini: use 9Router proxy
	redirectURI := fmt.Sprintf("https://api.ahvclaw.com/api/oauth/callback/%s", provider)
	routerURL := fmt.Sprintf("http://localhost:8080/api/oauth/%s/authorize?redirect_uri=%s", info.RouterName, redirectURI)

	resp, err := http.Get(routerURL)
	if err != nil {
		return c.Status(502).JSON(fiber.Map{"error": "failed to contact OAuth proxy"})
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var result struct {
		AuthURL      string `json:"authUrl"`
		State        string `json:"state"`
		CodeVerifier string `json:"codeVerifier"`
		RedirectURI  string `json:"redirectUri"`
		Error        string `json:"error"`
	}
	json.Unmarshal(body, &result)

	if result.Error != "" {
		return c.Status(502).JSON(fiber.Map{"error": result.Error})
	}

	pendingOAuthMu.Lock()
	pendingOAuth[result.State] = &oauthState{
		UserID:       userID,
		Provider:     provider,
		CodeVerifier: result.CodeVerifier,
		RedirectURI:  result.RedirectURI,
		CreatedAt:    time.Now(),
	}
	pendingOAuthMu.Unlock()

	go cleanupPendingOAuth()

	return c.JSON(fiber.Map{
		"auth_url": result.AuthURL,
		"provider": provider,
	})
}

// oauthAuthorizeOpenAI builds the auth URL directly (no 9Router)
// to avoid extra params that OpenAI rejects from browser
func oauthAuthorizeOpenAI(c *fiber.Ctx, userID uuid.UUID, info struct {
	RouterName string
	APIURL     string
	APIFormat  string
	Models     []string
}) error {
	verifier, challenge, state := generatePKCE()
	redirectURI := "http://localhost:1455/auth/callback"

	params := url.Values{
		"response_type":         {"code"},
		"client_id":             {"app_EMoamEEZ73f0CkXaXp7hrann"},
		"redirect_uri":          {redirectURI},
		"scope":                 {"openid profile email offline_access"},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
		"state":                 {state},
	}
	authURL := "https://auth.openai.com/oauth/authorize?" + params.Encode()
	log.Printf("[oauth] OpenAI auth URL: %s", authURL)

	pendingOAuthMu.Lock()
	pendingOAuth[state] = &oauthState{
		UserID:       userID,
		Provider:     "openai",
		CodeVerifier: verifier,
		RedirectURI:  redirectURI,
		CreatedAt:    time.Now(),
	}
	pendingOAuthMu.Unlock()

	go cleanupPendingOAuth()

	return c.JSON(fiber.Map{
		"auth_url":  authURL,
		"provider":  "openai",
		"paste_url": true,
	})
}

// OAuthCallback handles direct callbacks from providers (Claude, Gemini)
func OAuthCallback(c *fiber.Ctx) error {
	provider := c.Params("provider")
	code := c.Query("code")
	state := c.Query("state")

	if code == "" || state == "" {
		return c.Type("html").SendString(errorHTML(c.Query("error", "missing code or state")))
	}

	pendingOAuthMu.Lock()
	os, ok := pendingOAuth[state]
	if ok {
		delete(pendingOAuth, state)
	}
	pendingOAuthMu.Unlock()

	if !ok {
		return c.Type("html").SendString(errorHTML("Invalid or expired state"))
	}

	return exchangeAndSave(c, provider, code, os, true)
}

// OAuthPasteExchange handles pasted callback URLs from the frontend (for OpenAI)
func OAuthPasteExchange(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)

	var body struct {
		URL   string `json:"url"`
		Code  string `json:"code"`
		State string `json:"state"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request body"})
	}

	var code, state string
	if body.URL != "" {
		parsed, err := url.Parse(body.URL)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "URL không hợp lệ"})
		}
		code = parsed.Query().Get("code")
		state = parsed.Query().Get("state")
	} else {
		code = body.Code
		state = body.State
	}

	if code == "" || state == "" {
		return c.Status(400).JSON(fiber.Map{"error": "Không tìm thấy code trong URL. Hãy chắc chắn copy đúng URL từ thanh địa chỉ."})
	}

	pendingOAuthMu.Lock()
	os, ok := pendingOAuth[state]
	if ok {
		delete(pendingOAuth, state)
	}
	pendingOAuthMu.Unlock()

	if !ok {
		return c.Status(400).JSON(fiber.Map{"error": "Phiên đăng nhập đã hết hạn. Vui lòng thử lại."})
	}

	if userID != os.UserID {
		return c.Status(403).JSON(fiber.Map{"error": "user mismatch"})
	}

	return exchangeAndSave(c, os.Provider, code, os, false)
}

// exchangeAndSave exchanges code for tokens via 9Router and saves to DB.
// MULTI-ACCOUNT: Always creates a new connection (no upsert).
// If same email already connected, update that one instead.
func exchangeAndSave(c *fiber.Ctx, provider, code string, os *oauthState, renderHTML bool) error {
	info := oauthProviders[provider]

	var resp *http.Response
	var err error

	if provider == "openai" {
		// Exchange directly with OpenAI (we built the auth URL ourselves)
		exchangeBody := url.Values{
			"grant_type":    {"authorization_code"},
			"client_id":     {"app_EMoamEEZ73f0CkXaXp7hrann"},
			"code":          {code},
			"redirect_uri":  {os.RedirectURI},
			"code_verifier": {os.CodeVerifier},
		}
		resp, err = http.Post("https://auth.openai.com/oauth/token",
			"application/x-www-form-urlencoded",
			bytes.NewReader([]byte(exchangeBody.Encode())))
	} else {
		// Claude/Gemini: use 9Router proxy for exchange
		exchangeURL := fmt.Sprintf("http://localhost:8080/api/oauth/%s/exchange", info.RouterName)
		body, _ := json.Marshal(map[string]string{
			"code": code, "codeVerifier": os.CodeVerifier, "redirectUri": os.RedirectURI,
		})
		resp, err = http.Post(exchangeURL, "application/json", bytes.NewReader(body))
	}
	if err != nil {
		log.Printf("[oauth] exchange error for %s: %v", provider, err)
		if renderHTML {
			return c.Type("html").SendString(errorHTML("Token exchange failed"))
		}
		return c.Status(502).JSON(fiber.Map{"error": "Đổi token thất bại"})
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	// Parse token response (handles both 9Router and direct OpenAI formats)
	var raw map[string]interface{}
	json.Unmarshal(respBody, &raw)

	var tokenResp struct {
		AccessToken  string
		RefreshToken string
		ExpiresIn    int
		Scope        string
		Email        string
		Error        string
	}

	// 9Router uses camelCase, OpenAI uses snake_case
	if v, ok := raw["accessToken"].(string); ok {
		tokenResp.AccessToken = v
	} else if v, ok := raw["access_token"].(string); ok {
		tokenResp.AccessToken = v
	}
	if v, ok := raw["refreshToken"].(string); ok {
		tokenResp.RefreshToken = v
	} else if v, ok := raw["refresh_token"].(string); ok {
		tokenResp.RefreshToken = v
	}
	if v, ok := raw["expiresIn"].(float64); ok {
		tokenResp.ExpiresIn = int(v)
	} else if v, ok := raw["expires_in"].(float64); ok {
		tokenResp.ExpiresIn = int(v)
	}
	if v, ok := raw["scope"].(string); ok {
		tokenResp.Scope = v
	}
	if v, ok := raw["email"].(string); ok {
		tokenResp.Email = v
	}
	if v, ok := raw["error"].(string); ok {
		tokenResp.Error = v
	}

	if tokenResp.Error != "" || tokenResp.AccessToken == "" {
		errMsg := tokenResp.Error
		if errMsg == "" {
			errMsg = "failed to get access token"
		}
		log.Printf("[oauth] exchange failed for %s: %s", provider, errMsg)
		if renderHTML {
			return c.Type("html").SendString(errorHTML(errMsg))
		}
		return c.Status(502).JSON(fiber.Map{"error": errMsg})
	}

	encAccess, _ := crypto.Encrypt(tokenResp.AccessToken)
	var encRefresh string
	if tokenResp.RefreshToken != "" {
		encRefresh, _ = crypto.Encrypt(tokenResp.RefreshToken)
	}

	var expiresAt *time.Time
	if tokenResp.ExpiresIn > 0 {
		t := time.Now().Add(time.Duration(tokenResp.ExpiresIn) * time.Second)
		expiresAt = &t
	}

	accountName := tokenResp.Email
	if accountName == "" {
		accountName = fmt.Sprintf("%s (OAuth)", provider)
	}

	// Default models for this provider
	modelsJSON, _ := json.Marshal(info.Models)

	ctx := context.Background()

	// MULTI-ACCOUNT: Check if same email already connected for this provider+user
	// If yes, update (re-auth same account). If no, insert new (new account).
	var existingID uuid.UUID
	if tokenResp.Email != "" {
		db.Pool.QueryRow(ctx,
			`SELECT id FROM provider_connections
			 WHERE user_id = $1 AND provider_type = $2 AND auth_type = 'oauth' AND name = $3
			 LIMIT 1`,
			os.UserID, provider, tokenResp.Email).Scan(&existingID)
	}

	if existingID != uuid.Nil {
		// Re-auth existing account — update tokens
		_, err = db.Pool.Exec(ctx,
			`UPDATE provider_connections SET
			   access_token_encrypted = $1, refresh_token_encrypted = $2,
			   token_expires_at = $3, oauth_scope = $4, is_active = true, test_status = 'active',
			   last_error = '', error_code = 0, backoff_level = 0, models = $5, updated_at = now()
			 WHERE id = $6`,
			encAccess, encRefresh, expiresAt, tokenResp.Scope, modelsJSON, existingID)
		log.Printf("[oauth] %s re-authed for user %s (account: %s, id: %s)", provider, os.UserID, accountName, existingID)
	} else {
		// New account — count existing to set priority
		var count int
		db.Pool.QueryRow(ctx,
			`SELECT COUNT(*) FROM provider_connections WHERE user_id = $1 AND provider_type = $2`,
			os.UserID, provider).Scan(&count)

		_, err = db.Pool.Exec(ctx,
			`INSERT INTO provider_connections (user_id, provider_type, auth_type, name, api_url, api_format,
			   access_token_encrypted, refresh_token_encrypted, token_expires_at, oauth_scope,
			   is_active, test_status, models, priority)
			 VALUES ($1, $2, 'oauth', $3, $4, $5, $6, $7, $8, $9, true, 'active', $10, $11)`,
			os.UserID, provider, accountName, info.APIURL, info.APIFormat,
			encAccess, encRefresh, expiresAt, tokenResp.Scope, modelsJSON, count+1)
		log.Printf("[oauth] %s NEW account connected for user %s (account: %s, priority: %d)", provider, os.UserID, accountName, count+1)
	}
	if err != nil {
		log.Printf("[oauth] DB save error: %v", err)
		if renderHTML {
			return c.Type("html").SendString(errorHTML("Failed to save connection"))
		}
		return c.Status(500).JSON(fiber.Map{"error": "Lưu kết nối thất bại"})
	}

	if renderHTML {
		return c.Type("html").SendString(fmt.Sprintf(`<!DOCTYPE html>
<html><head><style>
body{background:#18181b;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{text-align:center;padding:2rem}.check{color:#22c55e;font-size:3rem}
</style></head><body>
<div class="card"><div class="check">&#10003;</div>
<h2>%s connected!</h2><p style="color:#a1a1aa">Account: %s</p>
<p style="color:#71717a;font-size:0.8rem">Cửa sổ sẽ tự đóng...</p></div>
<script>window.opener&&window.opener.postMessage({type:'oauth_success',provider:'%s'},'*');setTimeout(()=>window.close(),2000)</script>
</body></html>`, provider, accountName, provider))
	}

	return c.JSON(fiber.Map{"ok": true, "provider": provider, "account": accountName})
}

func errorHTML(msg string) string {
	return fmt.Sprintf(`<html><body style="background:#18181b;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h2>OAuth Failed</h2><p style="color:#a1a1aa">%s</p></div><script>setTimeout(()=>window.close(),3000)</script></body></html>`, msg)
}
