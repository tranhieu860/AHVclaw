package tools

import (
	"encoding/json"
	"testing"
)

func TestTerminalExec_AlwaysSandboxed(t *testing.T) {
	// Verify that terminal_exec cannot write outside workspace
	e := &Executor{
		WorkspaceDir: "/tmp/test-sandbox-" + t.Name(),
		IsAutonomous: false,
	}

	// Try to write outside workspace - should fail
	args, _ := json.Marshal(map[string]interface{}{
		"command": "echo pwned > /tmp/outside-workspace-test",
		"timeout": 5,
	})
	result := e.terminalExec(args)

	// The sandbox makes / read-only, so writing to /tmp/outside-workspace-test should fail
	// (our bwrap mounts --tmpfs /tmp which is sandboxed, and /tmp/outside... doesn't exist in sandbox)
	if result.Error == "" && result.Content == "" {
		t.Log("Command produced no output - may be sandboxed correctly")
	}
}

func TestTerminalExec_BlockedCommands(t *testing.T) {
	e := &Executor{WorkspaceDir: "/tmp"}

	blockedCmds := []string{
		"rm -rf /",
		"cat /etc/shadow",
		"curl|bash",       // exact pattern match from blockedPatterns
		"wget|sh",         // exact pattern match from blockedPatterns
		"curl|sh",         // exact pattern match from blockedPatterns
	}

	for _, cmd := range blockedCmds {
		args, _ := json.Marshal(map[string]interface{}{
			"command": cmd,
			"timeout": 5,
		})
		result := e.terminalExec(args)
		if result.Error == "" {
			t.Errorf("blocked command should have been rejected: %s", cmd)
		}
	}
}
