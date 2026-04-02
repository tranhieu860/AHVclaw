package tools

import "encoding/json"

type ToolDef struct {
	Type     string `json:"type"`
	Function struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Parameters  json.RawMessage `json:"parameters"`
	} `json:"function"`
}

var AllTools = []ToolDef{
	fileReadDef(), fileWriteDef(), fileListDef(), fileDeleteDef(), fileSearchDef(),
	terminalExecDef(),
	httpRequestDef(),
	memorySaveDef(),
	memorySearchDef(),
	serverSSHExecDef(),
	serverStatusDef(),
	browserNavigateDef(), browserScreenshotDef(), browserClickDef(), browserTypeDef(), browserExtractDef(),
	knowledgeSearchDef(),
	delegateAgentDef(),
	manageScheduledTaskDef(),
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
	return makeTool("http_request", "Make an HTTP request", `{
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
	var t ToolDef
	t.Type = "function"
	t.Function.Name = name
	t.Function.Description = desc
	t.Function.Parameters = json.RawMessage(params)
	return t
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
	return makeTool("browser_navigate", "Navigate the browser to a URL", `{
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
	return makeTool("browser_click", "Click an element on the page by CSS selector", `{
		"type":"object","properties":{
			"selector":{"type":"string","description":"CSS selector of element to click"}
		},"required":["selector"]
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
	return makeTool("browser_extract", "Extract text content from the current browser page", `{
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
