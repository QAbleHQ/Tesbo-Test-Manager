CREATE TABLE ai_generation_requests (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id                  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    requested_by                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider                    VARCHAR(32) NOT NULL,
    model                       VARCHAR(64),
    user_story                  TEXT NOT NULL,
    acceptance_criteria         TEXT,
    custom_prompt              TEXT,
    style                       VARCHAR(32) DEFAULT 'strict',
    requested_count             INT NOT NULL DEFAULT 5,
    include_happy_flow          BOOLEAN NOT NULL DEFAULT TRUE,
    include_negative_flow       BOOLEAN NOT NULL DEFAULT TRUE,
    include_multi_tab           BOOLEAN NOT NULL DEFAULT FALSE,
    include_cross_browser       BOOLEAN NOT NULL DEFAULT FALSE,
    include_boundary            BOOLEAN NOT NULL DEFAULT TRUE,
    generated_count             INT NOT NULL DEFAULT 0,
    generated_payload           JSONB NOT NULL DEFAULT '[]'::jsonb,
    saved_count                 INT NOT NULL DEFAULT 0,
    save_events                 JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_generation_requests_project ON ai_generation_requests(project_id, created_at DESC);
CREATE INDEX idx_ai_generation_requests_requested_by ON ai_generation_requests(requested_by, created_at DESC);
