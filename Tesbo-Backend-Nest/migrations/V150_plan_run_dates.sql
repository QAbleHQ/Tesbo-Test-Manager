-- Start Date and optional Due Date for test plans and test runs, plus the workspace timezone that
-- "due today" / "overdue" are judged in.
--
-- DATE, not TIMESTAMPTZ, for the same reason bugs.due_date (V146) is: a due date is a calendar day.
-- A timestamp would make "overdue" depend on whichever timezone wrote it. cycles.started_at /
-- ended_at already exist and mean when execution actually began and finished, so these are separate
-- planned dates, not a reuse of them.
--
-- start_date is NULL for every existing plan/run (the UI requires it on create from now on, the API
-- defaults it to the creation day); due_date NULL = no due date.
ALTER TABLE plans  ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE plans  ADD COLUMN IF NOT EXISTS due_date   DATE;
ALTER TABLE cycles ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE cycles ADD COLUMN IF NOT EXISTS due_date   DATE;

-- "Due Date cannot be earlier than Start Date", enforced below the API too, so no write path (MCP,
-- automation ingest, a future one) can store an inverted range.
ALTER TABLE plans  DROP CONSTRAINT IF EXISTS plans_due_not_before_start;
ALTER TABLE plans  ADD  CONSTRAINT plans_due_not_before_start  CHECK (due_date IS NULL OR start_date IS NULL OR due_date >= start_date);
ALTER TABLE cycles DROP CONSTRAINT IF EXISTS cycles_due_not_before_start;
ALTER TABLE cycles ADD  CONSTRAINT cycles_due_not_before_start CHECK (due_date IS NULL OR start_date IS NULL OR due_date >= start_date);

-- The due-date sweep only ever looks at rows that have a due date.
CREATE INDEX IF NOT EXISTS idx_plans_due_date  ON plans(due_date)  WHERE due_date IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cycles_due_date ON cycles(due_date) WHERE due_date IS NOT NULL AND deleted_at IS NULL;

-- IANA zone name. Default Asia/Kolkata to match the nightly sweeps, which already anchor on IST.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata';
