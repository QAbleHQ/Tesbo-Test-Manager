-- Indexes for the Activity feed (audit_logs) and the project dashboard (executions). Additive; no data touched.
--
-- The Activity feed asks audit_logs for "this project's newest rows" (project_id, newest first, stop at a
-- page) and, to hide a testcase_created/testcase_updated row that a zyra_* row duplicates, for "this
-- project's zyra_* rows". The only indexes were on project_id alone and on created_at alone, so a page of
-- 30 read and sorted the project's entire history (~1M rows on the largest tenant) and finding the zyra_*
-- rows meant reading all of it.

-- Newest-first scan of one project's rows, which is what lets a LIMIT stop after a page.
CREATE INDEX IF NOT EXISTS idx_audit_logs_project_created
  ON audit_logs (project_id, created_at DESC);

-- One project's zyra_* rows. Partial: they are a small slice of the table, so the index stays small and
-- finding them costs what they number, however large the history is. The predicate must match the feed's
-- own `action IN (...)` list exactly for Postgres to use this index.
CREATE INDEX IF NOT EXISTS idx_audit_logs_zyra_sibling
  ON audit_logs (project_id, entity_id)
  WHERE action IN ('zyra_created', 'zyra_updated', 'zyra_archived');

-- The workspace Activity feed also reads workspace-level events (invites, membership changes), which have
-- no project: `project_id IS NULL AND organization_id = $1`, newest first. Every project row carries an
-- organization_id too, so idx_audit_logs_organization returns all of the organization's history for that
-- filter to discard, and the planner instead walked idx_audit_logs_created_at across every tenant's rows
-- looking for a handful of matches (199k rows read to find none). Partial: only these rows are indexed.
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_events
  ON audit_logs (organization_id, created_at DESC)
  WHERE project_id IS NULL;

-- The project dashboard's "+N% this week" badge reads only executions from the last 14 days, but with no
-- index on executed_at it had to walk every execution in the project (~700k on the largest tenant) to find
-- them. Plain (not partial): that read counts executions whether or not they are soft-deleted, so a
-- `deleted_at IS NULL` predicate here would stop the planner from using the index for it.
CREATE INDEX IF NOT EXISTS idx_executions_executed_at
  ON executions (executed_at);
