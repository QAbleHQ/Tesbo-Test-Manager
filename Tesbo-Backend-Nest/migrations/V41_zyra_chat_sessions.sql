CREATE TABLE IF NOT EXISTS zyra_chat_sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    title       VARCHAR(240) NOT NULL DEFAULT 'Zyra chat',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_zyra_chat_sessions_project ON zyra_chat_sessions(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_zyra_chat_sessions_user ON zyra_chat_sessions(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS zyra_chat_messages (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id        UUID NOT NULL REFERENCES zyra_chat_sessions(id) ON DELETE CASCADE,
    project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
    role              VARCHAR(24) NOT NULL,
    content           TEXT NOT NULL,
    reasoning_summary TEXT,
    action_type       VARCHAR(64),
    status            VARCHAR(32) NOT NULL DEFAULT 'sent',
    testcases         JSONB NOT NULL DEFAULT '[]'::jsonb,
    activity          JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_zyra_chat_messages_session ON zyra_chat_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_zyra_chat_messages_project ON zyra_chat_messages(project_id, created_at DESC);
