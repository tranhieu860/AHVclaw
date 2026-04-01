package tools

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func (e *Executor) resolvePath(relPath string) (string, error) {
	abs := filepath.Join(e.WorkspaceDir, filepath.Clean(relPath))
	wsDir := e.WorkspaceDir
	if !strings.HasSuffix(wsDir, string(os.PathSeparator)) {
		wsDir += string(os.PathSeparator)
	}
	// Evaluate symlinks to prevent symlink-based escapes
	realAbs, err := filepath.EvalSymlinks(abs)
	if err != nil {
		// If file doesn't exist yet (for writes), check parent
		realAbs, err = filepath.EvalSymlinks(filepath.Dir(abs))
		if err != nil {
			return "", fmt.Errorf("path escapes workspace")
		}
		realAbs = filepath.Join(realAbs, filepath.Base(abs))
	}
	realWs, _ := filepath.EvalSymlinks(e.WorkspaceDir)
	if !strings.HasSuffix(realWs, string(os.PathSeparator)) {
		realWs += string(os.PathSeparator)
	}
	if !strings.HasPrefix(realAbs, realWs) && realAbs != strings.TrimSuffix(realWs, string(os.PathSeparator)) {
		return "", fmt.Errorf("path escapes workspace")
	}
	return abs, nil
}

func (e *Executor) fileRead(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "file_read", Error: "invalid arguments"}
	}
	path, err := e.resolvePath(args.Path)
	if err != nil {
		return &ToolResult{Name: "file_read", Error: err.Error()}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return &ToolResult{Name: "file_read", Error: err.Error()}
	}
	content := string(data)
	if len(content) > 100000 {
		content = content[:100000] + "\n... (truncated)"
	}
	return &ToolResult{Name: "file_read", Content: content}
}

func (e *Executor) fileWrite(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "file_write", Error: "invalid arguments"}
	}
	path, err := e.resolvePath(args.Path)
	if err != nil {
		return &ToolResult{Name: "file_write", Error: err.Error()}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return &ToolResult{Name: "file_write", Error: err.Error()}
	}
	if err := os.WriteFile(path, []byte(args.Content), 0644); err != nil {
		return &ToolResult{Name: "file_write", Error: err.Error()}
	}
	return &ToolResult{Name: "file_write", Content: fmt.Sprintf("Written %d bytes to %s", len(args.Content), args.Path)}
}

func (e *Executor) fileList(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "file_list", Error: "invalid arguments"}
	}
	if args.Path == "" {
		args.Path = "."
	}
	path, err := e.resolvePath(args.Path)
	if err != nil {
		return &ToolResult{Name: "file_list", Error: err.Error()}
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return &ToolResult{Name: "file_list", Error: err.Error()}
	}
	var lines []string
	for _, entry := range entries {
		info, _ := entry.Info()
		prefix := "  "
		if entry.IsDir() {
			prefix = "d "
		}
		size := int64(0)
		if info != nil {
			size = info.Size()
		}
		lines = append(lines, fmt.Sprintf("%s%s (%d bytes)", prefix, entry.Name(), size))
	}
	return &ToolResult{Name: "file_list", Content: strings.Join(lines, "\n")}
}

func (e *Executor) fileDelete(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "file_delete", Error: "invalid arguments"}
	}
	path, err := e.resolvePath(args.Path)
	if err != nil {
		return &ToolResult{Name: "file_delete", Error: err.Error()}
	}
	if err := os.Remove(path); err != nil {
		return &ToolResult{Name: "file_delete", Error: err.Error()}
	}
	return &ToolResult{Name: "file_delete", Content: "Deleted: " + args.Path}
}

func (e *Executor) fileSearch(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		Pattern string `json:"pattern"`
		Path    string `json:"path"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "file_search", Error: "invalid arguments"}
	}
	if args.Path == "" {
		args.Path = "."
	}
	dir, err := e.resolvePath(args.Path)
	if err != nil {
		return &ToolResult{Name: "file_search", Error: err.Error()}
	}
	cmd := exec.Command("grep", "-rn", "--include=*", "-l", args.Pattern, dir)
	out, _ := cmd.CombinedOutput()
	result := string(out)
	if len(result) > 50000 {
		result = result[:50000] + "\n... (truncated)"
	}
	if result == "" {
		result = "No matches found"
	}
	return &ToolResult{Name: "file_search", Content: result}
}
