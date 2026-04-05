package handlers

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/ahvholding/ahvclaw/autonomous"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

var startTime = time.Now()

// ==================== EXISTING ENDPOINTS ====================

func AdminListUsers(c *fiber.Ctx) error {
	rows, err := db.Pool.Query(context.Background(),
		`SELECT id, email, name, role, avatar_url, storage_used, storage_quota, created_at, updated_at
		FROM users ORDER BY created_at DESC`)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch users"})
	}
	defer rows.Close()

	var users []fiber.Map
	for rows.Next() {
		var id uuid.UUID
		var email, name, role string
		var avatarURL *string
		var storageUsed, storageQuota int64
		var createdAt, updatedAt interface{}
		if err := rows.Scan(&id, &email, &name, &role, &avatarURL, &storageUsed, &storageQuota, &createdAt, &updatedAt); err != nil {
			continue
		}
		users = append(users, fiber.Map{
			"id":            id,
			"email":         email,
			"name":          name,
			"role":          role,
			"avatar_url":    avatarURL,
			"storage_used":  storageUsed,
			"storage_quota": storageQuota,
			"created_at":    createdAt,
			"updated_at":    updatedAt,
		})
	}
	if users == nil {
		users = []fiber.Map{}
	}
	return c.JSON(users)
}

