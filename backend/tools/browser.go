package tools

import (
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"github.com/ahvholding/ahvclaw/browser"
	"github.com/ahvholding/ahvclaw/computeruse"
)

// BrowserMode represents which execution path to use for a browser action.
type BrowserMode int

const (
	ModeHTTPRequest  BrowserMode = iota // delegate to http_request tool
	ModePlaywright                       // headless Playwright
	ModeCDP                              // Native Helper via CDP (SendCompanionCommand)
	ModeNotifyUser                       // helper offline but auth required — ask user to install
)

// resolveMode picks the best execution path given the URL and runtime flags.
func (e *Executor) resolveMode(url string, needsAuth, needsInteraction, userRequested bool) BrowserMode {
	// Pure data endpoints — skip the browser entirely
	if strings.HasSuffix(url, ".json") || strings.Contains(url, "/api/") {
		return ModeHTTPRequest
	}

	helperOnline := computeruse.Hub.IsOnline(e.UserID)

	if helperOnline && (needsAuth || needsInteraction || userRequested) {
		return ModeCDP
	}
	if !helperOnline && needsAuth {
		return ModeNotifyUser
	}
	return ModePlaywright
}

// broadcast sends a browser_update event to the user's frontend
func (e *Executor) broadcastBrowserUpdate(source, screenshot, url, title, action string) {
	if e.BroadcastFn != nil {
		e.BroadcastFn(e.UserID, "browser_update", map[string]interface{}{
			"source":     source,
			"screenshot": screenshot,
			"url":        url,
			"title":      title,
			"action":     action,
		})
	}
}

// playwrightScreenshot captures a screenshot via Playwright and returns base64 image data
func (e *Executor) playwrightScreenshot() string {
	if ssResult, err := browser.Execute(browser.BrowserRequest{
		Action: "screenshot",
		UserID: e.UserID,
	}); err == nil {
		return ssResult.Image
	}
	return ""
}

