-- knowledge_document_versions had no uniqueness guard on (document_id, version_number): a
-- concurrent restore and edit could both read the same MAX(version_number)+1 and insert the same
-- number for the same document, before the advisory-lock serialization added alongside this
-- migration closed that race. Renumber any document that already has duplicates (ordered by
-- created_at/id so the timeline stays monotonic), then add the constraint so it can't recur.
-- Idempotent: safe to rerun against a database that already has the constraint or no duplicates.
DO $$
DECLARE
  doc RECORD;
BEGIN
  FOR doc IN
    SELECT document_id
    FROM knowledge_document_versions
    GROUP BY document_id
    HAVING COUNT(*) <> COUNT(DISTINCT version_number)
  LOOP
    WITH ordered AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn
      FROM knowledge_document_versions
      WHERE document_id = doc.document_id
    )
    UPDATE knowledge_document_versions v
    SET version_number = ordered.rn
    FROM ordered
    WHERE v.id = ordered.id;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'knowledge_document_versions_document_id_version_number_key'
      AND conrelid = 'public.knowledge_document_versions'::regclass
  ) THEN
    ALTER TABLE knowledge_document_versions
      ADD CONSTRAINT knowledge_document_versions_document_id_version_number_key UNIQUE (document_id, version_number);
  END IF;
END $$;