func AdminUpdateUserRole(c *fiber.Ctx) error {
	targetID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid user ID"})
	}
	var body struct {
		Role string `json:"role"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}
	if body.Role == "" {
		return c.Status(400).JSON(fiber.Map{"error": "role is required"})
	}
	validRoles := map[string]bool{"admin": true, "dev": true, "user": true}
	if !validRoles[body.Role] {
		return c.Status(400).JSON(fiber.Map{"error": "invalid role, must be admin, dev, or user"})
	}

	result, err := db.Pool.Exec(context.Background(),
		"UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2", body.Role, targetID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to update role"})
	}
	if result.RowsAffected() == 0 {
		return c.Status(404).JSON(fiber.Map{"error": "user not found"})
	}
	return c.JSON(fiber.Map{"message": "role updated"})
}

func AdminDeleteUser(c *fiber.Ctx) error {
	adminID := c.Locals("user_id").(uuid.UUID)
	targetID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid user ID"})
	}
	if adminID == targetID {
		return c.Status(400).JSON(fiber.Map{"error": "cannot delete yourself"})
	}

	result, err := db.Pool.Exec(context.Background(),
		"DELETE FROM users WHERE id = $1", targetID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to delete user"})
	}
	if result.RowsAffected() == 0 {
		return c.Status(404).JSON(fiber.Map{"error": "user not found"})
	}
	return c.JSON(fiber.Map{"message": "user deleted"})
}

func AdminSystemStats(c *fiber.Ctx) error {
	ctx := context.Background()
	stats := fiber.Map{}

	var totalUsers int
	db.Pool.QueryRow(ctx, "SELECT COUNT(*) FROM users").Scan(&totalUsers)
	stats["total_users"] = totalUsers

	var totalConversations int
	db.Pool.QueryRow(ctx, "SELECT COUNT(*) FROM conversations").Scan(&totalConversations)
	stats["total_conversations"] = totalConversations

	var totalMessages int
	db.Pool.QueryRow(ctx, "SELECT COUNT(*) FROM messages").Scan(&totalMessages)
	stats["total_messages"] = totalMessages

	var totalStorageUsed int64
	db.Pool.QueryRow(ctx, "SELECT COALESCE(SUM(storage_used), 0) FROM users").Scan(&totalStorageUsed)
	stats["total_storage_used"] = totalStorageUsed

	var activeBots int
	db.Pool.QueryRow(ctx, "SELECT COUNT(*) FROM bots WHERE is_active = true").Scan(&activeBots)
	stats["active_bots"] = activeBots

	return c.JSON(stats)
}

// ==================== NEW ENDPOINTS ====================

// AdminDashboard returns aggregate counts for the admin dashboard.
func AdminDashboard(c *fiber.Ctx) error {
	ctx := context.Background()
	counts := fiber.Map{}

	tables := []struct {
		Key   string
		Query string
	}{
		{"total_users", "SELECT COUNT(*) FROM users"},
		{"total_conversations", "SELECT COUNT(*) FROM conversations"},
		{"total_messages", "SELECT COUNT(*) FROM messages"},
		{"total_memory", "SELECT COUNT(*) FROM memories"},
		{"total_goals", "SELECT COUNT(*) FROM goals"},
		{"total_heartbeat_runs", "SELECT COUNT(*) FROM heartbeat_runs"},
		{"total_tool_calls", "SELECT COUNT(*) FROM tool_logs"},
		{"total_bots", "SELECT COUNT(*) FROM bots"},
		{"total_tasks", "SELECT COUNT(*) FROM scheduled_tasks"},
		{"total_connections", "SELECT COUNT(*) FROM provider_connections"},
	}

	for _, t := range tables {
		var count int
		err := db.Pool.QueryRow(ctx, t.Query).Scan(&count)
		if err != nil {
			counts[t.Key] = 0
		} else {
			counts[t.Key] = count
		}
	}

	return c.JSON(counts)
}

// AdminSystemInfo returns runtime and system information.
func AdminSystemInfo(c *fiber.Ctx) error {
	ctx := context.Background()
	info := fiber.Map{
		"go_version":  runtime.Version(),
		"goroutines":  runtime.NumGoroutine(),
		"cpu_count":   runtime.NumCPU(),
		"uptime":      time.Since(startTime).String(),
		"uptime_secs": int(time.Since(startTime).Seconds()),
	}

	// Disk usage
	if out, err := exec.Command("df", "-h", "/data").Output(); err == nil {
		lines := strings.Split(strings.TrimSpace(string(out)), "\n")
		if len(lines) >= 2 {
			fields := strings.Fields(lines[1])
			if len(fields) >= 6 {
				info["disk"] = fiber.Map{
					"filesystem": fields[0],
					"size":       fields[1],
					"used":       fields[2],
					"available":  fields[3],
					"use_pct":    fields[4],
					"mount":      fields[5],
				}
			}
		}
	}

	// Memory usage
	if out, err := exec.Command("free", "-h").Output(); err == nil {
		lines := strings.Split(strings.TrimSpace(string(out)), "\n")
		if len(lines) >= 2 {
			fields := strings.Fields(lines[1])
			if len(fields) >= 7 {
				info["memory"] = fiber.Map{
					"total":     fields[1],
					"used":      fields[2],
					"free":      fields[3],
					"shared":    fields[4],
					"buff_cache": fields[5],
					"available": fields[6],
				}
			}
		}
	}

	// DB size
	var dbSize string
	if err := db.Pool.QueryRow(ctx, "SELECT pg_size_pretty(pg_database_size(current_database()))").Scan(&dbSize); err == nil {
		info["db_size"] = dbSize
	}

	// Pool stats
	stat := db.Pool.Stat()
	info["db_pool"] = fiber.Map{
		"total_conns":       stat.TotalConns(),
		"idle_conns":        stat.IdleConns(),
		"acquired_conns":    stat.AcquiredConns(),
		"max_conns":         stat.MaxConns(),
		"constructing_conns": stat.ConstructingConns(),
	}

	return c.JSON(info)
}

// AdminListUsersDetailed returns users with per-user statistics.
func AdminListUsersDetailed(c *fiber.Ctx) error {
	ctx := context.Background()
	rows, err := db.Pool.Query(ctx,
		`SELECT u.id, u.email, u.name, u.role, u.avatar_url, u.storage_used, u.storage_quota, u.created_at, u.updated_at,
			(SELECT COUNT(*) FROM conversations WHERE user_id = u.id) as conversation_count,
			(SELECT COUNT(*) FROM messages m JOIN conversations c ON m.conversation_id = c.id WHERE c.user_id = u.id) as message_count,
			(SELECT COUNT(*) FROM memories WHERE user_id = u.id) as memory_count,
			(SELECT COUNT(*) FROM goals WHERE user_id = u.id) as goal_count,
			(SELECT COALESCE(enabled, false) FROM heartbeat_config WHERE user_id = u.id LIMIT 1) as heartbeat_enabled
		FROM users u ORDER BY u.created_at DESC`)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": fmt.Sprintf("failed to fetch users: %v", err)})
	}
	defer rows.Close()

	var users []fiber.Map
	for rows.Next() {
		var id uuid.UUID
		var email, name, role string
		var avatarURL *string
		var storageUsed, storageQuota int64
		var createdAt, updatedAt interface{}
		var convCount, msgCount, memCount, goalCount int
		var heartbeatEnabled *bool
		if err := rows.Scan(&id, &email, &name, &role, &avatarURL, &storageUsed, &storageQuota,
			&createdAt, &updatedAt, &convCount, &msgCount, &memCount, &goalCount, &heartbeatEnabled); err != nil {
			continue
		}
		hb := false
		if heartbeatEnabled != nil {
			hb = *heartbeatEnabled
		}
		users = append(users, fiber.Map{
			"id":                 id,
			"email":              email,
			"name":               name,
			"role":               role,
			"avatar_url":         avatarURL,
			"storage_used":       storageUsed,
			"storage_quota":      storageQuota,
			"created_at":         createdAt,
			"updated_at":         updatedAt,
			"conversation_count": convCount,
			"message_count":      msgCount,
			"memory_count":       memCount,
			"goal_count":         goalCount,
			"heartbeat_enabled":  hb,
		})
	}
	if users == nil {
		users = []fiber.Map{}
	}
	return c.JSON(users)
}

// AdminCreateUser creates a new user with all required setup.
func AdminCreateUser(c *fiber.Ctx) error {
	var body struct {
		Email    string `json:"email"`
		Name     string `json:"name"`
		Password string `json:"password"`
		Role     string `json:"role"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request body"})
	}
	if body.Email == "" || body.Name == "" || body.Password == "" {
		return c.Status(400).JSON(fiber.Map{"error": "email, name, and password are required"})
	}
	if body.Role == "" {
		body.Role = "user"
	}
	validRoles := map[string]bool{"admin": true, "dev": true, "user": true}
	if !validRoles[body.Role] {
		return c.Status(400).JSON(fiber.Map{"error": "invalid role, must be admin, dev, or user"})
	}

	// Check duplicate email
	var exists int
	db.Pool.QueryRow(context.Background(), "SELECT COUNT(*) FROM users WHERE email = $1", body.Email).Scan(&exists)
	if exists > 0 {
		return c.Status(409).JSON(fiber.Map{"error": "email already exists"})
	}

	// Hash password
	hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to hash password"})
	}

	// Generate API key
	apiKey := "ahv_" + uuid.New().String()[:20]

	// Create user
	var userID uuid.UUID
	err = db.Pool.QueryRow(context.Background(),
		`INSERT INTO users (email, name, password_hash, role, api_key, storage_quota)
		VALUES ($1, $2, $3, $4, $5, 1073741824)
		RETURNING id`,
		body.Email, body.Name, string(hash), body.Role, apiKey).Scan(&userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": fmt.Sprintf("failed to create user: %v", err)})
	}

	// Create workspace directory
	wsDir := "/data/ahvclaw/workspaces/" + userID.String()
	_ = os.MkdirAll(wsDir, 0755)

	// Insert heartbeat_config (disabled by default)
	_, _ = db.Pool.Exec(context.Background(),
		`INSERT INTO heartbeat_config (user_id, enabled, interval_min)
		VALUES ($1, false, 5)
		ON CONFLICT (user_id) DO NOTHING`, userID)

	// Seed default trust entries for the new user
	if err := autonomous.SeedDefaultTrust(context.Background(), userID); err != nil {
		log.Printf("[admin] warning: failed to seed trust for user %s: %v", userID, err)
	}

	return c.Status(201).JSON(fiber.Map{
		"id":      userID,
		"email":   body.Email,
		"name":    body.Name,
		"role":    body.Role,
		"api_key": apiKey,
	})
}

