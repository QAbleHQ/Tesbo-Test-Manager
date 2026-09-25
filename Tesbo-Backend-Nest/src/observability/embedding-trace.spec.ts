/*
 * Unit coverage for tracedEmbeddingCall's own contract: fn()'s result/error is always
 * returned/rethrown unchanged, regardless of whether tracing is on, off, or the SDK itself faults.
 * `@langfuse/tracing` and `./langfuse` are both mocked — this tests embedding-trace.ts's OWN
 * behaviour, not the real SDK/network path, matching ai-trace.spec.ts's existing approach for the
 * chat-turn tracing functions.
 */

const isTracingEnabledMock = jest.fn<boolean, []>();
jest.mock("./langfuse", () => ({ isTracingEnabled: () => isTracingEnabledMock() }));

type FakeSpan = { update: jest.Mock; end: jest.Mock };
function makeFakeSpan(): FakeSpan {
  return { update: jest.fn(), end: jest.fn() };
}

const startObservationMock = jest.fn();
const createTraceIdMock = jest.fn((seed: string) => Promise.resolve(`trace-${seed}`));

jest.mock("@langfuse/tracing", () => ({
  startObservation: (...args: [string, Record<string, unknown>, Record<string, unknown>]) => startObservationMock(...args),
  createTraceId: (seed: string) => createTraceIdMock(seed)
}));

import { tracedEmbeddingCall, type EmbeddingCallContext } from "./embedding-trace";

function baseCtx(overrides: Partial<EmbeddingCallContext> = {}): EmbeddingCallContext {
  return {
    name: "kb-chunk-embedding-batch",
    projectId: "project-1",
    provider: "openai",
    model: "text-embedding-3-small",
    inputCount: 2,
    inputSample: "sample chunk text",
    ...overrides
  };
}

