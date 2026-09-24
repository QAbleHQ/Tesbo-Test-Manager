-- One row per ticket comment Tesbo decided to post (or deliberately not post) after a Zyra save:
-- the "Auto-comment on Jira/Linear ticket" setting (projects.settings.jiraAutoComment /
-- linearAutoComment) lists the test cases a single save wrote for a ticket, in one comment.
--
-- It is a ledger rather than a fire-and-forget call for two reasons:
--
--   1. Idempotency. The poster claims its row with INSERT ... ON CONFLICT DO NOTHING before it
--      talks to the provider, keyed on the save that produced the test cases (save_event_id, which
--      zyraSaveAttempt also writes into ai_generation_requests.save_events). Processing the same
--      save twice therefore cannot post twice — the second claim finds the row already there.
--   2. Observability. Jira and Linear base URLs are compiled in, so no fake upstream can stand in
--      for them (see e2e/api/integrations.spec.ts). Recording every outcome — including the skips —
--      with the exact comment text is what lets the behaviour be proven through the real API.
--
-- status:
--   pending               claimed, provider call in flight
--   posted                provider accepted the comment
--   failed                provider call failed (reason holds why); the save itself still succeeded
--   skipped_disabled      the project's auto-comment setting for this provider is off
--   skipped_not_connected the provider is not connected (or was disconnected) for the workspace
CREATE TABLE integration_ticket_comments (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id             UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    generation_request_id  UUID NOT NULL REFERENCES ai_generation_requests(id) ON DELETE CASCADE,
    save_event_id          UUID NOT NULL,
    provider               VARCHAR(16) NOT NULL CHECK (provider IN ('jira', 'linear')),
    -- TEXT, not VARCHAR(n): a ticket key is whatever the provider or the caller says it is, and
    -- this row must be able to record any key a test case can carry (see V124).
    issue_key              TEXT NOT NULL,
    testcase_ids           JSONB NOT NULL DEFAULT '[]'::jsonb,
    status                 VARCHAR(32) NOT NULL
                           CHECK (status IN ('pending', 'posted', 'failed', 'skipped_disabled', 'skipped_not_connected')),
    comment_text           TEXT NOT NULL,
    reason                 TEXT,
    remote_comment_id      VARCHAR(128),
    posted_by              UUID REFERENCES users(id) ON DELETE SET NULL,
    posted_at              TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (generation_request_id, save_event_id, provider, issue_key)
);

CREATE INDEX idx_integration_ticket_comments_project_issue ON integration_ticket_comments(project_id, provider, issue_key);
