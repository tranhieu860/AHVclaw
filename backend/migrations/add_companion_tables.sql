-- Durable consent grants
CREATE TABLE IF NOT EXISTS companion_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    device_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    granted_at TIMESTAMPTZ DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    status TEXT DEFAULT 'active',
    policy_version INT DEFAULT 1,
    UNIQUE(user_id, device_id)
);

-- Browser audit log
CREATE TABLE IF NOT EXISTS browser_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    device_id TEXT,
    session_id TEXT,
    action TEXT NOT NULL,
    url TEXT,
    tab_id INT,
    tab_type TEXT,
    params JSONB,
    result TEXT NOT NULL,
    blocked_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_user_time ON browser_audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_grants_user ON companion_grants(user_id, status);
CREATE INDEX IF NOT EXISTS idx_grants_device ON companion_grants(device_id);
