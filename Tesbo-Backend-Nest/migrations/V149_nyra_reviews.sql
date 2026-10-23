-- NYRA findings review and approval.
--
-- NYRA itself has no review step and its findings have no ids, so Tesbo keeps the decisions. A
-- decision is keyed by what NYRA calls the finding (kind + key) within one scan, and stores the
-- final title and data as they were when decided, so approving later never has to ask NYRA for an
-- old scan again. A finding left undecided has no row.
CREATE TABLE nyra_item_reviews (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    nyra_project_id VARCHAR(64) NOT NULL,
    run_id          VARCHAR(64) NOT NULL,
    kind            VARCHAR(32) NOT NULL,
    item_key        TEXT NOT NULL CHECK (length(item_key) <= 500),
    status          VARCHAR(16) NOT NULL CHECK (status IN ('correct', 'edited', 'rejected')),
    title           TEXT NOT NULL,
    data            JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- What NYRA found, kept only when a person changed it, so the edit can be shown against it.
    original_title  TEXT,
    original_data   JSONB,
    reviewed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, nyra_project_id, run_id, kind, item_key)
);

-- "Latest decision per finding across scans" is what an approval reads.
CREATE INDEX idx_nyra_item_reviews_latest ON nyra_item_reviews(project_id, nyra_project_id, kind, item_key, reviewed_at DESC);

-- The Knowledge Base document that holds one kind of approved findings for one NYRA project.
CREATE TABLE nyra_kb_documents (
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    nyra_project_id VARCHAR(64) NOT NULL,
    kind            VARCHAR(32) NOT NULL,
    document_id     UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, nyra_project_id, kind)
);

-- When a scan was approved into the Knowledge Base, and how many findings that carried.
CREATE TABLE nyra_run_approvals (
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    nyra_project_id VARCHAR(64) NOT NULL,
    run_id          VARCHAR(64) NOT NULL,
    approved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    item_count      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, nyra_project_id, run_id)
);
