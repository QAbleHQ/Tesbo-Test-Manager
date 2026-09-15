/*
 * Unit coverage for RagRetrievalService — previously none existed for this file at all (grepped
 * before writing: only rag-ai-allocation.spec.ts covers this module). Written alongside the
 * relevance-floor / confidence-signal work (RAG_MIN_SIMILARITY / RAG_CONFIDENT_SIMILARITY,
 * rag.constants.ts): budgetToItems previously took the top RAG_MAX_SOURCES fused results
 * unconditionally, with no minimum similarity — a weak-match pool filled the context budget exactly
 * like a strong one, which the docs traced back to as a real contributor to generic-sounding
 * answers that technically cite a source.
 *
 * `./rag-ai-allocation` is mocked (resolveEmbeddingAllocation / embedTexts) rather than driving a
 * real embeddings call — this tests RagRetrievalService's OWN filtering/fusion/scoring logic given
 * a controlled set of raw cosine-similarity scores, not the embeddings provider integration.
 */

const resolveEmbeddingAllocationMock = jest.fn();
const embedTextsMock = jest.fn();
jest.mock("./rag-ai-allocation", () => ({
  resolveEmbeddingAllocation: (...args: unknown[]) => resolveEmbeddingAllocationMock(...args),
  embedTexts: (...args: unknown[]) => embedTextsMock(...args)
}));

import { RagRetrievalService } from "./rag-retrieval.service";
import type { DatabaseService } from "../database/database.service";
import { RAG_CONFIDENT_SIMILARITY, RAG_MIN_SIMILARITY, TESTCASE_SIMILARITY_THRESHOLD } from "./rag.constants";

type AnnRow = { source_type: string; source_id: string; heading_path: string | null; content: string; title: string; cosine_similarity: number };
type FtsRow = { id: string; title: string; content: string; rank: number };

function makeDb(annRows: AnnRow[], ftsDocRows: FtsRow[] = [], ftsFileRows: FtsRow[] = []): DatabaseService {
  const query = jest.fn((sql: string) => {
    if (sql.includes("knowledge_document_chunks")) return Promise.resolve({ rows: annRows });
    if (sql.includes("FROM knowledge_documents")) return Promise.resolve({ rows: ftsDocRows });
    if (sql.includes("FROM knowledge_files")) return Promise.resolve({ rows: ftsFileRows });
    return Promise.resolve({ rows: [] });
  });
  return { query } as unknown as DatabaseService;
}

const FAKE_ALLOCATION = { provider: "openai", api_key: "sk-test", base_url: null, auth_header_name: null, auth_scheme: null, model: "text-embedding-3-small", dimension: 1024, sendDimensionParam: true };

