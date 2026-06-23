-- API tokens (personal or project-scoped)
CREATE TABLE api_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
    name            VARCHAR(128) NOT NULL,
    token_hash      VARCHAR(64) NOT NULL UNIQUE,
    scopes          VARCHAR(256) DEFAULT 'read,write',
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_tokens_hash ON api_tokens(token_hash);

-- Webhooks (per project)
CREATE TABLE webhooks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    url             VARCHAR(1024) NOT NULL,
    events          VARCHAR(256)[] NOT NULL DEFAULT ARRAY['cycle.created', 'execution.updated'],
    secret          VARCHAR(64),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhooks_project ON webhooks(project_id);
