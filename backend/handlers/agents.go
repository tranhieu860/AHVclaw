package handlers

import (
	"context"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/models"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func ListAgents(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	rows, err := db.Pool.Query(ctx,
		`SELECT id, user_id, name, avatar_url, model, system_prompt, memory_scope, is_public, created_at, updated_at
		FROM agents WHERE user_id = $1 OR is_public = true
		ORDER BY created_at DESC`, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch agents"})
	}
	defer rows.Close()

	var agents []models.Agent
	for rows.Next() {
		var a models.Agent
		if err := rows.Scan(&a.ID, &a.UserID, &a.Name, &a.AvatarURL, &a.Model, &a.SystemPrompt, &a.MemoryScope, &a.IsPublic, &a.CreatedAt, &a.UpdatedAt); err != nil {
			continue
		}
		agents = append(agents, a)
	}
	if agents == nil {
		agents = []models.Agent{}
	}
	return c.JSON(agents)
}

func CreateAgent(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	var req models.AgentCreateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}
	if req.Name == "" || req.Model == "" || req.SystemPrompt == "" {
		return c.Status(400).JSON(fiber.Map{"error": "name, model, and system_prompt are required"})
	}
	if req.MemoryScope == "" {
		req.MemoryScope = "shared"
	}

	ctx := context.Background()
	var a models.Agent
	err := db.Pool.QueryRow(ctx,
		`INSERT INTO agents (user_id, name, model, system_prompt, memory_scope, is_public)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, user_id, name, avatar_url, model, system_prompt, memory_scope, is_public, created_at, updated_at`,
		userID, req.Name, req.Model, req.SystemPrompt, req.MemoryScope, req.IsPublic).Scan(
		&a.ID, &a.UserID, &a.Name, &a.AvatarURL, &a.Model, &a.SystemPrompt, &a.MemoryScope, &a.IsPublic, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to create agent: " + err.Error()})
	}
	return c.Status(201).JSON(a)
}

func GetAgent(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	agentID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}

	ctx := context.Background()
	var a models.Agent
	err = db.Pool.QueryRow(ctx,
		`SELECT id, user_id, name, avatar_url, model, system_prompt, memory_scope, is_public, created_at, updated_at
		FROM agents WHERE id = $1 AND (user_id = $2 OR is_public = true)`,
		agentID, userID).Scan(
		&a.ID, &a.UserID, &a.Name, &a.AvatarURL, &a.Model, &a.SystemPrompt, &a.MemoryScope, &a.IsPublic, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "agent not found"})
	}
	return c.JSON(a)
}
