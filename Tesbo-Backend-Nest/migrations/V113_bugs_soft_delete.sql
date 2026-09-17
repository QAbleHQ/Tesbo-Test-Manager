-- Soft-delete bugs. deleteBug (legacy.service.ts) issues a real `DELETE FROM bugs` today, and
-- bug_links.bug_id is ON DELETE CASCADE (V48), so deleting a bug also destroys every trace link
-- recording which run/test case/execution it was found against, with no audit trail anywhere.
-- See "Zyra Workflow Agents/hard-delete-remediation-progress-log.md", Phase 3, for the full audit.

ALTER TABLE bugs
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by UUID REFERENCES actors(id) ON DELETE SET NULL;

CREATE INDEX idx_bugs_active ON bugs(project_id) WHERE deleted_at IS NULL;

-- Hardening, matching V110/V111's treatment of suites.parent_id / cycle_items.cycle_id: once
-- deleteBug stops issuing a real DELETE, this CASCADE never fires on its only reachable
-- application path any more, but left as CASCADE it stays live and dangerous against any future
-- raw `DELETE FROM bugs`. RESTRICT makes that fail loudly instead of silently destroying links.
-- bug_links itself is not soft-deleted by this migration (a separate, explicitly-ruled phase,
-- "hard-delete-remediation-progress-log.md" Q-BL) — a soft-deleted bug's links simply survive,
-- physically live, in bug_links, harmless because every read of bug_links in the codebase is
-- reached through a bug-scoped query that already filters bugs.deleted_at (bugSelect).
ALTER TABLE bug_links DROP CONSTRAINT bug_links_bug_id_fkey;
ALTER TABLE bug_links
  ADD CONSTRAINT bug_links_bug_id_fkey FOREIGN KEY (bug_id) REFERENCES bugs(id) ON DELETE RESTRICT;
