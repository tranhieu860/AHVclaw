package tools

import (
	"encoding/json"
	"fmt"

	"github.com/ahvholding/ahvclaw/computeruse"
	"github.com/google/uuid"
)

func (e *Executor) cuSendCommand(action string, params interface{}) (*computeruse.CUResult, error) {
	if !computeruse.Hub.IsOnline(e.UserID) {
		return nil, fmt.Errorf("extension_offline")
	}
	paramsJSON, _ := json.Marshal(params)
	cmd := computeruse.CUCommand{
		ID:     uuid.New().String(),
		Action: action,
		Params: paramsJSON,
	}
	return computeruse.Hub.SendCommand(e.UserID, cmd)
}

func (e *Executor) cuBroadcastScreenshot(source, screenshot, url, title, action string) {
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

func (e *Executor) cuScreenshot(argsJSON json.RawMessage) *ToolResult {
	result, err := e.cuSendCommand("screenshot", nil)
	if err != nil {
		if err.Error() == "extension_offline" {
			return e.browserScreenshot(argsJSON)
		}
		return &ToolResult{Name: "cu_screenshot", Error: err.Error()}
	}
	var data struct {
		Screenshot string `json:"screenshot"`
		URL        string `json:"url"`
		Title      string `json:"title"`
	}
	json.Unmarshal(result.Data, &data)
	e.cuBroadcastScreenshot("extension", data.Screenshot, data.URL, data.Title, "Screenshot captured")
	return &ToolResult{
		Name:    "cu_screenshot",
		Content: fmt.Sprintf("Screenshot captured of: %s (%s)\n[Image data: %d bytes base64]", data.URL, data.Title, len(data.Screenshot)),
		Image:   data.Screenshot,
	}
}

func (e *Executor) cuClick(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		Selector string `json:"selector"`
		Text     string `json:"text"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "cu_click", Error: "invalid arguments"}
	}
	if args.Selector == "" && args.Text == "" {
		return &ToolResult{Name: "cu_click", Error: "selector or text is required"}
	}
	result, err := e.cuSendCommand("click", args)
	if err != nil {
		if err.Error() == "extension_offline" {
			return e.browserClick(argsJSON)
		}
		return &ToolResult{Name: "cu_click", Error: err.Error()}
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
	return &ToolResult{Name: "cu_click", Content: fmt.Sprintf("Clicked: %s\nCurrent URL: %s", target, data.URL)}
}

func (e *Executor) cuType(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		Selector string `json:"selector"`
		Text     string `json:"text"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "cu_type", Error: "invalid arguments"}
	}
	if args.Selector == "" || args.Text == "" {
		return &ToolResult{Name: "cu_type", Error: "selector and text are required"}
	}
	result, err := e.cuSendCommand("type", args)
	if err != nil {
		if err.Error() == "extension_offline" {
			return e.browserType(argsJSON)
		}
		return &ToolResult{Name: "cu_type", Error: err.Error()}
	}
	var data struct {
		URL string `json:"url"`
	}
	json.Unmarshal(result.Data, &data)
	return &ToolResult{Name: "cu_type", Content: fmt.Sprintf("Typed '%s' into %s", args.Text, args.Selector)}
}

func (e *Executor) cuScroll(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		Direction string `json:"direction"`
		Amount    int    `json:"amount"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "cu_scroll", Error: "invalid arguments"}
	}
	if args.Direction == "" {
		args.Direction = "down"
	}
	if args.Amount == 0 {
		args.Amount = 500
	}
	result, err := e.cuSendCommand("scroll", args)
	if err != nil {
		if err.Error() == "extension_offline" {
			return &ToolResult{Name: "cu_scroll", Error: "extension offline, scroll not available via Playwright"}
		}
		return &ToolResult{Name: "cu_scroll", Error: err.Error()}
	}
	_ = result
	return &ToolResult{Name: "cu_scroll", Content: fmt.Sprintf("Scrolled %s by %dpx", args.Direction, args.Amount)}
}

func (e *Executor) cuNavigate(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "cu_navigate", Error: "invalid arguments"}
	}
	if args.URL == "" {
		return &ToolResult{Name: "cu_navigate", Error: "url is required"}
	}
	result, err := e.cuSendCommand("navigate", args)
	if err != nil {
		if err.Error() == "extension_offline" {
			return e.browserNavigate(argsJSON)
		}
		return &ToolResult{Name: "cu_navigate", Error: err.Error()}
	}
	var data struct {
		URL   string `json:"url"`
		Title string `json:"title"`
	}
	json.Unmarshal(result.Data, &data)
	return &ToolResult{Name: "cu_navigate", Content: fmt.Sprintf("Navigated to: %s\nTitle: %s", data.URL, data.Title)}
}

func (e *Executor) cuReadPage(argsJSON json.RawMessage) *ToolResult {
	result, err := e.cuSendCommand("read_page", nil)
	if err != nil {
		if err.Error() == "extension_offline" {
			return e.browserExtract(argsJSON)
		}
		return &ToolResult{Name: "cu_read_page", Error: err.Error()}
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
	return &ToolResult{Name: "cu_read_page", Content: fmt.Sprintf("Page: %s (%s)\n\n%s", data.URL, data.Title, content)}
}

func (e *Executor) cuTabList(argsJSON json.RawMessage) *ToolResult {
	result, err := e.cuSendCommand("tab_list", nil)
	if err != nil {
		return &ToolResult{Name: "cu_tab_list", Error: err.Error()}
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
	return &ToolResult{Name: "cu_tab_list", Content: content}
}

func (e *Executor) cuTabSwitch(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		TabID int `json:"tab_id"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "cu_tab_switch", Error: "invalid arguments"}
	}
	result, err := e.cuSendCommand("tab_switch", args)
	if err != nil {
		return &ToolResult{Name: "cu_tab_switch", Error: err.Error()}
	}
	var data struct {
		URL   string `json:"url"`
		Title string `json:"title"`
	}
	json.Unmarshal(result.Data, &data)
	return &ToolResult{Name: "cu_tab_switch", Content: fmt.Sprintf("Switched to tab %d: %s (%s)", args.TabID, data.Title, data.URL)}
}
