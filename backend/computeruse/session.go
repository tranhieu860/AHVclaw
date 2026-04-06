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
	ID       string
	UserID   uuid.UUID
	DeviceID string
	ExpiresAt time.Time
	Seq      int64
	mu       sync.Mutex
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
type SessionManager struct {
	sessions map[string]*Session  // keyed by session ID
	byUser   map[string]*Session  // keyed by user ID string (one active session per user)
	mu       sync.RWMutex
}

// Sessions is the global singleton session manager.
var Sessions = &SessionManager{
	sessions: make(map[string]*Session),
	byUser:   make(map[string]*Session),
}

// Create invalidates any existing session for userID, then creates and stores a new one.
// Returns the new Session.
func (m *SessionManager) Create(userID uuid.UUID, deviceID string) *Session {
	uid := userID.String()
	sessionID := uuid.New().String()

	s := &Session{
		ID:        sessionID,
		UserID:    userID,
		DeviceID:  deviceID,
		ExpiresAt: time.Now().Add(SessionDuration),
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	// Invalidate existing session for this user.
	if old, ok := m.byUser[uid]; ok {
		delete(m.sessions, old.ID)
	}

	m.sessions[sessionID] = s
	m.byUser[uid] = s
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

// GetByUser returns the active session for the given user, or nil if none exists / expired.
func (m *SessionManager) GetByUser(userID uuid.UUID) *Session {
	m.mu.RLock()
	s, ok := m.byUser[userID.String()]
	m.mu.RUnlock()
	if !ok || time.Now().After(s.ExpiresAt) {
		return nil
	}
	return s
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
	uid := s.UserID.String()
	if cur, ok := m.byUser[uid]; ok && cur.ID == sessionID {
		delete(m.byUser, uid)
	}
}

// RevokeByUser removes all sessions belonging to userID.
func (m *SessionManager) RevokeByUser(userID uuid.UUID) {
	uid := userID.String()
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.byUser[uid]
	if !ok {
		return
	}
	delete(m.sessions, s.ID)
	delete(m.byUser, uid)
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
