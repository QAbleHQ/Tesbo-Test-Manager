--liquibase formatted sql

--changeset bettercases:v13-testcase-jira-link
ALTER TABLE testcases ADD COLUMN IF NOT EXISTS jira_issue_key VARCHAR(64);
ALTER TABLE testcases ADD COLUMN IF NOT EXISTS jira_url VARCHAR(512);
CREATE INDEX IF NOT EXISTS idx_testcases_jira_issue_key ON testcases (jira_issue_key) WHERE jira_issue_key IS NOT NULL;
