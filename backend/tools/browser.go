package tools

import (
	"encoding/json"
	"fmt"

	"github.com/ahvholding/ahvclaw/browser"
)

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

	result, err := browser.Execute(browser.BrowserRequest{
		Action: "navigate",
		UserID: e.UserID,
		URL:    args.URL,
	})
	if err != nil {
		return &ToolResult{Name: "browser_navigate", Error: err.Error()}
	}

	return &ToolResult{
		Name:    "browser_navigate",
		Content: fmt.Sprintf("Navigated to: %s\nTitle: %s", result.URL, result.Title),
	}
}

func (e *Executor) browserScreenshot(argsJSON json.RawMessage) *ToolResult {
	result, err := browser.Execute(browser.BrowserRequest{
		Action: "screenshot",
		UserID: e.UserID,
	})
	if err != nil {
		return &ToolResult{Name: "browser_screenshot", Error: err.Error()}
	}

	content := fmt.Sprintf("Screenshot captured of: %s (%s)\n[Image data: %d bytes base64]", result.URL, result.Title, len(result.Image))
	return &ToolResult{
		Name:    "browser_screenshot",
		Content: content,
	}
}

func (e *Executor) browserClick(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		Selector string `json:"selector"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "browser_click", Error: "invalid arguments"}
	}
	if args.Selector == "" {
		return &ToolResult{Name: "browser_click", Error: "selector is required"}
	}

	result, err := browser.Execute(browser.BrowserRequest{
		Action:   "click",
		UserID:   e.UserID,
		Selector: args.Selector,
	})
	if err != nil {
		return &ToolResult{Name: "browser_click", Error: err.Error()}
	}

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

	result, err := browser.Execute(browser.BrowserRequest{
		Action:   "type",
		UserID:   e.UserID,
		Selector: args.Selector,
		Text:     args.Text,
	})
	if err != nil {
		return &ToolResult{Name: "browser_type", Error: err.Error()}
	}

	return &ToolResult{
		Name:    "browser_type",
		Content: fmt.Sprintf("Typed '%s' into %s", result.Typed, args.Selector),
	}
}

func (e *Executor) browserExtract(argsJSON json.RawMessage) *ToolResult {
	result, err := browser.Execute(browser.BrowserRequest{
		Action: "extract",
		UserID: e.UserID,
	})
	if err != nil {
		return &ToolResult{Name: "browser_extract", Error: err.Error()}
	}

	content := result.Content
	if len(content) > 10000 {
		content = content[:10000] + "\n...(truncated)"
	}

	return &ToolResult{
		Name:    "browser_extract",
		Content: fmt.Sprintf("Page: %s (%s)\n\n%s", result.URL, result.Title, content),
	}
}
