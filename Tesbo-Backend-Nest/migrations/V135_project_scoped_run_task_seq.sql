-- Readable URLs (/projects/LOH/cycles/LOH-RUN-5, /projects/LOH/agents/tasks/LOH-TASK-3).
-- Bugs (<KEY>-BUG-n, V104) and test cases (<KEY>-TC-n) already carry a stored per-project id; runs
-- (cycles) and Zyra tasks (ai_generation_requests) only had a uuid. `seq` is the per-project number
-- the application renders as <KEY>-RUN-<seq> / <KEY>-TASK-<seq>. It is never reused: soft-deleted rows
-- keep their number, so a link to a deleted run cannot start resolving to a different one.
--
-- Assigned by trigger rather than in application code because runs are inserted from many paths
-- (create, from-plan, from-cases, schedules, CI createRun, MCP) and a missed path would leave a
-- NULL seq and an unreachable readable URL.

ALTER TABLE cycles ADD COLUMN IF NOT EXISTS seq INT;
ALTER TABLE ai_generation_requests ADD COLUMN IF NOT EXISTS seq INT;

WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY created_at, id) AS n
    FROM cycles WHERE seq IS NULL
)
UPDATE cycles SET seq = numbered.n FROM numbered WHERE cycles.id = numbered.id;

WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY created_at, id) AS n
    FROM ai_generation_requests WHERE seq IS NULL
)
UPDATE ai_generation_requests SET seq = numbered.n FROM numbered WHERE ai_generation_requests.id = numbered.id;

CREATE OR REPLACE FUNCTION assign_project_seq() RETURNS trigger AS $$
BEGIN
  IF NEW.seq IS NULL THEN
    -- Serialises concurrent inserts for the same project/table so two runs created at once
    -- cannot both read the same MAX.
    PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_NAME || ':' || NEW.project_id::text)::bigint);
    EXECUTE format('SELECT COALESCE(MAX(seq), 0) + 1 FROM %I WHERE project_id = $1', TG_TABLE_NAME)
      INTO NEW.seq USING NEW.project_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cycles_assign_seq ON cycles;
CREATE TRIGGER cycles_assign_seq BEFORE INSERT ON cycles
  FOR EACH ROW EXECUTE FUNCTION assign_project_seq();

DROP TRIGGER IF EXISTS ai_generation_requests_assign_seq ON ai_generation_requests;
CREATE TRIGGER ai_generation_requests_assign_seq BEFORE INSERT ON ai_generation_requests
  FOR EACH ROW EXECUTE FUNCTION assign_project_seq();

CREATE UNIQUE INDEX IF NOT EXISTS idx_cycles_project_seq ON cycles (project_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_generation_requests_project_seq ON ai_generation_requests (project_id, seq);
