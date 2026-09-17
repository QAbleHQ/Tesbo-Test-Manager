-- Soft-delete suites, mirroring V59's convention for testcases: a suite is never physically
-- removed by the application any more, only marked with deleted_at/deleted_by. Before this,
-- deleteSuite (legacy.service.ts) issued a real `DELETE FROM suites WHERE id = $1` — which,
-- combined with parent_id's ON DELETE CASCADE below, silently hard-deleted the entire descendant
-- suite subtree, and, via the further cascade off `testcases`, every bit of history attached to
-- the testcases in it (testcase_versions, cycle_items/executions, custom_field_values, ...) even
-- though several of those tables have their own soft-delete column that this path bypassed
-- entirely. See "Zyra Workflow Agents/zyra-context-integrity-progress-log.md" (Phase 3/4) for the
-- full audit this migration is part of.

ALTER TABLE suites
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by UUID REFERENCES actors(id) ON DELETE SET NULL;

CREATE INDEX idx_suites_active ON suites(project_id) WHERE deleted_at IS NULL;

-- Convenience view for parity with V64's testcases_active/executions_active. Genuinely optional
-- decoration: only the handful of simple `FROM suites` aggregate call sites use it as a drop-in
-- (see legacy.service.ts's `analytics`); every recursive-CTE or JOIN call site instead spells
-- `deleted_at IS NULL` inline, matching how testcases.deleted_at is used everywhere else in that
-- file.
CREATE VIEW suites_active AS SELECT * FROM suites WHERE deleted_at IS NULL;

-- Hardening, not a mechanical requirement of the soft-delete working: once deleteSuite stops
-- issuing a real DELETE, this CASCADE never fires on its only reachable path today — but it stays
-- live and dangerous against any *future* code that issues a raw `DELETE FROM suites` by accident
-- (a debugging one-liner, a script), which would silently destroy the whole descendant subtree the
-- same way today's bug did. Converting to RESTRICT makes that fail loudly instead of cascading.
-- Direct precedent for altering a constraint's delete action this way, not just adding a column:
-- V59_testcases_soft_delete_and_actors.sql drops and re-adds testcases_owner_id_fkey with a new
-- ON DELETE clause.
ALTER TABLE suites DROP CONSTRAINT suites_parent_id_fkey;
ALTER TABLE suites ADD CONSTRAINT suites_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES suites(id) ON DELETE RESTRICT;
