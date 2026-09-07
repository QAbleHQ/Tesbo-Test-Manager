-- integrationDisconnect used to DELETE the integration_connections row, which CASCADEd onto every
-- jira_tickets/linear_tickets/jira_project_mappings/linear_project_mappings row for that connection
-- -- silently destroying every synced ticket the moment a workspace disconnected Jira or Linear.
-- disconnected_at turns disconnect into a state flip instead: the row (and everything referencing
-- it) survives, credentials are cleared so it can't be used live, and reconnecting revives the same
-- row via the existing INSERT ... ON CONFLICT (organization_id, provider) DO UPDATE, keeping every
-- historical ticket/mapping attached to a stable connection id.
ALTER TABLE integration_connections ADD COLUMN disconnected_at TIMESTAMPTZ;
