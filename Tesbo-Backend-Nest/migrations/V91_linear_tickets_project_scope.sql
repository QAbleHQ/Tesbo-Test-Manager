-- linear_tickets was created in V47 with UNIQUE (integration_connection_id, linear_issue_id) --
-- no project_id. jira_tickets had the identical shape and was widened in that same migration
-- (jira_tickets_connection_issue_project_key UNIQUE (jira_connection_id, jira_issue_id, project_id))
-- because one org-level connection can be mapped into several Tesbo projects; linear_tickets was
-- added fresh in V47 and simply didn't get the same fix. Net effect today: if two Tesbo projects
-- are ever mapped to the same remote Linear team, syncing one silently overwrites the other's
-- mirrored ticket rows on (integration_connection_id, linear_issue_id) conflict -- the same bug
-- V72's own comment documents happening to knowledge_documents before it was fixed there.
--
-- Purely additive/widening: a superset key can't conflict with any existing row (anything already
-- distinct on the 2-column key stays distinct on the 3-column key), so no backfill is needed.
DO $$
DECLARE conname text;
BEGIN
  SELECT tc.constraint_name INTO conname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_name = tc.table_name
  WHERE tc.table_name = 'linear_tickets' AND tc.constraint_type = 'UNIQUE' AND kcu.column_name = 'linear_issue_id';
  EXECUTE format('ALTER TABLE linear_tickets DROP CONSTRAINT %I', conname);
END $$;

ALTER TABLE linear_tickets
  ADD CONSTRAINT linear_tickets_connection_issue_project_key UNIQUE (integration_connection_id, linear_issue_id, project_id);
