// Shared by rag-embedding.processor.ts (on-write embedding) and
// backfill-testcase-embeddings.ts (the one-off manual backfill) so both build the exact same
// text for the exact same test case — a backfilled row and a freshly-created one must be
// comparable, not embedded under two subtly different conventions.

// Char cap on the text sent to the embeddings API per test case (title + description + steps).
// Test cases are short in practice — this exists only to bound a pathological case (hundreds of
// steps) from producing an oversized request, the same defensive spirit as RAG_CHUNK_TARGET_CHARS
// for documents, not a tuned value.
export const TESTCASE_EMBEDDING_TEXT_CHAR_CAP = 4000;

export interface TestcaseEmbeddingSource {
  title: string | null;
  description: string | null;
  steps: unknown;
}

export function buildTestcaseEmbeddingText(source: TestcaseEmbeddingSource): string {
  const steps = Array.isArray(source.steps) ? source.steps : [];
  return [source.title || "", source.description || "", JSON.stringify(steps)]
    .join("\n")
    .trim()
    .slice(0, TESTCASE_EMBEDDING_TEXT_CHAR_CAP);
}
