package tools

import (
	"encoding/json"
	"fmt"
	"log"

	"github.com/ahvholding/ahvclaw/browser"
	"github.com/ahvholding/ahvclaw/computeruse"
	"github.com/google/uuid"
)

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
		URL string `json:"url"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "browser_navigate", Error: "invalid arguments"}
	}
	if args.URL == "" {
		return &ToolResult{Name: "browser_navigate", Error: "url is required"}
	}

	// Always use Playwright for navigate+extract workflows (more reliable for scraping)
	// Extension navigate opens in user's real browser which disrupts their session

	// Playwright fallback
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

func (e *Executor) browserScreenshot(argsJSON json.RawMessage) *ToolResult {
	// Try extension first
	if computeruse.Hub.IsOnline(e.UserID) {
		cmd := computeruse.CUCommand{ID: uuid.New().String(), Action: "screenshot"}
		result, err := computeruse.Hub.SendCommand(e.UserID, cmd)
		if err == nil {
			var data struct {
				Screenshot string `json:"screenshot"`
				URL        string `json:"url"`
				Title      string `json:"title"`
			}
			json.Unmarshal(result.Data, &data)
			e.broadcastBrowserUpdate("extension", data.Screenshot, data.URL, data.Title, "Screenshot captured")
			return &ToolResult{
				Name:    "browser_screenshot",
				Content: fmt.Sprintf("Screenshot captured of: %s (%s)\n[Image data: %d bytes base64]", data.URL, data.Title, len(data.Screenshot)),
				Image:   data.Screenshot,
			}
		}
	}

	// Playwright fallback
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

func (e *Executor) browserClick(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		Selector string `json:"selector"`
		Text     string `json:"text"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "browser_click", Error: "invalid arguments"}
	}
	if args.Selector == "" && args.Text == "" {
		return &ToolResult{Name: "browser_click", Error: "selector or text is required"}
	}

	// Try extension first
	if computeruse.Hub.IsOnline(e.UserID) {
		paramsJSON, _ := json.Marshal(args)
		cmd := computeruse.CUCommand{ID: uuid.New().String(), Action: "click", Params: paramsJSON}
		result, err := computeruse.Hub.SendCommand(e.UserID, cmd)
		if err == nil {
			var data struct {
				URL   string `json:"url"`
				Title string `json:"title"`
			}
			json.Unmarshal(result.Data, &data)
			target := args.Selector
			if target == "" {
				target = args.Text
			}
			e.broadcastBrowserUpdate("extension", "", data.URL, data.Title, fmt.Sprintf("Clicked: %s", target))
			return &ToolResult{Name: "browser_click", Content: fmt.Sprintf("Clicked: %s\nCurrent URL: %s", target, data.URL)}
		}
	}

	// Playwright fallback (only supports selector)
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

func (e *Executor) browserType(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		Selector string `json:"selector"`
		Text     string `json:"text"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "browser_type", Error: "invalid arguments"}
	}
	if args.Selector == "" || args.Text == "" {
		return &ToolResult{Name: "browser_type", Error: "selector and text are required"}
	}

	// Try extension first
	if computeruse.Hub.IsOnline(e.UserID) {
		paramsJSON, _ := json.Marshal(args)
		cmd := computeruse.CUCommand{ID: uuid.New().String(), Action: "type", Params: paramsJSON}
		result, err := computeruse.Hub.SendCommand(e.UserID, cmd)
		if err == nil {
			var data struct {
				URL string `json:"url"`
			}
			json.Unmarshal(result.Data, &data)
			e.broadcastBrowserUpdate("extension", "", data.URL, "", fmt.Sprintf("Typed into: %s", args.Selector))
			return &ToolResult{Name: "browser_type", Content: fmt.Sprintf("Typed '%s' into %s", args.Text, args.Selector)}
		}
	}

	// Playwright fallback
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

func (e *Executor) browserExtract(argsJSON json.RawMessage) *ToolResult {
	// Skip extension for extract — always use Playwright which has the navigated page
	// Extension reads the user's REAL browser which may be on a different tab
	if false && computeruse.Hub.IsOnline(e.UserID) {
		cmd := computeruse.CUCommand{ID: uuid.New().String(), Action: "read_page"}
		result, err := computeruse.Hub.SendCommand(e.UserID, cmd)
		if err == nil {
			var data struct {
				URL     string `json:"url"`
				Title   string `json:"title"`
				Content string `json:"content"`
			}
			json.Unmarshal(result.Data, &data)
			content := data.Content
			// If extension returned meaningful content (>200 chars), use it
			if len(content) > 200 {
				if len(content) > 10000 {
					content = content[:10000] + "\n...(truncated)"
				}
				e.broadcastBrowserUpdate("extension", "", data.URL, data.Title, "Page content extracted")
				return &ToolResult{Name: "browser_extract", Content: fmt.Sprintf("Page: %s (%s)\n\n%s", data.URL, data.Title, content)}
			}
			// Extension returned too little content, fall through to Playwright
		}
	}

	// Playwright fallback
	log.Printf("[browser_extract] using Playwright fallback for user %s", e.UserID)
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

func (e *Executor) browserScroll(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		Direction string `json:"direction"`
		Amount    int    `json:"amount"`
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

	// Extension only — Playwright doesn't have native scroll
	if computeruse.Hub.IsOnline(e.UserID) {
		paramsJSON, _ := json.Marshal(args)
		cmd := computeruse.CUCommand{ID: uuid.New().String(), Action: "scroll", Params: paramsJSON}
		_, err := computeruse.Hub.SendCommand(e.UserID, cmd)
		if err == nil {
			return &ToolResult{Name: "browser_scroll", Content: fmt.Sprintf("Scrolled %s by %dpx", args.Direction, args.Amount)}
		}
	}

	// Playwright fallback: use JavaScript scroll via extract-like mechanism
	return &ToolResult{Name: "browser_scroll", Error: "scroll requires the browser extension to be installed"}
}

func (e *Executor) browserTabList(argsJSON json.RawMessage) *ToolResult {
	if !computeruse.Hub.IsOnline(e.UserID) {
		return &ToolResult{Name: "browser_tab_list", Error: "tab management requires the browser extension to be installed"}
	}
	cmd := computeruse.CUCommand{ID: uuid.New().String(), Action: "tab_list"}
	result, err := computeruse.Hub.SendCommand(e.UserID, cmd)
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
	cmd := computeruse.CUCommand{ID: uuid.New().String(), Action: "tab_switch", Params: paramsJSON}
	result, err := computeruse.Hub.SendCommand(e.UserID, cmd)
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
