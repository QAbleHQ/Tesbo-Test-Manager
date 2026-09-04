-- linear_tickets.summary / jira_tickets.summary are free-text issue titles capped at
-- VARCHAR(1024), with no real reason to be — description/labels are already TEXT in these same
-- tables. A title over 1024 chars threw a raw Postgres "value too long" error that aborted the
-- entire sync run (see integration-sync.processor.ts's upsertTicket/onPage), and because
-- incremental syncs cursor off the last *successful* run, that failure was permanent for the
-- affected project until the title was manually shortened in the source tracker. TEXT removes the
-- limit at its source for both providers.
--
-- Metadata-only change in Postgres (VARCHAR(n) and TEXT share the same on-disk representation) —
-- no table rewrite, no lock contention risk. NOT NULL is preserved automatically.
ALTER TABLE linear_tickets ALTER COLUMN summary TYPE TEXT;
ALTER TABLE jira_tickets ALTER COLUMN summary TYPE TEXT;