func (e *Executor) browserNavigate(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		URL              string `json:"url"`
		UseHelper        bool   `json:"use_helper"`
		NeedsAuth        bool   `json:"needs_auth"`
		NeedsInteraction bool   `json:"needs_interaction"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "browser_navigate", Error: "invalid arguments"}
	}
	if args.URL == "" {
		return &ToolResult{Name: "browser_navigate", Error: "url is required"}
	}

	mode := e.resolveMode(args.URL, args.NeedsAuth, args.NeedsInteraction, args.UseHelper)

	switch mode {
	case ModeHTTPRequest:
		return &ToolResult{
			Name:    "browser_navigate",
			Content: fmt.Sprintf("URL %s looks like an API/data endpoint. Use the http_request tool instead for better results.", args.URL),
		}

	case ModeNotifyUser:
		return &ToolResult{
			Name:    "browser_navigate",
			Content: "Trang này cần đăng nhập. Cần bật AHVclaw extension để sử dụng trình duyệt thật.",
		}

	case ModeCDP:
		params, _ := json.Marshal(map[string]string{"url": args.URL})
		result, err := computeruse.Hub.SendCompanionCommand(e.UserID, "navigate", params)
		if err != nil {
			// FAIL CLOSED — do not fall back to Playwright
			return &ToolResult{Name: "browser_navigate", Error: fmt.Sprintf("CDP navigate failed: %s", err.Error())}
		}
		if result.Status == "blocked" {
			return &ToolResult{Name: "browser_navigate", Error: fmt.Sprintf("CDP navigate blocked: %s", result.Error)}
		}
		var data struct {
			URL   string `json:"url"`
			Title string `json:"title"`
		}
		json.Unmarshal(result.Data, &data)
		e.broadcastBrowserUpdate("cdp", "", data.URL, data.Title, fmt.Sprintf("Navigated to: %s", data.URL))
		return &ToolResult{
			Name:    "browser_navigate",
			Content: fmt.Sprintf("Navigated to: %s\nTitle: %s", data.URL, data.Title),
		}

	default: // ModePlaywright
		result, err := browser.Execute(browser.BrowserRequest{
			Action: "navigate",
			UserID: e.UserID,
			URL:    args.URL,
		})
		if err != nil {
			return &ToolResult{Name: "browser_navigate", Error: err.Error()}
		}
		screenshot := e.playwrightScreenshot()
		e.broadcastBrowserUpdate("playwright", screenshot, result.URL, result.Title, fmt.Sprintf("Navigated to: %s", result.URL))
		return &ToolResult{
			Name:    "browser_navigate",
			Content: fmt.Sprintf("Navigated to: %s\nTitle: %s", result.URL, result.Title),
		}
	}
}

func (e *Executor) browserExtract(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		Selector  string `json:"selector"`
		UseHelper bool   `json:"use_helper"`
		NeedsAuth bool   `json:"needs_auth"`
	}
	// args are optional — ignore unmarshal errors
	json.Unmarshal(argsJSON, &args)

	mode := e.resolveMode("", args.NeedsAuth, false, args.UseHelper)

	switch mode {
	case ModeNotifyUser:
		return &ToolResult{
			Name:    "browser_extract",
			Content: "Thao tac nay can dang nhap. Can bat AHVclaw extension de su dung trinh duyet that.",
		}

	case ModeCDP:
		params, _ := json.Marshal(map[string]string{"selector": args.Selector})
		result, err := computeruse.Hub.SendCompanionCommand(e.UserID, "extract", params)
		if err != nil {
			// FAIL CLOSED
			return &ToolResult{Name: "browser_extract", Error: fmt.Sprintf("CDP extract failed: %s", err.Error())}
		}
		if result.Status == "blocked" {
			return &ToolResult{Name: "browser_extract", Error: fmt.Sprintf("CDP extract blocked: %s", result.Error)}
		}
		var data struct {
			URL     string `json:"url"`
			Title   string `json:"title"`
			Content string `json:"content"`
		}
		json.Unmarshal(result.Data, &data)
		content := data.Content
		if len(content) > 10000 {
			content = content[:10000] + "\n...(truncated)"
		}
		e.broadcastBrowserUpdate("cdp", "", data.URL, data.Title, "Page content extracted")
		return &ToolResult{
			Name:    "browser_extract",
			Content: fmt.Sprintf("Page: %s (%s)\n\n%s", data.URL, data.Title, content),
		}

	default: // ModePlaywright
		log.Printf("[browser_extract] using Playwright for user %s", e.UserID)
		result, err := browser.Execute(browser.BrowserRequest{
			Action: "extract",
			UserID: e.UserID,
		})
		if err != nil {
			log.Printf("[browser_extract] Playwright error: %v", err)
			return &ToolResult{Name: "browser_extract", Error: err.Error()}
		}
		log.Printf("[browser_extract] Playwright returned: url=%s title=%s content_len=%d", result.URL, result.Title, len(result.Content))
		screenshot := e.playwrightScreenshot()
		e.broadcastBrowserUpdate("playwright", screenshot, result.URL, result.Title, "Page content extracted")
		content := result.Content
		if len(content) > 10000 {
			content = content[:10000] + "\n...(truncated)"
		}
		return &ToolResult{
			Name:    "browser_extract",
			Content: fmt.Sprintf("Page: %s (%s)\n\n%s", result.URL, result.Title, content),
		}
	}
}

func (e *Executor) browserScreenshot(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		UseHelper bool `json:"use_helper"`
		NeedsAuth bool `json:"needs_auth"`
	}
	json.Unmarshal(argsJSON, &args)

	mode := e.resolveMode("", args.NeedsAuth, false, args.UseHelper)

	switch mode {
	case ModeNotifyUser:
		return &ToolResult{
			Name:    "browser_screenshot",
			Content: "Thao tac nay can dang nhap. Can bat AHVclaw extension de su dung trinh duyet that.",
		}

	case ModeCDP:
		result, err := computeruse.Hub.SendCompanionCommand(e.UserID, "screenshot", nil)
		if err != nil {
			return &ToolResult{Name: "browser_screenshot", Error: fmt.Sprintf("CDP screenshot failed: %s", err.Error())}
		}
		if result.Status == "blocked" {
			return &ToolResult{Name: "browser_screenshot", Error: fmt.Sprintf("CDP screenshot blocked: %s", result.Error)}
		}
		var data struct {
			Screenshot string `json:"screenshot"`
			URL        string `json:"url"`
			Title      string `json:"title"`
		}
		json.Unmarshal(result.Data, &data)
		e.broadcastBrowserUpdate("cdp", data.Screenshot, data.URL, data.Title, "Screenshot captured")
		return &ToolResult{
			Name:    "browser_screenshot",
			Content: fmt.Sprintf("Screenshot captured of: %s (%s)\n[Image data: %d bytes base64]", data.URL, data.Title, len(data.Screenshot)),
			Image:   data.Screenshot,
		}

	default: // ModePlaywright
		result, err := browser.Execute(browser.BrowserRequest{
			Action: "screenshot",
			UserID: e.UserID,
		})
		if err != nil {
			return &ToolResult{Name: "browser_screenshot", Error: err.Error()}
		}
		e.broadcastBrowserUpdate("playwright", result.Image, result.URL, result.Title, "Screenshot captured")
		return &ToolResult{
			Name:    "browser_screenshot",
			Content: fmt.Sprintf("Screenshot captured of: %s (%s)\n[Image data: %d bytes base64]", result.URL, result.Title, len(result.Image)),
		}
	}
}

func (e *Executor) browserClick(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		Selector  string `json:"selector"`
		Text      string `json:"text"`
		UseHelper bool   `json:"use_helper"`
		NeedsAuth bool   `json:"needs_auth"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "browser_click", Error: "invalid arguments"}
	}
	if args.Selector == "" && args.Text == "" {
		return &ToolResult{Name: "browser_click", Error: "selector or text is required"}
	}

	mode := e.resolveMode("", args.NeedsAuth, true, args.UseHelper)

	switch mode {
	case ModeNotifyUser:
		return &ToolResult{
			Name:    "browser_click",
			Content: "Thao tac nay can dang nhap. Can bat AHVclaw extension de su dung trinh duyet that.",
		}

	case ModeCDP:
		params, _ := json.Marshal(map[string]string{"selector": args.Selector, "text": args.Text})
		result, err := computeruse.Hub.SendCompanionCommand(e.UserID, "click", params)
		if err != nil {
			return &ToolResult{Name: "browser_click", Error: fmt.Sprintf("CDP click failed: %s", err.Error())}
		}
		if result.Status == "blocked" {
			return &ToolResult{Name: "browser_click", Error: fmt.Sprintf("CDP click blocked: %s", result.Error)}
		}
		var data struct {
			URL   string `json:"url"`
			Title string `json:"title"`
		}
		json.Unmarshal(result.Data, &data)
		target := args.Selector
		if target == "" {
			target = args.Text
		}
		e.broadcastBrowserUpdate("cdp", "", data.URL, data.Title, fmt.Sprintf("Clicked: %s", target))
		return &ToolResult{Name: "browser_click", Content: fmt.Sprintf("Clicked: %s\nCurrent URL: %s", target, data.URL)}

	default: // ModePlaywright
		selector := args.Selector
		if selector == "" {
			selector = fmt.Sprintf("text=%s", args.Text)
		}
		result, err := browser.Execute(browser.BrowserRequest{
			Action:   "click",
			UserID:   e.UserID,
			Selector: selector,
		})
		if err != nil {
			return &ToolResult{Name: "browser_click", Error: err.Error()}
		}
		screenshot := e.playwrightScreenshot()
		e.broadcastBrowserUpdate("playwright", screenshot, result.URL, result.Title, fmt.Sprintf("Clicked: %s", selector))
		return &ToolResult{
			Name:    "browser_click",
			Content: fmt.Sprintf("Clicked: %s\nCurrent URL: %s", result.Clicked, result.URL),
		}
	}
}

