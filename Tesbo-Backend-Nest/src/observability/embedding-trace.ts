import { Logger } from "@nestjs/common";
import { isTracingEnabled } from "./langfuse";

/*
 * Langfuse instrumentation for embedding-provider calls (see rag-ai-allocation.ts::embedTexts).
 *
 * Two execution contexts feed this: a live Zyra chat turn (retrieval-time query embedding, where a
 * trace is already open or about to open) and a background BullMQ job with no chat turn at all
 * (ingestion-time document/file/testcase embedding — see rag-embedding.processor.ts).
 * tracedEmbeddingCall is the single choke point both funnel through, so the "must never break the
 * caller" contract lives in exactly one place rather than depending on every call site remembering
 * it correctly.
 *
 * The load-bearing guarantee: fn()'s result or thrown error is ALWAYS returned/rethrown unchanged.
 * rag-embedding.processor.ts's BullMQ retry/backoff and eventual `failed` status depend on the real
 * embedTexts() error propagating out of this wrapper — a tracing layer that swallowed it would
 * silently break that mechanism. Every Langfuse-side operation is therefore wrapped in its own
 * try/catch and only ever logs a warning; it can never suppress a real failure or fabricate a
 * success. See docs/superpowers/specs/2026-09-17-langfuse-embedding-instrumentation-design.md.
 */

const logger = new Logger("EmbeddingTrace");

const INPUT_SAMPLE_MAX = 200;

function shorten(value: string | undefined, max = INPUT_SAMPLE_MAX): string | undefined {
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export interface EmbeddingCallContext {
  /** An already-open trace (e.g. turn.traceId) — used as-is, no re-hash. Takes precedence over traceSeed. */
  traceId?: string | null;
  /** No open trace yet, or no chat turn at all — hashed via createTraceId() to open/rejoin a trace. */
  traceSeed?: string | null;
  /** Observation name, e.g. "query-embedding" | "kb-chunk-embedding-batch" | "testcase-embedding". */
  name: string;
  projectId: string;
  organizationId?: string | null;
  provider: string;
  model: string;
  inputCount: number;
  /** Capped sample for the trace — never the full batch text (batches can carry up to 96 chunks). */
  inputSample?: string;
}

type EmbeddingObservation = {
  update: (attrs: Record<string, unknown>) => unknown;
  end: () => void;
};

async function resolveTraceId(ctx: EmbeddingCallContext): Promise<string | null> {
  if (ctx.traceId) return ctx.traceId;
  if (ctx.traceSeed) {
    const { createTraceId } = await import("@langfuse/tracing");
    return createTraceId(ctx.traceSeed);
  }
  return null;
}

async function openSpan(ctx: EmbeddingCallContext): Promise<EmbeddingObservation | null> {
  if (!isTracingEnabled()) return null;
  try {
    const traceId = await resolveTraceId(ctx);
    if (!traceId) return null;
    const { startObservation } = await import("@langfuse/tracing");
    return startObservation(
      ctx.name,
      {
        model: ctx.model,
        input: { inputCount: ctx.inputCount, sample: shorten(ctx.inputSample) },
        metadata: {
          provider: ctx.provider,
          projectId: ctx.projectId,
          organizationId: ctx.organizationId ?? ""
        }
      },
      { asType: "embedding", parentSpanContext: { traceId, spanId: "0000000000000001", traceFlags: 1 } }
    ) as unknown as EmbeddingObservation;
  } catch (err) {
    logger.warn(`Failed to open embedding span: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function closeSpanSuccess(span: EmbeddingObservation | null, vectors: number[][], durationMs: number): void {
  if (!span) return;
  try {
    span.update({
      output: { vectorCount: vectors.length, dimension: vectors[0]?.length ?? 0 },
      metadata: { durationMs: String(durationMs) }
    });
    span.end();
  } catch (err) {
    logger.warn(`Failed to close embedding span (success): ${err instanceof Error ? err.message : err}`);
  }
}

function closeSpanError(span: EmbeddingObservation | null, message: string, durationMs: number): void {
  if (!span) return;
  try {
    span.update({
      output: { error: message },
      level: "ERROR",
      statusMessage: shorten(message, 500),
      metadata: { durationMs: String(durationMs) }
    });
    span.end();
  } catch (err) {
    logger.warn(`Failed to close embedding span (error): ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Wraps one embeddings-provider HTTP call with a Langfuse `embedding` observation.
 *
 * Always calls `fn` exactly once and always returns/rethrows exactly what `fn` resolves/rejects
 * with — a fault anywhere in this wrapper (SDK error, tracing disabled, no trace context supplied)
 * is caught and logged, never propagated in place of the real result and never swallowing a real
 * failure.
 */
export async function tracedEmbeddingCall(ctx: EmbeddingCallContext, fn: () => Promise<number[][]>): Promise<number[][]> {
  const startedAt = Date.now();
  const span = await openSpan(ctx);
  try {
    const vectors = await fn();
    closeSpanSuccess(span, vectors, Date.now() - startedAt);
    return vectors;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    closeSpanError(span, message, Date.now() - startedAt);
    throw err;
  }
}
