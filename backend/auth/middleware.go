package auth

import (
	"context"
	"strings"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func Middleware() fiber.Handler {
	return func(c *fiber.Ctx) error {
		header := c.Get("Authorization")

		// Try Bearer token
		if strings.HasPrefix(header, "Bearer ") {
			tokenStr := strings.TrimPrefix(header, "Bearer ")
			claims, err := ParseAccessToken(tokenStr)
			if err == nil {
				c.Locals("user_id", claims.UserID)
				c.Locals("role", claims.Role)
				return c.Next()
			}
		}

		// Try API key
		apiKey := header
		if apiKey == "" {
			apiKey = c.Get("X-API-Key")
		}
		if strings.HasPrefix(apiKey, "ahv_") {
			var userID uuid.UUID
			var role string
			err := db.Pool.QueryRow(context.Background(),
				"SELECT id, role FROM users WHERE api_key = $1", apiKey).Scan(&userID, &role)
			if err == nil {
				c.Locals("user_id", userID)
				c.Locals("role", role)
				return c.Next()
			}
		}

		return c.Status(401).JSON(fiber.Map{"error": "unauthorized"})
	}
}

func RequireRole(roles ...string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		role, _ := c.Locals("role").(string)
		for _, r := range roles {
			if role == r {
				return c.Next()
			}
		}
		return c.Status(403).JSON(fiber.Map{"error": "forbidden"})
	}
}
