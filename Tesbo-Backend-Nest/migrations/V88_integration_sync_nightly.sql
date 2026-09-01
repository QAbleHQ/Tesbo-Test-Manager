-- Nightly Jira/Linear sync cron (see docs discussion): a run now records who/what triggered it,
-- and every real add/update to a mirrored KB document gets its own append-only log entry so the
-- Knowledge Base UI can show "Added on" / a per-ticket change timeline without ever having to
-- infer it from audit_logs (which is shared with every other kind of activity in the project).

-- 'manual' (today's Sync button) vs 'nightly' (the new scheduler). Deliberately its own column
-- rather than inferring "nightly" from triggered_by IS NULL: that already means something else
-- (a manual run whose triggering user was later deleted, via ON DELETE SET NULL).
ALTER TABLE integration_sync_runs
  ADD COLUMN trigger_source VARCHAR(16) NOT NULL DEFAULT 'manual'
    CHECK (trigger_source IN ('manual', 'nightly'));

CREATE TABLE knowledge_document_sync_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    run_id          UUID REFERENCES integration_sync_runs(id) ON DELETE SET NULL,
    provider        VARCHAR(32) NOT NULL,
    event_type      VARCHAR(16) NOT NULL CHECK (event_type IN ('created', 'updated')),
    changed_summary TEXT,
    triggered_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Serves the info-icon popover: "every event for this document, newest first".
CREATE INDEX idx_kb_doc_sync_events_document ON knowledge_document_sync_events(document_id, created_at DESC);
