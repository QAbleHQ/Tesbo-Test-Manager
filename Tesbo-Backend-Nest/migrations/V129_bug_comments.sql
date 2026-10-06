-- Comments on a bug: a flat, chronological discussion shown at the bottom of Bug Details.
--
-- Deliberately a subset of knowledge_document_comments (V73): no replies, anchors or resolution —
-- a bug's own status already carries "resolved". is_deleted/deleted_at are here from the start so
-- a later delete action soft-deletes, as the rest of the bug tables now do, rather than needing a
-- second migration.
--
-- project_id is denormalised from bugs so the read path and the project-scoped routes
-- (/api/projects/:projectId/bugs/:bugId/comments, covered by ProjectWriteLockGuard) never need a
-- join to answer "does this comment belong to this project".

CREATE TABLE bug_comments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    bug_id      UUID NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
    author_id   UUID REFERENCES users(id) ON DELETE SET NULL,
    body        TEXT NOT NULL,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    deleted_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bug_comments_body_not_blank CHECK (length(btrim(body)) > 0)
);

-- Serves the per-bug fetch, oldest first (the only read path).
CREATE INDEX idx_bug_comments_bug ON bug_comments(bug_id, created_at)
  WHERE is_deleted = false;
