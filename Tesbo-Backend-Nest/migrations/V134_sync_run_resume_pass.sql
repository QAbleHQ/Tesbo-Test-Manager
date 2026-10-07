-- A sync stops at MAX_TICKETS_PER_RUN tickets. Every provider fetch is newest-updated first and
-- nothing remembered how far a run got, so the next Sync started at the top again and re-synced the same
-- newest tickets; the rest of a larger backlog was never reached.
--
-- A "pass" is one walk through the whole backlog, which may take several runs. These columns let the next
-- run continue the pass instead of restarting it:
--
--   truncated     The run was cut off by the cap, so the pass is unfinished. The next run for the same
--                 project + provider continues it. FALSE (the default) means the pass reached the end of the
--                 backlog, so the next Sync starts a fresh pass.
--   window_start  When the pass began; a continuation inherits it. A ticket whose row was synced at/after
--                 this instant (and is unchanged upstream) is already done in this pass and is skipped, so
--                 the cap counts only tickets that still need syncing. The nightly incremental cursor also
--                 reads this instead of started_at, so a pass that took several runs does not skip tickets
--                 edited while it was still going.
--   sync_since    The `since` (nightly incremental window) the pass was started with. A continuation keeps
--                 it, so it keeps walking the same set of tickets the first run was walking.
--
-- Nullable / defaulted with no backfill: a run recorded before this was never resumable, and a NULL
-- window_start reads as "this run's own started_at".
ALTER TABLE integration_sync_runs
  ADD COLUMN truncated    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN window_start TIMESTAMPTZ,
  ADD COLUMN sync_since   TIMESTAMPTZ;
