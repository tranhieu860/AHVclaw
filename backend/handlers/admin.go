package handlers

import (
	"context"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

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
