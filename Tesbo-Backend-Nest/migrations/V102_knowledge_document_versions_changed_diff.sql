-- Change History for a manually-created document recomputed the full diff of EVERY version pair
-- on every single page view (buildManualDocumentHistory in legacy.service.ts) — a document with a
-- long timeline paid that cost again for page 1, page 2, ... page 14, which is what made paging
-- visibly slow. The diff between a version and whatever superseded it never changes once a newer
-- version exists, so it is now computed once, at write time (updateKnowledgeDocument /
-- restoreKnowledgeDocumentVersion), and stored here instead of recomputed on every read.
-- Nullable and NOT backfilled by this migration: a NULL row is a version written before this
-- change shipped, and the read path computes its diff inline (once) the first time it's paged
-- into view and caches the result back onto the row, so old documents self-heal without a
-- separate batch job against production data.
ALTER TABLE knowledge_document_versions
  ADD COLUMN changed_summary TEXT,
  ADD COLUMN changed_fields JSONB;
