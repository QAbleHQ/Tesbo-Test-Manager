
-- Sub-task C of the archive-sweep feature: dedup for sweep-staged proposals across runs.
--
-- Investigated idx_integration_sync_runs_nightly_cycle (V90) as instructed, rather than assuming it
-- transfers — it doesn't, directly. That index dedupes at RUN granularity (project, provider,
-- calendar-day), which stops the nightly ticket-sync orchestrator from double-firing for one cron
-- slot. What this sub-task actually needs is dedup at PROPOSAL granularity: don't stage a second
-- archive proposal for the same test case while an earlier one from a prior sweep is still sitting
-- unresolved (task_status <> 'done') — a different key entirely, and one that also has to survive
-- indefinitely (across many days), not reset per calendar day. So this reuses V90's *technique* —
-- a plain stored column plus a partial unique index, rather than trying to derive the key from
-- something computed at query time — applied to the shape this table actually has.
--
-- Why a stored column and not an expression index on generated_payload->0->>'testcaseId': a sweep
-- proposal is only ever archive-only and always exactly one operation per row, so a flat column is
-- both simpler and, unlike an expression pulled from JSONB, trivially indexable without ever risking
-- V90's own original mistake (an index expression Postgres refuses to accept because it isn't
-- provably IMMUTABLE) — not a concern here since this is a plain UUID column, not a timezone
-- conversion, but keeping the same "store it flat, don't compute it in the index" shape regardless.
ALTER TABLE ai_generation_requests
  ADD COLUMN sweep_testcase_id UUID REFERENCES testcases(id) ON DELETE CASCADE;

-- NULL for every non-sweep row (chat-staged, task-board), and a unique index never treats two NULLs
-- as colliding, so this only ever constrains provider = 'zyra_archive_sweep' rows against each other
-- — exactly mirroring how V90's index only ever constrains trigger_source = 'nightly' rows.
--
-- task_status <> 'done' (not a positive list of "still open" statuses): 'done' is this table's one
-- true terminal state for a review batch — reached either by an explicit save (zyraSaveAttempt) or
-- an explicit dismissal (zyraCloseTask, "Task closed from review without saving"). Either way, once
-- 'done', the row is resolved and must fall out of this index so a future sweep can propose again if
-- the underlying condition (ticket still done) still holds. A sweep-staged row is created directly at
-- 'in_review' (mirroring how a chat-staged proposal starts there too — it never passes through
-- 'todo'/'in_progress', which only apply to the task-board generation flow), so in practice this
-- index only ever needs to distinguish 'in_review' from 'done' for these rows, but the <> comparison
-- is written the same defensive way V90's own migration comment favors: correct even if a status this
-- row type doesn't use today shows up later.
CREATE UNIQUE INDEX idx_ai_generation_requests_sweep_archive_dedup
  ON ai_generation_requests (sweep_testcase_id)
  WHERE provider = 'zyra_archive_sweep' AND task_status <> 'done';