func (e *Executor) browserType(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		Selector  string `json:"selector"`
		Text      string `json:"text"`
		UseHelper bool   `json:"use_helper"`
		NeedsAuth bool   `json:"needs_auth"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "browser_type", Error: "invalid arguments"}
	}
	if args.Selector == "" || args.Text == "" {
		return &ToolResult{Name: "browser_type", Error: "selector and text are required"}
	}

	mode := e.resolveMode("", args.NeedsAuth, true, args.UseHelper)

	switch mode {
	case ModeNotifyUser:
		return &ToolResult{
			Name:    "browser_type",
			Content: "Thao tac nay can dang nhap. Can bat AHVclaw extension de su dung trinh duyet that.",
		}

	case ModeCDP:
		params, _ := json.Marshal(map[string]string{"selector": args.Selector, "text": args.Text})
		result, err := computeruse.Hub.SendCompanionCommand(e.UserID, "type", params)
		if err != nil {
			return &ToolResult{Name: "browser_type", Error: fmt.Sprintf("CDP type failed: %s", err.Error())}
		}
		if result.Status == "blocked" {
			return &ToolResult{Name: "browser_type", Error: fmt.Sprintf("CDP type blocked: %s", result.Error)}
		}
		var data struct {
			URL string `json:"url"`
		}
		json.Unmarshal(result.Data, &data)
		e.broadcastBrowserUpdate("cdp", "", data.URL, "", fmt.Sprintf("Typed into: %s", args.Selector))
		return &ToolResult{Name: "browser_type", Content: fmt.Sprintf("Typed '%s' into %s", args.Text, args.Selector)}

	default: // ModePlaywright
		result, err := browser.Execute(browser.BrowserRequest{
			Action:   "type",
			UserID:   e.UserID,
			Selector: args.Selector,
			Text:     args.Text,
		})
		if err != nil {
			return &ToolResult{Name: "browser_type", Error: err.Error()}
		}
		screenshot := e.playwrightScreenshot()
		e.broadcastBrowserUpdate("playwright", screenshot, result.URL, result.Title, fmt.Sprintf("Typed into: %s", args.Selector))
		return &ToolResult{
			Name:    "browser_type",
			Content: fmt.Sprintf("Typed '%s' into %s", result.Typed, args.Selector),
		}
	}
}

func (e *Executor) browserScroll(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		Direction string `json:"direction"`
		Amount    int    `json:"amount"`
		UseHelper bool   `json:"use_helper"`
		NeedsAuth bool   `json:"needs_auth"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "browser_scroll", Error: "invalid arguments"}
	}
	if args.Direction == "" {
		args.Direction = "down"
	}
	if args.Amount == 0 {
		args.Amount = 500
	}

	mode := e.resolveMode("", args.NeedsAuth, true, args.UseHelper)

	switch mode {
	case ModeNotifyUser:
		return &ToolResult{
			Name:    "browser_scroll",
			Content: "Thao tac nay can dang nhap. Can bat AHVclaw extension de su dung trinh duyet that.",
		}

	case ModeCDP:
		params, _ := json.Marshal(map[string]interface{}{"direction": args.Direction, "amount": args.Amount})
		result, err := computeruse.Hub.SendCompanionCommand(e.UserID, "scroll", params)
		if err != nil {
			return &ToolResult{Name: "browser_scroll", Error: fmt.Sprintf("CDP scroll failed: %s", err.Error())}
		}
		if result.Status == "blocked" {
			return &ToolResult{Name: "browser_scroll", Error: fmt.Sprintf("CDP scroll blocked: %s", result.Error)}
		}
		return &ToolResult{Name: "browser_scroll", Content: fmt.Sprintf("Scrolled %s by %dpx", args.Direction, args.Amount)}

	default: // ModePlaywright — try legacy extension command if online
		if computeruse.Hub.IsOnline(e.UserID) {
			params, _ := json.Marshal(map[string]interface{}{"direction": args.Direction, "amount": args.Amount})
			cmd := computeruse.CUCommand{ID: "scroll_cmd", Action: "scroll", Params: params}
			_, err := computeruse.Hub.SendCommand(e.UserID, cmd)
			if err == nil {
				return &ToolResult{Name: "browser_scroll", Content: fmt.Sprintf("Scrolled %s by %dpx", args.Direction, args.Amount)}
			}
		}
		return &ToolResult{Name: "browser_scroll", Error: "scroll requires the browser extension to be installed"}
	}
}

