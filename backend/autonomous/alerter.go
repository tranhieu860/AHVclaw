package autonomous

import (
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// AlertRule defines a pattern-based alert trigger.
type AlertRule struct {
	Name     string
	Pattern  *regexp.Regexp
	Severity string // critical, warning, info
	Template string // message template
}

// Alert is a triggered alert ready for delivery.
type Alert struct {
	Rule     string
	Severity string
	Message  string
}

// alertDedup tracks last alert time per rule+user to avoid spam.
var alertDedup sync.Map // key: "userID:ruleName" → time.Time

// builtinRules are the default alert rules checked on every heartbeat result.
var builtinRules = []AlertRule{
	{
		Name:     "server_unreachable",
		Pattern:  regexp.MustCompile(`(?i)(connection refused|timeout|unreachable|cannot connect|dial tcp.*refused)`),
		Severity: "critical",
		Template: "Server connection issue detected: {{match}}",
	},
	{
		Name:     "disk_usage_high",
		Pattern:  regexp.MustCompile(`(?i)(disk|storage).*(9[0-9]|100)%`),
		Severity: "warning",
		Template: "High disk usage detected: {{match}}",
	},
	{
		Name:     "service_down",
		Pattern:  regexp.MustCompile(`(?i)(inactive|dead|failed|not running|stopped).*(service|systemctl|nginx|postgres|ahvclaw)`),
		Severity: "critical",
		Template: "Service appears down: {{match}}",
	},
	{
		Name:     "high_cpu",
		Pattern:  regexp.MustCompile(`(?i)cpu.*(9[0-9]|100)%`),
		Severity: "warning",
		Template: "High CPU usage detected: {{match}}",
	},
	{
		Name:     "memory_critical",
		Pattern:  regexp.MustCompile(`(?i)(memory|ram|swap).*(9[0-9]|100)%`),
		Severity: "warning",
		Template: "Critical memory usage: {{match}}",
	},
	{
		Name:     "tool_error",
		Pattern:  regexp.MustCompile(`(?i)(error|failed|exception|panic).*tool`),
		Severity: "warning",
		Template: "Tool execution error: {{match}}",
	},
	{
		Name:     "ssl_expiry",
		Pattern:  regexp.MustCompile(`(?i)ssl.*(expir|invalid|untrusted)`),
		Severity: "warning",
		Template: "SSL certificate issue: {{match}}",
	},
}

// EvaluateAlerts checks heartbeat output against all rules and returns triggered alerts.
func EvaluateAlerts(userID uuid.UUID, source, output string) []Alert {
	var alerts []Alert
	for _, rule := range builtinRules {
		match := rule.Pattern.FindString(output)
		if match == "" {
			continue
		}

		// Dedup: skip if same alert fired within 30 minutes
		dedupKey := userID.String() + ":" + rule.Name
		if lastTime, ok := alertDedup.Load(dedupKey); ok {
			if time.Since(lastTime.(time.Time)) < 30*time.Minute {
				continue
			}
		}

		// Build message from template
		msg := strings.ReplaceAll(rule.Template, "{{match}}", truncateAlert(match, 200))
		msg += "\nSource: " + source

		alerts = append(alerts, Alert{
			Rule:     rule.Name,
			Severity: rule.Severity,
			Message:  msg,
		})

		// Update dedup timestamp
		alertDedup.Store(dedupKey, time.Now())
	}
	return alerts
}

// cleanupDedupEntries removes stale dedup entries older than 1 hour.
// Called periodically from a goroutine started by init().
func cleanupDedupEntries() {
	alertDedup.Range(func(key, value interface{}) bool {
		if t, ok := value.(time.Time); ok {
			if time.Since(t) > 1*time.Hour {
				alertDedup.Delete(key)
			}
		}
		return true
	})
}

func init() {
	go func() {
		ticker := time.NewTicker(15 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			cleanupDedupEntries()
		}
	}()
}

func truncateAlert(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max]) + "..."
}