// AdminUpdateUser updates user details (name, role, storage_quota, email).
func AdminUpdateUser(c *fiber.Ctx) error {
	targetID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid user ID"})
	}
	var body struct {
		Name         *string `json:"name"`
		Role         *string `json:"role"`
		Email        *string `json:"email"`
		StorageQuota *int64  `json:"storage_quota"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request body"})
	}

	sets := []string{}
	args := []interface{}{}
	argIdx := 1

	if body.Name != nil {
		sets = append(sets, fmt.Sprintf("name = $%d", argIdx))
		args = append(args, *body.Name)
		argIdx++
	}
	if body.Role != nil {
		validRoles := map[string]bool{"admin": true, "dev": true, "user": true}
		if !validRoles[*body.Role] {
			return c.Status(400).JSON(fiber.Map{"error": "invalid role"})
		}
		sets = append(sets, fmt.Sprintf("role = $%d", argIdx))
		args = append(args, *body.Role)
		argIdx++
	}
	if body.Email != nil {
		sets = append(sets, fmt.Sprintf("email = $%d", argIdx))
		args = append(args, *body.Email)
		argIdx++
	}
	if body.StorageQuota != nil {
		sets = append(sets, fmt.Sprintf("storage_quota = $%d", argIdx))
		args = append(args, *body.StorageQuota)
		argIdx++
	}

	if len(sets) == 0 {
		return c.Status(400).JSON(fiber.Map{"error": "no fields to update"})
	}

	sets = append(sets, "updated_at = NOW()")
	args = append(args, targetID)
	query := fmt.Sprintf("UPDATE users SET %s WHERE id = $%d", strings.Join(sets, ", "), argIdx)

	result, err := db.Pool.Exec(context.Background(), query, args...)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": fmt.Sprintf("failed to update user: %v", err)})
	}
	if result.RowsAffected() == 0 {
		return c.Status(404).JSON(fiber.Map{"error": "user not found"})
	}
	return c.JSON(fiber.Map{"message": "user updated"})
}

// AdminGetSettings returns all system_settings rows.
func AdminGetSettings(c *fiber.Ctx) error {
	rows, err := db.Pool.Query(context.Background(),
		"SELECT key, value, updated_at FROM system_settings ORDER BY key")
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": fmt.Sprintf("failed to fetch settings: %v", err)})
	}
	defer rows.Close()

	settings := fiber.Map{}
	for rows.Next() {
		var key, value string
		var updatedAt interface{}
		if err := rows.Scan(&key, &value, &updatedAt); err != nil {
			continue
		}
		settings[key] = fiber.Map{"value": value, "updated_at": updatedAt}
	}
	return c.JSON(settings)
}

// AdminUpdateSetting upserts a system_settings key/value.
func AdminUpdateSetting(c *fiber.Ctx) error {
	var body struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request body"})
	}
	if body.Key == "" {
		return c.Status(400).JSON(fiber.Map{"error": "key is required"})
	}

	_, err := db.Pool.Exec(context.Background(),
		`INSERT INTO system_settings (key, value, updated_at)
		VALUES ($1, $2, NOW())
		ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
		body.Key, body.Value)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": fmt.Sprintf("failed to update setting: %v", err)})
	}
	return c.JSON(fiber.Map{"message": "setting updated", "key": body.Key})
}