describe("tracedEmbeddingCall", () => {
  beforeEach(() => {
    isTracingEnabledMock.mockReset();
    startObservationMock.mockReset();
    createTraceIdMock.mockClear();
    startObservationMock.mockImplementation(() => makeFakeSpan());
  });

  it("returns fn()'s result unchanged when tracing is disabled — no span opened", async () => {
    isTracingEnabledMock.mockReturnValue(false);
    const fn = jest.fn().mockResolvedValue([[0.1, 0.2]]);
    const result = await tracedEmbeddingCall(baseCtx({ traceSeed: "seed-1" }), fn);
    expect(result).toEqual([[0.1, 0.2]]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(startObservationMock).not.toHaveBeenCalled();
  });

  it("skips tracing (but still calls fn) when tracing is on but neither traceId nor traceSeed is given", async () => {
    isTracingEnabledMock.mockReturnValue(true);
    const fn = jest.fn().mockResolvedValue([[0.1, 0.2]]);
    const result = await tracedEmbeddingCall(baseCtx(), fn);
    expect(result).toEqual([[0.1, 0.2]]);
    expect(startObservationMock).not.toHaveBeenCalled();
    expect(createTraceIdMock).not.toHaveBeenCalled();
  });

  it("uses traceId directly, without calling createTraceId, when traceId is given", async () => {
    isTracingEnabledMock.mockReturnValue(true);
    const fn = jest.fn().mockResolvedValue([[0.1, 0.2]]);
    await tracedEmbeddingCall(baseCtx({ traceId: "already-resolved-trace" }), fn);
    expect(createTraceIdMock).not.toHaveBeenCalled();
    const [, , opts] = startObservationMock.mock.calls[0];
    expect((opts as { parentSpanContext: { traceId: string } }).parentSpanContext.traceId).toBe("already-resolved-trace");
  });

  it("hashes traceSeed via createTraceId when only traceSeed is given", async () => {
    isTracingEnabledMock.mockReturnValue(true);
    const fn = jest.fn().mockResolvedValue([[0.1, 0.2]]);
    await tracedEmbeddingCall(baseCtx({ traceSeed: "embed-doc:document:src-1:hash-abc" }), fn);
    expect(createTraceIdMock).toHaveBeenCalledWith("embed-doc:document:src-1:hash-abc");
    const [, , opts] = startObservationMock.mock.calls[0];
    expect((opts as { parentSpanContext: { traceId: string } }).parentSpanContext.traceId).toBe("trace-embed-doc:document:src-1:hash-abc");
  });

  it("prefers traceId over traceSeed when both are given", async () => {
    isTracingEnabledMock.mockReturnValue(true);
    const fn = jest.fn().mockResolvedValue([[0.1, 0.2]]);
    await tracedEmbeddingCall(baseCtx({ traceId: "resolved-trace", traceSeed: "some-seed" }), fn);
    expect(createTraceIdMock).not.toHaveBeenCalled();
    const [, , opts] = startObservationMock.mock.calls[0];
    expect((opts as { parentSpanContext: { traceId: string } }).parentSpanContext.traceId).toBe("resolved-trace");
  });

  it("uses asType 'embedding' and records model/provider/inputCount/capped sample on success", async () => {
    isTracingEnabledMock.mockReturnValue(true);
    const fn = jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]);
    const span = makeFakeSpan();
    startObservationMock.mockReturnValue(span);
    const longSample = "x".repeat(500);
    await tracedEmbeddingCall(baseCtx({ traceId: "t1", inputCount: 5, inputSample: longSample }), fn);

    const [name, attrs, opts] = startObservationMock.mock.calls[0];
    expect(name).toBe("kb-chunk-embedding-batch");
    expect(opts).toMatchObject({ asType: "embedding" });
    expect(attrs).toMatchObject({ model: "text-embedding-3-small", metadata: { provider: "openai", projectId: "project-1" } });
    expect((attrs.input as { inputCount: number; sample: string }).inputCount).toBe(5);
    // Capped, never the full raw text — batches can carry up to 96 chunks of ~1600 chars each.
    expect((attrs.input as { sample: string }).sample.length).toBeLessThan(longSample.length);

    expect(span.update).toHaveBeenCalledWith(expect.objectContaining({ output: { vectorCount: 1, dimension: 3 } }));
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it("records an ERROR-level span and still rethrows the exact original error on failure", async () => {
    isTracingEnabledMock.mockReturnValue(true);
    const span = makeFakeSpan();
    startObservationMock.mockReturnValue(span);
    const original = new Error("embeddings provider unreachable");
    const fn = jest.fn().mockRejectedValue(original);

    await expect(tracedEmbeddingCall(baseCtx({ traceId: "t1" }), fn)).rejects.toBe(original);

    expect(span.update).toHaveBeenCalledWith(
      expect.objectContaining({ output: { error: "embeddings provider unreachable" }, level: "ERROR" })
    );
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it("rethrows the exact original error unchanged even when tracing is off", async () => {
    isTracingEnabledMock.mockReturnValue(false);
    const original = new Error("network timeout");
    const fn = jest.fn().mockRejectedValue(original);
    await expect(tracedEmbeddingCall(baseCtx(), fn)).rejects.toBe(original);
  });

  it("rethrows a non-Error thrown value as-is, without wrapping it", async () => {
    isTracingEnabledMock.mockReturnValue(true);
    startObservationMock.mockReturnValue(makeFakeSpan());
    const fn = jest.fn().mockRejectedValue("plain string rejection");
    await expect(tracedEmbeddingCall(baseCtx({ traceId: "t1" }), fn)).rejects.toBe("plain string rejection");
  });

  it("still calls fn and returns its result when createTraceId itself throws", async () => {
    isTracingEnabledMock.mockReturnValue(true);
    createTraceIdMock.mockRejectedValueOnce(new Error("hash blew up"));
    const fn = jest.fn().mockResolvedValue([[0.1, 0.2]]);
    const result = await tracedEmbeddingCall(baseCtx({ traceSeed: "seed-x" }), fn);
    expect(result).toEqual([[0.1, 0.2]]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("still calls fn and returns its result when startObservation itself throws", async () => {
    isTracingEnabledMock.mockReturnValue(true);
    startObservationMock.mockImplementation(() => {
      throw new Error("SDK internal error");
    });
    const fn = jest.fn().mockResolvedValue([[0.1, 0.2]]);
    const result = await tracedEmbeddingCall(baseCtx({ traceId: "t1" }), fn);
    expect(result).toEqual([[0.1, 0.2]]);
  });

  it("still returns fn()'s success result when span.update/span.end themselves throw", async () => {
    isTracingEnabledMock.mockReturnValue(true);
    const brokenSpan: FakeSpan = {
      update: jest.fn(() => {
        throw new Error("update blew up");
      }),
      end: jest.fn(() => {
        throw new Error("end blew up");
      })
    };
    startObservationMock.mockReturnValue(brokenSpan);
    const fn = jest.fn().mockResolvedValue([[0.4, 0.5]]);
    const result = await tracedEmbeddingCall(baseCtx({ traceId: "t1" }), fn);
    expect(result).toEqual([[0.4, 0.5]]);
  });

  it("still rethrows fn()'s original error when span.update/span.end themselves throw while closing the error span", async () => {
    isTracingEnabledMock.mockReturnValue(true);
    const brokenSpan: FakeSpan = {
      update: jest.fn(() => {
        throw new Error("update blew up");
      }),
      end: jest.fn(() => {
        throw new Error("end blew up");
      })
    };
    startObservationMock.mockReturnValue(brokenSpan);
    const original = new Error("real embeddings failure");
    const fn = jest.fn().mockRejectedValue(original);
    await expect(tracedEmbeddingCall(baseCtx({ traceId: "t1" }), fn)).rejects.toBe(original);
  });

  it("handles an undefined inputSample without crashing", async () => {
    isTracingEnabledMock.mockReturnValue(true);
    const span = makeFakeSpan();
    startObservationMock.mockReturnValue(span);
    const fn = jest.fn().mockResolvedValue([[0.1]]);
    await tracedEmbeddingCall(baseCtx({ traceId: "t1", inputSample: undefined }), fn);
    const [, attrs] = startObservationMock.mock.calls[0];
    expect((attrs.input as { sample: string | undefined }).sample).toBeUndefined();
  });

  it("calls fn() exactly once even when tracing is fully wired up", async () => {
    isTracingEnabledMock.mockReturnValue(true);
    startObservationMock.mockReturnValue(makeFakeSpan());
    const fn = jest.fn().mockResolvedValue([[0.1, 0.2]]);
    await tracedEmbeddingCall(baseCtx({ traceId: "t1" }), fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
