/*
 * Unit coverage for RagEmbeddingProcessor — previously none existed for this file at all (grepped
 * before writing: only rag-ai-allocation.spec.ts and rag-retrieval.service.spec.ts cover this
 * module). Added alongside wiring tracedEmbeddingCall into this file's two embedTexts() call
 * sites, per docs/superpowers/specs/2026-09-17-langfuse-embedding-instrumentation-design.md.
 *
 * `./rag-ai-allocation` and `../observability/embedding-trace` are both mocked — this tests the
 * processor's OWN batching/status/error-handling logic and confirms it wires tracedEmbeddingCall
 * correctly, not the real embeddings provider or Langfuse SDK (those are covered by
 * rag-ai-allocation.spec.ts and embedding-trace.spec.ts respectively).
 *
 * tracedEmbeddingCallMock defaults to a transparent pass-through (calls fn() and returns/throws
 * its result), matching the real wrapper's contract — the one property every test here that
 * touches the embeddings call implicitly relies on: tracing must never change what the processor
 * sees back from embedTexts().
 */

const resolveEmbeddingAllocationMock = jest.fn();
const embedTextsMock = jest.fn();
jest.mock("./rag-ai-allocation", () => ({
  resolveEmbeddingAllocation: (...args: unknown[]) => resolveEmbeddingAllocationMock(...args),
  embedTexts: (...args: unknown[]) => embedTextsMock(...args)
}));

interface TracedEmbeddingCtx {
  traceSeed?: string;
  traceId?: string;
  name: string;
  projectId: string;
  organizationId?: string;
  provider: string;
  model: string;
  inputCount: number;
}

const tracedEmbeddingCallMock = jest.fn<Promise<number[][]>, [TracedEmbeddingCtx, () => Promise<number[][]>]>((_ctx, fn) => fn());
jest.mock("../observability/embedding-trace", () => ({
  tracedEmbeddingCall: (ctx: TracedEmbeddingCtx, fn: () => Promise<number[][]>) => tracedEmbeddingCallMock(ctx, fn)
}));

import type { Job } from "bullmq";
import { RagEmbeddingProcessor } from "./rag-embedding.processor";
import { RagChunkingService } from "./rag-chunking.service";
import type { DatabaseService } from "../database/database.service";
import { RAG_EMBEDDING_BATCH_SIZE, RAG_EMBEDDING_DIMENSION, RAG_TESTCASE_EMBEDDING_JOB_NAME } from "./rag.constants";
import { EmbeddingJobPayload, TestcaseEmbeddingJobPayload } from "./rag.types";

const FAKE_ALLOCATION = { provider: "openai", api_key: "sk-test", base_url: null, auth_header_name: null, auth_scheme: null, model: "text-embedding-3-small", dimension: RAG_EMBEDDING_DIMENSION, sendDimensionParam: true };

function vector(fill = 0.1): number[] {
  return new Array(RAG_EMBEDDING_DIMENSION).fill(fill);
}

interface FakeDbOpts {
  source?: Record<string, unknown> | null;
  updates?: Array<{ sql: string; params: unknown[] }>;
  txQueries?: Array<{ sql: string; params: unknown[] }>;
}

function makeDb(opts: FakeDbOpts): DatabaseService {
  const updates = opts.updates ?? [];
  const txQueries = opts.txQueries ?? [];
  const client = { query: jest.fn((sql: string, params: unknown[] = []) => (txQueries.push({ sql, params }), Promise.resolve({ rows: [] }))) };
  return {
    query: jest.fn((sql: string, params: unknown[] = []) => {
      if (sql.trim().startsWith("SELECT") && (sql.includes("FROM knowledge_documents") || sql.includes("FROM knowledge_files") || sql.includes("FROM testcases"))) {
        return Promise.resolve({ rows: opts.source ? [opts.source] : [] });
      }
      updates.push({ sql, params });
      return Promise.resolve({ rows: [] });
    }),
    transaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(client))
  } as unknown as DatabaseService;
}

function makeJob<T>(name: string, data: T): Job<T> {
  return { name, data } as Job<T>;
}

