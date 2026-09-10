export const RAG_EMBEDDING_QUEUE = "knowledge-embedding";
export const RAG_EMBEDDING_JOB_NAME = "embed-source";

// The platform-wide vector width. Every embeddings-capable provider must emit exactly this,
// either natively or via the OpenAI `dimensions` parameter — pgvector cannot index mixed
// widths in one column, and the HNSW index in V55/V85 is declared at this size.
//
// 1024 rather than OpenAI's native 1536 because it is the only width every candidate provider
// can produce: mistral-embed and the self-hosted open models are natively 1024 and cannot be
// widened, while text-embedding-3-small and gemini-embedding-001 reduce to it natively.
// See V85_embedding_dimension_1024.sql for the full reasoning.
export const RAG_EMBEDDING_DIMENSION = 1024;
export const RAG_EMBEDDING_BATCH_SIZE = 96;

// Char-count approximation of tokens (~4 chars/token) — good enough for chunk sizing and
// context-budget trimming, no tokenizer dependency needed.
export const RAG_CHUNK_TARGET_CHARS = 1600;
export const RAG_CHUNK_OVERLAP_CHARS = 240;
export const RAG_CHUNK_MIN_CHARS = 20;
export const RAG_MAX_CHUNKS_PER_SOURCE = 500;

export const RAG_ANN_CANDIDATES = 40;
export const RAG_FTS_CANDIDATES = 20;
export const RAG_RRF_K = 60;
export const RAG_MAX_SOURCES = 8;
export const RAG_CONTEXT_CHAR_BUDGET = 6000;

// Minimum cosine similarity (the raw ANN score, before RRF fusion) for a semantic match to count as
// relevant at all, rather than merely the least-bad candidate in an otherwise weak pool. RRF's own
// score (1/(k+rank+1)) is a rank position, not a relevance magnitude — without this floor, the 8th
// candidate out of 8 unrelated ones still gets a nonzero RRF score and fills the context budget
// exactly like a strong match would.
//
// 0.5 is a conservative starting point, not tuned against this project's live query traffic — no
// empirical score-distribution sample was pulled before shipping this (see the phase-4 changelog
// entry in docs/langfuse-observability-plan.md for why: pulling one would have meant issuing a real
// embedding-provider call, spending an actual workspace's provider budget on a one-off dev-time
// sample, which needed asking first rather than assuming). Common practice for cosine similarity on
// normalized text-embedding models treats >0.7 as a strong match, 0.5-0.7 as plausibly related, and
// below 0.5 as no more related than chance for typical short-query/long-document pairs.
// recordKnowledgeContext (ai-trace.ts) now traces the top raw score per query specifically so this
// can be revisited against real distributions once traces accumulate, rather than adjusted again
// from first principles.
export const RAG_MIN_SIMILARITY = 0.5;

// Below this top score, retrieval is reported as "weak" rather than "grounded" even when it returned
// results above RAG_MIN_SIMILARITY — see generateZyraChatTestcasesWithAi's ungrounded check.
// Deliberately higher than RAG_MIN_SIMILARITY: a single candidate that just clears the relevance
// floor is still a shaky foundation to call "coverage", not the same as having nothing.
export const RAG_CONFIDENT_SIMILARITY = 0.65;
