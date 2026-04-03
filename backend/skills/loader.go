package skills

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	SystemSkillsDir = "/data/ahvclaw/skills"
	UserSkillsBase  = "/data/ahvclaw/users"
)

type SkillFrontmatter struct {
	Name          string `yaml:"name"`
	Description   string `yaml:"description"`
	MaxToolRounds int    `yaml:"max_tool_rounds"`
}

type Skill struct {
	SkillFrontmatter
	Body string
	Path string
}

type SkillMeta struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Source      string `json:"source"`
}

func LoadSkill(userID, slug string) (*Skill, error) {
	if !IsValidSlug(slug) {
		return nil, fmt.Errorf("invalid skill slug: %s", slug)
	}

	userPath := filepath.Join(UserSkillsBase, userID, "skills", slug, "SKILL.md")
	if s, err := loadFromPath(userPath); err == nil {
		return s, nil
	}

	sysPath := filepath.Join(SystemSkillsDir, slug, "SKILL.md")
	if s, err := loadFromPath(sysPath); err == nil {
		return s, nil
	}

	return nil, fmt.Errorf("skill not found: %s", slug)
}

func ListSkills(userID string) []SkillMeta {
	seen := make(map[string]bool)
	var result []SkillMeta

	userDir := filepath.Join(UserSkillsBase, userID, "skills")
	if entries, err := os.ReadDir(userDir); err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			slug := e.Name()
			s, err := loadFromPath(filepath.Join(userDir, slug, "SKILL.md"))
			if err != nil {
				continue
			}
			result = append(result, SkillMeta{Name: s.Name, Description: s.Description, Source: "user"})
			seen[slug] = true
		}
	}

	if entries, err := os.ReadDir(SystemSkillsDir); err == nil {
		for _, e := range entries {
			if !e.IsDir() || seen[e.Name()] {
				continue
			}
			s, err := loadFromPath(filepath.Join(SystemSkillsDir, e.Name(), "SKILL.md"))
			if err != nil {
				continue
			}
			result = append(result, SkillMeta{Name: s.Name, Description: s.Description, Source: "system"})
		}
	}

	return result
}

func loadFromPath(path string) (*Skill, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	fm, body, err := parseFrontmatter(string(data))
	if err != nil {
		return nil, err
	}

	return &Skill{SkillFrontmatter: fm, Body: body, Path: path}, nil
}

func parseFrontmatter(content string) (SkillFrontmatter, string, error) {
	var fm SkillFrontmatter

	if !strings.HasPrefix(content, "---\n") {
		return fm, content, fmt.Errorf("no frontmatter")
	}

	end := strings.Index(content[4:], "\n---")
	if end < 0 {
		return fm, content, fmt.Errorf("unclosed frontmatter")
	}

	fmRaw := content[4 : 4+end]
	body := strings.TrimSpace(content[4+end+4:])

	if err := yaml.Unmarshal([]byte(fmRaw), &fm); err != nil {
		return fm, body, fmt.Errorf("invalid yaml: %w", err)
	}

	if fm.Name == "" {
		return fm, body, fmt.Errorf("missing name")
	}

	return fm, body, nil
}

func IsValidSlug(slug string) bool {
	if slug == "" || len(slug) > 100 {
		return false
	}
	for _, c := range slug {
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
			return false
		}
	}
	return !strings.Contains(slug, "..")
}
