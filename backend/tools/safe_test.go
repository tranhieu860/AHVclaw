package tools

import (
	"testing"
)

func TestToolsForRole_UserNoPrivileged(t *testing.T) {
	userTools := ToolsForRole("user")
	for _, tool := range userTools {
		if tool.Function.Name == "terminal_exec" {
			t.Error("user role should NOT have terminal_exec")
		}
		if tool.Function.Name == "server_ssh_exec" {
			t.Error("user role should NOT have server_ssh_exec")
		}
		if tool.Function.Name == "delegate_agent" {
			t.Error("user role should NOT have delegate_agent")
		}
	}
}

func TestToolsForRole_DevHasTerminal(t *testing.T) {
	devTools := ToolsForRole("dev")
	hasTerminal := false
	for _, tool := range devTools {
		if tool.Function.Name == "terminal_exec" {
			hasTerminal = true
		}
		if tool.Function.Name == "server_ssh_exec" {
			t.Error("dev role should NOT have server_ssh_exec")
		}
	}
	if !hasTerminal {
		t.Error("dev role should have terminal_exec")
	}
}

func TestToolsForRole_AdminHasAll(t *testing.T) {
	adminTools := ToolsForRole("admin")
	if len(adminTools) != len(AllTools) {
		t.Errorf("admin should have all tools: got %d, want %d", len(adminTools), len(AllTools))
	}
}

func TestCapabilityManifest_AllToolsHaveCapability(t *testing.T) {
	for _, tool := range AllTools {
		cap := CapabilityFor(tool.Function.Name)
		if cap == "" {
			t.Errorf("tool %s has no capability assigned", tool.Function.Name)
		}
		valid := map[string]bool{"read": true, "write_low": true, "write_high": true, "critical": true}
		if !valid[cap] {
			t.Errorf("tool %s has invalid capability: %s", tool.Function.Name, cap)
		}
	}
}

func TestCapabilityManifest_UnknownToolIsCritical(t *testing.T) {
	cap := CapabilityFor("nonexistent_tool")
	if cap != "critical" {
		t.Errorf("unknown tool should be critical, got %s", cap)
	}
}
