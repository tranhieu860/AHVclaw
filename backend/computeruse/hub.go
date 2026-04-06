package computeruse

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/gofiber/contrib/websocket"
	"github.com/google/uuid"
)

type CUCommand struct {
	ID     string          `json:"id"`
	Action string          `json:"action"`
	Params json.RawMessage `json:"params"`
}

type CUResult struct {
	ID     string          `json:"id"`
	Status string          `json:"status"`
	Data   json.RawMessage `json:"data"`
	Error  string          `json:"error,omitempty"`
}

type CUEvent struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data,omitempty"`
}

// HelperHello is the initial handshake message sent by the Native Helper.
type HelperHello struct {
	Type          string `json:"type"` // "helper_hello"
	UserID        string `json:"user_id"`
	DeviceID      string `json:"device_id"`
	HelperVersion string `json:"helper_version"`
	Signature     string `json:"signature"`
	SignedPayload string `json:"signed_payload"`
}

// CompanionCommand is a session-bound command sent to the Native Helper.
type CompanionCommand struct {
	ID        string          `json:"id"`
	SessionID string          `json:"session_id"`
	UserID    string          `json:"user_id"`
	Seq       int64           `json:"seq"`
	ExpiresAt string          `json:"expires_at"`
	Action    string          `json:"action"`
	Params    json.RawMessage `json:"params"`
}

type cuConnection struct {
	conn    *websocket.Conn
	pending map[string]chan *CUResult
	mu      sync.Mutex
}

type CUHub struct {
	mu    sync.RWMutex
	conns map[string]*cuConnection
}

var Hub = &CUHub{
	conns: make(map[string]*cuConnection),
}

func (h *CUHub) IsOnline(userID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	_, ok := h.conns[userID]
	return ok
}

// SendCommand sends a legacy CUCommand and waits up to 30s for a CUResult.
// Kept for backward compatibility.
func (h *CUHub) SendCommand(userID string, cmd CUCommand) (*CUResult, error) {
	h.mu.RLock()
	cu, ok := h.conns[userID]
	h.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("extension not connected")
	}

	resultCh := make(chan *CUResult, 1)
	cu.mu.Lock()
	cu.pending[cmd.ID] = resultCh
	cu.mu.Unlock()

	defer func() {
		cu.mu.Lock()
		delete(cu.pending, cmd.ID)
		cu.mu.Unlock()
	}()

	payload, _ := json.Marshal(cmd)
	if err := cu.conn.WriteMessage(websocket.TextMessage, payload); err != nil {
		return nil, err
	}

	select {
	case result := <-resultCh:
		return result, nil
	case <-time.After(30 * time.Second):
		return nil, fmt.Errorf("extension command timed out")
	}
}

// SendCompanionCommand sends a session-bound CompanionCommand and waits up to 45s for a CUResult.
// It looks up the active session for the user, increments the sequence number, and sets ExpiresAt.
func (h *CUHub) SendCompanionCommand(userID string, action string, params json.RawMessage) (*CUResult, error) {
	h.mu.RLock()
	cu, ok := h.conns[userID]
	h.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("extension not connected")
	}

	uid, err := uuid.Parse(userID)
	if err != nil {
		return nil, fmt.Errorf("invalid user_id: %w", err)
	}

	sess := Sessions.GetByUser(uid)
	if sess == nil {
		return nil, fmt.Errorf("no active session for user")
	}

	expiresAt := time.Now().Add(30 * time.Second)
	cmdID := uuid.New().String()

	sess.mu.Lock()
	sess.Seq++
	seq := sess.Seq
	sess.mu.Unlock()

	cmd := CompanionCommand{
		ID:        cmdID,
		SessionID: sess.ID,
		UserID:    userID,
		Seq:       seq,
		ExpiresAt: expiresAt.UTC().Format(time.RFC3339),
		Action:    action,
		Params:    params,
	}

	resultCh := make(chan *CUResult, 1)
	cu.mu.Lock()
	cu.pending[cmdID] = resultCh
	cu.mu.Unlock()

	defer func() {
		cu.mu.Lock()
		delete(cu.pending, cmdID)
		cu.mu.Unlock()
	}()

	payload, _ := json.Marshal(cmd)
	if err := cu.conn.WriteMessage(websocket.TextMessage, payload); err != nil {
		return nil, err
	}

	select {
	case result := <-resultCh:
		return result, nil
	case <-time.After(45 * time.Second):
		return nil, fmt.Errorf("companion command timed out")
	}
}

func (h *CUHub) Register(userID string, conn *websocket.Conn) *cuConnection {
	h.mu.Lock()
	defer h.mu.Unlock()
	if old, ok := h.conns[userID]; ok {
		old.conn.Close()
	}
	cu := &cuConnection{
		conn:    conn,
		pending: make(map[string]chan *CUResult),
	}
	h.conns[userID] = cu
	log.Printf("[computer-use] extension connected for user %s", userID)
	return cu
}

func (h *CUHub) Unregister(userID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.conns, userID)
	log.Printf("[computer-use] extension disconnected for user %s", userID)
}

// HandleMessage processes an incoming WebSocket message. Returns true if handled as a result.
func HandleMessage(cu *cuConnection, msg []byte) (isResult bool) {
	var result CUResult
	if json.Unmarshal(msg, &result) == nil && result.ID != "" {
		cu.mu.Lock()
		if ch, ok := cu.pending[result.ID]; ok {
			ch <- &result
		}
		cu.mu.Unlock()
		return true
	}
	return false
}

