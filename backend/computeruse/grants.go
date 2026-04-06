package computeruse

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/google/uuid"
)

const CurrentPolicyVersion = 1

var ErrPolicyChanged = errors.New("companion policy version changed: re-consent required")

type CompanionGrant struct {
	ID            uuid.UUID
	UserID        uuid.UUID
	DeviceID      string
	PublicKey     string
	GrantedAt     time.Time
	RevokedAt     *time.Time
	Status        string
	PolicyVersion int
}

// CreateGrant inserts a new grant or updates the existing one for the (user_id, device_id) pair.
func CreateGrant(ctx context.Context, userID uuid.UUID, deviceID, publicKey string) (*CompanionGrant, error) {
	const q = `
		INSERT INTO companion_grants (user_id, device_id, public_key, policy_version, status, granted_at, revoked_at)
		VALUES ($1, $2, $3, $4, 'active', now(), NULL)
		ON CONFLICT (user_id, device_id) DO UPDATE
			SET public_key     = EXCLUDED.public_key,
			    policy_version = EXCLUDED.policy_version,
			    status         = 'active',
			    granted_at     = now(),
			    revoked_at     = NULL
		RETURNING id, user_id, device_id, public_key, granted_at, revoked_at, status, policy_version
	`
	row := db.Pool.QueryRow(ctx, q, userID, deviceID, publicKey, CurrentPolicyVersion)
	return scanGrant(row)
}

// GetActiveGrant returns the active grant for the given (user_id, device_id).
// Returns ErrPolicyChanged if the stored policy_version differs from CurrentPolicyVersion.
func GetActiveGrant(ctx context.Context, userID uuid.UUID, deviceID string) (*CompanionGrant, error) {
	const q = `
		SELECT id, user_id, device_id, public_key, granted_at, revoked_at, status, policy_version
		FROM companion_grants
		WHERE user_id = $1 AND device_id = $2 AND status = 'active'
		LIMIT 1
	`
	row := db.Pool.QueryRow(ctx, q, userID, deviceID)
	grant, err := scanGrant(row)
	if err != nil {
		return nil, err
	}
	if grant.PolicyVersion != CurrentPolicyVersion {
		return nil, ErrPolicyChanged
	}
	return grant, nil
}

// RevokeGrant sets status=revoked and revoked_at=now() for the given (user_id, device_id).
func RevokeGrant(ctx context.Context, userID uuid.UUID, deviceID string) error {
	const q = `
		UPDATE companion_grants
		SET status = 'revoked', revoked_at = now()
		WHERE user_id = $1 AND device_id = $2 AND status = 'active'
	`
	ct, err := db.Pool.Exec(ctx, q, userID, deviceID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return fmt.Errorf("grant not found or already revoked")
	}
	return nil
}

// RevokeAllGrants revokes all active grants for a user.
func RevokeAllGrants(ctx context.Context, userID uuid.UUID) error {
	const q = `
		UPDATE companion_grants
		SET status = 'revoked', revoked_at = now()
		WHERE user_id = $1 AND status = 'active'
	`
	_, err := db.Pool.Exec(ctx, q, userID)
	return err
}

// scanGrant is a helper that scans a pgx row into a CompanionGrant.
type pgxRow interface {
	Scan(dest ...any) error
}

func scanGrant(row pgxRow) (*CompanionGrant, error) {
	g := &CompanionGrant{}
	err := row.Scan(
		&g.ID,
		&g.UserID,
		&g.DeviceID,
		&g.PublicKey,
		&g.GrantedAt,
		&g.RevokedAt,
		&g.Status,
		&g.PolicyVersion,
	)
	if err != nil {
		return nil, err
	}
	return g, nil
}
