package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"

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

	// If autonomous mode, use sandboxed execution
	if e.IsAutonomous && e.WorkspaceDir != "" {
		output, err := sandbox.SandboxedExec(context.Background(), e.WorkspaceDir, args.Command, args.Timeout)
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

	timeout := args.Timeout
	if timeout <= 0 {
		timeout = 30
	}
	if timeout > 120 {
		timeout = 120
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "bash", "-c", args.Command)
	cmd.Dir = e.WorkspaceDir
	// Restrict environment
	cmd.Env = []string{
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"HOME=" + e.WorkspaceDir,
		"TERM=xterm",
		"LANG=en_US.UTF-8",
	}

	output, err := cmd.CombinedOutput()
	result := string(output)
	if len(result) > 100000 {
		result = result[:100000] + "\n...(truncated)"
	}

	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return &ToolResult{Name: "terminal_exec", Content: result + "\n(command timed out)"}
		}
		return &ToolResult{Name: "terminal_exec", Content: result + "\nExit error: " + err.Error()}
	}

	return &ToolResult{Name: "terminal_exec", Content: result}
}