// AdminActivityLog returns recent tool_logs with user names.
func AdminActivityLog(c *fiber.Ctx) error {
	limitStr := c.Query("limit", "50")
	limit, err := strconv.Atoi(limitStr)
	if err != nil || limit <= 0 || limit > 500 {
		limit = 50
	}

	rows, err := db.Pool.Query(context.Background(),
		`SELECT tl.id, tl.user_id, u.name as user_name, tl.tool_name, tl.input::text, tl.output::text,
			tl.status, tl.duration_ms, tl.created_at, tl.source
		FROM tool_logs tl
		LEFT JOIN users u ON tl.user_id = u.id
		ORDER BY tl.created_at DESC
		LIMIT $1`, limit)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": fmt.Sprintf("failed to fetch activity: %v", err)})
	}
	defer rows.Close()

	var logs []fiber.Map
	for rows.Next() {
		var id uuid.UUID
		var userID uuid.UUID
		var userName *string
		var toolName string
		var input, output *string
		var status string
		var durationMs *int
		var createdAt interface{}
		var source *string
		if err := rows.Scan(&id, &userID, &userName, &toolName, &input, &output, &status, &durationMs, &createdAt, &source); err != nil {
			continue
		}
		logs = append(logs, fiber.Map{
			"id":          id,
			"user_id":     userID,
			"user_name":   userName,
			"tool_name":   toolName,
			"input":       input,
			"output":      output,
			"status":      status,
			"duration_ms": durationMs,
			"created_at":  createdAt,
			"source":      source,
		})
	}
	if logs == nil {
		logs = []fiber.Map{}
	}
	return c.JSON(logs)
}

// AdminHeartbeatStatus returns per-user heartbeat status.
func AdminHeartbeatStatus(c *fiber.Ctx) error {
	ctx := context.Background()
	rows, err := db.Pool.Query(ctx,
		`SELECT hc.user_id, u.name as user_name, hc.enabled, hc.interval_min,
			(SELECT COUNT(*) FROM heartbeat_runs WHERE user_id = hc.user_id) as run_count,
			(SELECT MAX(created_at) FROM heartbeat_runs WHERE user_id = hc.user_id) as last_run,
			(SELECT COUNT(*) FROM autonomous_actions WHERE user_id = hc.user_id AND status = 'executed') as actions_executed,
			(SELECT COUNT(*) FROM goals WHERE user_id = hc.user_id AND status = 'active') as active_goals
		FROM heartbeat_config hc
		JOIN users u ON hc.user_id = u.id
		ORDER BY u.name`)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": fmt.Sprintf("failed to fetch heartbeat status: %v", err)})
	}
	defer rows.Close()

	var statuses []fiber.Map
	for rows.Next() {
		var userID uuid.UUID
		var userName string
		var enabled bool
		var intervalMin int
		var runCount, actionsExecuted, activeGoals int
		var lastRun *time.Time
		if err := rows.Scan(&userID, &userName, &enabled, &intervalMin,
			&runCount, &lastRun, &actionsExecuted, &activeGoals); err != nil {
			continue
		}
		statuses = append(statuses, fiber.Map{
			"user_id":           userID,
			"user_name":         userName,
			"enabled":           enabled,
			"interval_minutes":  intervalMin,
			"run_count":         runCount,
			"last_run":          lastRun,
			"actions_executed":  actionsExecuted,
			"active_goals":     activeGoals,
		})
	}
	if statuses == nil {
		statuses = []fiber.Map{}
	}
	return c.JSON(statuses)
}

