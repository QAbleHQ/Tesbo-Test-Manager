-- linear_project_mappings has only ever stored Linear TEAM data in linear_team_id/key/name,
-- despite the table's name — Linear's actual "Project" entity (a separate, optional,
-- often-cross-team grouping of issues) was never mappable. This adds Project-mapping support by
-- reusing the same columns generically: a Linear Project's id/slugId/name land in the same
-- linear_team_id/key/name slots a Team's would. Every existing reader (integration-sync's
-- mappingSql and listNightlySyncTargets, legacy.service.ts's linearStatus/startIntegrationSync/
-- linearSearchIssues/integrationStatus) already treats these columns as generic remote_id/
-- remote_key/remote_name aliases, so none of them need to change — entity_type is the only new
-- thing, and it exists purely to disambiguate what's actually stored in a given row.
--
-- Every existing row defaults to 'team', which is exactly correct: every row that exists today
-- genuinely is a team mapping. No backfill needed.
ALTER TABLE linear_project_mappings
  ADD COLUMN entity_type VARCHAR(16) NOT NULL DEFAULT 'team' CHECK (entity_type IN ('team', 'project'));
