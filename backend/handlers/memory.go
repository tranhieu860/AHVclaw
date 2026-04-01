package handlers

import (
	"context"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/models"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func ListMemories(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	memType := c.Query("type")

	ctx := context.Background()

	if memType != "" {
		return listMemoriesByType(c, ctx, userID, memType)
	}
	return listAllMemories(c, ctx, userID)
}

func listAllMemories(c *fiber.Ctx, ctx context.Context, userID uuid.UUID) error {
	rows, err := db.Pool.Query(ctx,
		"SELECT id, user_id, type, key, content, source_conversation_id, created_at, updated_at FROM memories WHERE user_id = $1 ORDER BY updated_at DESC",
		userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch memories"})
	}
	defer rows.Close()

	var memories []models.Memory
	for rows.Next() {
		var m models.Memory
		if err := rows.Scan(&m.ID, &m.UserID, &m.Type, &m.Key, &m.Content, &m.SourceConversationID, &m.CreatedAt, &m.UpdatedAt); err != nil {
			continue
		}
		memories = append(memories, m)
	}
	if memories == nil {
		memories = []models.Memory{}
	}
	return c.JSON(memories)
}

func listMemoriesByType(c *fiber.Ctx, ctx context.Context, userID uuid.UUID, memType string) error {
	rows, err := db.Pool.Query(ctx,
		"SELECT id, user_id, type, key, content, source_conversation_id, created_at, updated_at FROM memories WHERE user_id = $1 AND type = $2 ORDER BY updated_at DESC",
		userID, memType)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch memories"})
	}
	defer rows.Close()

	var memories []models.Memory
	for rows.Next() {
		var m models.Memory
		if err := rows.Scan(&m.ID, &m.UserID, &m.Type, &m.Key, &m.Content, &m.SourceConversationID, &m.CreatedAt, &m.UpdatedAt); err != nil {
			continue
		}
		memories = append(memories, m)
	}
	if memories == nil {
		memories = []models.Memory{}
	}
	return c.JSON(memories)
}

func CreateMemory(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	var req models.MemoryCreateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}
	if req.Type == "" || req.Key == "" || req.Content == "" {
		return c.Status(400).JSON(fiber.Map{"error": "type, key, and content are required"})
	}

	validTypes := map[string]bool{"profile": true, "preference": true, "knowledge": true, "correction": true}
	if !validTypes[req.Type] {
		return c.Status(400).JSON(fiber.Map{"error": "type must be one of: profile, preference, knowledge, correction"})
	}

	var m models.Memory
	err := db.Pool.QueryRow(context.Background(),
		"INSERT INTO memories (user_id, type, key, content) VALUES ($1, $2, $3, $4) RETURNING id, user_id, type, key, content, source_conversation_id, created_at, updated_at",
		userID, req.Type, req.Key, req.Content,
	).Scan(&m.ID, &m.UserID, &m.Type, &m.Key, &m.Content, &m.SourceConversationID, &m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to create memory"})
	}

	return c.Status(201).JSON(m)
}

func UpdateMemory(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	memID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid memory ID"})
	}

	var req models.MemoryUpdateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}

	var m models.Memory
	err = db.Pool.QueryRow(context.Background(),
		"UPDATE memories SET content = $1, updated_at = now() WHERE id = $2 AND user_id = $3 RETURNING id, user_id, type, key, content, source_conversation_id, created_at, updated_at",
		req.Content, memID, userID,
	).Scan(&m.ID, &m.UserID, &m.Type, &m.Key, &m.Content, &m.SourceConversationID, &m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "memory not found"})
	}

	return c.JSON(m)
}

func DeleteMemory(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	memID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid memory ID"})
	}

	result, err := db.Pool.Exec(context.Background(),
		"DELETE FROM memories WHERE id = $1 AND user_id = $2", memID, userID)
	if err != nil || result.RowsAffected() == 0 {
		return c.Status(404).JSON(fiber.Map{"error": "memory not found"})
	}

	return c.JSON(fiber.Map{"deleted": true})
}

func SearchMemories(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	var req models.MemorySearchRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}
	if req.Query == "" {
		return c.Status(400).JSON(fiber.Map{"error": "query is required"})
	}
	if req.Limit <= 0 || req.Limit > 50 {
		req.Limit = 20
	}

	ctx := context.Background()
	searchPattern := "%" + req.Query + "%"

	if req.Type != "" {
		return searchMemoriesByType(c, ctx, userID, req.Type, searchPattern, req.Limit)
	}
	return searchAllMemories(c, ctx, userID, searchPattern, req.Limit)
}

func searchAllMemories(c *fiber.Ctx, ctx context.Context, userID uuid.UUID, pattern string, limit int) error {
	rows, err := db.Pool.Query(ctx,
		"SELECT id, user_id, type, key, content, source_conversation_id, created_at, updated_at FROM memories WHERE user_id = $1 AND (key ILIKE $2 OR content ILIKE $2) ORDER BY updated_at DESC LIMIT $3",
		userID, pattern, limit)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "search failed"})
	}
	defer rows.Close()

	var memories []models.Memory
	for rows.Next() {
		var m models.Memory
		if err := rows.Scan(&m.ID, &m.UserID, &m.Type, &m.Key, &m.Content, &m.SourceConversationID, &m.CreatedAt, &m.UpdatedAt); err != nil {
			continue
		}
		memories = append(memories, m)
	}
	if memories == nil {
		memories = []models.Memory{}
	}
	return c.JSON(memories)
}

func searchMemoriesByType(c *fiber.Ctx, ctx context.Context, userID uuid.UUID, memType string, pattern string, limit int) error {
	rows, err := db.Pool.Query(ctx,
		"SELECT id, user_id, type, key, content, source_conversation_id, created_at, updated_at FROM memories WHERE user_id = $1 AND type = $2 AND (key ILIKE $3 OR content ILIKE $3) ORDER BY updated_at DESC LIMIT $4",
		userID, memType, pattern, limit)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "search failed"})
	}
	defer rows.Close()

	var memories []models.Memory
	for rows.Next() {
		var m models.Memory
		if err := rows.Scan(&m.ID, &m.UserID, &m.Type, &m.Key, &m.Content, &m.SourceConversationID, &m.CreatedAt, &m.UpdatedAt); err != nil {
			continue
		}
		memories = append(memories, m)
	}
	if memories == nil {
		memories = []models.Memory{}
	}
	return c.JSON(memories)
}
