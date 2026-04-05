package sandbox

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const workspaceRoot = "/data/ahvclaw/workspaces/"

// ValidateWorkspacePath ensures the workspace path is safe:
// - Must be an absolute path under /data/ahvclaw/workspaces/{userID}
// - Must not contain symlinks that resolve elsewhere
// - Must not be the parent workspaces directory itself
func ValidateWorkspacePath(workspaceDir string) error {
	absPath, err := filepath.Abs(workspaceDir)
	if err != nil {
		return fmt.Errorf("invalid workspace path: %s", workspaceDir)
	}

	// Must be strictly under workspaceRoot, not the root itself
	if !strings.HasPrefix(absPath, workspaceRoot) {
		return fmt.Errorf("workspace path outside allowed root: %s", absPath)
	}

	// Must be exactly one level deep (the userID directory), not the root
	rel, err := filepath.Rel(workspaceRoot, absPath)
	if err != nil || rel == "." || strings.Contains(rel, "..") {
		return fmt.Errorf("workspace path must be a specific user directory: %s", absPath)
	}

	// Check for symlink attacks: resolved path must match the absolute path
	resolved, err := filepath.EvalSymlinks(absPath)
	if err != nil {
		// Directory may not exist yet; check parent
		parentResolved, perr := filepath.EvalSymlinks(filepath.Dir(absPath))
		if perr != nil {
			return fmt.Errorf("cannot resolve workspace path: %s", absPath)
		}
		expectedParent, _ := filepath.Abs(strings.TrimSuffix(workspaceRoot, "/"))
		if parentResolved != expectedParent {
			return fmt.Errorf("workspace parent contains symlinks: %s -> %s", filepath.Dir(absPath), parentResolved)
		}
	} else if resolved != absPath {
		return fmt.Errorf("workspace path contains symlinks: %s -> %s", absPath, resolved)
	}

	return nil
}

// SandboxedExec runs a command inside a bubblewrap sandbox.
// The root filesystem is mounted read-only, only the user's workspace is writable.
func SandboxedExec(ctx context.Context, workspaceDir, command string, timeoutSec int) (string, error) {
	if timeoutSec <= 0 {
		timeoutSec = 30
	}
	if timeoutSec > 120 {
		timeoutSec = 120
	}

	// Validate workspace path before sandboxing
	if err := ValidateWorkspacePath(workspaceDir); err != nil {
		return "", fmt.Errorf("sandbox rejected workspace: %w", err)
	}

	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSec)*time.Second)
	defer cancel()

	// Bind root read-only, then overlay workspaces root with tmpfs to hide other tenants,
	// then bind only this user's workspace writable on top.
	// Order matters: ro-bind / -> tmpfs /data/ahvclaw/workspaces -> bind user workspace
	args := []string{
		"--ro-bind", "/", "/",
		"--tmpfs", "/data/ahvclaw/workspaces",
		"--bind", workspaceDir, workspaceDir,
		"--tmpfs", "/tmp",
		"--proc", "/proc",
		"--dev", "/dev",
		"--die-with-parent",
		"--chdir", workspaceDir,
		"/bin/bash", "-c", command,
	}

	cmd := exec.CommandContext(ctx, "bwrap", args...)
	output, err := cmd.CombinedOutput()

	result := strings.TrimSpace(string(output))

	if ctx.Err() == context.DeadlineExceeded {
		return result, fmt.Errorf("command timed out after %ds", timeoutSec)
	}

	return result, err
}
