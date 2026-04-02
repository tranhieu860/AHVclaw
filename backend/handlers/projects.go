package handlers

import (
	"context"
	"io"
	"mime/multipart"
	"os"
	"path/filepath"
	"strings"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/models"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func ListProjects(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	rows, err := db.Pool.Query(ctx,
		`SELECT id, user_id, name, description, instructions, icon, is_archived, created_at, updated_at
		 FROM projects
		 WHERE user_id = $1 AND is_archived = false
		 ORDER BY updated_at DESC`,
		userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to list projects"})
	}
	defer rows.Close()

	var projects []models.Project
	for rows.Next() {
		var p models.Project
		if err := rows.Scan(&p.ID, &p.UserID, &p.Name, &p.Description, &p.Instructions, &p.Icon, &p.IsArchived, &p.CreatedAt, &p.UpdatedAt); err != nil {
			continue
		}
		projects = append(projects, p)
	}
	if projects == nil {
		projects = []models.Project{}
	}
	return c.JSON(projects)
}

func CreateProject(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	var req models.CreateProjectRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request body"})
	}
	if strings.TrimSpace(req.Name) == "" {
		return c.Status(400).JSON(fiber.Map{"error": "name is required"})
	}
	if req.Icon == "" {
		req.Icon = "📁"
	}

	var p models.Project
	err := db.Pool.QueryRow(ctx,
		`INSERT INTO projects (user_id, name, description, instructions, icon)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id, user_id, name, description, instructions, icon, is_archived, created_at, updated_at`,
		userID, req.Name, req.Description, req.Instructions, req.Icon,
	).Scan(&p.ID, &p.UserID, &p.Name, &p.Description, &p.Instructions, &p.Icon, &p.IsArchived, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to create project"})
	}
	return c.Status(201).JSON(p)
}

func GetProject(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	projectID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid project id"})
	}

	var p models.Project
	err = db.Pool.QueryRow(ctx,
		`SELECT id, user_id, name, description, instructions, icon, is_archived, created_at, updated_at
		 FROM projects WHERE id = $1 AND user_id = $2`,
		projectID, userID,
	).Scan(&p.ID, &p.UserID, &p.Name, &p.Description, &p.Instructions, &p.Icon, &p.IsArchived, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "project not found"})
	}

	fileRows, err := db.Pool.Query(ctx,
		`SELECT id, project_id, filename, file_path, file_size, mime_type, created_at
		 FROM project_files WHERE project_id = $1 ORDER BY created_at ASC`,
		projectID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to load files"})
	}
	defer fileRows.Close()

	var files []models.ProjectFile
	for fileRows.Next() {
		var f models.ProjectFile
		if err := fileRows.Scan(&f.ID, &f.ProjectID, &f.Filename, &f.FilePath, &f.FileSize, &f.MimeType, &f.CreatedAt); err != nil {
			continue
		}
		files = append(files, f)
	}
	if files == nil {
		files = []models.ProjectFile{}
	}

	return c.JSON(fiber.Map{
		"project": p,
		"files":   files,
	})
}

func UpdateProject(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	projectID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid project id"})
	}

	var req models.UpdateProjectRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request body"})
	}

	var p models.Project
	err = db.Pool.QueryRow(ctx,
		`UPDATE projects SET
		   name         = COALESCE($3, name),
		   description  = COALESCE($4, description),
		   instructions = COALESCE($5, instructions),
		   icon         = COALESCE($6, icon),
		   is_archived  = COALESCE($7, is_archived),
		   updated_at   = now()
		 WHERE id = $1 AND user_id = $2
		 RETURNING id, user_id, name, description, instructions, icon, is_archived, created_at, updated_at`,
		projectID, userID,
		req.Name, req.Description, req.Instructions, req.Icon, req.IsArchived,
	).Scan(&p.ID, &p.UserID, &p.Name, &p.Description, &p.Instructions, &p.Icon, &p.IsArchived, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "project not found"})
	}
	return c.JSON(p)
}

func DeleteProject(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	projectID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid project id"})
	}

	tag, err := db.Pool.Exec(ctx,
		`UPDATE projects SET is_archived = true, updated_at = now()
		 WHERE id = $1 AND user_id = $2`,
		projectID, userID)
	if err != nil || tag.RowsAffected() == 0 {
		return c.Status(404).JSON(fiber.Map{"error": "project not found"})
	}
	return c.JSON(fiber.Map{"message": "project archived"})
}

func UploadProjectFile(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	projectID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid project id"})
	}

	var ownerID uuid.UUID
	err = db.Pool.QueryRow(ctx, "SELECT user_id FROM projects WHERE id = $1", projectID).Scan(&ownerID)
	if err != nil || ownerID != userID {
		return c.Status(404).JSON(fiber.Map{"error": "project not found"})
	}

	fh, err := c.FormFile("file")
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "file is required"})
	}

	dir := "/data/ahvclaw/projects/" + projectID.String()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to create storage directory"})
	}

	filename := filepath.Base(fh.Filename)
	storagePath := filepath.Join(dir, filename)

	src, err := fh.Open()
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to open uploaded file"})
	}
	defer func(src multipart.File) { _ = src.Close() }(src)

	dst, err := os.Create(storagePath)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to save file"})
	}
	defer func(dst *os.File) { _ = dst.Close() }(dst)

	if _, err := io.Copy(dst, src); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to write file"})
	}

	mimeType := fh.Header.Get("Content-Type")
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}

	ext := strings.ToLower(filepath.Ext(filename))
	var extractedText *string
	if isTextFile(mimeType, ext) {
		data, readErr := os.ReadFile(storagePath)
		if readErr == nil {
			text := string(data)
			runes := []rune(text)
			if len(runes) > 50000 {
				text = string(runes[:50000])
			}
			extractedText = &text
		}
	}

	var f models.ProjectFile
	err = db.Pool.QueryRow(ctx,
		`INSERT INTO project_files (project_id, filename, content, file_path, file_size, mime_type)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id, project_id, filename, file_path, file_size, mime_type, created_at`,
		projectID, filename, extractedText, storagePath, fh.Size, mimeType,
	).Scan(&f.ID, &f.ProjectID, &f.Filename, &f.FilePath, &f.FileSize, &f.MimeType, &f.CreatedAt)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to save file record"})
	}
	return c.Status(201).JSON(f)
}

func DeleteProjectFile(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	ctx := context.Background()

	projectID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid project id"})
	}
	fileID, err := uuid.Parse(c.Params("fileId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid file id"})
	}

	var ownerID uuid.UUID
	err = db.Pool.QueryRow(ctx, "SELECT user_id FROM projects WHERE id = $1", projectID).Scan(&ownerID)
	if err != nil || ownerID != userID {
		return c.Status(404).JSON(fiber.Map{"error": "project not found"})
	}

	var storagePath *string
	err = db.Pool.QueryRow(ctx,
		"SELECT file_path FROM project_files WHERE id = $1 AND project_id = $2",
		fileID, projectID,
	).Scan(&storagePath)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "file not found"})
	}

	_, err = db.Pool.Exec(ctx,
		"DELETE FROM project_files WHERE id = $1 AND project_id = $2",
		fileID, projectID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to delete file record"})
	}

	if storagePath != nil && *storagePath != "" {
		_ = os.Remove(*storagePath)
	}

	return c.JSON(fiber.Map{"message": "file deleted"})
}
