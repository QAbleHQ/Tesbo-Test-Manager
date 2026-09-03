-- Zyra Settings "Token usage" tile reads SUM(token_total) from ai_generation_requests, a table
-- only the task-board flow (Tasks tab) ever writes. Every chat-driven call — the router decision,
-- chat-based testcase generation, the "generate all" batch planner/loop, the Jira-coverage tool
-- finalizer — spends real provider tokens but never persisted them anywhere queryable, so any
-- project whose Zyra usage is chat-only (most of them) showed a permanent 0.
--
-- This ledger is deliberately INSERT-only (no UPDATE/DELETE in normal operation): one row per
-- provider call, keyed by its own generated id, so concurrent writes from different chat turns or
-- background plan batches never contend for a shared row lock the way a counter column would.
-- Read side is a plain SUM — an MVCC snapshot that never blocks on, or is blocked by, concurrent
-- inserts.
CREATE TABLE zyra_token_usage (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source       VARCHAR(32) NOT NULL CHECK (source IN (
                     'task_generate', 'task_regenerate',
                     'chat_router', 'chat_generate', 'chat_plan', 'chat_tool_finalize'
                 )),
    provider     VARCHAR(32) NOT NULL,
    model        VARCHAR(128) NOT NULL,
    token_input  INT NOT NULL DEFAULT 0,
    token_output INT NOT NULL DEFAULT 0,
    token_total  INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_zyra_token_usage_project_created ON zyra_token_usage(project_id, created_at);

-- One-time backfill so a project with real, already-completed task-board generations doesn't
-- regress from a correct non-zero total to 0 the moment the settings tile switches to reading this
-- (currently empty) table instead of ai_generation_requests. Chat-driven usage from before this
-- migration can't be backfilled — those token counts were never stored anywhere — so this covers
-- only what was actually recoverable.
INSERT INTO zyra_token_usage (project_id, source, provider, model, token_input, token_output, token_total, created_at)
SELECT project_id,
       'task_generate',
       COALESCE(NULLIF(provider, ''), 'unknown'),
       COALESCE(NULLIF(model, ''), 'unknown'),
       token_input,
       token_output,
       token_total,
       created_at
FROM ai_generation_requests
WHERE agent_name IN ('Zyra the Test Generator', 'Zyra the Edge Hunter')
  AND token_total > 0;
