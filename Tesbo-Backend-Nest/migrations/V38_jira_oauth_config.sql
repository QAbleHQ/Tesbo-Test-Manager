CREATE TABLE jira_oauth_config (
    project_id      UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    client_id       TEXT NOT NULL,
    client_secret   TEXT NOT NULL,
    redirect_uri    TEXT NOT NULL,
    updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