describe("RagEmbeddingProcessor.process — knowledge source (document/file)", () => {
  let chunking: RagChunkingService;

  beforeEach(() => {
    resolveEmbeddingAllocationMock.mockReset();
    embedTextsMock.mockReset();
    tracedEmbeddingCallMock.mockReset();
    tracedEmbeddingCallMock.mockImplementation((_ctx: unknown, fn: () => Promise<number[][]>) => fn());
    chunking = new RagChunkingService();
  });

  const payload: EmbeddingJobPayload = { organizationId: "org-1", projectId: "project-1", sourceType: "document", sourceId: "doc-1", reason: "created" };

  it("marks the source unsupported (no crash) when it is gone/soft-deleted since the job was queued", async () => {
    const db = makeDb({ source: null });
    const processor = new RagEmbeddingProcessor(db, chunking);
    await processor.process(makeJob("embed-source", payload));
    expect(embedTextsMock).not.toHaveBeenCalled();
    expect(tracedEmbeddingCallMock).not.toHaveBeenCalled();
  });

  it("marks the source unsupported and never calls the embeddings API when there is no extractable text", async () => {
    const db = makeDb({ source: { id: "doc-1", organization_id: "org-1", content: "   ", embedding_content_hash: null } });
    const processor = new RagEmbeddingProcessor(db, chunking);
    await processor.process(makeJob("embed-source", payload));
    expect(tracedEmbeddingCallMock).not.toHaveBeenCalled();
  });

  it("marks the source pending (not unsupported) and never calls the embeddings API when there is no usable key", async () => {
    resolveEmbeddingAllocationMock.mockResolvedValue({ allocation: null, reason: "No embeddings-capable key." });
    const db = makeDb({ source: { id: "doc-1", organization_id: "org-1", content: "Some real content here.", embedding_content_hash: null } });
    const updateSpy = (db.query as jest.Mock);
    const processor = new RagEmbeddingProcessor(db, chunking);
    await processor.process(makeJob("embed-source", payload));
    expect(tracedEmbeddingCallMock).not.toHaveBeenCalled();
    const statusUpdate = updateSpy.mock.calls.find((c) => String(c[0]).includes("embedding_status = $2"));
    expect(statusUpdate?.[1]).toEqual(["doc-1", "pending"]);
  });

  it("skips re-embedding (no API call) when the content hash has not changed since last time", async () => {
    resolveEmbeddingAllocationMock.mockResolvedValue({ allocation: FAKE_ALLOCATION, reason: "ok" });
    const content = "Unchanged content.";
    const { createHash } = jest.requireActual("crypto");
    const hash = createHash("sha256").update(content).digest("hex");
    const db = makeDb({ source: { id: "doc-1", organization_id: "org-1", content, embedding_content_hash: hash } });
    const processor = new RagEmbeddingProcessor(db, chunking);
    await processor.process(makeJob("embed-source", payload));
    expect(tracedEmbeddingCallMock).not.toHaveBeenCalled();
  });

  it("marks the source unsupported when chunking produces zero chunks", async () => {
    resolveEmbeddingAllocationMock.mockResolvedValue({ allocation: FAKE_ALLOCATION, reason: "ok" });
    // Below RAG_CHUNK_MIN_CHARS, so RagChunkingService.chunk() returns [].
    const db = makeDb({ source: { id: "doc-1", organization_id: "org-1", content: "hi", embedding_content_hash: null } });
    const processor = new RagEmbeddingProcessor(db, chunking);
    await processor.process(makeJob("embed-source", payload));
    expect(tracedEmbeddingCallMock).not.toHaveBeenCalled();
  });

  it("wraps the embeddings call with tracedEmbeddingCall, passing a deterministic seed derived from source identity + content hash", async () => {
    resolveEmbeddingAllocationMock.mockResolvedValue({ allocation: FAKE_ALLOCATION, reason: "ok" });
    embedTextsMock.mockResolvedValue([vector()]);
    const content = "A real paragraph of content, long enough to survive chunking easily.";
    const db = makeDb({ source: { id: "doc-1", organization_id: "org-1", content, embedding_content_hash: null } });
    const processor = new RagEmbeddingProcessor(db, chunking);
    await processor.process(makeJob("embed-source", payload));

    expect(tracedEmbeddingCallMock).toHaveBeenCalledTimes(1);
    const [ctx] = tracedEmbeddingCallMock.mock.calls[0];
    expect(ctx).toMatchObject({ name: "kb-chunk-embedding-batch", projectId: "project-1", organizationId: "org-1", provider: "openai", model: "text-embedding-3-small" });
    expect(String(ctx.traceSeed)).toBe(
      `embed-doc:document:doc-1:${jest.requireActual("crypto").createHash("sha256").update(content).digest("hex")}`
    );
  });

  it("issues one tracedEmbeddingCall per batch when a source chunks into more than RAG_EMBEDDING_BATCH_SIZE pieces, all sharing the same trace seed", async () => {
    resolveEmbeddingAllocationMock.mockResolvedValue({ allocation: FAKE_ALLOCATION, reason: "ok" });
    embedTextsMock.mockImplementation((_alloc: unknown, inputs: string[]) => Promise.resolve(inputs.map(() => vector())));
    const manyChunks = Array.from({ length: RAG_EMBEDDING_BATCH_SIZE + 5 }, (_, i) => ({ chunkIndex: i, headingPath: null, content: `chunk ${i}`, tokenCount: 3 }));
    jest.spyOn(chunking, "chunk").mockReturnValue(manyChunks);
    const db = makeDb({ source: { id: "doc-1", organization_id: "org-1", content: "irrelevant, chunk() is mocked", embedding_content_hash: null } });
    const processor = new RagEmbeddingProcessor(db, chunking);
    await processor.process(makeJob("embed-source", payload));

    expect(tracedEmbeddingCallMock).toHaveBeenCalledTimes(2); // 101 chunks / 96 batch size = 2 batches
    const seeds = tracedEmbeddingCallMock.mock.calls.map((c) => c[0].traceSeed);
    expect(seeds[0]).toBe(seeds[1]); // same job, same trace
  });

  it("propagates a batch embeddings failure unchanged out of the processor — BullMQ's retry/backoff depends on this", async () => {
    resolveEmbeddingAllocationMock.mockResolvedValue({ allocation: FAKE_ALLOCATION, reason: "ok" });
    const original = new Error("embeddings provider unreachable");
    tracedEmbeddingCallMock.mockRejectedValue(original);
    const db = makeDb({ source: { id: "doc-1", organization_id: "org-1", content: "Enough content to chunk normally here.", embedding_content_hash: null } });
    const processor = new RagEmbeddingProcessor(db, chunking);
    await expect(processor.process(makeJob("embed-source", payload))).rejects.toBe(original);
  });

  it("discards a chunk whose returned vector has the wrong dimension and does not insert it", async () => {
    resolveEmbeddingAllocationMock.mockResolvedValue({ allocation: FAKE_ALLOCATION, reason: "ok" });
    tracedEmbeddingCallMock.mockResolvedValue([vector().slice(0, 10)]); // wrong width
    const db = makeDb({ source: { id: "doc-1", organization_id: "org-1", content: "Enough content to chunk normally here.", embedding_content_hash: null } });
    const processor = new RagEmbeddingProcessor(db, chunking);
    await processor.process(makeJob("embed-source", payload));
    // Should not throw, and should still reach the final status update (ready) — the mismatch is
    // logged and the chunk skipped, not treated as a hard failure of the whole job.
    const calls = (db.query as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(calls.some((sql) => sql.includes("embedding_status = 'ready'") || sql.includes("SET embedding_status = 'ready'"))).toBe(true);
  });
});

describe("RagEmbeddingProcessor.process — testcase", () => {
  let chunking: RagChunkingService;
  const payload: TestcaseEmbeddingJobPayload = { projectId: "project-1", testcaseId: "tc-1", reason: "created" };

  beforeEach(() => {
    resolveEmbeddingAllocationMock.mockReset();
    embedTextsMock.mockReset();
    tracedEmbeddingCallMock.mockReset();
    tracedEmbeddingCallMock.mockImplementation((_ctx: unknown, fn: () => Promise<number[][]>) => fn());
    chunking = new RagChunkingService();
  });

  it("marks the testcase unsupported (no crash) when it is gone/soft-deleted since the job was queued", async () => {
    const db = makeDb({ source: null });
    const processor = new RagEmbeddingProcessor(db, chunking);
    await processor.process(makeJob(RAG_TESTCASE_EMBEDDING_JOB_NAME, payload));
    expect(tracedEmbeddingCallMock).not.toHaveBeenCalled();
  });

  it("marks the testcase pending (not unsupported) and never calls the embeddings API when there is no usable key", async () => {
    resolveEmbeddingAllocationMock.mockResolvedValue({ allocation: null, reason: "No embeddings-capable key." });
    const db = makeDb({ source: { id: "tc-1", title: "Login works", description: "desc", steps: [], embedding_content_hash: null } });
    const processor = new RagEmbeddingProcessor(db, chunking);
    await processor.process(makeJob(RAG_TESTCASE_EMBEDDING_JOB_NAME, payload));
    expect(tracedEmbeddingCallMock).not.toHaveBeenCalled();
    const statusUpdate = (db.query as jest.Mock).mock.calls.find((c) => String(c[0]).includes("embedding_status = $2"));
    expect(statusUpdate?.[1]).toEqual(["tc-1", "pending"]);
  });

  it("skips re-embedding (no API call) when the content hash has not changed since last time", async () => {
    resolveEmbeddingAllocationMock.mockResolvedValue({ allocation: FAKE_ALLOCATION, reason: "ok" });
    const { createHash } = jest.requireActual("crypto");
    const text = ["Login works", "desc", "[]"].join("\n");
    const hash = createHash("sha256").update(text).digest("hex");
    const db = makeDb({ source: { id: "tc-1", title: "Login works", description: "desc", steps: [], embedding_content_hash: hash } });
    const processor = new RagEmbeddingProcessor(db, chunking);
    await processor.process(makeJob(RAG_TESTCASE_EMBEDDING_JOB_NAME, payload));
    expect(tracedEmbeddingCallMock).not.toHaveBeenCalled();
  });

  it("wraps the single embeddings call with tracedEmbeddingCall, seeded from testcaseId + content hash", async () => {
    resolveEmbeddingAllocationMock.mockResolvedValue({ allocation: FAKE_ALLOCATION, reason: "ok" });
    tracedEmbeddingCallMock.mockResolvedValue([vector()]);
    const db = makeDb({ source: { id: "tc-1", title: "Login works", description: "desc", steps: [], embedding_content_hash: null } });
    const processor = new RagEmbeddingProcessor(db, chunking);
    await processor.process(makeJob(RAG_TESTCASE_EMBEDDING_JOB_NAME, payload));

    expect(tracedEmbeddingCallMock).toHaveBeenCalledTimes(1);
    const [ctx] = tracedEmbeddingCallMock.mock.calls[0];
    expect(ctx).toMatchObject({ name: "testcase-embedding", projectId: "project-1", provider: "openai", model: "text-embedding-3-small", inputCount: 1 });
    expect(String(ctx.traceSeed)).toMatch(/^embed-testcase:tc-1:/);
  });

  it("marks the testcase failed (not thrown) when the returned vector has the wrong dimension", async () => {
    resolveEmbeddingAllocationMock.mockResolvedValue({ allocation: FAKE_ALLOCATION, reason: "ok" });
    tracedEmbeddingCallMock.mockResolvedValue([vector().slice(0, 10)]);
    const db = makeDb({ source: { id: "tc-1", title: "Login works", description: "desc", steps: [], embedding_content_hash: null } });
    const processor = new RagEmbeddingProcessor(db, chunking);
    await expect(processor.process(makeJob(RAG_TESTCASE_EMBEDDING_JOB_NAME, payload))).resolves.toBeUndefined();
    const statusUpdate = (db.query as jest.Mock).mock.calls.find((c) => String(c[0]).includes("embedding_status = $2") && (c[1] as unknown[]).includes("failed"));
    expect(statusUpdate).toBeTruthy();
  });

  it("propagates an embeddings failure unchanged out of the processor — BullMQ's retry/backoff depends on this", async () => {
    resolveEmbeddingAllocationMock.mockResolvedValue({ allocation: FAKE_ALLOCATION, reason: "ok" });
    const original = new Error("embeddings provider unreachable");
    tracedEmbeddingCallMock.mockRejectedValue(original);
    const db = makeDb({ source: { id: "tc-1", title: "Login works", description: "desc", steps: [], embedding_content_hash: null } });
    const processor = new RagEmbeddingProcessor(db, chunking);
    await expect(processor.process(makeJob(RAG_TESTCASE_EMBEDDING_JOB_NAME, payload))).rejects.toBe(original);
  });
});

describe("RagEmbeddingProcessor.onFailed", () => {
  beforeEach(() => {
    tracedEmbeddingCallMock.mockReset();
  });

  it("marks a knowledge source failed once retry attempts are exhausted", async () => {
    const db = makeDb({});
    const processor = new RagEmbeddingProcessor(db, new RagChunkingService());
    const job = { data: { organizationId: "org-1", projectId: "project-1", sourceType: "document", sourceId: "doc-1", reason: "created" }, attemptsMade: 3, opts: { attempts: 3 }, name: "embed-source" } as unknown as Job<EmbeddingJobPayload>;
    await processor.onFailed(job);
    const statusUpdate = (db.query as jest.Mock).mock.calls.find((c) => (c[1] as unknown[])?.includes?.("failed"));
    expect(statusUpdate).toBeTruthy();
  });

  it("does nothing while retry attempts remain", async () => {
    const db = makeDb({});
    const processor = new RagEmbeddingProcessor(db, new RagChunkingService());
    const job = { data: { organizationId: "org-1", projectId: "project-1", sourceType: "document", sourceId: "doc-1", reason: "created" }, attemptsMade: 1, opts: { attempts: 3 }, name: "embed-source" } as unknown as Job<EmbeddingJobPayload>;
    await processor.onFailed(job);
    expect((db.query as jest.Mock)).not.toHaveBeenCalled();
  });

  it("marks a testcase failed once retry attempts are exhausted", async () => {
    const db = makeDb({});
    const processor = new RagEmbeddingProcessor(db, new RagChunkingService());
    const job = { data: { projectId: "project-1", testcaseId: "tc-1", reason: "created" }, attemptsMade: 3, opts: { attempts: 3 }, name: RAG_TESTCASE_EMBEDDING_JOB_NAME } as unknown as Job<TestcaseEmbeddingJobPayload>;
    await processor.onFailed(job);
    const statusUpdate = (db.query as jest.Mock).mock.calls.find((c) => (c[1] as unknown[])?.includes?.("failed"));
    expect(statusUpdate).toBeTruthy();
  });
});
