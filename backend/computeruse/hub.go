package computeruse

import (
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
