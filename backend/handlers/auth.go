package handlers

import (
	"context"
	"strings"
	"time"

	"github.com/ahvholding/ahvclaw/auth"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/models"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

func Register(c *fiber.Ctx) error {
	var req models.RegisterRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}
	if req.Email == "" || req.Password == "" || req.Name == "" {
		return c.Status(400).JSON(fiber.Map{"error": "email, password, and name are required"})
	}

	if len(req.Email) > 255 || !strings.Contains(req.Email, "@") || !strings.Contains(req.Email, ".") {
		return c.Status(400).JSON(fiber.Map{"error": "invalid email format"})
	}
	if len(req.Password) < 8 {
		return c.Status(400).JSON(fiber.Map{"error": "password must be at least 8 characters"})
	}
	if len(req.Password) > 72 {
		return c.Status(400).JSON(fiber.Map{"error": "password must be at most 72 characters"})
	}
	if len(req.Name) > 255 {
		return c.Status(400).JSON(fiber.Map{"error": "name too long"})
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "internal error"})
	}

	apiKey, _ := auth.GenerateAPIKey()

	// First registered user becomes admin — use transaction to prevent race condition
	tx, txErr := db.Pool.Begin(context.Background())
	if txErr != nil {
		return c.Status(500).JSON(fiber.Map{"error": "internal error"})
	}
	defer tx.Rollback(context.Background())

	var count int
	tx.QueryRow(context.Background(), "SELECT COUNT(*) FROM users").Scan(&count)
	role := "user"
	if count == 0 {
		role = "admin"
	}

	var user models.User
	err = tx.QueryRow(context.Background(),
		"INSERT INTO users (email, password_hash, name, role, api_key) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name, role, avatar_url, api_key, settings, created_at, updated_at",
		req.Email, string(hash), req.Name, role, apiKey,
	).Scan(&user.ID, &user.Email, &user.Name, &user.Role, &user.AvatarURL,
		&user.APIKey, &user.Settings, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		return c.Status(409).JSON(fiber.Map{"error": "email already exists"})
	}

	if err := tx.Commit(context.Background()); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "internal error"})
	}

	return respondWithTokens(c, user)
}

func Login(c *fiber.Ctx) error {
	var req models.LoginRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}

	var user models.User
	err := db.Pool.QueryRow(context.Background(),
		"SELECT id, email, password_hash, name, role, avatar_url, api_key, settings, created_at, updated_at FROM users WHERE email = $1", req.Email,
	).Scan(&user.ID, &user.Email, &user.PasswordHash, &user.Name, &user.Role,
		&user.AvatarURL, &user.APIKey, &user.Settings, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		return c.Status(401).JSON(fiber.Map{"error": "invalid credentials"})
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
		return c.Status(401).JSON(fiber.Map{"error": "invalid credentials"})
	}

	return respondWithTokens(c, user)
}

func RefreshToken(c *fiber.Ctx) error {
	var body struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}

	var userID uuid.UUID
	var expiresAt time.Time
	err := db.Pool.QueryRow(context.Background(),
		"SELECT user_id, expires_at FROM sessions WHERE refresh_token = $1", body.RefreshToken,
	).Scan(&userID, &expiresAt)
	if err != nil || time.Now().After(expiresAt) {
		return c.Status(401).JSON(fiber.Map{"error": "invalid or expired refresh token"})
	}

	var user models.User
	err = db.Pool.QueryRow(context.Background(),
		"SELECT id, email, name, role, avatar_url, api_key, settings, created_at, updated_at FROM users WHERE id = $1", userID,
	).Scan(&user.ID, &user.Email, &user.Name, &user.Role, &user.AvatarURL,
		&user.APIKey, &user.Settings, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		return c.Status(401).JSON(fiber.Map{"error": "user not found"})
	}

	_, _ = db.Pool.Exec(context.Background(),
		"DELETE FROM sessions WHERE refresh_token = $1", body.RefreshToken)

	return respondWithTokens(c, user)
}

func GetMe(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	var user models.User
	err := db.Pool.QueryRow(context.Background(),
		"SELECT id, email, name, role, avatar_url, api_key, settings, created_at, updated_at FROM users WHERE id = $1", userID,
	).Scan(&user.ID, &user.Email, &user.Name, &user.Role, &user.AvatarURL,
		&user.APIKey, &user.Settings, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "user not found"})
	}
	return c.JSON(user)
}

func respondWithTokens(c *fiber.Ctx, user models.User) error {
	accessToken, err := auth.GenerateAccessToken(user.ID, user.Role)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "token generation failed"})
	}

	refreshToken, err := auth.GenerateRefreshToken()
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "token generation failed"})
	}

	_, _ = db.Pool.Exec(context.Background(),
		"INSERT INTO sessions (user_id, refresh_token, expires_at) VALUES ($1, $2, $3)",
		user.ID, refreshToken, time.Now().Add(7*24*time.Hour))

	return c.JSON(models.AuthResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		User:         user,
	})
}
