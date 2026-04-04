package security

import (
	"regexp"
	"strings"
)

// ToolPolicy enforces safety boundaries for tool execution.

// DangerousShellPatterns are shell commands that should be blocked or require elevated trust.
var DangerousShellPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\brm\s+-rf\s+/`),           // rm -rf /
	regexp.MustCompile(`(?i)\bmkfs\b`),                  // format disk
	regexp.MustCompile(`(?i)\bdd\s+if=.*of=/dev/`),      // disk overwrite
	regexp.MustCompile(`(?i)>\s*/dev/sd[a-z]`),          // redirect to disk
	regexp.MustCompile(`(?i)\bshutdown\b`),              // shutdown
	regexp.MustCompile(`(?i)\breboot\b`),                // reboot
	regexp.MustCompile(`(?i)\biptables\s+-F`),           // flush firewall
	regexp.MustCompile(`(?i)\bchmod\s+777\s+/`),        // chmod 777 root
	regexp.MustCompile(`(?i)\bcurl\b.*\|\s*(ba)?sh`),    // curl pipe to shell
	regexp.MustCompile(`(?i)\bwget\b.*\|\s*(ba)?sh`),    // wget pipe to shell
	regexp.MustCompile(`(?i):(){ :\|:& };:`),            // fork bomb
}

// SensitivePathPrefixes are filesystem paths that tools should not access.
var SensitivePathPrefixes = []string{
	"/etc/shadow",
	"/etc/passwd",
	"/etc/ssh/",
	"/root/.ssh/",
	"/proc/",
	"/sys/",
}

// CheckShellCommand returns a risk assessment for a shell command.
func CheckShellCommand(cmd string) (blocked bool, reason string) {
	for _, p := range DangerousShellPatterns {
		if p.MatchString(cmd) {
			return true, "blocked dangerous command pattern: " + p.String()
		}
	}
	return false, ""
}

// CheckFilePath returns true if a path should be blocked for tool access.
func CheckFilePath(path string) (blocked bool, reason string) {
	normalized := strings.TrimSpace(path)
	for _, prefix := range SensitivePathPrefixes {
		if strings.HasPrefix(normalized, prefix) {
			return true, "access to sensitive path blocked: " + prefix
		}
	}
	return false, ""
}

// CheckWorkspaceBoundary ensures file operations stay within user workspace.
func CheckWorkspaceBoundary(path, workspace string) bool {
	if workspace == "" {
		return true
	}
	return strings.HasPrefix(path, workspace)
}