// ParseEvent tries to parse a message as a CUEvent. Returns the event and true if successful.
func ParseEvent(msg []byte) (*CUEvent, bool) {
	var event CUEvent
	if json.Unmarshal(msg, &event) == nil && event.Type != "" {
		return &event, true
	}
	return nil, false
}

// writeJSON is a helper to marshal and send a JSON message over a WebSocket connection.
func writeJSON(conn *websocket.Conn, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		log.Printf("[computer-use] writeJSON marshal error: %v", err)
		return
	}
	if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
		log.Printf("[computer-use] writeJSON write error: %v", err)
	}
}

// handleHelperHello processes a helper_hello handshake message.
func handleHelperHello(conn *websocket.Conn, uid uuid.UUID, msg []byte) {
	var hello HelperHello
	if err := json.Unmarshal(msg, &hello); err != nil {
		writeJSON(conn, map[string]string{"type": "hello_rejected", "error": "invalid hello payload"})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	grant, err := GetActiveGrant(ctx, uid, hello.DeviceID)
	if err != nil {
		log.Printf("[computer-use] hello_rejected for user %s device %s: %v", uid, hello.DeviceID, err)
		writeJSON(conn, map[string]string{"type": "hello_rejected", "error": err.Error()})
		return
	}

	payload := []byte(hello.SignedPayload)
	if err := VerifyHelloSignature(grant.PublicKey, payload, hello.Signature); err != nil {
		log.Printf("[computer-use] hello_rejected signature for user %s: %v", uid, err)
		writeJSON(conn, map[string]string{"type": "hello_rejected", "error": "signature verification failed"})
		return
	}

	sess := Sessions.Create(uid, hello.DeviceID)
	log.Printf("[computer-use] hello_accepted for user %s session %s", uid, sess.ID)
	writeJSON(conn, map[string]any{
		"type":       "hello_accepted",
		"session_id": sess.ID,
		"expires_at": sess.ExpiresAt.UTC().Format(time.RFC3339),
	})
}

// handleSessionRenew processes a session_renew message.
func handleSessionRenew(conn *websocket.Conn, uid uuid.UUID, msg []byte) {
	var req struct {
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal(msg, &req); err != nil || req.SessionID == "" {
		writeJSON(conn, map[string]string{"type": "renew_rejected", "error": "invalid renew payload"})
		return
	}

	sess := Sessions.Get(req.SessionID)
	if sess == nil {
		writeJSON(conn, map[string]string{"type": "renew_rejected", "error": "session not found or expired"})
		return
	}
	if sess.UserID != uid {
		writeJSON(conn, map[string]string{"type": "renew_rejected", "error": "session user mismatch"})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if _, err := GetActiveGrant(ctx, uid, sess.DeviceID); err != nil {
		log.Printf("[computer-use] renew_rejected grant check for user %s: %v", uid, err)
		writeJSON(conn, map[string]string{"type": "renew_rejected", "error": err.Error()})
		return
	}

	if err := Sessions.Renew(req.SessionID); err != nil {
		writeJSON(conn, map[string]string{"type": "renew_rejected", "error": err.Error()})
		return
	}

	// Re-fetch to get the updated ExpiresAt.
	updated := Sessions.Get(req.SessionID)
	if updated == nil {
		writeJSON(conn, map[string]string{"type": "renew_rejected", "error": "session expired after renew"})
		return
	}

	log.Printf("[computer-use] renew_accepted for user %s session %s", uid, req.SessionID)
	writeJSON(conn, map[string]any{
		"type":       "renew_accepted",
		"session_id": req.SessionID,
		"expires_at": updated.ExpiresAt.UTC().Format(time.RFC3339),
	})
}

// WSHandler creates a WebSocket handler function.
// broadcastFn is called for page_changed/tab_changed events.
// statusFn is called on connect/disconnect with (userID, online bool).
func WSHandler(broadcastFn func(userID string, msg []byte), statusFn func(userID string, online bool)) func(*websocket.Conn) {
	return func(conn *websocket.Conn) {
		userID, ok := conn.Locals("user_id").(uuid.UUID)
		if !ok || userID == uuid.Nil {
			log.Printf("[computer-use] missing user_id")
			conn.Close()
			return
		}

		uid := userID.String()
		cu := Hub.Register(uid, conn)
		if statusFn != nil {
			statusFn(uid, true)
		}
		defer func() {
			Hub.Unregister(uid)
			if statusFn != nil {
				statusFn(uid, false)
			}
			conn.Close()
		}()

		conn.SetReadDeadline(time.Now().Add(2 * time.Minute))
		conn.SetPongHandler(func(string) error {
			conn.SetReadDeadline(time.Now().Add(2 * time.Minute))
			return nil
		})

		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				break
			}
			conn.SetReadDeadline(time.Now().Add(2 * time.Minute))

			// Peek at the message type before full parsing.
			var peek struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(msg, &peek) == nil {
				switch peek.Type {
				case "helper_hello":
					handleHelperHello(conn, userID, msg)
					continue
				case "session_renew":
					handleSessionRenew(conn, userID, msg)
					continue
				}
			}

			if HandleMessage(cu, msg) {
				continue
			}

			if event, ok := ParseEvent(msg); ok {
				switch event.Type {
				case "heartbeat":
					// keep alive
				case "page_changed", "tab_changed":
					if broadcastFn != nil {
						broadcastFn(uid, msg)
					}
				}
			}
		}
	}
}