describe("RagRetrievalService.retrieveWithDiagnostics", () => {
  beforeEach(() => {
    resolveEmbeddingAllocationMock.mockReset();
    embedTextsMock.mockReset();
    resolveEmbeddingAllocationMock.mockResolvedValue({ allocation: FAKE_ALLOCATION, reason: "Using the project's openai key for embeddings." });
    embedTextsMock.mockResolvedValue([[0.1, 0.2, 0.3]]);
  });

  function annRow(id: string, score: number): AnnRow {
    return { source_type: "document", source_id: id, heading_path: null, content: `content for ${id}`, title: `Doc ${id}`, cosine_similarity: score };
  }

  it("excludes a semantic match below RAG_MIN_SIMILARITY, even though it would otherwise rank within RAG_MAX_SOURCES", async () => {
    const svc = new RagRetrievalService(makeDb([annRow("strong", 0.9), annRow("weak", RAG_MIN_SIMILARITY - 0.05)]));
    const result = await svc.retrieveWithDiagnostics("project-1", "how does login work");
    const ids = result.items.map((item) => item.citation.sourceId);
    expect(ids).toContain("strong");
    expect(ids).not.toContain("weak");
  });

  it("keeps a match that clears the floor even if it is not a confident one", async () => {
    const belowConfident = RAG_MIN_SIMILARITY + (RAG_CONFIDENT_SIMILARITY - RAG_MIN_SIMILARITY) / 2;
    const svc = new RagRetrievalService(makeDb([annRow("plausible", belowConfident)]));
    const result = await svc.retrieveWithDiagnostics("project-1", "how does login work");
    expect(result.items.map((item) => item.citation.sourceId)).toContain("plausible");
    expect(result.confidence).toBe("weak");
  });

  it("reports topScore and 'none' confidence honestly when every candidate is filtered out — distinct from nothing having been searched at all", async () => {
    const svc = new RagRetrievalService(makeDb([annRow("too-weak", 0.12)]));
    const result = await svc.retrieveWithDiagnostics("project-1", "unrelated query");
    expect(result.items).toEqual([]);
    // The real, honest score is still reported — "we searched and the best match scored 0.12" is
    // meaningfully different from "no candidates existed", even though both end up confidence "none".
    expect(result.topScore).toBeCloseTo(0.12);
    expect(result.confidence).toBe("none");
    expect(result.semanticSearchRan).toBe(true);
  });

  it("reports 'strong' confidence and the real topScore for a genuinely well-matched query — the regression case", async () => {
    const svc = new RagRetrievalService(makeDb([annRow("a", 0.92), annRow("b", 0.4)]));
    const result = await svc.retrieveWithDiagnostics("project-1", "a specific, well-covered feature");
    expect(result.confidence).toBe("strong");
    expect(result.topScore).toBeCloseTo(0.92);
    expect(result.items.map((item) => item.citation.sourceId)).toEqual(["a"]);
    expect(result.items[0].content).toContain("content for a");
  });

  it("degrades to keyword-only results (confidence 'none', no crash) when the embeddings call itself fails mid-query", async () => {
    embedTextsMock.mockRejectedValue(new Error("embeddings provider unreachable"));
    const db = makeDb([], [{ id: "kw-doc", title: "Keyword match", content: "matched by text", rank: 0.5 }]);
    const svc = new RagRetrievalService(db);
    const result = await svc.retrieveWithDiagnostics("project-1", "some query");
    // annSearch itself catches nothing — the embeddings failure propagates out of embedTexts, is
    // caught by retrieveWithDiagnostics' own try/catch, and the whole call degrades to [] rather
    // than losing the FTS half too or throwing into the caller.
    expect(result.items).toEqual([]);
    expect(result.confidence).toBe("none");
    expect(result.topScore).toBeNull();
  });

  it("reports confidence 'none' (not a crash, not a false 'weak') when there is no embeddings key at all — FTS-only degradation", async () => {
    resolveEmbeddingAllocationMock.mockResolvedValue({ allocation: null, reason: "No embeddings-capable key." });
    const db = makeDb([], [{ id: "kw-doc", title: "Keyword match", content: "matched by text", rank: 0.5 }]);
    const svc = new RagRetrievalService(db);
    const result = await svc.retrieveWithDiagnostics("project-1", "some query");
    expect(result.items.map((item) => item.citation.sourceId)).toContain("kw-doc");
    expect(result.semanticSearchRan).toBe(false);
    expect(result.confidence).toBe("none");
    expect(result.topScore).toBeNull();
    expect(embedTextsMock).not.toHaveBeenCalled();
  });

  it("never throws for an empty query", async () => {
    const svc = new RagRetrievalService(makeDb([]));
    const result = await svc.retrieveWithDiagnostics("project-1", "   ");
    expect(result).toEqual({ items: [], semanticSearchRan: false, reason: "Empty query.", topScore: null, confidence: "none" });
  });
});

/*
 * findSimilarTestcases — the ANN half aimed at testcase_embeddings instead of
 * knowledge_document_chunks, and the threshold that gates it (TESTCASE_SIMILARITY_THRESHOLD,
 * 0.86) — deliberately its own, higher-than-RAG_MIN_SIMILARITY constant, so a false-positive match
 * here costs a wrongly-suppressed Add rather than a slightly-off KB citation. Wired into
 * generateZyraChatTestcasesWithAi (legacy.service.ts) as a signal fed back into the drafting
 * call's own `feedback`, never a deterministic Create->Update conversion — that wiring is covered
 * separately in legacy/zyra-similarity-feedback.spec.ts. This file only tests the threshold/ANN
 * mechanics themselves, matching this file's existing scope (RagRetrievalService's own
 * filtering/fusion/scoring logic).
 */
