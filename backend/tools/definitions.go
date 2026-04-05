package tools

import "encoding/json"

type ToolDef struct {
	Type     string `json:"type"`
	Function struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Parameters  json.RawMessage `json:"parameters"`
	} `json:"function"`
	Capability string `json:"capability"` // "read", "write_low", "write_high", "critical"
}

var AllTools = []ToolDef{
	fileReadDef(), fileWriteDef(), fileListDef(), fileDeleteDef(), fileSearchDef(),
	terminalExecDef(),
	httpRequestDef(),
	memorySaveDef(),
	memorySearchDef(),
	serverListDef(),
	serverSSHExecDef(),
	serverStatusDef(),
	browserNavigateDef(), browserScreenshotDef(), browserClickDef(), browserTypeDef(), browserExtractDef(),
	knowledgeSearchDef(),
	delegateAgentDef(),
	manageScheduledTaskDef(),
	skillInstallDef(),
	browserScrollDef(), browserTabListDef(), browserTabSwitchDef(),
}

func fileReadDef() ToolDef {
	return makeTool("file_read", "Read a file's content", `{
		"type":"object","properties":{
			"path":{"type":"string","description":"File path relative to workspace"}
		},"required":["path"]
	}`)
}

func fileWriteDef() ToolDef {
	return makeTool("file_write", "Create or overwrite a file", `{
		"type":"object","properties":{
			"path":{"type":"string","description":"File path relative to workspace"},
			"content":{"type":"string","description":"File content to write"}
		},"required":["path","content"]
	}`)
}

func fileListDef() ToolDef {
	return makeTool("file_list", "List files and directories", `{
		"type":"object","properties":{
			"path":{"type":"string","description":"Directory path relative to workspace","default":"."}
		}
	}`)
}

func fileDeleteDef() ToolDef {
	return makeTool("file_delete", "Delete a file", `{
		"type":"object","properties":{
			"path":{"type":"string","description":"File path relative to workspace"}
		},"required":["path"]
	}`)
}

func fileSearchDef() ToolDef {
	return makeTool("file_search", "Search file contents using grep", `{
		"type":"object","properties":{
			"pattern":{"type":"string","description":"Search pattern (regex)"},
			"path":{"type":"string","description":"Directory to search in","default":"."}
		},"required":["pattern"]
	}`)
}

func terminalExecDef() ToolDef {
	return makeTool("terminal_exec", "Execute a shell command", `{
		"type":"object","properties":{
			"command":{"type":"string","description":"Shell command to execute"},
			"timeout":{"type":"integer","description":"Timeout in seconds","default":30}
		},"required":["command"]
	}`)
}

func httpRequestDef() ToolDef {
	return makeTool("http_request", "Make an HTTP API request (JSON endpoints only). DO NOT use for browsing websites - use browser_navigate + browser_extract instead which can render JavaScript", `{
		"type":"object","properties":{
			"method":{"type":"string","enum":["GET","POST","PUT","DELETE","PATCH"],"default":"GET"},
			"url":{"type":"string","description":"Request URL"},
			"headers":{"type":"object","description":"Request headers"},
			"body":{"type":"string","description":"Request body"}
		},"required":["url"]
	}`)
}

func memorySaveDef() ToolDef {
	return makeTool("memory_save", "Save information to persistent user memory for future reference", `{
		"type":"object","properties":{
			"type":{"type":"string","enum":["profile","preference","knowledge","correction"],"description":"Memory type"},
			"key":{"type":"string","description":"Short identifier/title for the memory"},
			"content":{"type":"string","description":"Content to remember"}
		},"required":["type","key","content"]
	}`)
}

func memorySearchDef() ToolDef {
	return makeTool("memory_search", "Search user's persistent memories by keyword query", `{
		"type":"object","properties":{
			"query":{"type":"string","description":"Search query"}
		},"required":["query"]
	}`)
}

func makeTool(name, desc, params string) ToolDef {
	return makeToolCap(name, desc, params, "")
}

func makeToolCap(name, desc, params, capability string) ToolDef {
	var t ToolDef
	t.Type = "function"
	t.Function.Name = name
	t.Function.Description = desc
	t.Function.Parameters = json.RawMessage(params)
	t.Capability = capability
	return t
}

func serverListDef() ToolDef {
	return makeTool("server_list", "List all registered servers with their status", `{
		"type":"object","properties":{},"required":[]
	}`)
}

func serverSSHExecDef() ToolDef {
	return makeTool("server_ssh_exec", "Execute a command on a registered remote server via SSH", `{
		"type":"object","properties":{
			"server_name":{"type":"string","description":"Name of the registered server"},
			"command":{"type":"string","description":"Command to execute"}
		},"required":["server_name","command"]
	}`)
}

