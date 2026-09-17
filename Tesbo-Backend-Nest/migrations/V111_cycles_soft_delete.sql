-- Soft-delete cycles and cycle_items, closing the bypass of the existing executions.deleted_at
-- convention (V60): deleteCycle, removeCycleTestCase and removeCycleTestCases (legacy.service.ts)
-- issue real `DELETE FROM cycles` / `DELETE FROM cycle_items` today, which — combined with
-- cycle_items.cycle_id and executions.cycle_item_id both being ON DELETE CASCADE (V3) — silently
-- hard-deletes every execution in a run (and, from there, evidence attachments, which have no FK
-- to executions at all and are simply orphaned) even though executions already had a deleted_at
-- column that nothing ever wrote to. See
-- "Zyra Workflow Agents/hard-delete-remediation-progress-log.md", Phase 1, for the full audit this
-- migration is part of.

ALTER TABLE cycles
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by UUID REFERENCES actors(id) ON DELETE SET NULL;

ALTER TABLE cycle_items
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by UUID REFERENCES actors(id) ON DELETE SET NULL;

CREATE INDEX idx_cycles_active ON cycles(project_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_cycle_items_active ON cycle_items(cycle_id) WHERE deleted_at IS NULL;

-- Hardening, matching V110's treatment of suites.parent_id: once deleteCycle / removeCycleTestCase
-- / removeCycleTestCases stop issuing real DELETEs, these two CASCADEs never fire on their only
-- reachable application path any more — but left as CASCADE they stay live and dangerous against
-- any *future* raw `DELETE FROM cycles` / `DELETE FROM cycle_items` (a debugging one-liner, a
-- script), which would silently destroy execution history the same way today's bug does.
-- Converting to RESTRICT makes that fail loudly instead of cascading.
ALTER TABLE cycle_items DROP CONSTRAINT cycle_items_cycle_id_fkey;
ALTER TABLE cycle_items
  ADD CONSTRAINT cycle_items_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE RESTRICT;

ALTER TABLE executions DROP CONSTRAINT executions_cycle_item_id_fkey;
ALTER TABLE executions
  ADD CONSTRAINT executions_cycle_item_id_fkey FOREIGN KEY (cycle_item_id) REFERENCES cycle_items(id) ON DELETE RESTRICT;

-- cycle_items_cycle_id_testcase_id_key (V78/V79) enforced uniqueness across ALL rows, active or
-- not. Once removeCycleTestCase(s) stops deleting the row and instead stamps deleted_at, a
-- soft-deleted cycle_item would permanently block re-adding the same test case to the same run —
-- addCycleTestCases' and attachCases' `ON CONFLICT (cycle_id, testcase_id) DO NOTHING` would
-- silently no-op the re-add forever, which would look to a user exactly like the "re-add rejects
-- with no error" bug V78/V79 fixed for duplicates, just triggered a different way.
--
-- Made partial so only the active (non-deleted) row participates in the constraint: re-adding a
-- removed case inserts a brand-new cycle_item/execution pair (matching today's actual behavior,
-- since today's hard delete already makes every re-add a fresh row), while the old row survives
-- underneath as pure history — zero special-casing needed in executions' own UNIQUE(cycle_item_id),
-- because the new cycle_item gets a new id. Decided over the resurrect-on-conflict alternative;
-- see "Decisions requiring approval" in the progress log, 2026-09-16 14:51 IST.
ALTER TABLE cycle_items DROP CONSTRAINT cycle_items_cycle_id_testcase_id_key;
CREATE UNIQUE INDEX cycle_items_cycle_id_testcase_id_key
  ON cycle_items (cycle_id, testcase_id) WHERE deleted_at IS NULL;
