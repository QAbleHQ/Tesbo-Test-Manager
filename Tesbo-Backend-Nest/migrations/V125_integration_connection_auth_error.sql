-- Remembers that a connection's refresh token was definitively refused, so it is never sent again.
--
-- Before this, getIntegrationConnection (legacy.service.ts) and the sync client re-sent the same
-- refresh token on every request once the access token had expired. When the provider had already
-- refused that token — revoked, already rotated away, or issued to a different OAuth app than the
-- one this deployment renews with — every Jira/Linear call paid for a round trip that was certain
-- to fail again, and nothing recorded that the connection was dead: the status endpoint kept
-- answering `connected: true` while every call failed.
--
-- auth_error_refresh_fingerprint is a SHA-256 of the stored (encrypted) refresh_token value the
-- refusal was for, never the token itself. That makes the marker self-healing without any writer
-- having to clear it: the moment the refresh token changes — a reconnect, or another deployment
-- sharing this row renewing it — the fingerprint no longer matches and the marker is ignored.
ALTER TABLE integration_connections
  ADD COLUMN auth_error TEXT,
  ADD COLUMN auth_error_at TIMESTAMPTZ,
  ADD COLUMN auth_error_refresh_fingerprint VARCHAR(64);
