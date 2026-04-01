package handlers

import (
	"context"
	"fmt"
	"strings"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/models"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func ListContacts(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()
	search := strings.TrimSpace(c.Query("search"))
	tag := strings.TrimSpace(c.Query("tag"))

	query := "SELECT id, user_id, name, avatar_url, tags, notes, metadata, first_seen_at, last_seen_at, created_at, updated_at FROM contacts WHERE user_id = $1"
	args := []interface{}{userID}
	argIdx := 2

	if search != "" {
		query += fmt.Sprintf(" AND (name ILIKE $%d)", argIdx)
		args = append(args, "%"+search+"%")
		argIdx++
	}
	if tag != "" {
		query += fmt.Sprintf(" AND $%d = ANY(tags)", argIdx)
		args = append(args, tag)
		argIdx++
	}
	_ = argIdx

	query += " ORDER BY last_seen_at DESC"

	rows, err := db.Pool.Query(ctx, query, args...)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch contacts"})
	}
	defer rows.Close()

	var contacts []models.Contact
	for rows.Next() {
		var ct models.Contact
		if err := rows.Scan(&ct.ID, &ct.UserID, &ct.Name, &ct.AvatarURL, &ct.Tags, &ct.Notes, &ct.Metadata,
			&ct.FirstSeenAt, &ct.LastSeenAt, &ct.CreatedAt, &ct.UpdatedAt); err != nil {
			continue
		}
		contacts = append(contacts, ct)
	}
	if contacts == nil {
		contacts = []models.Contact{}
	}
	return c.JSON(contacts)
}

func GetContact(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	contactID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	ctx := context.Background()

	var ct models.Contact
	err = db.Pool.QueryRow(ctx,
		"SELECT id, user_id, name, avatar_url, tags, notes, metadata, first_seen_at, last_seen_at, created_at, updated_at FROM contacts WHERE id = $1 AND user_id = $2",
		contactID, userID).Scan(
		&ct.ID, &ct.UserID, &ct.Name, &ct.AvatarURL, &ct.Tags, &ct.Notes, &ct.Metadata,
		&ct.FirstSeenAt, &ct.LastSeenAt, &ct.CreatedAt, &ct.UpdatedAt)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "contact not found"})
	}

	chRows, err := db.Pool.Query(ctx,
		"SELECT id, contact_id, channel, channel_user_id, channel_username, metadata FROM contact_channels WHERE contact_id = $1", contactID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch channels"})
	}
	defer chRows.Close()

	var channels []models.ContactChannel
	for chRows.Next() {
		var ch models.ContactChannel
		if err := chRows.Scan(&ch.ID, &ch.ContactID, &ch.Channel, &ch.ChannelUserID, &ch.ChannelUsername, &ch.Metadata); err != nil {
			continue
		}
		channels = append(channels, ch)
	}
	if channels == nil {
		channels = []models.ContactChannel{}
	}

	return c.JSON(models.ContactDetail{Contact: ct, Channels: channels})
}

func UpdateContact(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	contactID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	var req models.ContactUpdateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}

	ctx := context.Background()
	var ct models.Contact
	err = db.Pool.QueryRow(ctx,
		"UPDATE contacts SET name = COALESCE($3, name), tags = COALESCE($4, tags), notes = COALESCE($5, notes), metadata = COALESCE($6, metadata), updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING id, user_id, name, avatar_url, tags, notes, metadata, first_seen_at, last_seen_at, created_at, updated_at",
		contactID, userID, req.Name, req.Tags, req.Notes, req.Metadata).Scan(
		&ct.ID, &ct.UserID, &ct.Name, &ct.AvatarURL, &ct.Tags, &ct.Notes, &ct.Metadata,
		&ct.FirstSeenAt, &ct.LastSeenAt, &ct.CreatedAt, &ct.UpdatedAt)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "contact not found"})
	}
	return c.JSON(ct)
}

func DeleteContact(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	contactID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}

	ctx := context.Background()
	tag, err := db.Pool.Exec(ctx, "DELETE FROM contacts WHERE id = $1 AND user_id = $2", contactID, userID)
	if err != nil || tag.RowsAffected() == 0 {
		return c.Status(404).JSON(fiber.Map{"error": "contact not found"})
	}
	return c.JSON(fiber.Map{"deleted": true})
}

func MergeContacts(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	var req models.ContactMergeRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}
	if req.SourceID == req.TargetID {
		return c.Status(400).JSON(fiber.Map{"error": "source and target must be different"})
	}

	ctx := context.Background()
	var count int
	err := db.Pool.QueryRow(ctx,
		"SELECT COUNT(*) FROM contacts WHERE id IN ($1, $2) AND user_id = $3",
		req.SourceID, req.TargetID, userID).Scan(&count)
	if err != nil || count != 2 {
		return c.Status(404).JSON(fiber.Map{"error": "one or both contacts not found"})
	}

	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to start transaction"})
	}
	defer tx.Rollback(ctx)

	// Move channel links from source to target
	if _, err = tx.Exec(ctx, "UPDATE contact_channels SET contact_id = $1 WHERE contact_id = $2", req.TargetID, req.SourceID); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to merge channels"})
	}
	// Move conversations from source to target
	if _, err = tx.Exec(ctx, "UPDATE channel_conversations SET contact_id = $1 WHERE contact_id = $2", req.TargetID, req.SourceID); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to merge conversations"})
	}
	// Delete source contact
	if _, err = tx.Exec(ctx, "DELETE FROM contacts WHERE id = $1", req.SourceID); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to delete source contact"})
	}
	// Update target timestamp
	if _, err = tx.Exec(ctx, "UPDATE contacts SET updated_at = now() WHERE id = $1", req.TargetID); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to update target"})
	}

	if err := tx.Commit(ctx); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to commit merge"})
	}

	return c.JSON(fiber.Map{"merged": true, "target_id": req.TargetID})
}
