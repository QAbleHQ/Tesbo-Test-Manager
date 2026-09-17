-- Soft-delete attachments — metadata-only, by explicit decision (Q-AT, hard-delete remediation
-- progress log, "Soft-delete the row anyway (metadata-only)"). deleteBugAttachment already deletes
-- the object from storage first (storage.delete()), so a soft-deleted row can never actually be
-- restored — this exists purely so who deleted which evidence, and when, is recoverable via the
-- row itself even though the file content is not. attachments has no FK to any parent table
-- (polymorphic entity_type/entity_id), so unlike every other phase there is no CASCADE to harden.

ALTER TABLE attachments
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by UUID REFERENCES actors(id) ON DELETE SET NULL;

CREATE INDEX idx_attachments_active ON attachments(entity_type, entity_id) WHERE deleted_at IS NULL;