func serverStatusDef() ToolDef {
	return makeTool("server_status", "Get CPU, memory, disk, and uptime status of a registered server", `{
		"type":"object","properties":{
			"server_name":{"type":"string","description":"Name of the registered server"}
		},"required":["server_name"]
	}`)
}

func browserNavigateDef() ToolDef {
	return makeTool("browser_navigate", "Open a website URL in browser (PREFERRED for all web pages). Use this instead of http_request for websites. After navigating, use browser_extract to read page content", `{
		"type":"object","properties":{
			"url":{"type":"string","description":"URL to navigate to"}
		},"required":["url"]
	}`)
}

func browserScreenshotDef() ToolDef {
	return makeTool("browser_screenshot", "Take a screenshot of the current browser page", `{
		"type":"object","properties":{}
	}`)
}

func browserClickDef() ToolDef {
	return makeTool("browser_click", "Click an element on the page by CSS selector or visible text", `{
		"type":"object","properties":{
			"selector":{"type":"string","description":"CSS selector of element to click"},
			"text":{"type":"string","description":"Visible text of element to click (alternative to selector)"}
		}
	}`)
}

func browserTypeDef() ToolDef {
	return makeTool("browser_type", "Type text into an input field by CSS selector", `{
		"type":"object","properties":{
			"selector":{"type":"string","description":"CSS selector of the input field"},
			"text":{"type":"string","description":"Text to type"}
		},"required":["selector","text"]
	}`)
}

func browserExtractDef() ToolDef {
	return makeTool("browser_extract", "Read/extract all text content from current browser page (after browser_navigate). Gets full rendered content including JavaScript-generated data like prices, tables, etc.", `{
		"type":"object","properties":{}
	}`)
}

func knowledgeSearchDef() ToolDef {
	return makeTool("knowledge_search", "Search the user's knowledge bases for relevant information. Use this when the user asks about documents they have uploaded.", `{
		"type":"object","properties":{
			"kb_id":{"type":"string","description":"Optional: specific knowledge base ID to search. If empty, searches all."},
			"query":{"type":"string","description":"Search query keywords"},
			"limit":{"type":"integer","description":"Max results to return","default":5}
		},"required":["query"]
	}`)
}

func delegateAgentDef() ToolDef {
	return makeTool("delegate_agent", "Hand off the current conversation to a different AI agent by name. Use when the user's request is better handled by a specialized agent.", `{
		"type":"object","properties":{
			"agent_name":{"type":"string","description":"Name of the agent to delegate to"},
			"reason":{"type":"string","description":"Reason for delegation"},
			"conversation_id":{"type":"string","description":"Channel conversation ID to delegate"}
		},"required":["agent_name"]
	}`)
}


func manageScheduledTaskDef() ToolDef {
	return makeTool("manage_scheduled_task", "Create, list, update, delete, pause, or resume scheduled tasks that run automatically on a cron schedule", `{
		"type":"object","properties":{
			"action":{"type":"string","enum":["create","list","update","delete","pause","resume"],"description":"Action to perform"},
			"name":{"type":"string","description":"Task name (for create)"},
			"prompt":{"type":"string","description":"AI prompt to execute (for create/update)"},
			"schedule":{"type":"string","description":"Cron expression, e.g. 0 9 * * * for daily at 9am (for create/update)"},
			"delivery_channel":{"type":"string","enum":["web","telegram","zalo","discord"],"description":"Where to deliver results (for create/update)","default":"web"},
			"timezone":{"type":"string","description":"Timezone for schedule, e.g. Asia/Ho_Chi_Minh (for create/update)","default":"Asia/Ho_Chi_Minh"},
			"task_id":{"type":"string","description":"Task ID (for update/delete/pause/resume)"},
			"description":{"type":"string","description":"Task description (for create/update)"},
			"agent_id":{"type":"string","description":"Agent ID to use for execution (optional)"}
		},"required":["action"]
	}`)
}

func skillInstallDef() ToolDef {
	return makeTool("skill_install",
		"Create or update a skill file (SKILL.md) for the bot. Use this to teach yourself new capabilities by writing skill definitions with YAML frontmatter and markdown instructions.",
		`{"type":"object","properties":{"slug":{"type":"string","description":"Skill identifier (lowercase, numbers, hyphens). Example: data-pipeline"},"content":{"type":"string","description":"Full SKILL.md content starting with YAML frontmatter (---). Include name, description, max_tool_rounds."}},"required":["slug","content"]}`)
}

