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
	AuditFunc      func(toolName, actionType, status string, trustScore, latencyMs, exitStatus int, result, errMsg string)
}

func NewExecutor(workspaceDir string, userID string) *Executor {
	return &Executor{WorkspaceDir: workspaceDir, UserID: userID}
}

func (e *Executor) executeInternal(name string, argsJSON json.RawMessage) *ToolResult {
	// Fix: 9Router sometimes double-encodes tool arguments as a JSON string.
	// e.g. "\"{\\"content\\":\\"...\\"}\"" instead of {"content":"..."}
	// If argsJSON is a JSON string, unwrap it to get the actual object.
	if len(argsJSON) > 1 && argsJSON[0] == '"' {
		var unwrapped string
		if json.Unmarshal(argsJSON, &unwrapped) == nil && len(unwrapped) > 0 && unwrapped[0] == '{' {
			argsJSON = json.RawMessage(unwrapped)
		}
	}
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
	capability := CapabilityFor(toolName)

	// Read tools always allowed regardless of mode
	if capability == "read" {
		return "execute"
	}

	// In human-initiated mode, allow up to write_high
	// (role-gated tools already filtered by ToolsForRole)
	if !e.IsAutonomous {
		return "execute"
	}

	// In autonomous mode, check trust for everything with side effects
	if e.TrustCheckFunc == nil {
		return "block" // fail-secure: no trust function = block
	}
	decision, err := e.TrustCheckFunc(capability, toolName)
	if err != nil {
		return "block" // fail-secure on error
	}
	return decision
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
		if e.IsAutonomous && e.AuditFunc != nil {
			capability := CapabilityFor(name)
			e.AuditFunc(name, capability, "blocked", 0, 0, -1, "", fmt.Sprintf("Action %s blocked by trust system.", name))
		}
		return &ToolResult{Name: name, Error: fmt.Sprintf("Action %s blocked by trust system.", name)}
	case "ask":
		if e.DeliverFunc != nil {
			e.DeliverFunc(fmt.Sprintf("AGI requests permission: %s - Use /approve %s to allow.", name, name))
		}
		if e.IsAutonomous && e.AuditFunc != nil {
			capability := CapabilityFor(name)
			e.AuditFunc(name, capability, "pending_approval", 0, 0, -1, "", "")
		}
		return &ToolResult{Name: name, Error: fmt.Sprintf("Awaiting approval for %s.", name)}
	case "notify":
		if e.DeliverFunc != nil {
			e.DeliverFunc(fmt.Sprintf("AGI auto-executing: %s", name))
		}
	}

	// Record start time for latency tracking
	execStart := time.Now()

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
		// Audit log for autonomous actions
		if e.IsAutonomous && e.AuditFunc != nil {
			latency := int(time.Since(execStart).Milliseconds())
			exitCode := 0
			auditStatus := "executed"
			errStr := ""
			if result.Error != "" {
				exitCode = 1
				auditStatus = "error"
				errStr = result.Error
			}
			capability := CapabilityFor(name)
			e.AuditFunc(name, capability, auditStatus, 0, latency, exitCode, result.Content, errStr)
		}
		return result
	case <-time.After(timeout):
		// Audit log timeout
		if e.IsAutonomous && e.AuditFunc != nil {
			latency := int(time.Since(execStart).Milliseconds())
			capability := CapabilityFor(name)
			e.AuditFunc(name, capability, "timeout", 0, latency, -1, "", fmt.Sprintf("tool %s timed out after %v", name, timeout))
		}
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