type TestcaseAnnRow = { testcase_id: string; cosine_similarity: number };

function makeTestcaseDb(rows: TestcaseAnnRow[]): DatabaseService {
  const query = jest.fn((sql: string) => {
    if (sql.includes("testcase_embeddings")) return Promise.resolve({ rows });
    return Promise.resolve({ rows: [] });
  });
  return { query } as unknown as DatabaseService;
}

describe("RagRetrievalService.findSimilarTestcases", () => {
  beforeEach(() => {
    resolveEmbeddingAllocationMock.mockReset();
    embedTextsMock.mockReset();
    resolveEmbeddingAllocationMock.mockResolvedValue({ allocation: FAKE_ALLOCATION, reason: "Using the project's openai key for embeddings." });
    embedTextsMock.mockResolvedValue([[0.1, 0.2, 0.3]]);
  });

  it("returns a match whose cosine similarity is above the threshold", async () => {
    const svc = new RagRetrievalService(makeTestcaseDb([{ testcase_id: "tc-1", cosine_similarity: 0.93 }]));
    const result = await svc.findSimilarTestcases("project-1", "user can log in with valid credentials");
    expect(result.matches).toEqual([{ testcaseId: "tc-1", cosineSimilarity: 0.93 }]);
    expect(result.semanticSearchRan).toBe(true);
  });

  it("returns no matches when nothing in testcase_embeddings comes back at all", async () => {
    const svc = new RagRetrievalService(makeTestcaseDb([]));
    const result = await svc.findSimilarTestcases("project-1", "a genuinely novel scenario");
    expect(result.matches).toEqual([]);
  });

  it("excludes a candidate scored just below the threshold", async () => {
    const svc = new RagRetrievalService(makeTestcaseDb([{ testcase_id: "tc-below", cosine_similarity: TESTCASE_SIMILARITY_THRESHOLD - 0.001 }]));
    const result = await svc.findSimilarTestcases("project-1", "query");
    expect(result.matches).toEqual([]);
  });

  it("includes a candidate scored exactly at the threshold (>=, not >)", async () => {
    const svc = new RagRetrievalService(makeTestcaseDb([{ testcase_id: "tc-exact", cosine_similarity: TESTCASE_SIMILARITY_THRESHOLD }]));
    const result = await svc.findSimilarTestcases("project-1", "query");
    expect(result.matches).toEqual([{ testcaseId: "tc-exact", cosineSimilarity: TESTCASE_SIMILARITY_THRESHOLD }]);
  });

  it("includes a candidate scored just above the threshold", async () => {
    const svc = new RagRetrievalService(makeTestcaseDb([{ testcase_id: "tc-above", cosine_similarity: TESTCASE_SIMILARITY_THRESHOLD + 0.001 }]));
    const result = await svc.findSimilarTestcases("project-1", "query");
    expect(result.matches.map((m) => m.testcaseId)).toEqual(["tc-above"]);
  });

  it("resolves to no matches (never throws) when there is no embeddings-capable key", async () => {
    resolveEmbeddingAllocationMock.mockResolvedValue({ allocation: null, reason: "No embeddings-capable key." });
    const svc = new RagRetrievalService(makeTestcaseDb([{ testcase_id: "tc-1", cosine_similarity: 0.99 }]));
    const result = await svc.findSimilarTestcases("project-1", "query");
    expect(result.matches).toEqual([]);
    expect(result.semanticSearchRan).toBe(false);
    expect(embedTextsMock).not.toHaveBeenCalled();
  });

  it("never throws for an empty query", async () => {
    const svc = new RagRetrievalService(makeTestcaseDb([]));
    const result = await svc.findSimilarTestcases("project-1", "   ");
    expect(result.matches).toEqual([]);
  });
});
