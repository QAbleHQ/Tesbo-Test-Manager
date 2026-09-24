-- A Linear Project has no human-readable key, so a Project mapping (V95) stores its opaque slugId
-- (e.g. "4081f3c6e1df") in linear_team_key — and remote_project_key, which the Requirements sync
-- panel displays, copies that. This records the mapped name alongside it so the panel can show
-- "Namm Orange HRMS Project" instead. Snapshotted per run rather than joined at read time, so a
-- later remap doesn't relabel history.
--
-- Written for Linear runs only; Jira keeps displaying its key. Nullable with no backfill: runs
-- recorded before this have no name and the panel falls back to the key for them.
ALTER TABLE integration_sync_runs
  ADD COLUMN remote_project_name VARCHAR(512);
