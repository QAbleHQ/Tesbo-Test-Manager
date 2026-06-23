
-- Public sharing support for test runs
ALTER TABLE cycles ADD COLUMN IF NOT EXISTS share_token VARCHAR(64) UNIQUE;
ALTER TABLE cycles ADD COLUMN IF NOT EXISTS share_enabled BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_cycles_share_token ON cycles(share_token) WHERE share_token IS NOT NULL;
