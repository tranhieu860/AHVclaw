package handlers

import (
	"context"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/models"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func ListSkills(c *fiber.Ctx) error {
	ctx := context.Background()

	rows, err := db.Pool.Query(ctx,
		"SELECT id, name, slug, description, version, author_id, config, is_public, installs_count, created_at, updated_at FROM skills ORDER BY created_at DESC")
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch skills"})
	}
	defer rows.Close()

	var skills []models.Skill
	for rows.Next() {
		var s models.Skill
		if err := rows.Scan(&s.ID, &s.Name, &s.Slug, &s.Description, &s.Version, &s.AuthorID, &s.Config, &s.IsPublic, &s.InstallsCount, &s.CreatedAt, &s.UpdatedAt); err != nil {
			continue
		}
		skills = append(skills, s)
	}
	if skills == nil {
		skills = []models.Skill{}
	}
	return c.JSON(skills)
}

func CreateSkill(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	var req models.SkillCreateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}
	if req.Name == "" || req.Slug == "" {
		return c.Status(400).JSON(fiber.Map{"error": "name and slug are required"})
	}
	if req.Config == "" {
		req.Config = "{}"
	}

	ctx := context.Background()
	var s models.Skill
	desc := &req.Description
	if req.Description == "" {
		desc = nil
	}
	err := db.Pool.QueryRow(ctx,
		`INSERT INTO skills (name, slug, description, author_id, config, is_public)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, name, slug, description, version, author_id, config, is_public, installs_count, created_at, updated_at`,
		req.Name, req.Slug, desc, userID, req.Config, req.IsPublic).Scan(
		&s.ID, &s.Name, &s.Slug, &s.Description, &s.Version, &s.AuthorID, &s.Config, &s.IsPublic, &s.InstallsCount, &s.CreatedAt, &s.UpdatedAt)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to create skill: " + err.Error()})
	}
	return c.Status(201).JSON(s)
}