func (e *Executor) browserTabList(argsJSON json.RawMessage) *ToolResult {
	if !computeruse.Hub.IsOnline(e.UserID) {
		return &ToolResult{Name: "browser_tab_list", Error: "tab management requires the browser extension to be installed"}
	}
	result, err := computeruse.Hub.SendCompanionCommand(e.UserID, "tab_list", nil)
	if err != nil {
		return &ToolResult{Name: "browser_tab_list", Error: err.Error()}
	}
	var data struct {
		Tabs []struct {
			ID    int    `json:"id"`
			URL   string `json:"url"`
			Title string `json:"title"`
		} `json:"tabs"`
	}
	json.Unmarshal(result.Data, &data)
	var content string
	for i, tab := range data.Tabs {
		content += fmt.Sprintf("%d. [Tab %d] %s - %s\n", i+1, tab.ID, tab.Title, tab.URL)
	}
	if content == "" {
		content = "No tabs found"
	}
	return &ToolResult{Name: "browser_tab_list", Content: content}
}

func (e *Executor) browserTabSwitch(argsJSON json.RawMessage) *ToolResult {
	if !computeruse.Hub.IsOnline(e.UserID) {
		return &ToolResult{Name: "browser_tab_switch", Error: "tab management requires the browser extension to be installed"}
	}
	var args struct {
		TabID int `json:"tab_id"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "browser_tab_switch", Error: "invalid arguments"}
	}
	paramsJSON, _ := json.Marshal(args)
	result, err := computeruse.Hub.SendCompanionCommand(e.UserID, "tab_switch", paramsJSON)
	if err != nil {
		return &ToolResult{Name: "browser_tab_switch", Error: err.Error()}
	}
	var data struct {
		URL   string `json:"url"`
		Title string `json:"title"`
	}
	json.Unmarshal(result.Data, &data)
	return &ToolResult{Name: "browser_tab_switch", Content: fmt.Sprintf("Switched to tab %d: %s (%s)", args.TabID, data.Title, data.URL)}
}
