-- At most one nightly-triggered run per (project, provider) per calendar day in NIGHTLY_SYNC_TZ
-- ("Asia/Kolkata"), regardless of that run's outcome. Guards against the nightly orchestrator being
-- invoked more than once for the same cron slot: observed in production forensics, a backend/Redis
-- restart landed in a window where BullMQ's Job Scheduler produced an extra, unscheduled orchestrator
-- fire ~10h21m after the legitimate midnight-IST run, creating a second full batch of sync runs (all
-- of which failed, surfacing as spurious "Jira sync failed" cards). Manual Sync is unaffected — this
-- only applies to trigger_source = 'nightly'.
--
-- The IST calendar day is computed in application code (IntegrationSyncService.nightlyCycleDate) and
-- stored here as a plain column, rather than derived by the index itself via
-- `date_trunc('day', created_at AT TIME ZONE 'Asia/Kolkata')`. That was this migration's first
-- version, and it failed to create: Postgres marks `AT TIME ZONE` on a timestamptz as STABLE, not
-- IMMUTABLE (the IANA tz database can change over time), and an index expression must be IMMUTABLE.
-- A plain stored column sidesteps the restriction entirely — Asia/Kolkata has a permanent, unchanging
-- +5:30 offset (no DST since 1945), so computing it once in application code is exact, not a hack.
ALTER TABLE integration_sync_runs
  ADD COLUMN nightly_cycle_date DATE;

-- NULL for every manual-triggered run, and a unique index never treats two NULLs as colliding, so
-- this only ever constrains trigger_source = 'nightly' rows against each other.
CREATE UNIQUE INDEX idx_integration_sync_runs_nightly_cycle
  ON integration_sync_runs (project_id, provider, nightly_cycle_date)
  WHERE trigger_source = 'nightly';
