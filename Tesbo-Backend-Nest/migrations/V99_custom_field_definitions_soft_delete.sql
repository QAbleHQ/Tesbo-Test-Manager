-- Custom field definitions: switch "Delete" from a hard DELETE to soft-delete, matching the
-- treatment already given to testcases (V59) and executions (V60). Independent of `status`
-- (active/inactive/archived) for the same reason it's independent there — a field can be
-- archived-and-deleted, active-and-deleted, etc.
--
-- Without this, a field with any recorded value could never be deleted (only archived), and an
-- archived field that also happened to be in use had no lifecycle action left at all: Edit/
-- Deactivate/Archive are hidden once archived, and the old delete endpoint refused any in-use
-- field regardless of status. Soft-delete removes that dead end.

ALTER TABLE custom_field_definitions
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by UUID REFERENCES actors(id) ON DELETE SET NULL;

CREATE INDEX idx_custom_field_definitions_active ON custom_field_definitions(project_id) WHERE deleted_at IS NULL;

-- Replace the status-only partial uniqueness index: a deleted field's name must free up
-- immediately, the same way an archived field's name already does, regardless of status.
DROP INDEX idx_custom_field_definitions_project_name_active;
CREATE UNIQUE INDEX idx_custom_field_definitions_project_name_active
  ON custom_field_definitions(project_id, lower(name)) WHERE status <> 'archived' AND deleted_at IS NULL;
