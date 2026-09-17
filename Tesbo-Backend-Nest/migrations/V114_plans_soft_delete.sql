-- Soft-delete plans and plan_items. deletePlan/deletePlanItem (legacy.service.ts) issue real
-- DELETEs today, and plan_items.plan_id is ON DELETE CASCADE (V3), so deleting a plan silently
-- destroys every item in it with no audit trail. See
-- "Zyra Workflow Agents/hard-delete-remediation-progress-log.md", Phase 4, for the full audit.

ALTER TABLE plans
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by UUID REFERENCES actors(id) ON DELETE SET NULL;

ALTER TABLE plan_items
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by UUID REFERENCES actors(id) ON DELETE SET NULL;

CREATE INDEX idx_plans_active ON plans(project_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_plan_items_active ON plan_items(plan_id) WHERE deleted_at IS NULL;

-- Hardening, matching V110/V111/V113's treatment of the same CASCADE pattern: once deletePlan
-- stops issuing a real DELETE, this constraint never fires on its only reachable application path
-- any more, but left as CASCADE it stays live and dangerous against any future raw
-- `DELETE FROM plans`. RESTRICT makes that fail loudly instead of silently destroying items.
ALTER TABLE plan_items DROP CONSTRAINT plan_items_plan_id_fkey;
ALTER TABLE plan_items
  ADD CONSTRAINT plan_items_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE RESTRICT;
