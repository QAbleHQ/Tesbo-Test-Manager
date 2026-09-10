/*
 * Unit coverage for ai-trace.ts's exported record* functions — previously none existed anywhere
 * (the original Langfuse plan, docs/langfuse-observability-plan.md §3.2, named
 * `ai-trace.service.spec.ts` as part of Phase 1 but it was never written). Written alongside this
 * phase's additions: the raw pre-parse completion / `__salvaged` fields on recordGeneration, and the
 * new recordReconciliation guardrail span.
 *
 * `@langfuse/tracing` and `./langfuse` are both mocked — this tests ai-trace.ts's OWN contract (what
 * it calls, with what shape, and that a fault in the SDK can never escape into a chat turn), not the
 * real SDK/network behaviour, which the product's own e2e suite deliberately never exercises either
 * (see this repo's zyra-chat-consistency.spec.ts header: "this suite never calls a model").
 */

const isTracingEnabledMock = jest.fn<boolean, []>();
jest.mock("./langfuse", () => ({ isTracingEnabled: () => isTracingEnabledMock() }));

type FakeCall = { name: string; attrs: Record<string, unknown>; opts: Record<string, unknown> };
const observationCalls: FakeCall[] = [];
const topLevelCalls: FakeCall[] = [];

function makeFakeSpan(recordInto: FakeCall[]) {
  const otelSpan = { setAttribute: jest.fn() };
  const node: Record<string, unknown> = {
    otelSpan,
    update: jest.fn(),
    end: jest.fn(),
    startObservation: jest.fn((name: string, attrs: Record<string, unknown>, opts: Record<string, unknown>) => {
      recordInto.push({ name, attrs, opts });
      return makeFakeSpan(recordInto);
    })
  };
  return node;
}

const startObservationMock = jest.fn((name: string, attrs: Record<string, unknown>, opts: Record<string, unknown>) => {
  topLevelCalls.push({ name, attrs, opts });
  return makeFakeSpan(observationCalls);
});
const createTraceIdMock = jest.fn((seed: string) => Promise.resolve(`trace-${seed}`));
const LangfuseOtelSpanAttributes = { TRACE_SESSION_ID: "session.id", TRACE_USER_ID: "user.id", TRACE_NAME: "langfuse.trace.name" };

jest.mock("@langfuse/tracing", () => ({
  startObservation: (...args: [string, Record<string, unknown>, Record<string, unknown>]) => startObservationMock(...args),
  createTraceId: (seed: string) => createTraceIdMock(seed),
  LangfuseOtelSpanAttributes
}));

import { recordGeneration, recordReconciliation, startZyraTurn, type TurnHandle } from "./ai-trace";

