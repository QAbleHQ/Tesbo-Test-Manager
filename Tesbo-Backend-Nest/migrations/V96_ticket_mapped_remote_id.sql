-- jira_tickets/linear_tickets only ever recorded the Tesbo project_id, never which remote Jira
-- project / Linear team-or-project actually produced a row. So once a Tesbo project's mapping was
-- ever switched to a different remote entity, every ticket from every past entity kept showing up
-- forever alongside the current one (WHERE project_id = $1 alone can't tell them apart). This adds
-- the missing provenance column so reads can scope to "the currently mapped entity only".
ALTER TABLE jira_tickets   ADD COLUMN mapped_remote_id VARCHAR(128);
ALTER TABLE linear_tickets ADD COLUMN mapped_remote_id VARCHAR(128);

CREATE INDEX idx_jira_tickets_mapped_remote   ON jira_tickets(project_id, mapped_remote_id);
CREATE INDEX idx_linear_tickets_mapped_remote ON linear_tickets(project_id, mapped_remote_id);

-- One-time backfill via issue-key prefix: Jira project keys and Linear team keys can never contain
-- '-', so the substring before the first '-' in an issue key reliably names the source project/team
-- for every mapping this project has ever had (current or since-disabled) -- this is only safe as a
-- one-time derivation; every ticket synced from here on is tagged directly at sync time instead.
-- Linear project-mode mappings are skipped (entity_type='project'): a project-mode issue key is
-- still team-key-prefixed, so it can't be matched back to its project via prefix. Those rows stay
-- NULL until their next sync re-tags them -- acceptable since project-mode is new with negligible
-- existing data.
UPDATE jira_tickets jt SET mapped_remote_id = m.jira_project_id
FROM jira_project_mappings m
WHERE m.project_id = jt.project_id
  AND split_part(jt.jira_issue_key, '-', 1) = m.jira_project_key;

UPDATE linear_tickets lt SET mapped_remote_id = m.linear_team_id
FROM linear_project_mappings m
WHERE m.project_id = lt.project_id
  AND m.entity_type = 'team'
  AND split_part(lt.linear_issue_key, '-', 1) = m.linear_team_key;
