package handlers

import (
	"github.com/ahvholding/ahvclaw/memories"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func ListMemoryFiles(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	metas := memories.ListMemories(userID.String())

	type MemItem struct {
		Type     string `json:"type"`
		Key      string `json:"key"`
		Filename string `json:"filename"`
	}

	var result []MemItem
	for _, m := range metas {
		result = append(result, MemItem{Type: m.Type, Key: m.Key, Filename: m.Filename})
	}
	if result == nil {
		result = []MemItem{}
	}
	return c.JSON(result)
}

func GetMemoryFile(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	filename := c.Params("filename")

	m, err := memories.LoadMemory(userID.String(), filename)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "memory not found"})
	}

	return c.JSON(fiber.Map{
		"type":     m.Type,
		"key":      m.Key,
		"filename": m.Filename,
		"content":  m.Content,
	})
}

func UpdateMemoryFile(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	filename := c.Params("filename")

	var req struct {
		Content string `json:"content"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}

	m, err := memories.LoadMemory(userID.String(), filename)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "memory not found"})
	}

	m.Content = req.Content
	if err := memories.SaveMemoryFile(userID.String(), m); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to save"})
	}

	return c.JSON(fiber.Map{"filename": filename, "updated": true})
}

func DeleteMemoryFile(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	filename := c.Params("filename")

	if err := memories.DeleteMemoryFile(userID.String(), filename); err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "memory not found"})
	}

	return c.JSON(fiber.Map{"deleted": filename})
}
