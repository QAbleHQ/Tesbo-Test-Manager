
-- Stores Jira OAuth credentials per project (one Jira site connection per project)
CREATE TABLE jira_connections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    cloud_id        VARCHAR(256) NOT NULL,
    site_url        VARCHAR(1024) NOT NULL,
    access_token    TEXT NOT NULL,
    refresh_token   TEXT NOT NULL,
    token_expires_at TIMESTAMPTZ NOT NULL,
    connected_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id)
);

-- Maps which Jira projects are linked to a BetterCases project
CREATE TABLE jira_project_mappings (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    jira_connection_id  UUID NOT NULL REFERENCES jira_connections(id) ON DELETE CASCADE,
    project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    jira_project_id     VARCHAR(128) NOT NULL,
    jira_project_key    VARCHAR(64) NOT NULL,
    jira_project_name   VARCHAR(512) NOT NULL,
    enabled             BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (jira_connection_id, jira_project_id)
);

CREATE INDEX idx_jira_project_mappings_project ON jira_project_mappings(project_id);

-- Cached Jira tickets for display in Knowledge Base
CREATE TABLE jira_tickets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    jira_connection_id  UUID NOT NULL REFERENCES jira_connections(id) ON DELETE CASCADE,
    jira_issue_id       VARCHAR(128) NOT NULL,
    jira_issue_key      VARCHAR(64) NOT NULL,
    summary             VARCHAR(1024) NOT NULL,
    description         TEXT,
    issue_type          VARCHAR(128),
    status              VARCHAR(128),
    priority            VARCHAR(64),
    assignee            VARCHAR(256),
    reporter            VARCHAR(256),
    labels              TEXT,
    jira_created_at     TIMESTAMPTZ,
    jira_updated_at     TIMESTAMPTZ,
    jira_url            VARCHAR(1024),
    synced_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (jira_connection_id, jira_issue_id)
);

CREATE INDEX idx_jira_tickets_project ON jira_tickets(project_id);
CREATE INDEX idx_jira_tickets_connection ON jira_tickets(jira_connection_id);
CREATE INDEX idx_jira_tickets_key ON jira_tickets(jira_issue_key);
