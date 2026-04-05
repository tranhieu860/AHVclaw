package tools

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/ahvholding/ahvclaw/security"
)

type ToolResult struct {
	Name    string `json:"name"`
	Content string `json:"content"`
	Error   string `json:"error,omitempty"`
	Image   string `json:"image,omitempty"`
}

type Executor struct {
	WorkspaceDir   string
	UserID         string
	SendFileFn     func(path, caption string) error
	BroadcastFn    func(userID string, eventType string, data interface{})
	IsAutonomous   bool
	TrustCheckFunc func(category, toolName string) (string, error)
	DeliverFunc    func(text string)
}

func NewExecutor(workspaceDir string, userID string) *Executor {
	return &Executor{WorkspaceDir: workspaceDir, UserID: userID}
}

func (e *Executor) executeInternal(name string, argsJSON json.RawMessage) *ToolResult {
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
	case "server_list":
		return e.serverList(argsJSON)
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
	case "knowledge_search":
		return e.knowledgeSearch(argsJSON)
	case "delegate_agent":
		return e.delegateAgent(argsJSON)
	case "manage_scheduled_task":
		return e.manageScheduledTask(argsJSON)
	case "send_file":
		return e.sendFile(argsJSON)
	case "skill_install":
		return e.skillInstall(argsJSON)
	case "cu_screenshot":
		return e.cuScreenshot(argsJSON)
	case "cu_click":
		return e.cuClick(argsJSON)
	case "cu_type":
		return e.cuType(argsJSON)
	case "cu_scroll":
		return e.cuScroll(argsJSON)
	case "cu_navigate":
		return e.cuNavigate(argsJSON)
	case "cu_read_page":
		return e.cuReadPage(argsJSON)
	case "cu_tab_list":
		return e.cuTabList(argsJSON)
	case "cu_tab_switch":
		return e.cuTabSwitch(argsJSON)
	case "browser_scroll":
		return e.browserScroll(argsJSON)
	case "browser_tab_list":
		return e.browserTabList(argsJSON)
	case "browser_tab_switch":
		return e.browserTabSwitch(argsJSON)
	default:
		return &ToolResult{Name: name, Error: fmt.Sprintf("unknown tool: %s", name)}
	}
}


func (e *Executor) checkTrust(toolName string) string {
	if !e.IsAutonomous || e.TrustCheckFunc == nil {
		return "execute"
	}
	category := toolCategory(toolName)
	decision, err := e.TrustCheckFunc(category, toolName)
	if err != nil {
		return "execute"
	}
	return decision
}

func toolCategory(name string) string {
	switch name {
	case "memory_search", "memory_list", "knowledge_search", "file_read", "file_list", "file_search":
		return "read"
	case "memory_save", "file_write", "send_file", "scheduled_task_create":
		return "write_low"
	case "terminal_exec", "http_request":
		return "write_high"
	case "server_exec", "delegate":
		return "critical"
	default:
		return "write_low"
	}
}

func (e *Executor) Execute(name string, argsJSON json.RawMessage) *ToolResult {
	// Security: check shell commands and file paths
	if name == "terminal_exec" {
		var args struct{ Command string `json:"command"` }
		if json.Unmarshal(argsJSON, &args) == nil {
			if blocked, reason := security.CheckShellCommand(args.Command); blocked {
				return &ToolResult{Name: name, Error: "Security: " + reason}
			}
		}
	}
	if name == "file_read" || name == "file_write" || name == "file_list" {
		var args struct{ Path string `json:"path"` }
		if json.Unmarshal(argsJSON, &args) == nil {
			if blocked, reason := security.CheckFilePath(args.Path); blocked {
				return &ToolResult{Name: name, Error: "Security: " + reason}
			}
		}
	}

	// Trust gate for autonomous mode
	decision := e.checkTrust(name)
	switch decision {
	case "block":
		return &ToolResult{Name: name, Error: fmt.Sprintf("Action '%s' blocked by trust system.", name)}
	case "ask":
		if e.DeliverFunc != nil {
			e.DeliverFunc(fmt.Sprintf("AGI requests permission: %s - Use /approve %s to allow.", name, name))
		}
		return &ToolResult{Name: name, Error: fmt.Sprintf("Awaiting approval for '%s'.", name)}
	case "notify":
		if e.DeliverFunc != nil {
			e.DeliverFunc(fmt.Sprintf("AGI auto-executing: %s", name))
		}
	}

	timeout := 30 * time.Second
	switch name {
	case "browser_navigate", "browser_extract", "browser_screenshot":
		timeout = 45 * time.Second
	case "browser_scroll", "browser_click", "browser_type", "browser_tab_list", "browser_tab_switch":
		timeout = 45 * time.Second
	case "terminal_exec":
		timeout = 120 * time.Second
	}

	resultCh := make(chan *ToolResult, 1)
	go func() {
		resultCh <- e.executeInternal(name, argsJSON)
	}()

	select {
	case result := <-resultCh:
		if len(result.Content) > 8000 {
			result.Content = result.Content[:8000] + "\n...(truncated)"
		}
		return result
	case <-time.After(timeout):
		return &ToolResult{Name: name, Error: fmt.Sprintf("tool %s timed out after %v", name, timeout)}
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
