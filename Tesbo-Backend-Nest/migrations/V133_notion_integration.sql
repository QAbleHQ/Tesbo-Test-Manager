-- Notion workspace integration: a third ticket-tracker provider next to Jira and Linear.
--
-- Notion's unit of work is a DATABASE (a table of pages), so a Tesbo project maps to exactly one
-- Notion database and the database's pages are mirrored as tickets. The shapes below follow
-- linear_project_mappings / linear_tickets (V47) with every later widening already folded in:
-- project-scoped uniqueness (V91), one enabled mapping per project (V72), cached comments and the
-- decision summary (V72), TEXT summary (V93) and the mapped_remote_id provenance column (V96).
-- integration_connections needs no change: provider is a free VARCHAR(32), and a Notion connection
-- stores the workspace id in external_id and an empty refresh_token (Notion tokens neither expire
-- nor refresh).

CREATE TABLE IF NOT EXISTS notion_project_mappings (
    id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    integration_connection_id  UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
    project_id                 UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    notion_database_id         VARCHAR(128) NOT NULL,
    notion_database_name       VARCHAR(512) NOT NULL,
    enabled                    BOOLEAN NOT NULL DEFAULT true,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (integration_connection_id, notion_database_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_notion_project_mappings_project ON notion_project_mappings(project_id);

-- Same invariant as idx_linear_project_mappings_one_per_project (V72): at most one enabled mapping
-- per Tesbo project. The connect endpoint translates the 23505 this raises into a 409.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notion_project_mappings_one_per_project
  ON notion_project_mappings(project_id) WHERE enabled = true;

CREATE TABLE IF NOT EXISTS notion_pages (
    id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id                 UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    integration_connection_id  UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
    notion_page_id             VARCHAR(128) NOT NULL,
    -- Display key only ("notion:" + first 8 hex chars of the page id). Test cases link to a page by
    -- notion_page_id, never by this key.
    notion_page_key            TEXT NOT NULL,
    summary                    TEXT NOT NULL,
    -- Rendered properties followed by the page body as markdown.
    description                TEXT,
    issue_type                 VARCHAR(128),
    status                     VARCHAR(128),
    priority                   VARCHAR(64),
    assignee                   VARCHAR(256),
    reporter                   VARCHAR(256),
    labels                     TEXT,
    -- Every database property rendered to text, keyed by property name.
    properties_json            JSONB,
    notion_created_at          TIMESTAMPTZ,
    notion_updated_at          TIMESTAMPTZ,
    notion_url                 VARCHAR(1024),
    -- Set when Notion reports the page archived / in the trash. Archived rows are kept but excluded
    -- from every list.
    archived                   BOOLEAN NOT NULL DEFAULT false,
    synced_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    comments_json              JSONB,
    comments_count             INTEGER NOT NULL DEFAULT 0,
    comments_hash              VARCHAR(64),
    decision_summary           TEXT,
    decision_summary_hash      VARCHAR(64),
    mapped_remote_id           VARCHAR(128),
    UNIQUE (integration_connection_id, notion_page_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_notion_pages_project ON notion_pages(project_id);
CREATE INDEX IF NOT EXISTS idx_notion_pages_connection ON notion_pages(integration_connection_id);
CREATE INDEX IF NOT EXISTS idx_notion_pages_page_id ON notion_pages(project_id, notion_page_id);
CREATE INDEX IF NOT EXISTS idx_notion_pages_mapped_remote ON notion_pages(project_id, mapped_remote_id);

-- Test case <-> Notion page link. TEXT from the start (see V124 for why ticket keys are never
-- length-capped).
ALTER TABLE testcases ADD COLUMN IF NOT EXISTS notion_page_id TEXT;
ALTER TABLE testcases ADD COLUMN IF NOT EXISTS notion_url TEXT;
CREATE INDEX IF NOT EXISTS idx_testcases_notion_page_id ON testcases (notion_page_id) WHERE notion_page_id IS NOT NULL;

ALTER TABLE ai_generation_requests ADD COLUMN IF NOT EXISTS notion_page_ids JSONB DEFAULT '[]'::jsonb;

-- testcases_active (V64) is `SELECT * FROM testcases`, whose column list Postgres froze at creation,
-- so the two new testcases columns above are invisible through it until it is recreated. Same
-- drop-and-recreate V124 did (nothing depends on the view, and the migrator runs a file in one
-- transaction, so no reader ever sees it missing).
DROP VIEW IF EXISTS testcases_active;
CREATE VIEW testcases_active AS SELECT * FROM testcases WHERE deleted_at IS NULL;

-- V123's inline CHECK on integration_ticket_comments.provider only admits jira and linear. Drop it by
-- looking the (auto-generated) name up rather than assuming it, then re-add with notion included.
DO $$
DECLARE conname text;
BEGIN
  FOR conname IN
    SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid = 'integration_ticket_comments'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%provider%'
  LOOP
    EXECUTE format('ALTER TABLE integration_ticket_comments DROP CONSTRAINT %I', conname);
  END LOOP;
END $$;

ALTER TABLE integration_ticket_comments
  ADD CONSTRAINT integration_ticket_comments_provider_check CHECK (provider IN ('jira', 'linear', 'notion'));
