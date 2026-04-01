package handlers

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/models"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

// Knowledge Bases

func ListKnowledgeBases(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	rows, err := db.Pool.Query(ctx,
		"SELECT id, user_id, name, description, created_at FROM knowledge_bases WHERE user_id = $1 ORDER BY created_at DESC", userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch knowledge bases"})
	}
	defer rows.Close()

	var kbs []models.KnowledgeBase
	for rows.Next() {
		var kb models.KnowledgeBase
		if err := rows.Scan(&kb.ID, &kb.UserID, &kb.Name, &kb.Description, &kb.CreatedAt); err != nil {
			continue
		}
		kbs = append(kbs, kb)
	}
	if kbs == nil {
		kbs = []models.KnowledgeBase{}
	}
	return c.JSON(kbs)
}

func CreateKnowledgeBase(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	var req models.KBCreateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}
	if req.Name == "" {
		return c.Status(400).JSON(fiber.Map{"error": "name is required"})
	}

	ctx := context.Background()
	var kb models.KnowledgeBase
	desc := &req.Description
	if req.Description == "" {
		desc = nil
	}
	err := db.Pool.QueryRow(ctx,
		"INSERT INTO knowledge_bases (user_id, name, description) VALUES ($1, $2, $3) RETURNING id, user_id, name, description, created_at",
		userID, req.Name, desc).Scan(&kb.ID, &kb.UserID, &kb.Name, &kb.Description, &kb.CreatedAt)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to create knowledge base"})
	}
	return c.Status(201).JSON(kb)
}

func DeleteKnowledgeBase(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	kbID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}

	ctx := context.Background()
	tag, err := db.Pool.Exec(ctx,
		"DELETE FROM knowledge_bases WHERE id = $1 AND user_id = $2", kbID, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to delete"})
	}
	if tag.RowsAffected() == 0 {
		return c.Status(404).JSON(fiber.Map{"error": "not found"})
	}
	return c.JSON(fiber.Map{"deleted": true})
}

// Documents

func ListDocuments(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	kbID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}

	ctx := context.Background()
	var ownerID uuid.UUID
	err = db.Pool.QueryRow(ctx, "SELECT user_id FROM knowledge_bases WHERE id = $1", kbID).Scan(&ownerID)
	if err != nil || ownerID != userID {
		return c.Status(404).JSON(fiber.Map{"error": "knowledge base not found"})
	}

	rows, err := db.Pool.Query(ctx,
		"SELECT id, kb_id, filename, content_hash, file_size, chunks_count, created_at FROM documents WHERE kb_id = $1 ORDER BY created_at DESC", kbID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch documents"})
	}
	defer rows.Close()

	var docs []models.Document
	for rows.Next() {
		var d models.Document
		if err := rows.Scan(&d.ID, &d.KbID, &d.Filename, &d.ContentHash, &d.FileSize, &d.ChunksCount, &d.CreatedAt); err != nil {
			continue
		}
		docs = append(docs, d)
	}
	if docs == nil {
		docs = []models.Document{}
	}
	return c.JSON(docs)
}

func CreateDocument(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	kbID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}

	var req models.DocumentCreateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}
	if req.Filename == "" || req.Content == "" {
		return c.Status(400).JSON(fiber.Map{"error": "filename and content are required"})
	}

	ctx := context.Background()
	var ownerID uuid.UUID
	err = db.Pool.QueryRow(ctx, "SELECT user_id FROM knowledge_bases WHERE id = $1", kbID).Scan(&ownerID)
	if err != nil || ownerID != userID {
		return c.Status(404).JSON(fiber.Map{"error": "knowledge base not found"})
	}

	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(req.Content)))
	size := int64(len(req.Content))
	chunks := chunkText(req.Content, 500)
	chunksCount := len(chunks)

	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to start transaction"})
	}
	defer tx.Rollback(ctx)

	var doc models.Document
	err = tx.QueryRow(ctx,
		"INSERT INTO documents (kb_id, filename, content_hash, file_size, chunks_count) VALUES ($1, $2, $3, $4, $5) RETURNING id, kb_id, filename, content_hash, file_size, chunks_count, created_at",
		kbID, req.Filename, hash, size, chunksCount).Scan(&doc.ID, &doc.KbID, &doc.Filename, &doc.ContentHash, &doc.FileSize, &doc.ChunksCount, &doc.CreatedAt)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to create document"})
	}

	for i, chunk := range chunks {
		_, err = tx.Exec(ctx,
			"INSERT INTO chunks (document_id, content, position) VALUES ($1, $2, $3)",
			doc.ID, chunk, i)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "failed to store chunks"})
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to commit"})
	}

	return c.Status(201).JSON(doc)
}