func browserScrollDef() ToolDef {
	return makeTool("browser_scroll", "Scroll the browser page (requires extension, otherwise not available)", `{
		"type":"object","properties":{
			"direction":{"type":"string","enum":["up","down","left","right"],"description":"Scroll direction","default":"down"},
			"amount":{"type":"integer","description":"Pixels to scroll (default 500)"}
		}
	}`)
}

func browserTabListDef() ToolDef {
	return makeTool("browser_tab_list", "List all open tabs in the user's browser (requires extension)", `{
		"type":"object","properties":{}
	}`)
}

func browserTabSwitchDef() ToolDef {
	return makeTool("browser_tab_switch", "Switch to a specific tab in the user's browser (requires extension)", `{
		"type":"object","properties":{
			"tab_id":{"type":"integer","description":"Tab ID to switch to"}
		},"required":["tab_id"]
	}`)
}

func cuScreenshotDef() ToolDef {
	return makeTool("cu_screenshot", "Take a screenshot of the user's active browser tab (requires extension)", `{"type":"object","properties":{}}`)
}
func cuClickDef() ToolDef {
	return makeTool("cu_click", "Click an element on the user's browser page by CSS selector or visible text", `{"type":"object","properties":{"selector":{"type":"string","description":"CSS selector of element to click"},"text":{"type":"string","description":"Visible text of element to click (alternative to selector)"}}}`)
}
func cuTypeDef() ToolDef {
	return makeTool("cu_type", "Type text into an input field on the user's browser page", `{"type":"object","properties":{"selector":{"type":"string","description":"CSS selector of the input field"},"text":{"type":"string","description":"Text to type"}},"required":["selector","text"]}`)
}
func cuScrollDef() ToolDef {
	return makeTool("cu_scroll", "Scroll the user's browser page", `{"type":"object","properties":{"direction":{"type":"string","enum":["up","down","left","right"],"description":"Scroll direction"},"amount":{"type":"integer","description":"Pixels to scroll (default 500)"}}}`)
}
func cuNavigateDef() ToolDef {
	return makeTool("cu_navigate", "Navigate the user's browser to a URL", `{"type":"object","properties":{"url":{"type":"string","description":"URL to navigate to"}},"required":["url"]}`)
}
func cuReadPageDef() ToolDef {
	return makeTool("cu_read_page", "Extract text content from the user's active browser tab", `{"type":"object","properties":{}}`)
}
func cuTabListDef() ToolDef {
	return makeTool("cu_tab_list", "List all open tabs in the user's browser", `{"type":"object","properties":{}}`)
}
func cuTabSwitchDef() ToolDef {
	return makeTool("cu_tab_switch", "Switch to a specific tab in the user's browser", `{"type":"object","properties":{"tab_id":{"type":"integer","description":"Tab ID to switch to (from cu_tab_list)"}},"required":["tab_id"]}`)
}

// toolCapabilities maps tool names to their capability level.
var toolCapabilities = map[string]string{
	// read
	"memory_search":    "read",
	"memory_list":      "read",
	"knowledge_search": "read",
	"file_read":        "read",
	"file_list":        "read",
	"file_search":      "read",
	"server_list":      "read",
	"server_status":    "read",
	"browser_screenshot": "read",
	"browser_extract":  "read",
	"browser_tab_list": "read",
	"cu_screenshot":    "read",
	"cu_read_page":     "read",
	"cu_tab_list":      "read",
	// write_low
	"memory_save":           "write_low",
	"file_write":            "write_low",
	"file_delete":           "write_low",
	"send_file":             "write_low",
	"manage_scheduled_task": "write_low",
	"skill_install":         "write_low",
	"browser_navigate":      "write_low",
	"browser_click":         "write_low",
	"browser_type":          "write_low",
	"browser_scroll":        "write_low",
	"browser_tab_switch":    "write_low",
	"cu_click":              "write_low",
	"cu_type":               "write_low",
	"cu_scroll":             "write_low",
	"cu_navigate":           "write_low",
	"cu_tab_switch":         "write_low",
	// write_high
	"terminal_exec": "write_high",
	"http_request":  "write_high",
	// critical
	"server_ssh_exec":  "critical",
	"delegate_agent":   "critical",
}

// CapabilityFor returns the capability level for a tool name. Unknown tools default to "critical".
func CapabilityFor(name string) string {
	if cap, ok := toolCapabilities[name]; ok {
		return cap
	}
	return "critical"
}

func init() {
	// Set Capability on all tools from the map
	for i := range AllTools {
		AllTools[i].Capability = CapabilityFor(AllTools[i].Function.Name)
	}
}
