export const RAG_EMBEDDING_QUEUE = "knowledge-embedding";
export const RAG_EMBEDDING_JOB_NAME = "embed-source";
// Same queue as knowledge documents/files (RAG_EMBEDDING_QUEUE) — a test case's embeddable text
// is short enough to need none of the chunking/multi-row machinery the document job uses, but it
// shares the worker, the retry/backoff config, and the embedding provider call. Only the job name
// and the write target (testcase_embeddings, not knowledge_document_chunks) differ; see
// rag-embedding.processor.ts, which branches on job.name.
export const RAG_TESTCASE_EMBEDDING_JOB_NAME = "embed-testcase";

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

// Similarity floor for test-case-to-test-case matching — the ADVISORY tier. At or above this
// (and below TESTCASE_UPDATE_THRESHOLD below), a match is surfaced as *context* handed back to
// the drafting model — see generateZyraChatTestcasesWithAi/zyraSimilarityFeedbackForDrafts in
// legacy.service.ts — never a backend-side reclassification. Wired in; see
// ZYRA_TICKET_WORKFLOW.md §10.
//
// Deliberately its own constant, not a reuse of RAG_MIN_SIMILARITY/RAG_CONFIDENT_SIMILARITY.
// Those two are tuned (loosely) for "is this KB paragraph relevant enough to cite in an answer" —
// a false positive there costs a slightly-off citation. A false positive here costs handing the
// model a spurious "this looks like it already exists" note on a genuinely distinct draft — cheap
// to ignore (the model decides, not this code), unlike TESTCASE_UPDATE_THRESHOLD below where a
// false positive silently overwrites real content. The two use cases warrant different risk
// tolerances even though both are cosine similarity over the same embedding space.
//
// 0.86 is not tuned against any real distribution — no test-case embeddings existed to sample when
// this shipped (same spirit as RAG_MIN_SIMILARITY's own comment about not spending a real
// embedding-provider call on a one-off dev-time sample). Deliberately higher than
// RAG_CONFIDENT_SIMILARITY (0.65): biased toward saying nothing over noisy advisory notes. Revisit
// once real usage data accumulates — lower it deliberately against an observed score distribution,
// not by adjusting again from first principles.
export const TESTCASE_SIMILARITY_THRESHOLD = 0.86;

// Similarity floor for the UPDATE tier — meaningfully higher than TESTCASE_SIMILARITY_THRESHOLD
// on purpose. At or above this, generateZyraChatTestcasesWithAi redirects that draft's operation
// from create to update, targeting the matched test case's real id with the drafted content as
// the update payload (still staged, still requires the user's explicit Save — see
// applyZyraChatOperations' "update" branch, unchanged by this threshold). This is a materially
// more consequential action than the advisory case above: TESTCASE_SIMILARITY_THRESHOLD only ever
// hands the model a note it can freely ignore, while this constant makes the backend decide, on
// the model's behalf, to overwrite an existing test case's title/steps/etc. A false positive here
// is a real, silent loss of existing content — not a false positive on a suggestion.
//
// 0.95 is not tuned against any real distribution, for the same reason 0.86 above isn't. Set
// deliberately near the top of the [0,1] cosine range — closer to "near-duplicate" than "related"
// — because the cost of firing on a genuinely distinct draft (silently destroying real content) is
// far worse than the cost of missing a genuine duplicate (it stays a Create the user reviews
// normally, no worse than today). Revisit only against an observed score distribution once real
// test-case embeddings exist, never lowered from first principles alone.
export const TESTCASE_UPDATE_THRESHOLD = 0.95;
