package handlers

import (
	"context"

	"github.com/ahvholding/ahvclaw/crypto"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/models"
	"fmt"
	"os"
	"strings"
	sshpkg "github.com/ahvholding/ahvclaw/ssh"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func ListServers(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	rows, err := db.Pool.Query(context.Background(),
		`SELECT id, user_id, name, host, port, username, auth_type, environment, tags, last_connected_at, created_at
		 FROM servers WHERE user_id = $1 ORDER BY name`, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to list servers"})
	}
	defer rows.Close()

	var servers []models.Server
	for rows.Next() {
		var s models.Server
		if err := rows.Scan(&s.ID, &s.UserID, &s.Name, &s.Host, &s.Port, &s.Username,
			&s.AuthType, &s.Environment, &s.Tags, &s.LastConnectedAt, &s.CreatedAt); err != nil {
			continue
		}
		servers = append(servers, s)
	}
	if servers == nil {
		servers = []models.Server{}
	}
	return c.JSON(servers)
}

func CreateServer(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	var req models.ServerCreateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}
	if req.Name == "" || req.Host == "" || req.Credentials == "" {
		return c.Status(400).JSON(fiber.Map{"error": "name, host, and credentials are required"})
	}
	if req.Port == 0 {
		req.Port = 22
	}
	if req.Username == "" {
		req.Username = "root"
	}
	if req.AuthType == "" {
		req.AuthType = "password"
	}
	if req.Environment == "" {
		req.Environment = "dev"
	}

	// Encrypt credentials before storing
	encryptedCreds, err := crypto.Encrypt(req.Credentials)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "encryption failed"})
	}

	var s models.Server
	err = db.Pool.QueryRow(context.Background(),
		`INSERT INTO servers (user_id, name, host, port, username, auth_type, credentials_encrypted, environment, tags)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 RETURNING id, user_id, name, host, port, username, auth_type, environment, tags, last_connected_at, created_at`,
		userID, req.Name, req.Host, req.Port, req.Username, req.AuthType, encryptedCreds, req.Environment, req.Tags,
	).Scan(&s.ID, &s.UserID, &s.Name, &s.Host, &s.Port, &s.Username, &s.AuthType, &s.Environment, &s.Tags, &s.LastConnectedAt, &s.CreatedAt)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to create server: " + err.Error()})
	}

	go SyncServersToFile(userID)
	return c.Status(201).JSON(s)
}

func DeleteServer(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	serverID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid server ID"})
	}

	result, err := db.Pool.Exec(context.Background(),
		"DELETE FROM servers WHERE id = $1 AND user_id = $2", serverID, userID)
	if err != nil || result.RowsAffected() == 0 {
		return c.Status(404).JSON(fiber.Map{"error": "server not found"})
	}

	go SyncServersToFile(userID)
	return c.JSON(fiber.Map{"deleted": true})
}

func ServerExec(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	serverID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid server ID"})
	}

	var req models.ServerExecRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}
	if req.Command == "" {
		return c.Status(400).JSON(fiber.Map{"error": "command is required"})
	}

	var host, username, credentials string
	var port int
	err = db.Pool.QueryRow(context.Background(),
		"SELECT host, port, username, credentials_encrypted FROM servers WHERE id = $1 AND user_id = $2",
		serverID, userID).Scan(&host, &port, &username, &credentials)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "server not found"})
	}

	// Decrypt credentials
	decryptedCreds, err := crypto.Decrypt(credentials)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "decryption failed"})
	}

	client := sshpkg.NewClient(host, port, username, decryptedCreds)
	output, exitCode, err := client.Execute(req.Command)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}

	_, _ = db.Pool.Exec(context.Background(),
		"UPDATE servers SET last_connected_at = now() WHERE id = $1", serverID)

	_, _ = db.Pool.Exec(context.Background(),
		"INSERT INTO audit_logs (user_id, server_id, command, output, exit_code) VALUES ($1, $2, $3, $4, $5)",
		userID, serverID, req.Command, output, exitCode)

	return c.JSON(models.ServerExecResponse{Output: output, ExitCode: exitCode})
}

