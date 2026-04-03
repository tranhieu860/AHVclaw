package handlers

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/ahvholding/ahvclaw/skills"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func ListSkillFiles(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	meta := skills.ListSkills(userID.String())

	type SkillItem struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Source      string `json:"source"`
	}

	var result []SkillItem
	for _, m := range meta {
		result = append(result, SkillItem{Name: m.Name, Description: m.Description, Source: m.Source})
	}

	if result == nil {
		result = []SkillItem{}
	}
	return c.JSON(result)
}

func GetSkillFile(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	slug := c.Params("slug")

	s, err := skills.LoadSkill(userID.String(), slug)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "skill not found"})
	}

	return c.JSON(fiber.Map{
		"name":            s.Name,
		"description":     s.Description,
		"max_tool_rounds": s.MaxToolRounds,
		"body":            s.Body,
		"path":            s.Path,
	})
}

func CreateSkillFile(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)

	var req struct {
		Slug    string `json:"slug"`
		Content string `json:"content"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}
	if req.Slug == "" || req.Content == "" {
		return c.Status(400).JSON(fiber.Map{"error": "slug and content required"})
	}
	if !skills.IsValidSlug(req.Slug) {
		return c.Status(400).JSON(fiber.Map{"error": "invalid slug"})
	}

	dir := filepath.Join(skills.UserSkillsBase, userID.String(), "skills", req.Slug)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to create directory"})
	}

	path := filepath.Join(dir, "SKILL.md")
	if err := os.WriteFile(path, []byte(req.Content), 0644); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to write file"})
	}

	return c.Status(201).JSON(fiber.Map{"slug": req.Slug, "path": path})
}

func UpdateSkillFile(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	slug := c.Params("slug")

	var req struct {
		Content string `json:"content"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}

	path := filepath.Join(skills.UserSkillsBase, userID.String(), "skills", slug, "SKILL.md")
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return c.Status(404).JSON(fiber.Map{"error": "user skill not found — fork it first"})
	}

	if err := os.WriteFile(path, []byte(req.Content), 0644); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to write file"})
	}

	return c.JSON(fiber.Map{"slug": slug, "path": path})
}

func DeleteSkillFile(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	slug := c.Params("slug")

	dir := filepath.Join(skills.UserSkillsBase, userID.String(), "skills", slug)
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		return c.Status(404).JSON(fiber.Map{"error": "user skill not found"})
	}

	if err := os.RemoveAll(dir); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to delete skill"})
	}

	return c.JSON(fiber.Map{"deleted": slug})
}

func ForkSkill(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	slug := c.Params("slug")

	srcPath := filepath.Join(skills.SystemSkillsDir, slug, "SKILL.md")
	data, err := os.ReadFile(srcPath)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "system skill not found"})
	}

	dstDir := filepath.Join(skills.UserSkillsBase, userID.String(), "skills", slug)
	if err := os.MkdirAll(dstDir, 0755); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to create directory"})
	}

	dstPath := filepath.Join(dstDir, "SKILL.md")
	if err := os.WriteFile(dstPath, data, 0644); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to write file"})
	}

	return c.JSON(fiber.Map{
		"slug":    slug,
		"path":    dstPath,
		"forked":  true,
		"message": fmt.Sprintf("Forked %s to your workspace.", slug),
	})
}
