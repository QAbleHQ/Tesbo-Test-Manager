-- idx_integration_sync_runs_nightly_cycle (V90) is supposed to cap nightly-triggered sync runs at
-- one per (project, provider) per IST calendar day, but a unique index never treats two NULLs as
-- colliding — so any writer that inserts trigger_source='nightly' without also setting
-- nightly_cycle_date silently evades the dedup entirely. That's exactly what happened: a second,
-- out-of-date backend process (predating this codebase's nightly_cycle_date wiring) has been
-- running nightly-sync jobs against this same database, producing phantom duplicate runs every
-- night since Sep 4 with nightly_cycle_date left NULL — invisible for Jira (the duplicate run just
-- quietly repeats "no changes"), but visibly failing for Linear once the mapped entity happened to
-- be a Linear Project rather than a Team, because that stale code also predates Project-mapping
-- support and always queried Linear's team(id:...) field.
--
-- This doesn't fix which process is stale (that's an infra/deploy problem, not a schema one) — it
-- makes the failure mode impossible to reintroduce silently: any future writer that forgets to set
-- nightly_cycle_date on a nightly-triggered row now gets a loud constraint violation instead of a
-- row that quietly bypasses the dedup index.
--
-- Backfill first: existing nightly rows already have NULL cycle dates (the historical stale-writer
-- rows this incident produced). A CHECK constraint validates every existing row immediately on ADD,
-- so this has to run before it or the migration fails outright.
--
-- These NULL rows are, by construction, phantom duplicates of a same-night run that already holds
-- the real nightly_cycle_date for that (project, provider, day) — that's the entire bug. Backfilling
-- them to their "real" IST calendar date (created_at + 5:30) re-proves that on every run of this
-- migration: it collides with idx_integration_sync_runs_nightly_cycle, the very index they evaded.
-- There is no accurate, collision-free date to give them, and there doesn't need to be — they're
-- dead, terminal rows; nothing reads nightly_cycle_date off a historical row for anything other than
-- that one dedup check. So each gets a distinct, clearly out-of-band placeholder (far outside any
-- date this feature could ever have produced) purely to satisfy "not null," ordered by id so the
-- values are at least stable and reproducible if this migration is ever re-examined.
UPDATE integration_sync_runs r
SET nightly_cycle_date = '1970-01-01'::date - sub.rn::int
FROM (
  SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn
  FROM integration_sync_runs
  WHERE trigger_source = 'nightly' AND nightly_cycle_date IS NULL
) sub
WHERE r.id = sub.id;

ALTER TABLE integration_sync_runs
  ADD CONSTRAINT chk_nightly_cycle_date CHECK (trigger_source <> 'nightly' OR nightly_cycle_date IS NOT NULL);
