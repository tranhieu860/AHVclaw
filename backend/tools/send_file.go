package tools

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func (e *Executor) sendFile(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		Path    string `json:"path"`
		Caption string `json:"caption"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "send_file", Error: "invalid arguments: " + err.Error()}
	}
	if args.Path == "" {
		return &ToolResult{Name: "send_file", Error: "path is required"}
	}

	// Resolve path relative to workspace
	resolvedPath := args.Path
	if !filepath.IsAbs(resolvedPath) {
		resolvedPath = filepath.Join(e.WorkspaceDir, resolvedPath)
	}
	resolvedPath = filepath.Clean(resolvedPath)

	// Security: must be within workspace or /tmp
	if !strings.HasPrefix(resolvedPath, e.WorkspaceDir) && !strings.HasPrefix(resolvedPath, "/tmp/") {
		return &ToolResult{Name: "send_file", Error: "access denied: file must be in workspace or /tmp"}
	}

	// Symlink check: resolve and re-verify the path stays within allowed boundaries
	realPath, err := filepath.EvalSymlinks(resolvedPath)
	if err != nil {
		return &ToolResult{Name: "send_file", Error: "cannot resolve file path: " + err.Error()}
	}
	if !strings.HasPrefix(realPath, e.WorkspaceDir) && !strings.HasPrefix(realPath, "/tmp/") {
		return &ToolResult{Name: "send_file", Error: "access denied: resolved path escapes workspace"}
	}

	// Check file exists
	info, err := os.Stat(realPath)
	if err != nil {
		return &ToolResult{Name: "send_file", Error: "file not found: " + err.Error()}
	}
	if info.IsDir() {
		return &ToolResult{Name: "send_file", Error: "path is a directory, not a file"}
	}

	// Check file size (max 50MB for Telegram)
	if info.Size() > 50*1024*1024 {
		return &ToolResult{Name: "send_file", Error: "file too large (max 50MB)"}
	}

	// Use SendFileFn callback if available
	if e.SendFileFn == nil {
		return &ToolResult{Name: "send_file", Error: "file sending not available in this context"}
	}

	if err := e.SendFileFn(realPath, args.Caption); err != nil {
		return &ToolResult{Name: "send_file", Error: fmt.Sprintf("failed to send file: %v", err)}
	}

	return &ToolResult{Name: "send_file", Content: fmt.Sprintf("File sent successfully: %s (%d bytes)", filepath.Base(resolvedPath), info.Size())}
}
