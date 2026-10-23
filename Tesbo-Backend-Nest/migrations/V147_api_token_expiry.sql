-- API tokens expire. Until now a token lived until someone remembered to revoke it, so a token pasted
-- into a CI log or committed to a repo stayed valid indefinitely.
--
-- Nullable on purpose: NULL still means "never expires", which keeps the column additive and lets the
-- application decide the default for new tokens (90 days). Existing tokens get the same 90 days,
-- counted from this migration, instead of being cut off at once: a token a build pipeline depends on
-- must not stop working the moment this deploys, but it must also stop being immortal.
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

UPDATE api_tokens SET expires_at = now() + interval '90 days' WHERE expires_at IS NULL;
