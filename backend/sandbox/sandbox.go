package sandbox

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// SandboxedExec runs a command inside a bubblewrap sandbox.
// The root filesystem is mounted read-only, only the user's workspace is writable.
func SandboxedExec(ctx context.Context, workspaceDir, command string, timeoutSec int) (string, error) {
	if timeoutSec <= 0 {
		timeoutSec = 30
	}
	if timeoutSec > 120 {
		timeoutSec = 120
	}

	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSec)*time.Second)
	defer cancel()

	args := []string{
		"--ro-bind", "/", "/",
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
