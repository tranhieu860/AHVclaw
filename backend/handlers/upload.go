package handlers

import (
	"context"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/models"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

const maxUploadSize = 20 * 1024 * 1024 // 20MB
const uploadBasePath = "/data/ahvclaw/uploads"

var allowedMimeTypes = map[string]bool{
	// Images
	"image/jpeg":    true,
	"image/png":     true,
	"image/gif":     true,
	"image/webp":    true,
	"image/svg+xml": true,
	// Documents
	"application/pdf":    true,
	"text/plain":         true,
	"text/csv":           true,
	"text/markdown":      true,
	"application/json":   true,
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":   true,
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":         true,
	// Code files
	"text/html":                true,
	"text/css":                 true,
	"text/javascript":          true,
	"application/javascript":   true,
	"text/x-python":            true,
	"text/x-go":                true,
	"text/x-java":              true,
	"text/x-c":                 true,
	"text/x-c++":               true,
	"text/x-ruby":              true,
	"text/x-php":               true,
	"text/x-rust":              true,
	"text/x-shellscript":       true,
	"text/x-yaml":              true,
	"text/xml":                 true,
	"application/xml":          true,
	"application/octet-stream": true,
}

// allowedExtensions for fallback when mime type is generic
var allowedExtensions = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true, ".svg": true,
	".pdf": true, ".txt": true, ".csv": true, ".md": true, ".json": true,
	".docx": true, ".xlsx": true,
	".html": true, ".css": true, ".js": true, ".ts": true, ".tsx": true, ".jsx": true,
	".py": true, ".go": true, ".java": true, ".c": true, ".cpp": true, ".h": true,
	".rb": true, ".php": true, ".rs": true, ".sh": true, ".bash": true,
	".yaml": true, ".yml": true, ".xml": true, ".toml": true, ".ini": true,
	".sql": true, ".lua": true, ".swift": true, ".kt": true, ".scala": true,
	".r": true, ".m": true, ".vue": true, ".svelte": true,
}

func UploadFile(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	// Get file from multipart form
	fileHeader, err := c.FormFile("file")
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "file is required"})
	}

	// Check file size
	if fileHeader.Size > maxUploadSize {
		return c.Status(400).JSON(fiber.Map{"error": "file too large, max 20MB"})
	}

	// Validate file type
	ext := strings.ToLower(filepath.Ext(fileHeader.Filename))
	contentType := fileHeader.Header.Get("Content-Type")

	if !allowedMimeTypes[contentType] && !allowedExtensions[ext] {
		return c.Status(400).JSON(fiber.Map{"error": "file type not allowed"})
	}

	// Check user storage quota
	var storageQuota, storageUsed int64
	err = db.Pool.QueryRow(ctx,
		"SELECT COALESCE(storage_quota, 1073741824), COALESCE(storage_used, 0) FROM users WHERE id = $1",
		userID).Scan(&storageQuota, &storageUsed)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to check storage quota"})
	}
	if storageUsed+fileHeader.Size > storageQuota {
		return c.Status(400).JSON(fiber.Map{"error": "storage quota exceeded"})
	}

	// Generate unique filename
	fileID := uuid.New()
	filename := fileID.String() + ext
	userDir := filepath.Join(uploadBasePath, userID.String())

	// Create user directory if needed
	if err := os.MkdirAll(userDir, 0755); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to create upload directory"})
	}

	storagePath := filepath.Join(userDir, filename)

	// Save file
	if err := c.SaveFile(fileHeader, storagePath); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to save file"})
	}

	// Get image dimensions if applicable
	var width, height *int
	if strings.HasPrefix(contentType, "image/") && contentType != "image/svg+xml" {
		if w, h, err := getImageDimensions(storagePath); err == nil {
			width = &w
			height = &h
		}
	}

	// Extract text for text-based files
	var extractedText *string
	if isTextFile(contentType, ext) {
		if text, err := extractTextContent(storagePath, fileHeader.Size); err == nil && text != "" {
			extractedText = &text
		}
	}

	// Insert attachment record
	var att models.Attachment
	err = db.Pool.QueryRow(ctx,
		`INSERT INTO attachments (user_id, filename, original_name, mime_type, file_size, storage_path, extracted_text, width, height)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id, user_id, filename, original_name, mime_type, file_size, storage_path, extracted_text, width, height, created_at`,
		userID, filename, fileHeader.Filename, contentType, fileHeader.Size, storagePath, extractedText, width, height,
	).Scan(&att.ID, &att.UserID, &att.Filename, &att.OriginalName, &att.MimeType, &att.FileSize,
		&att.StoragePath, &att.ExtractedText, &att.Width, &att.Height, &att.CreatedAt)
	if err != nil {
		// Clean up file on DB error
		os.Remove(storagePath)
		return c.Status(500).JSON(fiber.Map{"error": "failed to save attachment record"})
	}

	// Update user storage_used
	db.Pool.Exec(ctx,
		"UPDATE users SET storage_used = COALESCE(storage_used, 0) + $1 WHERE id = $2",
		fileHeader.Size, userID)

	att.URL = fmt.Sprintf("/api/uploads/%s", att.ID.String())
	return c.Status(201).JSON(att)
}