func SearchKnowledgeBase(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	kbID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}

	var req models.KBSearchRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}
	if req.Query == "" {
		return c.Status(400).JSON(fiber.Map{"error": "query is required"})
	}
	if req.Limit <= 0 || req.Limit > 20 {
		req.Limit = 5
	}

	ctx := context.Background()
	var ownerID uuid.UUID
	err = db.Pool.QueryRow(ctx, "SELECT user_id FROM knowledge_bases WHERE id = $1", kbID).Scan(&ownerID)
	if err != nil || ownerID != userID {
		return c.Status(404).JSON(fiber.Map{"error": "knowledge base not found"})
	}

	pattern := "%" + strings.ReplaceAll(req.Query, "%", "") + "%"
	rows, err := db.Pool.Query(ctx,
		`SELECT c.id, c.content, c.position, d.filename
		FROM chunks c
		JOIN documents d ON d.id = c.document_id
		WHERE d.kb_id = $1 AND c.content ILIKE $2
		ORDER BY c.position
		LIMIT $3`, kbID, pattern, req.Limit)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "search failed"})
	}
	defer rows.Close()

	type SearchResult struct {
		ID       uuid.UUID `json:"id"`
		Content  string    `json:"content"`
		Position int       `json:"position"`
		Filename string    `json:"filename"`
	}
	var results []SearchResult
	for rows.Next() {
		var r SearchResult
		if err := rows.Scan(&r.ID, &r.Content, &r.Position, &r.Filename); err != nil {
			continue
		}
		results = append(results, r)
	}
	if results == nil {
		results = []SearchResult{}
	}
	return c.JSON(results)
}

// SearchKnowledgeBaseTool is used by the AI tool executor
func SearchKnowledgeBaseTool(userID, kbID uuid.UUID, query string, limit int) ([]map[string]interface{}, error) {
	ctx := context.Background()

	var ownerID uuid.UUID
	err := db.Pool.QueryRow(ctx, "SELECT user_id FROM knowledge_bases WHERE id = $1", kbID).Scan(&ownerID)
	if err != nil || ownerID != userID {
		return nil, fmt.Errorf("knowledge base not found")
	}

	if limit <= 0 || limit > 20 {
		limit = 5
	}

	pattern := "%" + strings.ReplaceAll(query, "%", "") + "%"
	rows, err := db.Pool.Query(ctx,
		`SELECT c.content, c.position, d.filename
		FROM chunks c
		JOIN documents d ON d.id = c.document_id
		WHERE d.kb_id = $1 AND c.content ILIKE $2
		ORDER BY c.position
		LIMIT $3`, kbID, pattern, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []map[string]interface{}
	for rows.Next() {
		var content, filename string
		var position int
		if err := rows.Scan(&content, &position, &filename); err != nil {
			continue
		}
		results = append(results, map[string]interface{}{
			"content":  content,
			"position": position,
			"filename": filename,
		})
	}
	if results == nil {
		results = []map[string]interface{}{}
	}
	return results, nil
}

func chunkText(text string, maxLen int) []string {
	var chunks []string
	paragraphs := strings.Split(text, "\n\n")
	current := ""
	for _, p := range paragraphs {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if len(current)+len(p)+2 > maxLen && current != "" {
			chunks = append(chunks, strings.TrimSpace(current))
			current = p
		} else {
			if current != "" {
				current += "\n\n"
			}
			current += p
		}
	}
	if strings.TrimSpace(current) != "" {
		chunks = append(chunks, strings.TrimSpace(current))
	}
	if len(chunks) == 0 {
		chunks = append(chunks, text)
	}
	return chunks
}
