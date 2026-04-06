package computeruse

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"strings"
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

// CUHub keys connections by "userID:deviceID" to support multiple devices per user.
type CUHub struct {
	mu    sync.RWMutex
	conns map[string]*cuConnection // key: "userID:deviceID"
}

var Hub = &CUHub{
	conns: make(map[string]*cuConnection),
}

// Nonce cache to prevent hello replay attacks.
var (
	usedNonces   = make(map[string]time.Time)
	usedNoncesMu sync.Mutex
)

// isNonceUsed checks and records a nonce. Returns true if the nonce was already seen.
// Nonces older than 10 minutes are evicted on each call.
func isNonceUsed(nonce string) bool {
	usedNoncesMu.Lock()
	defer usedNoncesMu.Unlock()
	// Cleanup expired nonces (> 10 min).
	for n, t := range usedNonces {
		if time.Since(t) > 10*time.Minute {
			delete(usedNonces, n)
		}
	}
	if _, exists := usedNonces[nonce]; exists {
		return true
	}
	usedNonces[nonce] = time.Now()
	return false
}

// IsOnline returns true if any device belonging to userID is currently connected.
func (h *CUHub) IsOnline(userID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	prefix := userID + ":"
	for key := range h.conns {
		if strings.HasPrefix(key, prefix) {
			return true
		}
	}
	return false
}

