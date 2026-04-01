package skills

import (
	"context"
	"log"

	"github.com/ahvholding/ahvclaw/db"
)

type builtinSkill struct {
	Name        string
	Slug        string
	Description string
	Config      string
}

var defaultSkills = []builtinSkill{
	{
		Name:        "Web Search",
		Slug:        "web-search",
		Description: "Search the web for information",
		Config:      `{"prompt": "Search the web for relevant and up-to-date information based on the user query.", "tools_required": ["http_request", "browser_navigate", "browser_extract"]}`,
	},
	{
		Name:        "Code Review",
		Slug:        "code-review",
		Description: "Review code for bugs and improvements",
		Config:      `{"prompt": "Review the following code for bugs, security issues, performance problems, and suggest improvements.", "tools_required": ["file_read"]}`,
	},
	{
		Name:        "File Manager",
		Slug:        "file-manager",
		Description: "Manage files in your workspace",
		Config:      `{"prompt": "Help manage files in the workspace. You can read, write, list, and delete files as needed.", "tools_required": ["file_read", "file_write", "file_list", "file_delete"]}`,
	},
	{
		Name:        "Server Monitor",
		Slug:        "server-monitor",
		Description: "Monitor and manage remote servers",
		Config:      `{"prompt": "Monitor and manage remote servers. Check server status, run commands, and report on system health.", "tools_required": ["server_ssh_exec", "server_status"]}`,
	},
	{
		Name:        "Data Analyst",
		Slug:        "data-analyst",
		Description: "Analyze data and create insights",
		Config:      `{"prompt": "Analyze data files and datasets to extract insights, generate summaries, and identify patterns.", "tools_required": ["file_read", "terminal_exec"]}`,
	},
}

func SeedBuiltinSkills() {
	ctx := context.Background()
	for _, s := range defaultSkills {
		_, err := db.Pool.Exec(ctx,
			`INSERT INTO skills (name, slug, description, config, is_public, is_system)
			VALUES ($1, $2, $3, $4, true, true)
			ON CONFLICT (slug) DO NOTHING`,
			s.Name, s.Slug, s.Description, s.Config)
		if err != nil {
			log.Printf("Failed to seed skill %s: %v", s.Slug, err)
		}
	}
	log.Println("Built-in skills seeded")
}
