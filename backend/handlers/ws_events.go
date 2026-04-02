package handlers

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gofiber/contrib/websocket"
	"github.com/google/uuid"
)

// Event is the payload broadcast to connected clients.
type Event struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

// EventHub tracks WebSocket connections per user and broadcasts events.
type EventHub struct {
	mu    sync.RWMutex
	conns map[string]map[*websocket.Conn]bool
}

// Hub is the global EventHub instance.
var Hub = &EventHub{
	conns: make(map[string]map[*websocket.Conn]bool),
}

// Register adds a WebSocket connection for the given userID.
func (h *EventHub) Register(userID string, conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.conns[userID] == nil {
		h.conns[userID] = make(map[*websocket.Conn]bool)
	}
	h.conns[userID][conn] = true
	log.Printf("[event-hub] registered conn for user %s (total=%d)", userID, len(h.conns[userID]))
}

// Unregister removes a WebSocket connection for the given userID.
func (h *EventHub) Unregister(userID string, conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if conns, ok := h.conns[userID]; ok {
		delete(conns, conn)
		if len(conns) == 0 {
			delete(h.conns, userID)
		}
	}
	log.Printf("[event-hub] unregistered conn for user %s", userID)
}

// BroadcastToUser marshals the event as JSON and sends it to all connections for the given userID.
func (h *EventHub) BroadcastToUser(userID string, event Event) {
	h.mu.RLock()
	conns := h.conns[userID]
	// Copy to avoid holding lock during writes
	targets := make([]*websocket.Conn, 0, len(conns))
	for c := range conns {
		targets = append(targets, c)
	}
	h.mu.RUnlock()

	if len(targets) == 0 {
		return
	}

	payload, err := json.Marshal(event)
	if err != nil {
		log.Printf("[event-hub] marshal error: %v", err)
		return
	}

	for _, c := range targets {
		if err := c.WriteMessage(websocket.TextMessage, payload); err != nil {
			log.Printf("[event-hub] write error for user %s: %v", userID, err)
			h.Unregister(userID, c)
		}
	}
}

// WSEvents is the Fiber WebSocket handler for /ws/events.
// It authenticates via ticket (same as /ws/chat), registers the connection,
// and keeps the connection alive by reading ping/pong messages.
func WSEvents() func(*websocket.Conn) {
	return func(conn *websocket.Conn) {
		userID, ok := conn.Locals("user_id").(uuid.UUID)
		if !ok || userID == uuid.Nil {
			log.Printf("[event-hub] WSEvents: missing user_id local")
			conn.Close()
			return
		}

		uid := userID.String()
		Hub.Register(uid, conn)
		defer func() {
			Hub.Unregister(uid, conn)
			conn.Close()
		}()

		// Set read deadline for keep-alive pings
		conn.SetReadDeadline(time.Now().Add(5 * time.Minute))
		conn.SetPongHandler(func(string) error {
			conn.SetReadDeadline(time.Now().Add(5 * time.Minute))
			return nil
		})

		// Read loop — clients may send pings or we just wait for close
		for {
			_, _, err := conn.ReadMessage()
			if err != nil {
				break
			}
			// Reset deadline on any message
			conn.SetReadDeadline(time.Now().Add(5 * time.Minute))
		}
	}
}
