-- cycle_items has only ever snapshotted a test case's title (V3's snapshot_title). Every other
-- field a run's execution list, detail panel, CSV export, and reports read — external id, priority,
-- type, suite, description, preconditions, postconditions, steps, test data, automation
-- status/tags — is pulled live via `LEFT JOIN testcases t ON t.id = ci.testcase_id AND t.deleted_at
-- IS NULL`. Soft-deleting the source test case (V59) makes that join fail, so all of it goes NULL
-- and a past run's history reads as blank/"—" even though the execution's own status, actual
-- result, executed_at and defect data are untouched. A run is meant to be a point-in-time record;
-- it should not depend on the live test case surviving to keep rendering.
--
-- Columns are prefixed `snapshot_` to match the existing snapshot_title convention. No FK on
-- snapshot_suite_id: it is display/grouping data captured at add-time, not a live reference — the
-- suite it names may itself be renamed, moved or deleted afterwards without that affecting history.

ALTER TABLE cycle_items
  ADD COLUMN snapshot_external_id VARCHAR(32),
  ADD COLUMN snapshot_priority VARCHAR(8),
  ADD COLUMN snapshot_type VARCHAR(32),
  ADD COLUMN snapshot_suite_id UUID,
  ADD COLUMN snapshot_description TEXT,
  ADD COLUMN snapshot_preconditions TEXT,
  ADD COLUMN snapshot_postconditions TEXT,
  ADD COLUMN snapshot_steps JSONB,
  ADD COLUMN snapshot_test_data TEXT,
  ADD COLUMN snapshot_automation_status VARCHAR(32),
  ADD COLUMN snapshot_automation_tags VARCHAR(512);

-- Backfill every existing cycle_item from its test case now, including ones whose test case has
-- already been soft-deleted: soft delete leaves the row (and its field values) in place, so this
-- recovers the history that today's live-join already broke, not just future adds. A row whose
-- test case has since been hard-deleted (should not happen post-V59, but pre-existing data may
-- predate it) simply gets no backfill and keeps reading through the live join as it does today.
UPDATE cycle_items ci
   SET snapshot_external_id = t.external_id,
       snapshot_priority = t.priority,
       snapshot_type = t.type,
       snapshot_suite_id = t.suite_id,
       snapshot_description = t.description,
       snapshot_preconditions = t.preconditions,
       snapshot_postconditions = t.postconditions,
       snapshot_steps = t.steps,
       snapshot_test_data = t.test_data,
       snapshot_automation_status = t.automation_status,
       snapshot_automation_tags = t.automation_tags
  FROM testcases t
 WHERE t.id = ci.testcase_id;
