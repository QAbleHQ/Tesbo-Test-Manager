-- Semantic similarity search for test cases, reusing the same pgvector/ANN mechanics
-- knowledge_document_chunks already uses for KB documents (see rag/rag-retrieval.service.ts).
-- Not wired into any classification logic yet — this migration only makes the storage exist.
--
-- Mirrors V55_knowledge_document_chunks.sql's shape (HASH(project_id) into a fixed 64 buckets,
-- vector(1024) at the same platform width as RAG_EMBEDDING_DIMENSION, HNSW cosine index) with
-- two deliberate differences:
--
--   1. One row per test case, not per chunk. A test case's embeddable text (title + description
--      + steps, see rag-embedding.processor.ts) is short enough that chunking would add
--      complexity (heading paths, chunk_index, multi-row fusion) for no benefit — unlike a KB
--      document, a test case is never longer than a few paragraphs in practice.
--   2. A real FK to testcases(id). knowledge_document_chunks explicitly has no FK because one
--      chunks table serves two different parent tables (documents and files) and a single FK
--      column can't reference either — that constraint does not apply here: testcase_embeddings
--      has exactly one parent, so a real FK is strictly better than the app-enforced version.
CREATE TABLE testcase_embeddings (
    id                UUID NOT NULL DEFAULT gen_random_uuid(),
    project_id        UUID NOT NULL,
    testcase_id       UUID NOT NULL REFERENCES testcases(id) ON DELETE CASCADE,
    content_hash      TEXT NOT NULL,
    embedding_model   VARCHAR(128) NOT NULL,
    embedding         vector(1024),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, project_id)
) PARTITION BY HASH (project_id);

DO $$
BEGIN
  FOR i IN 0..63 LOOP
    EXECUTE format(
      'CREATE TABLE testcase_embeddings_p%1$s PARTITION OF testcase_embeddings FOR VALUES WITH (MODULUS 64, REMAINDER %1$s)',
      i
    );
  END LOOP;
END $$;

-- One embedding per test case (no chunk_index — see the "one row per test case" note above).
-- Propagates automatically to all 64 partitions as a single partitioned index.
CREATE UNIQUE INDEX idx_tce_unique ON testcase_embeddings(project_id, testcase_id);
CREATE INDEX idx_tce_embedding ON testcase_embeddings USING hnsw (embedding vector_cosine_ops);

-- Tracks embedding pipeline progress per test case, mirroring V56_knowledge_embedding_status.sql's
-- convention on knowledge_documents/knowledge_files exactly (same status vocabulary, same
-- meaning of 'unsupported' vs 'pending' — see rag-embedding.processor.ts's comment on why a
-- missing workspace key must stay 'pending', not 'unsupported').
--
-- DEFAULT 'pending' means every EXISTING test case becomes 'pending' the moment this migration
-- runs — that is intentional (it is the honest status: nothing has been embedded for them yet)
-- but it is not, by itself, a backfill. Nothing currently sweeps 'pending' test cases the way
-- RagIngestionService.resumeInterruptedEmbeddings() sweeps documents/files on every boot — that
-- sweep is document/file-only on purpose, so this migration does not silently trigger embedding
-- calls (and provider spend) across every existing test case in every workspace the next time the
-- backend restarts. Backfilling the existing corpus is a deliberate, separate decision — see
-- ZYRA_BINDING_REPORT.md's testcase-similarity follow-up for the open question.
ALTER TABLE testcases
  ADD COLUMN embedding_status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (embedding_status IN ('pending', 'queued', 'processing', 'ready', 'failed', 'unsupported')),
  ADD COLUMN embedding_content_hash TEXT;