describe("ai-trace.ts", () => {
  beforeEach(() => {
    isTracingEnabledMock.mockReset();
    startObservationMock.mockClear();
    createTraceIdMock.mockClear();
    observationCalls.length = 0;
    topLevelCalls.length = 0;
  });

  function fakeTurn(): TurnHandle {
    return { span: makeFakeSpan(observationCalls), traceId: "trace-fake", sessionId: "session-1", userId: "user-1" };
  }

  describe("recordGeneration", () => {
    it("is a no-op when the turn has no span (tracing off)", () => {
      recordGeneration({ span: null, traceId: null }, { name: "router", provider: "openai", model: "gpt-4o", output: { ok: true } });
      expect(observationCalls).toHaveLength(0);
    });

    it("puts the raw pre-parse completion under output.rawCompletion, never metadata, alongside the parsed output", () => {
      const turn = fakeTurn();
      recordGeneration(turn, {
        name: "router",
        provider: "openai",
        model: "gpt-4o",
        output: { reply: "salvaged reply text" },
        rawOutput: '{"reply":"salvaged reply text","reasoningSummary":"cut off mid',
        salvaged: true
      });
      expect(observationCalls).toHaveLength(1);
      const call = observationCalls[0];
      expect(call.name).toBe("router");
      expect(call.opts.asType).toBe("generation");
      const output = call.attrs.output as Record<string, unknown>;
      expect(output.parsed).toEqual({ reply: "salvaged reply text" });
      expect(output.rawCompletion).toContain("cut off mid");
      // The security-sensitive field must never land in metadata — that's the one Langfuse's own
      // `mask` hook does NOT cover (measured, docs/langfuse-observability-plan.md §7.2).
      const metadata = call.attrs.metadata as Record<string, unknown>;
      expect(JSON.stringify(metadata)).not.toContain("cut off mid");
      expect(metadata.salvaged).toBe("true");
    });

    it("truncates a raw completion longer than the cap rather than shipping it unbounded", () => {
      const turn = fakeTurn();
      const huge = "x".repeat(20_000);
      recordGeneration(turn, { name: "router", provider: "openai", model: "gpt-4o", output: {}, rawOutput: huge });
      const output = observationCalls[0].attrs.output as Record<string, unknown>;
      expect((output.rawCompletion as string).length).toBeLessThan(20_000);
      expect((output.rawCompletion as string).endsWith("…")).toBe(true);
    });

    it("falls back to a plain {error} output when there is no rawOutput to show", () => {
      const turn = fakeTurn();
      recordGeneration(turn, { name: "router", provider: "openai", model: "gpt-4o", errorMessage: "timeout" });
      const output = observationCalls[0].attrs.output as Record<string, unknown>;
      expect(output).toEqual({ error: "timeout" });
    });

    it("prefers the raw completion over the generic {error} shape when both are given", () => {
      // The salvage-retry case: errorMessage explains WHY (for the level/statusMessage fields), but
      // the raw text is the actual diagnostic content and must not be replaced by a bare error string.
      const turn = fakeTurn();
      recordGeneration(turn, {
        name: "router",
        provider: "openai",
        model: "gpt-4o",
        output: { reply: "x" },
        rawOutput: "malformed json fragment",
        errorMessage: "Router JSON unparseable; retrying once."
      });
      const output = observationCalls[0].attrs.output as Record<string, unknown>;
      expect(output.rawCompletion).toBe("malformed json fragment");
      expect(output.note).toBe("Router JSON unparseable; retrying once.");
      expect(output).not.toHaveProperty("error");
    });

    it("never throws when the SDK call itself throws", () => {
      const turn = fakeTurn();
      (turn.span as { startObservation: jest.Mock }).startObservation.mockImplementationOnce(() => {
        throw new Error("SDK exploded");
      });
      expect(() => recordGeneration(turn, { name: "router", provider: "openai", model: "gpt-4o", output: {} })).not.toThrow();
    });
  });

  describe("recordReconciliation", () => {
    const ctx = { messageId: "msg-1", sessionId: "session-1", projectId: "project-1", userId: "user-1" };
    const data = { bannerFired: "false-completion-claim", reason: "0 of 3 applied", requested: 3, appliedCount: 0, proposedCount: 0, reply: "final reply text" };

    it("is a no-op when tracing is off", async () => {
      isTracingEnabledMock.mockReturnValue(false);
      await recordReconciliation(ctx, data);
      expect(topLevelCalls).toHaveLength(0);
      expect(createTraceIdMock).not.toHaveBeenCalled();
    });

    it("attaches to the SAME deterministic trace id startZyraTurn would derive from this messageId", async () => {
      isTracingEnabledMock.mockReturnValue(true);
      await recordReconciliation(ctx, data);
      expect(createTraceIdMock).toHaveBeenCalledWith("msg-1");
      expect(topLevelCalls).toHaveLength(1);
      const call = topLevelCalls[0];
      expect(call.name).toBe("reply-reconciliation");
      expect(call.opts.asType).toBe("guardrail");
      expect((call.opts.parentSpanContext as Record<string, unknown>).traceId).toBe("trace-msg-1");
    });

    it("records the banner outcome and the counts, and the final reply text in output, not metadata", async () => {
      isTracingEnabledMock.mockReturnValue(true);
      await recordReconciliation(ctx, data);
      const call = topLevelCalls[0];
      const output = call.attrs.output as Record<string, unknown>;
      expect(output.bannerFired).toBe("false-completion-claim");
      expect(output.finalReply).toContain("final reply text");
      const input = call.attrs.input as Record<string, unknown>;
      expect(input).toEqual({ requested: 3, appliedCount: 0, proposedCount: 0 });
      const metadata = call.attrs.metadata as Record<string, unknown>;
      expect(metadata.bannerFired).toBe("true");
      expect(metadata).not.toHaveProperty("finalReply");
    });

    it("never throws when the SDK call itself throws", async () => {
      isTracingEnabledMock.mockReturnValue(true);
      startObservationMock.mockImplementationOnce(() => {
        throw new Error("SDK exploded");
      });
      await expect(recordReconciliation(ctx, data)).resolves.toBeUndefined();
    });
  });

  // Sanity check that startZyraTurn's own trace-id derivation matches what recordReconciliation
  // uses above — both must key off the SAME messageId, or the two observations land on different
  // traces despite describing the same turn.
  it("startZyraTurn and recordReconciliation derive the same trace id from the same messageId", async () => {
    isTracingEnabledMock.mockReturnValue(true);
    const turn = await startZyraTurn({ messageId: "msg-1", sessionId: "session-1", projectId: "project-1", message: "hi" });
    await recordReconciliation({ messageId: "msg-1", sessionId: "session-1", projectId: "project-1" }, { bannerFired: null, reason: "", requested: 0, appliedCount: 0, proposedCount: 0, reply: "" });
    expect(turn.traceId).toBe(topLevelCalls[topLevelCalls.length - 1].opts.parentSpanContext ? (topLevelCalls[topLevelCalls.length - 1].opts.parentSpanContext as Record<string, unknown>).traceId : null);
  });
});