// AdminDBStats returns per-table row counts and sizes.
func AdminDBStats(c *fiber.Ctx) error {
	ctx := context.Background()
	rows, err := db.Pool.Query(ctx,
		`SELECT
			schemaname,
			relname as table_name,
			n_live_tup as row_count,
			pg_size_pretty(pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(relname))) as total_size,
			pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(relname)) as size_bytes
		FROM pg_stat_user_tables
		ORDER BY pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(relname)) DESC`)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": fmt.Sprintf("failed to fetch db stats: %v", err)})
	}
	defer rows.Close()

	var tables []fiber.Map
	var totalBytes int64
	for rows.Next() {
		var schema, tableName, totalSize string
		var rowCount int64
		var sizeBytes int64
		if err := rows.Scan(&schema, &tableName, &rowCount, &totalSize, &sizeBytes); err != nil {
			continue
		}
		totalBytes += sizeBytes
		tables = append(tables, fiber.Map{
			"schema":     schema,
			"table_name": tableName,
			"row_count":  rowCount,
			"total_size": totalSize,
			"size_bytes": sizeBytes,
		})
	}
	if tables == nil {
		tables = []fiber.Map{}
	}

	// DB total size
	var dbSize string
	db.Pool.QueryRow(ctx, "SELECT pg_size_pretty(pg_database_size(current_database()))").Scan(&dbSize)

	return c.JSON(fiber.Map{
		"tables":        tables,
		"total_bytes":   totalBytes,
		"database_size": dbSize,
	})
}

// AdminSecurityDashboard returns security invariants for the admin panel.
func AdminSecurityDashboard(c *fiber.Ctx) error {
	ctx := context.Background()
	var stats fiber.Map = fiber.Map{}

	// Denied autonomous actions
	var deniedActions int
	db.Pool.QueryRow(ctx, "SELECT COUNT(*) FROM autonomous_actions WHERE status IN ('block','ask','denied')").Scan(&deniedActions)
	stats["denied_actions"] = deniedActions

	// Trust escalations - low trust executions
	var escalations int
	db.Pool.QueryRow(ctx, "SELECT COUNT(*) FROM autonomous_actions WHERE status='executed' AND trust_score_at_time < 4").Scan(&escalations)
	stats["low_trust_executions"] = escalations

	// Stalled plans
	var stalledPlans int
	db.Pool.QueryRow(ctx, "SELECT COUNT(*) FROM execution_plans WHERE status IN ('blocked','failed')").Scan(&stalledPlans)
	stats["stalled_plans"] = stalledPlans

	// Active plans
	var activePlans int
	db.Pool.QueryRow(ctx, "SELECT COUNT(*) FROM execution_plans WHERE status IN ('pending','running')").Scan(&activePlans)
	stats["active_plans"] = activePlans

	// Embedding backlog (memories without embeddings)
	var backlog int
	db.Pool.QueryRow(ctx, "SELECT COUNT(*) FROM memories m LEFT JOIN memory_embeddings me ON me.memory_id=m.id WHERE me.id IS NULL").Scan(&backlog)
	stats["embedding_backlog"] = backlog

	// Reflection trend (last 7 days)
	rows, _ := db.Pool.Query(ctx,
		"SELECT date, performance_score FROM reflections WHERE created_at > now() - interval '7 days' ORDER BY date ASC")
	if rows != nil {
		defer rows.Close()
		var trend []fiber.Map
		for rows.Next() {
			var date string
			var score float64
			if rows.Scan(&date, &score) == nil {
				trend = append(trend, fiber.Map{"date": date, "score": score})
			}
		}
		stats["reflection_trend"] = trend
	}

	return c.JSON(stats)
}
