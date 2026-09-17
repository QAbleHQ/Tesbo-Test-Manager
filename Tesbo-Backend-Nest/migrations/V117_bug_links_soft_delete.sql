-- Soft-delete bug_links, per Q-BL's ruling ("soft-delete it properly", hard-delete remediation
-- progress log) — chosen over the cheaper audit-log-only alternative despite bug_links being a
-- pure association row, because it is the documented source of truth for bug traceability reads
-- (V48) and replaceBugLinks currently does a blind delete-all-then-reinsert on every bug edit.
-- See "Zyra Workflow Agents/hard-delete-remediation-progress-log.md", Phase 7, for the full audit.

ALTER TABLE bug_links
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by UUID REFERENCES actors(id) ON DELETE SET NULL;

CREATE INDEX idx_bug_links_active ON bug_links(bug_id) WHERE deleted_at IS NULL;

-- The plain UNIQUE (bug_id, testcase_id, cycle_id) constraint (V48) enforced uniqueness across ALL
-- rows, active or not. Once removeBugLink/replaceBugLinks stop deleting the row and instead stamp
-- deleted_at, a soft-deleted link would permanently block re-linking the same bug to the same
-- testcase/cycle pair — addBugLink's and replaceBugLinks' `ON CONFLICT ... DO NOTHING` inserts
-- would silently no-op the re-link forever. Made partial, same decision already made for
-- cycle_items (V111) and cycles.external_id (V112): only the active row participates, a re-link
-- inserts a brand-new row, the old one survives underneath as history.
ALTER TABLE bug_links DROP CONSTRAINT bug_links_bug_id_testcase_id_cycle_id_key;
CREATE UNIQUE INDEX bug_links_bug_id_testcase_id_cycle_id_key
  ON bug_links (bug_id, testcase_id, cycle_id) WHERE deleted_at IS NULL;
