package tools

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/ahvholding/ahvclaw/skills"
)

func (e *Executor) skillInstall(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		Slug    string `json:"slug"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Content: "Error: invalid arguments: " + err.Error(), Error: "invalid arguments"}
	}

	if args.Slug == "" || args.Content == "" {
		return &ToolResult{Content: "Error: slug and content are required", Error: "slug and content are required"}
	}

	if !skills.IsValidSlug(args.Slug) {
		return &ToolResult{Content: "Error: invalid slug — use only lowercase letters, numbers, and hyphens", Error: "invalid slug"}
	}

	if !strings.HasPrefix(args.Content, "---\n") {
		return &ToolResult{Content: "Error: SKILL.md must start with YAML frontmatter (---)", Error: "missing frontmatter"}
	}

	dir := filepath.Join(skills.UserSkillsBase, e.UserID, "skills", args.Slug)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return &ToolResult{Content: "Error creating skill directory: " + err.Error(), Error: err.Error()}
	}

	path := filepath.Join(dir, "SKILL.md")
	if err := os.WriteFile(path, []byte(args.Content), 0644); err != nil {
		return &ToolResult{Content: "Error writing SKILL.md: " + err.Error(), Error: err.Error()}
	}

	return &ToolResult{Content: fmt.Sprintf("Skill '%s' saved to %s", args.Slug, path)}
}
