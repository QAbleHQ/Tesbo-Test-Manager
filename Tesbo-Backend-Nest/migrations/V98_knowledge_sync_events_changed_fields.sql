-- Change History polish: the popover's plain "what changed" sentence stays, but large or
-- multi-field changes now also carry a structured per-field diff (old/new excerpts) so the UI can
-- show a compact badge with an on-demand "View diff" modal instead of an ever-growing sentence.
-- Nullable and backfilled with nothing — historical rows fall back to the plain sentence, no diff
-- button, which is a strict subset of what they already rendered.
ALTER TABLE knowledge_document_sync_events
  ADD COLUMN changed_fields JSONB;
