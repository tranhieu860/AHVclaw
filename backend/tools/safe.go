package tools

// safeToolNames are tools safe for autonomous heartbeat use (read-only + low-risk)
var safeToolNames = map[string]bool{
	"http_request":     true,
	"file_read":        true,
	"file_list":        true,
	"file_search":      true,
	"memory_save":      true,
	"memory_search":    true,
	"server_status":    true,
	"knowledge_search": true,
}

// SafeToolsOnly returns only read/low-risk tools for autonomous use
func SafeToolsOnly() []ToolDef {
	var safe []ToolDef
	for _, t := range AllTools {
		if safeToolNames[t.Function.Name] {
			safe = append(safe, t)
		}
	}
	return safe
}

// SafeToolNames returns just the names of safe tools.
func SafeToolNames() []string {
	var names []string
	for name := range safeToolNames {
		names = append(names, name)
	}
	return names
}

// AutonomousToolNames returns tool names available in autonomous mode.
// Write tools are gated by the trust system at execution time.
func AutonomousToolNames() []string {
	names := SafeToolNames()
	names = append(names, "file_write", "terminal_exec", "send_file", "manage_scheduled_task")
	return names
}

// AutonomousToolsOnly returns tool definitions for autonomous mode (safe + trust-gated write tools).
func AutonomousToolsOnly() []ToolDef {
	autoNames := map[string]bool{}
	for _, n := range AutonomousToolNames() {
		autoNames[n] = true
	}
	var result []ToolDef
	for _, t := range AllTools {
		if autoNames[t.Function.Name] {
			result = append(result, t)
		}
	}
	return result
}
