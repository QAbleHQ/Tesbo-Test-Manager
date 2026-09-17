-- Follow-up to V111_cycles_soft_delete.sql, closing the one gap that migration's own commit
-- explicitly left open (see "Zyra Workflow Agents/hard-delete-remediation-progress-log.md",
-- Phase 1 change log, "known, explicitly out-of-scope-for-Phase-1 gap"): `idx_cycles_project_
-- external_id` (V84) still enforces uniqueness of (project_id, external_id) across ALL rows,
-- soft-deleted or not.
--
-- Consequence today: once a run is soft-deleted (V111), a CI shard that resubmits the same
-- externalId cannot open a fresh run -- a real INSERT would violate this very index -- so
-- createRun's idempotency lookup resolves back to the dead row instead, and attachCases' own
-- EXISTS guard then refuses to write into it. The reuse response is `reused: true` describing a
-- run nobody can ever add results to again, with casesAttached always 0. That is a correctness
-- gap, not just a cosmetic one: the CI build has no way to get a *working* run for that
-- externalId ever again.
--
-- Mirrors the precedent this same migration set already established for `cycle_items_cycle_id_
-- testcase_id_key` (V111): make the unique index partial on `deleted_at IS NULL` so only the
-- live row participates in the constraint, and a resubmit after a delete creates a genuine new
-- run instead of colliding with history. The old row survives underneath, untouched, as
-- history -- exactly like the V111 precedent's re-added cycle_item.
DROP INDEX idx_cycles_project_external_id;

CREATE UNIQUE INDEX idx_cycles_project_external_id
  ON cycles (project_id, external_id)
  WHERE external_id IS NOT NULL AND deleted_at IS NULL;
