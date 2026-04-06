package computeruse

import (
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
)

const SessionDuration = 1 * time.Hour

// Session holds an in-memory browser-companion session.
type Session struct {
	ID        string
	UserID    uuid.UUID
	DeviceID  string
	ExpiresAt time.Time
	Seq       int64
	mu        sync.Mutex
}

// ValidateSeq checks that seq is strictly greater than the last seen sequence number.
// It updates the stored Seq on success (CAS-like anti-replay).
func (s *Session) ValidateSeq(seq int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if seq <= s.Seq {
		return false
	}
	s.Seq = seq
	return true
}

// SessionManager is a thread-safe in-memory store of active sessions.
// byUser is keyed by "userID:deviceID" to support multiple devices per user.
type SessionManager struct {
	sessions map[string]*Session // keyed by session ID
	byUser   map[string]*Session // keyed by "userID:deviceID"
	mu       sync.RWMutex
}

// Sessions is the global singleton session manager.
var Sessions = &SessionManager{
	sessions: make(map[string]*Session),
	byUser:   make(map[string]*Session),
}

// Create invalidates any existing session for the userID+deviceID pair,
// then creates and stores a new one. Returns the new Session.
func (m *SessionManager) Create(userID uuid.UUID, deviceID string) *Session {
	key := userID.String() + ":" + deviceID
	sessionID := uuid.New().String()

	s := &Session{
		ID:        sessionID,
		UserID:    userID,
		DeviceID:  deviceID,
		ExpiresAt: time.Now().Add(SessionDuration),
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	// Invalidate existing session for this user+device.
	if old, ok := m.byUser[key]; ok {
		delete(m.sessions, old.ID)
	}

	m.sessions[sessionID] = s
	m.byUser[key] = s
	return s
}

// Get returns the session with the given ID, or nil if it does not exist or is expired.
func (m *SessionManager) Get(sessionID string) *Session {
	m.mu.RLock()
	s, ok := m.sessions[sessionID]
	m.mu.RUnlock()
	if !ok || time.Now().After(s.ExpiresAt) {
		return nil
	}
	return s
}

// GetByUser returns any active session for the given user (first device found), or nil.
func (m *SessionManager) GetByUser(userID uuid.UUID) *Session {
	prefix := userID.String() + ":"
	m.mu.RLock()
	defer m.mu.RUnlock()
	for key, s := range m.byUser {
		if len(key) > len(prefix) && key[:len(prefix)] == prefix {
			if time.Now().Before(s.ExpiresAt) {
				return s
			}
		}
	}
	return nil
}

// Renew extends the expiry of the session with sessionID by SessionDuration.
func (m *SessionManager) Renew(sessionID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[sessionID]
	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}
	s.ExpiresAt = time.Now().Add(SessionDuration)
	return nil
}

// Revoke removes the session with the given ID.
func (m *SessionManager) Revoke(sessionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[sessionID]
	if !ok {
		return
	}
	delete(m.sessions, sessionID)
	key := s.UserID.String() + ":" + s.DeviceID
	if cur, ok := m.byUser[key]; ok && cur.ID == sessionID {
		delete(m.byUser, key)
	}
}

// RevokeByDevice removes the session belonging to userID+deviceID only.
func (m *SessionManager) RevokeByDevice(userID uuid.UUID, deviceID string) {
	key := userID.String() + ":" + deviceID
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.byUser[key]
	if !ok {
		return
	}
	delete(m.sessions, s.ID)
	delete(m.byUser, key)
}

// RevokeByUser removes ALL sessions belonging to userID across all devices.
func (m *SessionManager) RevokeByUser(userID uuid.UUID) {
	prefix := userID.String() + ":"
	m.mu.Lock()
	defer m.mu.Unlock()
	for key, s := range m.byUser {
		if len(key) > len(prefix) && key[:len(prefix)] == prefix {
			delete(m.sessions, s.ID)
			delete(m.byUser, key)
		}
	}
}

// VerifyHelloSignature verifies an RSA PKCS1v15 SHA-256 signature.
// publicKeyPEM is a PEM-encoded RSA public key.
// message is the raw message bytes that were signed.
// signatureB64 is the base64-encoded signature.
func VerifyHelloSignature(publicKeyPEM string, message []byte, signatureB64 string) error {
	block, _ := pem.Decode([]byte(publicKeyPEM))
	if block == nil {
		return errors.New("failed to decode PEM block")
	}

	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return fmt.Errorf("failed to parse public key: %w", err)
	}

	rsaPub, ok := pub.(*rsa.PublicKey)
	if !ok {
		return errors.New("public key is not RSA")
	}

	sig, err := base64.StdEncoding.DecodeString(signatureB64)
	if err != nil {
		// Try URL-safe base64 as fallback.
		sig, err = base64.URLEncoding.DecodeString(signatureB64)
		if err != nil {
			return fmt.Errorf("failed to decode signature: %w", err)
		}
	}

	digest := sha256.Sum256(message)
	if err := rsa.VerifyPKCS1v15(rsaPub, crypto.SHA256, digest[:], sig); err != nil {
		return fmt.Errorf("signature verification failed: %w", err)
	}
	return nil
}
