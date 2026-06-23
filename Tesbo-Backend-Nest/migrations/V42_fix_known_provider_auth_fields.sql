-- For known providers (openai, anthropic), auth_header_name and auth_scheme are
-- not needed — the generation code applies the correct provider-specific auth.
-- Rows created before this fix had auth_header_name='Authorization' and
-- auth_scheme='Bearer' stored as the form defaults, which caused Anthropic keys
-- to send `Authorization: Bearer <key>` instead of `x-api-key: <key>`.

-- These columns were originally NOT NULL DEFAULT. Allow NULL so known providers
-- can store NULL and let the code apply the correct provider-specific defaults.
ALTER TABLE workspace_ai_keys ALTER COLUMN auth_header_name DROP NOT NULL;
ALTER TABLE workspace_ai_keys ALTER COLUMN auth_header_name DROP DEFAULT;
ALTER TABLE workspace_ai_keys ALTER COLUMN auth_scheme DROP NOT NULL;
ALTER TABLE workspace_ai_keys ALTER COLUMN auth_scheme DROP DEFAULT;

-- Clear the stale form-default auth fields on existing known-provider keys so
-- the corrected provider-specific auth logic takes over.
UPDATE workspace_ai_keys
SET auth_header_name = NULL,
    auth_scheme      = NULL,
    updated_at       = NOW()
WHERE provider IN ('openai', 'anthropic')
  AND (auth_header_name IS NOT NULL OR auth_scheme IS NOT NULL);
