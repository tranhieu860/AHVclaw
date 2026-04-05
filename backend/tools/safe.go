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

// ToolTier classifies tools by privilege level.
type ToolTier int

const (
	TierSafe       ToolTier = iota // read-only, no side effects
	TierStandard                   // normal user tools with write capability
	TierPrivileged                 // admin/dev only (shell, SSH, delegation)
)

// toolTierMap classifies every tool. Unlisted tools default to TierPrivileged
// so new tools are restricted until explicitly classified.
var toolTierMap = map[string]ToolTier{
	// Safe: read-only / no side effects
	"file_read":           TierSafe,
	"file_list":           TierSafe,
	"file_search":         TierSafe,
	"memory_search":       TierSafe,
	"knowledge_search":    TierSafe,
	"server_list":         TierSafe,
	"server_status":       TierSafe,
	"browser_screenshot":  TierSafe,
	"browser_extract":     TierSafe,
	"browser_tab_list":    TierSafe,
	"cu_screenshot":       TierSafe,
	"cu_read_page":        TierSafe,
	"cu_tab_list":         TierSafe,

	// Standard: write/mutate but normal user operations
	"file_write":             TierStandard,
	"file_delete":            TierStandard,
	"memory_save":            TierStandard,
	"http_request":           TierStandard,
	"browser_navigate":       TierStandard,
	"browser_click":          TierStandard,
	"browser_type":           TierStandard,
	"browser_scroll":         TierStandard,
	"browser_tab_switch":     TierStandard,
	"cu_click":               TierStandard,
	"cu_type":                TierStandard,
	"cu_scroll":              TierStandard,
	"cu_navigate":            TierStandard,
	"cu_tab_switch":          TierStandard,
	"manage_scheduled_task":  TierStandard,
	"skill_install":          TierStandard,

	// Privileged: shell access, SSH, agent delegation
	"terminal_exec":    TierPrivileged,
	"server_ssh_exec":  TierPrivileged,
	"delegate_agent":   TierPrivileged,
}

// ToolTierFor returns the tier for a tool name. Unknown tools are TierPrivileged.
func ToolTierFor(name string) ToolTier {
	if tier, ok := toolTierMap[name]; ok {
		return tier
	}
	return TierPrivileged
}

// ToolsForRole returns only the tools accessible to the given role.
//   - "user"  → safe + standard
//   - "dev"   → safe + standard + terminal_exec
//   - "admin" → all tools
func ToolsForRole(role string) []ToolDef {
	var result []ToolDef
	for _, t := range AllTools {
		tier := ToolTierFor(t.Function.Name)
		switch role {
		case "admin":
			result = append(result, t)
		case "dev":
			if tier <= TierStandard {
				result = append(result, t)
			} else if t.Function.Name == "terminal_exec" {
				result = append(result, t)
			}
		default: // "user" and anything else
			if tier <= TierStandard {
				result = append(result, t)
			}
		}
	}
	return result
}
