package memories

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

const MemoriesBase = "/data/ahvclaw/users"

type MemoryFrontmatter struct {
	Type string `yaml:"type"`
	Key  string `yaml:"key"`
}

type Memory struct {
	MemoryFrontmatter
	Content  string
	Filename string
}

type MemoryMeta struct {
	Type     string `json:"type"`
	Key      string `json:"key"`
	Filename string `json:"filename"`
}

func MemoriesDir(userID string) string {
	return filepath.Join(MemoriesBase, userID, "memories")
}

func LoadMemory(userID, filename string) (*Memory, error) {
	path := filepath.Join(MemoriesDir(userID), filename)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	fm, body, err := parseFrontmatter(string(data))
	if err != nil {
		return nil, err
	}

	return &Memory{MemoryFrontmatter: fm, Content: body, Filename: filename}, nil
}

func ListMemories(userID string) []MemoryMeta {
	dir := MemoriesDir(userID)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	var result []MemoryMeta
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") || e.Name() == "MEMORY.md" {
			continue
		}
		m, err := LoadMemory(userID, e.Name())
		if err != nil {
			continue
		}
		result = append(result, MemoryMeta{Type: m.Type, Key: m.Key, Filename: m.Filename})
	}
	return result
}

func SaveMemoryFile(userID string, mem *Memory) error {
	dir := MemoriesDir(userID)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	content := fmt.Sprintf("---\ntype: %s\nkey: %s\n---\n%s\n", mem.Type, mem.Key, strings.TrimSpace(mem.Content))
	path := filepath.Join(dir, mem.Filename)
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		return err
	}

	updateIndex(userID)
	return nil
}

func DeleteMemoryFile(userID, filename string) error {
	path := filepath.Join(MemoriesDir(userID), filename)
	if err := os.Remove(path); err != nil {
		return err
	}
	updateIndex(userID)
	return nil
}

func MakeFilename(memType, key string) string {
	slug := strings.ToLower(key)
	slug = strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			return r
		}
		if r == ' ' || r == '-' || r == '_' {
			return '-'
		}
		return -1
	}, slug)
	for strings.Contains(slug, "--") {
		slug = strings.ReplaceAll(slug, "--", "-")
	}
	slug = strings.Trim(slug, "-")
	if slug == "" {
		slug = "memory"
	}
	if len(slug) > 60 {
		slug = slug[:60]
	}
	return fmt.Sprintf("%s_%s.md", memType, slug)
}

func updateIndex(userID string) {
	metas := ListMemories(userID)
	var sb strings.Builder
	sb.WriteString("# Memory Index\n\n")
	for _, m := range metas {
		sb.WriteString(fmt.Sprintf("- [%s](%s) — %s: %s\n", m.Filename, m.Filename, m.Type, m.Key))
	}
	indexPath := filepath.Join(MemoriesDir(userID), "MEMORY.md")
	os.WriteFile(indexPath, []byte(sb.String()), 0644)
}

func parseFrontmatter(content string) (MemoryFrontmatter, string, error) {
	var fm MemoryFrontmatter

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
		return fm, body, err
	}

	return fm, body, nil
}
