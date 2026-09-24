-- Ticket keys have no length limit: every column a Jira/Linear issue key passes through becomes TEXT.
--
-- Before this, all four were VARCHAR(64) (V12, V13, V47, V66). A key longer than that — the
-- Requirements page and the API both accept an explicit key — failed the Zyra save outright with a
-- truncation error at the testcases write, because the save stamps the task's key onto each test
-- case it creates. integration_ticket_comments.issue_key (V123) is TEXT from the start for the same
-- reason, so the ticket auto-comment can record any key a test case can carry.
--
-- VARCHAR(n) -> TEXT is binary-compatible in Postgres: a catalog-only change, with no table rewrite
-- and no index rebuild, so this is cheap on the shared database.
--
-- testcases_active (V64) is `SELECT * FROM testcases`, and Postgres refuses to change the type of a
-- column a view depends on. It is dropped and recreated with its V64 definition around the ALTER;
-- the migrator runs this file in one transaction, so no reader ever sees it missing. Because the
-- definition is `SELECT *`, recreating it also refreshes its frozen column list to include columns
-- added to testcases since V64 — a pure superset. Nothing else depends on the view, and its readers
-- in legacy.service.ts name their columns or aggregate, so none of them changes behaviour.
DROP VIEW testcases_active;

ALTER TABLE testcases ALTER COLUMN jira_issue_key TYPE TEXT;
ALTER TABLE testcases ALTER COLUMN linear_issue_key TYPE TEXT;
ALTER TABLE jira_tickets ALTER COLUMN jira_issue_key TYPE TEXT;
ALTER TABLE linear_tickets ALTER COLUMN linear_issue_key TYPE TEXT;

CREATE VIEW testcases_active AS SELECT * FROM testcases WHERE deleted_at IS NULL;