func ServeUpload(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	role, _ := c.Locals("role").(string)
	ctx := context.Background()

	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid attachment id"})
	}

	var att models.Attachment
	err = db.Pool.QueryRow(ctx,
		"SELECT id, user_id, filename, original_name, mime_type, file_size, storage_path FROM attachments WHERE id = $1",
		id).Scan(&att.ID, &att.UserID, &att.Filename, &att.OriginalName, &att.MimeType, &att.FileSize, &att.StoragePath)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "attachment not found"})
	}

	// Check ownership (owner or admin)
	if att.UserID != userID && role != "admin" {
		return c.Status(403).JSON(fiber.Map{"error": "forbidden"})
	}

	c.Set("Content-Type", att.MimeType)
	c.Set("Content-Disposition", fmt.Sprintf("inline; filename=\"%s\"", att.OriginalName))
	return c.SendFile(att.StoragePath)
}

func DeleteUpload(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	role, _ := c.Locals("role").(string)
	ctx := context.Background()

	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid attachment id"})
	}

	var att models.Attachment
	err = db.Pool.QueryRow(ctx,
		"SELECT id, user_id, file_size, storage_path FROM attachments WHERE id = $1",
		id).Scan(&att.ID, &att.UserID, &att.FileSize, &att.StoragePath)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "attachment not found"})
	}

	// Check ownership
	if att.UserID != userID && role != "admin" {
		return c.Status(403).JSON(fiber.Map{"error": "forbidden"})
	}

	// Delete from DB
	_, err = db.Pool.Exec(ctx, "DELETE FROM attachments WHERE id = $1", id)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to delete attachment"})
	}

	// Delete file from disk
	os.Remove(att.StoragePath)

	// Update storage_used
	db.Pool.Exec(ctx,
		"UPDATE users SET storage_used = GREATEST(COALESCE(storage_used, 0) - $1, 0) WHERE id = $2",
		att.FileSize, att.UserID)

	return c.JSON(fiber.Map{"message": "attachment deleted"})
}

// getImageDimensions returns width and height for an image file
func getImageDimensions(path string) (int, int, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()

	config, _, err := image.DecodeConfig(f)
	if err != nil {
		return 0, 0, err
	}
	return config.Width, config.Height, nil
}

// isTextFile checks if the file is a text-based file
func isTextFile(mimeType, ext string) bool {
	if strings.HasPrefix(mimeType, "text/") {
		return true
	}
	textExts := map[string]bool{
		".txt": true, ".csv": true, ".md": true, ".json": true,
		".html": true, ".css": true, ".js": true, ".ts": true, ".tsx": true, ".jsx": true,
		".py": true, ".go": true, ".java": true, ".c": true, ".cpp": true, ".h": true,
		".rb": true, ".php": true, ".rs": true, ".sh": true, ".bash": true,
		".yaml": true, ".yml": true, ".xml": true, ".toml": true, ".ini": true,
		".sql": true, ".lua": true, ".swift": true, ".kt": true, ".scala": true,
		".vue": true, ".svelte": true,
	}
	return textExts[ext]
}

// extractTextContent reads text content from a file (up to 1MB)
func extractTextContent(path string, fileSize int64) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	// Limit text extraction to 1MB
	limit := fileSize
	if limit > 1024*1024 {
		limit = 1024 * 1024
	}

	data, err := io.ReadAll(io.LimitReader(f, limit))
	if err != nil {
		return "", err
	}
	return string(data), nil
}
