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
	"server_list":      true,
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
