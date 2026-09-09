-- Bugs get the same per-project sequential key test cases already have (<KEY>-TC-<n>), so every
-- bug has a stable, human-friendly identifier even when it is never linked to an external tracker
-- (Jira/Linear). integration_issue_key stays null for a self-logged bug, and "Bug Key" in the Test
-- Run / Test Case Detail UI had nothing to fall back to for it.

ALTER TABLE bugs ADD COLUMN IF NOT EXISTS external_id VARCHAR(32);

-- Backfill existing rows in creation order, per project, using each project's own short key —
-- normalized the same way the application's externalIdPrefix() normalizes it for new rows
-- (uppercase, alphanumeric only, max 3 chars, "TC" if that leaves nothing). Some existing
-- projects' `key` column predates that normalization being enforced everywhere and can be
-- longer or contain other characters; without normalizing here too, a long key made the
-- computed id overflow external_id's VARCHAR(32).
WITH prefixed AS (
  SELECT b.id, b.project_id, b.created_at,
         NULLIF(LEFT(regexp_replace(upper(COALESCE(p.key, '')), '[^A-Z0-9]', '', 'g'), 3), '') AS key
    FROM bugs b
    JOIN projects p ON p.id = b.project_id
   WHERE b.external_id IS NULL
),
numbered AS (
  SELECT id, COALESCE(key, 'TC') || '-BUG-' || row_number() OVER (PARTITION BY project_id ORDER BY created_at, id) AS computed_id
    FROM prefixed
)
UPDATE bugs SET external_id = numbered.computed_id
  FROM numbered
 WHERE bugs.id = numbered.id;

ALTER TABLE bugs ALTER COLUMN external_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bugs_project_external ON bugs(project_id, external_id);