func ServerStatus(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	serverID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid server ID"})
	}

	var host, username, credentials string
	var port int
	err = db.Pool.QueryRow(context.Background(),
		"SELECT host, port, username, credentials_encrypted FROM servers WHERE id = $1 AND user_id = $2",
		serverID, userID).Scan(&host, &port, &username, &credentials)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "server not found"})
	}

	// Decrypt credentials
	decryptedCreds, err := crypto.Decrypt(credentials)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "decryption failed"})
	}

	client := sshpkg.NewClient(host, port, username, decryptedCreds)
	status, err := client.GetStatus()
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}

	_, _ = db.Pool.Exec(context.Background(),
		"UPDATE servers SET last_connected_at = now() WHERE id = $1", serverID)

	return c.JSON(fiber.Map{"status": status})
}

// ServerConversation returns or creates the conversation linked to a server.
func ServerConversation(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	serverID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid server ID"})
	}

	// Verify server ownership
	var serverName, serverHost, serverEnv string
	var serverPort int
	err = db.Pool.QueryRow(context.Background(),
		"SELECT name, host, port, environment FROM servers WHERE id = $1 AND user_id = $2",
		serverID, userID).Scan(&serverName, &serverHost, &serverPort, &serverEnv)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "server not found"})
	}

	// Find existing conversation for this server
	var convID uuid.UUID
	var convTitle *string
	err = db.Pool.QueryRow(context.Background(),
		"SELECT id, title FROM conversations WHERE user_id = $1 AND server_id = $2 ORDER BY updated_at DESC LIMIT 1",
		userID, serverID).Scan(&convID, &convTitle)

	if err != nil {
		// Create new conversation for this server
		convID = uuid.New()
		title := serverName + " (" + serverHost + ")"
		_, err = db.Pool.Exec(context.Background(),
			"INSERT INTO conversations (id, user_id, server_id, title, model) VALUES ($1, $2, $3, $4, $5)",
			convID, userID, serverID, title, "AHV-Holding-TroLy")
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "failed to create conversation: " + err.Error()})
		}
		convTitle = &title
	}

	return c.JSON(fiber.Map{
		"conversation_id": convID,
		"title":           convTitle,
		"server": fiber.Map{
			"id":          serverID,
			"name":        serverName,
			"host":        serverHost,
			"port":        serverPort,
			"environment": serverEnv,
		},
	})
}


// SyncServersToFile writes the user's server list to /data/ahvclaw/users/{userID}/servers.md
// so the AI bot can read and reference it proactively.
func SyncServersToFile(userID uuid.UUID) {
	rows, err := db.Pool.Query(context.Background(),
		"SELECT id, name, host, port, username, environment, tags FROM servers WHERE user_id = $1 ORDER BY name", userID)
	if err != nil {
		return
	}
	defer rows.Close()

	var sb strings.Builder
	sb.WriteString("# Servers\n\n")
	sb.WriteString("Danh sách máy chủ được quản lý. Bot có thể đọc, thêm, sửa, xóa file này.\n\n")

	count := 0
	for rows.Next() {
		var id uuid.UUID
		var name, host, username, env string
		var port int
		var tags *string
		if rows.Scan(&id, &name, &host, &port, &username, &env, &tags) != nil {
			continue
		}
		count++
		sb.WriteString(fmt.Sprintf("## %s\n\n", name))
		sb.WriteString(fmt.Sprintf("- **Host:** %s\n", host))
		sb.WriteString(fmt.Sprintf("- **Port:** %d\n", port))
		sb.WriteString(fmt.Sprintf("- **User:** %s\n", username))
		sb.WriteString(fmt.Sprintf("- **Environment:** %s\n", env))
		if tags != nil && *tags != "" {
			sb.WriteString(fmt.Sprintf("- **Tags:** %s\n", *tags))
		}
		sb.WriteString(fmt.Sprintf("- **ID:** %s\n", id.String()))
		sb.WriteString("\n")
	}

	if count == 0 {
		sb.WriteString("_Chưa có server nào được đăng ký._\n")
	}

	dir := fmt.Sprintf("/data/ahvclaw/users/%s", userID.String())
	os.MkdirAll(dir, 0755)
	os.WriteFile(fmt.Sprintf("%s/servers.md", dir), []byte(sb.String()), 0644)
}
