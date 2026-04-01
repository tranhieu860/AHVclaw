package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

type wsTicket struct {
	UserID    uuid.UUID
	Role      string
	ExpiresAt time.Time
}

var (
	ticketStore = make(map[string]*wsTicket)
	ticketMu    sync.Mutex
)

// CreateWSTicket generates a short-lived single-use ticket for WebSocket auth
func CreateWSTicket(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	role, _ := c.Locals("role").(string)

	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to generate ticket"})
	}
	ticket := hex.EncodeToString(b)

	ticketMu.Lock()
	ticketStore[ticket] = &wsTicket{
		UserID:    userID,
		Role:      role,
		ExpiresAt: time.Now().Add(30 * time.Second),
	}
	ticketMu.Unlock()

	// Cleanup old tickets periodically
	go cleanupTickets()

	return c.JSON(fiber.Map{"ticket": ticket})
}

// ValidateWSTicket validates and consumes a WebSocket ticket (single-use)
func ValidateWSTicket(ticket string) (uuid.UUID, string, bool) {
	ticketMu.Lock()
	defer ticketMu.Unlock()

	t, ok := ticketStore[ticket]
	if !ok || time.Now().After(t.ExpiresAt) {
		delete(ticketStore, ticket)
		return uuid.Nil, "", false
	}

	// Single-use: delete after validation
	delete(ticketStore, ticket)
	return t.UserID, t.Role, true
}

func cleanupTickets() {
	ticketMu.Lock()
	defer ticketMu.Unlock()
	now := time.Now()
	for k, v := range ticketStore {
		if now.After(v.ExpiresAt) {
			delete(ticketStore, k)
		}
	}
}
