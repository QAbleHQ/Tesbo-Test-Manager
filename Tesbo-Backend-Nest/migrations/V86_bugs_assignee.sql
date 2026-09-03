-- Bug assignee ("[Test Runs] Unable to assign test cases for execution"): bugs need the same
-- "assign to a project member" concept executions.assignee_id already has.
--
-- References actors(id), not users(id), for the same reason executions.assignee_id was repointed
-- in V60: a single FK that can name either a human user or an AI agent identity, with no separate
-- column, and a single actor_profiles join to resolve a display name either way.

ALTER TABLE bugs ADD COLUMN IF NOT EXISTS assignee_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bugs_assignee_id_fkey' AND conrelid = 'bugs'::regclass
  ) THEN
    ALTER TABLE bugs
      ADD CONSTRAINT bugs_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES actors(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_bugs_assignee ON bugs (assignee_id) WHERE assignee_id IS NOT NULL;
