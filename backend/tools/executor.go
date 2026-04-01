package tools

import (
	"encoding/json"
	"fmt"
)

type ToolResult struct {
	Name    string `json:"name"`
	Content string `json:"content"`
	Error   string `json:"error,omitempty"`
}

type Executor struct {
	WorkspaceDir string
	UserID       string
}

func NewExecutor(workspaceDir string, userID string) *Executor {
	return &Executor{WorkspaceDir: workspaceDir, UserID: userID}
}

func (e *Executor) Execute(name string, argsJSON json.RawMessage) *ToolResult {
	switch name {
	case "file_read":
		return e.fileRead(argsJSON)
	case "file_write":
		return e.fileWrite(argsJSON)
	case "file_list":
		return e.fileList(argsJSON)
	case "file_delete":
		return e.fileDelete(argsJSON)
	case "file_search":
		return e.fileSearch(argsJSON)
	case "terminal_exec":
		return e.terminalExec(argsJSON)
	case "http_request":
		return e.httpRequest(argsJSON)
	case "memory_save":
		return e.memorySave(argsJSON)
	case "memory_search":
		return e.memorySearch(argsJSON)
	case "server_ssh_exec":
		return e.serverSSHExec(argsJSON)
	case "server_status":
		return e.serverStatus(argsJSON)
	case "browser_navigate":
		return e.browserNavigate(argsJSON)
	case "browser_screenshot":
		return e.browserScreenshot(argsJSON)
	case "browser_click":
		return e.browserClick(argsJSON)
	case "browser_type":
		return e.browserType(argsJSON)
	case "browser_extract":
		return e.browserExtract(argsJSON)
	default:
		return &ToolResult{Name: name, Error: fmt.Sprintf("unknown tool: %s", name)}
	}
}

func getString(args map[string]interface{}, key, fallback string) string {
	if v, ok := args[key].(string); ok {
		return v
	}
	return fallback
}

func getInt(args map[string]interface{}, key string, fallback int) int {
	if v, ok := args[key].(float64); ok {
		return int(v)
	}
	return fallback
}