// SendCommand sends a legacy CUCommand and waits up to 30s for a CUResult.
// Kept for backward compatibility. Uses the first connected device for userID.
func (h *CUHub) SendCommand(userID string, cmd CUCommand) (*CUResult, error) {
	cu := h.findFirstConn(userID)
	if cu == nil {
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
// It looks up the active session for the user, then routes to the exact device that owns the session.
func (h *CUHub) SendCompanionCommand(userID string, action string, params json.RawMessage) (*CUResult, error) {
	uid, err := uuid.Parse(userID)
	if err != nil {
		return nil, fmt.Errorf("invalid user_id: %w", err)
	}

	sess := Sessions.GetByUser(uid)
	if sess == nil {
		return nil, fmt.Errorf("no active session for user")
	}

	// Route to the exact device that owns this session.
	cu := h.findConn(userID, sess.DeviceID)
	if cu == nil {
		return nil, fmt.Errorf("device %s not connected", sess.DeviceID)
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

// SendKillToAllDevices sends a kill command to every connected device for userID.
// Used by the kill switch — sessions are already revoked, so this uses legacy CUCommand.
func (h *CUHub) SendKillToAllDevices(userID string) {
	devConns := h.FindConnsByUser(userID)
	for devID, cu := range devConns {
		cmdID := uuid.New().String()
		cmd := CUCommand{
			ID:     cmdID,
			Action: "kill",
		}
		payload, _ := json.Marshal(cmd)
		if err := cu.conn.WriteMessage(websocket.TextMessage, payload); err != nil {
			log.Printf("[computer-use] failed to send kill to user %s device %s: %v", userID, devID, err)
		} else {
			log.Printf("[computer-use] kill sent to user %s device %s", userID, devID)
		}
	}
}

// findFirstConn returns the first cuConnection matching userID, or nil.
func (h *CUHub) findFirstConn(userID string) *cuConnection {
	h.mu.RLock()
	defer h.mu.RUnlock()
	prefix := userID + ":"
	for key, cu := range h.conns {
		if strings.HasPrefix(key, prefix) {
			return cu
		}
	}
	return nil
}

// findConn returns the cuConnection for exact userID+deviceID, or nil.
func (h *CUHub) findConn(userID, deviceID string) *cuConnection {
	key := userID + ":" + deviceID
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.conns[key]
}

// FindConnsByUser returns all connections for userID as a map of deviceID -> cuConnection.
func (h *CUHub) FindConnsByUser(userID string) map[string]*cuConnection {
	h.mu.RLock()
	defer h.mu.RUnlock()
	prefix := userID + ":"
	result := make(map[string]*cuConnection)
	for key, cu := range h.conns {
		if strings.HasPrefix(key, prefix) {
			devID := key[len(prefix):]
			result[devID] = cu
		}
	}
	return result
}

// UnregisterByUser removes ALL connections for the given userID.
func (h *CUHub) UnregisterByUser(userID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	prefix := userID + ":"
	for key, cu := range h.conns {
		if strings.HasPrefix(key, prefix) {
			cu.conn.Close()
			delete(h.conns, key)
			log.Printf("[computer-use] extension disconnected for user %s (kill-all)", userID)
		}
	}
}

// Register stores a connection keyed by "userID:deviceID".
// If a previous connection for the same key exists it is closed first.
func (h *CUHub) Register(userID, deviceID string, conn *websocket.Conn) *cuConnection {
	key := userID + ":" + deviceID
	h.mu.Lock()
	defer h.mu.Unlock()
	if old, ok := h.conns[key]; ok {
		old.conn.Close()
	}
	cu := &cuConnection{
		conn:    conn,
		pending: make(map[string]chan *CUResult),
	}
	h.conns[key] = cu
	log.Printf("[computer-use] extension connected for user %s device %s", userID, deviceID)
	return cu
}

// Unregister removes the connection for "userID:deviceID".
func (h *CUHub) Unregister(userID, deviceID string) {
	key := userID + ":" + deviceID
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.conns, key)
	log.Printf("[computer-use] extension disconnected for user %s device %s", userID, deviceID)
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
// Returns the deviceID and session on success, or empty string/nil on failure.
func handleHelperHello(conn *websocket.Conn, uid uuid.UUID, msg []byte) (deviceID string, sess *Session) {
	var hello HelperHello
	if err := json.Unmarshal(msg, &hello); err != nil {
		writeJSON(conn, map[string]string{"type": "hello_rejected", "error": "invalid hello payload"})
		return "", nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	grant, err := GetActiveGrant(ctx, uid, hello.DeviceID)
	if err != nil {
		log.Printf("[computer-use] hello_rejected for user %s device %s: %v", uid, hello.DeviceID, err)
		writeJSON(conn, map[string]string{"type": "hello_rejected", "error": err.Error()})
		return "", nil
	}

	payload := []byte(hello.SignedPayload)
	if err := VerifyHelloSignature(grant.PublicKey, payload, hello.Signature); err != nil {
		log.Printf("[computer-use] hello_rejected signature for user %s: %v", uid, err)
		writeJSON(conn, map[string]string{"type": "hello_rejected", "error": "signature verification failed"})
		return "", nil
	}

	// --- FIX 1: Parse and validate the SignedPayload fields ---
	rawPayload, err := base64.StdEncoding.DecodeString(hello.SignedPayload)
	if err != nil {
		// Try URL-safe base64 as fallback.
		rawPayload, err = base64.URLEncoding.DecodeString(hello.SignedPayload)
		if err != nil {
			// SignedPayload may be plain JSON rather than base64.
			rawPayload = []byte(hello.SignedPayload)
		}
	}

	var spFields struct {
		UserID    string `json:"user_id"`
		DeviceID  string `json:"device_id"`
		Timestamp string `json:"timestamp"`
		Nonce     string `json:"nonce"`
	}
	if err := json.Unmarshal(rawPayload, &spFields); err != nil {
		writeJSON(conn, map[string]string{"type": "hello_rejected", "error": "signed_payload is not valid JSON"})
		return "", nil
	}

	// Verify payload fields match the envelope.
	if spFields.UserID != uid.String() {
		writeJSON(conn, map[string]string{"type": "hello_rejected", "error": "signed_payload user_id mismatch"})
		return "", nil
	}
	if spFields.DeviceID != hello.DeviceID {
		writeJSON(conn, map[string]string{"type": "hello_rejected", "error": "signed_payload device_id mismatch"})
		return "", nil
	}

	// Verify timestamp freshness (within ±5 minutes).
	ts, err := time.Parse(time.RFC3339, spFields.Timestamp)
	if err != nil {
		writeJSON(conn, map[string]string{"type": "hello_rejected", "error": "signed_payload timestamp invalid"})
		return "", nil
	}
	if diff := time.Since(ts); diff > 5*time.Minute || diff < -5*time.Minute {
		writeJSON(conn, map[string]string{"type": "hello_rejected", "error": "signed_payload timestamp expired or skewed"})
		return "", nil
	}

	// Verify nonce has not been used before.
	if spFields.Nonce == "" {
		writeJSON(conn, map[string]string{"type": "hello_rejected", "error": "signed_payload nonce missing"})
		return "", nil
	}
	if isNonceUsed(spFields.Nonce) {
		log.Printf("[computer-use] hello_rejected replay for user %s nonce %s", uid, spFields.Nonce)
		writeJSON(conn, map[string]string{"type": "hello_rejected", "error": "nonce already used (replay detected)"})
		return "", nil
	}
	// --- End FIX 1 ---

	newSess := Sessions.Create(uid, hello.DeviceID)
	log.Printf("[computer-use] hello_accepted for user %s device %s session %s", uid, hello.DeviceID, newSess.ID)
	writeJSON(conn, map[string]any{
		"type":       "hello_accepted",
		"session_id": newSess.ID,
		"expires_at": newSess.ExpiresAt.UTC().Format(time.RFC3339),
	})
	return hello.DeviceID, newSess
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

		// FIX 3: Do NOT register or broadcast online until helper_hello is verified.
		var authenticated bool
		var deviceID string
		var cu *cuConnection

		defer func() {
			if authenticated {
				Hub.Unregister(uid, deviceID)
				if statusFn != nil {
					statusFn(uid, false)
				}
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
					dev, _ := handleHelperHello(conn, userID, msg)
					if dev != "" && !authenticated {
						// Handshake succeeded — now register and broadcast online.
						deviceID = dev
						cu = Hub.Register(uid, deviceID, conn)
						authenticated = true
						if statusFn != nil {
							statusFn(uid, true)
						}
					}
					continue
				case "session_renew":
					if !authenticated {
						writeJSON(conn, map[string]string{"type": "error", "error": "not authenticated"})
						continue
					}
					handleSessionRenew(conn, userID, msg)
					continue
				}
			}

			// Reject all non-hello messages until authenticated.
			if !authenticated {
				writeJSON(conn, map[string]string{"type": "error", "error": "not authenticated"})
				continue
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
