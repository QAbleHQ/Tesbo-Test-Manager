
CREATE TABLE IF NOT EXISTS platform_admins (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role          VARCHAR(32) NOT NULL DEFAULT 'admin',
    granted_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_admins_user ON platform_admins(user_id);

-- Seed the platform owner (viral@tryqable.com)
INSERT INTO platform_admins (user_id, role)
SELECT id, 'owner' FROM users WHERE email = 'viral@tryqable.com'
ON CONFLICT DO NOTHING;
