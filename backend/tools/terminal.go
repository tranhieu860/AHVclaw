package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/ahvholding/ahvclaw/sandbox"
)

// blockedCommands that should never be run
var blockedCommands = []string{
	"rm -rf /", "rm -rf /*", "mkfs", "dd if=", "> /dev/sd",
	"chmod -R 777 /", "chown -R", "shutdown", "reboot", "halt",
	"init 0", "init 6", ":(){ :|:& };:",
}

// blockedPatterns in commands
var blockedPatterns = []string{
	"/etc/shadow", "/etc/passwd", "/etc/sudoers",
	"ssh-keygen", "authorized_keys",
	"crontab", "/etc/cron",
	"iptables", "firewall",
	"systemctl", "service ",
	"curl|bash", "wget|bash", "curl|sh", "wget|sh",
}

func (e *Executor) terminalExec(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		Command string `json:"command"`
		Timeout int    `json:"timeout"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "terminal_exec", Error: "invalid arguments"}
	}

	if args.Command == "" {
		return &ToolResult{Name: "terminal_exec", Error: "command is required"}
	}

	// Check blocked commands
	cmdLower := strings.ToLower(args.Command)
	for _, blocked := range blockedCommands {
		if strings.Contains(cmdLower, blocked) {
			return &ToolResult{Name: "terminal_exec", Error: fmt.Sprintf("command blocked for safety: contains '%s'", blocked)}
		}
	}
	for _, pattern := range blockedPatterns {
		if strings.Contains(cmdLower, pattern) {
			return &ToolResult{Name: "terminal_exec", Error: fmt.Sprintf("command blocked for safety: contains '%s'", pattern)}
		}
	}

	// ALL execution goes through bubblewrap sandbox
	wsDir := e.WorkspaceDir
	if wsDir == "" {
		wsDir = "/tmp"
	}

	// Validate workspace path for directory traversal and symlink attacks
	if wsDir != "/tmp" {
		absPath, err := filepath.Abs(wsDir)
		if err != nil || !strings.HasPrefix(absPath, "/data/ahvclaw/workspaces/") {
			return &ToolResult{Name: "terminal_exec", Error: fmt.Sprintf("invalid workspace path: %s", wsDir)}
		}
		resolved, err := filepath.EvalSymlinks(absPath)
		if err == nil && resolved != absPath {
			return &ToolResult{Name: "terminal_exec", Error: fmt.Sprintf("workspace path contains symlinks: %s -> %s", absPath, resolved)}
		}
	}

	output, err := sandbox.SandboxedExec(context.Background(), wsDir, args.Command, args.Timeout)
	if err != nil {
		if output != "" {
			return &ToolResult{Name: "terminal_exec", Content: output + "\nError: " + err.Error()}
		}
		return &ToolResult{Name: "terminal_exec", Error: err.Error()}
	}
	if len(output) > 100*1024 {
		output = output[:100*1024] + "\n... (truncated)"
	}
	return &ToolResult{Name: "terminal_exec", Content: output}
}
