import { Logger } from "@nestjs/common";
import { isTracingEnabled } from "./langfuse";

/*
 * What a Zyra turn records.
 *
 * Shaped around the two questions that were unanswerable from the product, both of which took
 * database forensics to settle:
 *
 *   "which Jira tickets did it read?"  — the reply said "1 Jira ticket(s) read directly" and named
 *      CREATE-10, a ticket that existed in no Jira anywhere. It turned out our own key extractor
 *      built it out of the words "create 10". A count cannot show that; a lifecycle can.
 *
 *   "which knowledge-base documents did it consider?" — the reply said "1 knowledge-base item(s)"
 *      and never which one, so nobody could tell a correct retrieval from a wrong one, or notice
 *      that the vector half of the search had never run in production at all.
 *
 * So the rule here is: record IDENTITY and PROVENANCE, never just counts. Which key, which
 * document, where it came from, and what happened to it at each step.
 *
 * Every export is a no-op when tracing is off, and every one is wrapped — a fault in this file
 * must never surface in a chat turn.
 */

const logger = new Logger("AiTrace");

/** Langfuse caps propagated metadata values at 200 chars and drops non-strings silently. */
const META_MAX = 200;

/*
 * Trace-level OTel attribute keys, mirroring LangfuseOtelSpanAttributes in @langfuse/core.
 *
 * Duplicated as literals because every record* function below is synchronous and the SDK is
 * ESM-only behind a dynamic import. startZyraTurn asserts these against the real enum on each
 * boot, so an SDK rename shows up as a log line rather than as silently unattributed traces.
 */
const TRACE_SESSION_ID = "session.id";
const TRACE_USER_ID = "user.id";
const TRACE_NAME = "langfuse.trace.name";

export interface TurnHandle {
  /** Null when tracing is off, or when the SDK failed to produce a span. */
  readonly span: unknown | null;
  readonly traceId: string | null;
  /** Restamped onto every child span, the way propagateAttributes would. See stampTraceIdentity. */
  readonly sessionId?: string | null;
  readonly userId?: string | null;
}

const NO_TURN: TurnHandle = { span: null, traceId: null };

function shorten(value: unknown, max = META_MAX): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

type Observation = {
  update: (attrs: Record<string, unknown>) => unknown;
  end: () => void;
  startObservation: (name: string, attrs: Record<string, unknown>, opts: { asType: string }) => Observation;
  /** The wrapped OTel span. Public on LangfuseBaseObservation; the only way to reach trace-level keys. */
  readonly otelSpan?: { setAttribute: (key: string, value: string) => unknown };
};

/**
 * Stamps session/user onto one span.
 *
 * Applied to the root AND to every child, because that is what `propagateAttributes` does — it
 * puts the keys on every span in scope. Verified against the instance: a child span left
 * unstamped comes back from `/api/public/v2/observations` with `sessionId: ""`, so relying on
 * the root alone would make session grouping depend on which observation the trace record is
 * assembled from.
 */
function stampTraceIdentity(span: Observation | null | undefined, turn: TurnHandle): void {
  if (!span?.otelSpan) return;
  if (turn.sessionId) span.otelSpan.setAttribute(TRACE_SESSION_ID, turn.sessionId);
  if (turn.userId) span.otelSpan.setAttribute(TRACE_USER_ID, turn.userId);
}

/**
 * Opens the trace for one Zyra chat turn.
 *
 * The trace id is derived deterministically from the chat message id, so a support report ("Zyra
 * did the wrong thing on this message") maps to its trace by recomputing the id — no trace_id
 * column, no backfill, and it works for messages written before this shipped.
 */
export async function startZyraTurn(ctx: {
  messageId: string;
  sessionId: string;
  projectId: string;
  organizationId?: string | null;
  userId?: string | null;
  message: string;
  provider?: string;
  model?: string;
}): Promise<TurnHandle> {
  if (!isTracingEnabled()) return NO_TURN;
  try {
    const { startObservation, createTraceId, LangfuseOtelSpanAttributes } = await import("@langfuse/tracing");
    const traceId = await createTraceId(ctx.messageId);
    const span = startObservation(
      "zyra.chat.turn",
      {
        input: { message: ctx.message },
        metadata: {
          projectId: ctx.projectId,
          organizationId: ctx.organizationId ?? "",
          sessionId: ctx.sessionId,
          messageId: ctx.messageId,
          provider: ctx.provider ?? "",
          model: ctx.model ?? ""
        }
      },
      { asType: "agent", parentSpanContext: { traceId, spanId: "0000000000000001", traceFlags: 1 } }
    ) as unknown as Observation;

    /*
     * Trace-level identity. Without these three keys the trace still lands, but Langfuse's
     * Sessions and Users pages are empty and the traces list shows an unnamed row — which is
     * indistinguishable from "tracing isn't working".
     *
     * `sessionId` in observation metadata does NOT do this. Sessions are keyed off the OTel
     * attribute `session.id` (LangfuseOtelSpanAttributes.TRACE_SESSION_ID); metadata is a
     * separate, purely descriptive blob.
     *
     * `propagateAttributes()` is the documented route, but it wraps a function scope and this
     * module deliberately hands back a handle instead — see the header. Setting the keys on the
     * span reaches the same attributes.
     *
     * Only identifiers and a constant name go here. Trace-level input/output would ALSO be a
     * plain span attribute and would therefore bypass the mask hook (langfuse.ts, §mask): the
     * message text stays on the observation, where masking applies.
     */
    const expected: Array<[string, string]> = [
      [LangfuseOtelSpanAttributes.TRACE_SESSION_ID, TRACE_SESSION_ID],
      [LangfuseOtelSpanAttributes.TRACE_USER_ID, TRACE_USER_ID],
      [LangfuseOtelSpanAttributes.TRACE_NAME, TRACE_NAME]
    ];
    for (const [fromSdk, local] of expected) {
      if (fromSdk !== local) logger.warn(`Langfuse renamed a trace attribute: expected "${local}", SDK says "${fromSdk}".`);
    }

    const turn: TurnHandle = { span, traceId, sessionId: ctx.sessionId, userId: ctx.userId ?? null };
    stampTraceIdentity(span, turn);
    span.otelSpan?.setAttribute(TRACE_NAME, "zyra.chat.turn");

    return turn;
  } catch (err) {
    logger.warn(`startZyraTurn failed: ${err instanceof Error ? err.message : err}`);
    return NO_TURN;
  }
}

/**
 * The full life of every Jira key in this message.
 *
 * `extracted` is what the pattern matched, `validated` is what survived the project's configured
 * Jira projects, and `resolved` is what actually came back as a ticket — each with its provenance.
 * The gap between the three columns is the finding: extracted CREATE-10 → validated none is the
 * phantom-key bug, visible at a glance instead of via a database audit.
 */
export function recordJiraContext(
  turn: TurnHandle,
  data: {
    extracted: string[];
    validated: string[];
    configuredProjectKeys: string[];
    resolved: Array<{ key: string; source: "cache" | "live-fetch"; summary?: string }>;
    relevanceMatched: string[];
  }
): void {
  if (!turn.span) return;
  try {
    const discarded = data.extracted.filter((key) => !data.validated.includes(key));
    const requested = new Set(data.validated);
    const resolvedKeys = new Set(data.resolved.map((row) => row.key));
    const child = (turn.span as Observation).startObservation(
      "jira-context",
      {
        input: {
          extractedFromMessage: data.extracted,
          configuredProjectKeys: data.configuredProjectKeys
        },
        output: {
          validated: data.validated,
          // Named rather than counted: a key thrown away here is either a bug we just fixed or a
          // project whose Jira mapping is missing, and those need telling apart.
          discardedAsNotAProjectKey: discarded,
          resolvedFromCache: data.resolved.filter((row) => row.source === "cache").map((row) => row.key),
          resolvedByLiveFetch: data.resolved.filter((row) => row.source === "live-fetch").map((row) => row.key),
          requestedButNotFound: [...requested].filter((key) => !resolvedKeys.has(key)),
          alsoIncludedByRelevance: data.relevanceMatched,
          tickets: data.resolved.map((row) => ({ key: row.key, summary: shorten(row.summary ?? "", 120), source: row.source }))
        },
        metadata: {
          extractedCount: String(data.extracted.length),
          validatedCount: String(data.validated.length),
          resolvedCount: String(data.resolved.length),
          liveFetchCount: String(data.resolved.filter((row) => row.source === "live-fetch").length),
          jiraConfigured: String(data.configuredProjectKeys.length > 0)
        }
      },
      { asType: "tool" }
    );
    stampTraceIdentity(child, turn);
    child.end();
  } catch (err) {
    logger.warn(`recordJiraContext failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Which knowledge-base documents were considered, by name, and how each was found.
 *
 * `semanticSearchRan` is the one that matters most: the vector half of hybrid retrieval had never
 * produced a row in production, and because a missing embeddings key returns the same empty list
 * as "nothing relevant", nothing ever said so. Recording it as a boolean next to the reason makes
 * a silent degradation a visible one.
 */
export function recordKnowledgeContext(
  turn: TurnHandle,
  data: {
    query: string;
    semanticSearchRan: boolean;
    reason: string;
    retrieved: Array<{ title: string; sourceType?: string; sourceId?: string; score?: number }>;
    folderMatched: Array<{ title: string }>;
    fallbackUsed: boolean;
  }
): void {
  if (!turn.span) return;
  try {
    const child = (turn.span as Observation).startObservation(
      "knowledge-context",
      {
        input: { query: shorten(data.query, 500) },
        output: {
          // Titles, not a count. "1 knowledge-base item(s)" is what made this unauditable.
          documents: data.retrieved.map((item) => ({
            title: item.title,
            sourceType: item.sourceType ?? "",
            sourceId: item.sourceId ?? "",
            score: typeof item.score === "number" ? Number(item.score.toFixed(5)) : null
          })),
          matchedByFolderName: data.folderMatched.map((item) => item.title),
          semanticSearchRan: data.semanticSearchRan,
          reason: data.reason,
          fellBackToRecentDocuments: data.fallbackUsed
        },
        metadata: {
          documentCount: String(data.retrieved.length),
          semanticSearchRan: String(data.semanticSearchRan),
          fellBackToRecentDocuments: String(data.fallbackUsed),
          reason: shorten(data.reason)
        }
      },
      { asType: "retriever" }
    );
    stampTraceIdentity(child, turn);
    child.end();
  } catch (err) {
    logger.warn(`recordKnowledgeContext failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Existing test cases shown to the model for duplicate avoidance — named, not counted. */
export function recordExistingCoverage(turn: TurnHandle, data: { searchTerms: string[]; testcases: Array<{ externalId?: string; title?: string }> }): void {
  if (!turn.span) return;
  try {
    const child = (turn.span as Observation).startObservation(
      "existing-coverage",
      {
        input: { searchTerms: data.searchTerms },
        output: {
          // A message like "create 10 first" has no content words, so this comes back empty and
          // duplicate-avoidance silently does nothing. Showing the terms explains the empty result.
          testcases: data.testcases.slice(0, 50).map((row) => ({ externalId: row.externalId ?? "", title: shorten(row.title ?? "", 120) }))
        },
        metadata: { count: String(data.testcases.length), searchTermCount: String(data.searchTerms.length) }
      },
      { asType: "span" }
    );
    stampTraceIdentity(child, turn);
    child.end();
  } catch (err) {
    logger.warn(`recordExistingCoverage failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** One model call, with usage so cost aggregates per workspace. */
export function recordGeneration(
  turn: TurnHandle,
  data: {
    name: string;
    provider: string;
    model: string;
    input?: unknown;
    output?: unknown;
    usage?: { input?: number; output?: number; cached?: number };
    errorMessage?: string;
  }
): void {
  if (!turn.span) return;
  try {
    const child = (turn.span as Observation).startObservation(
      data.name,
      {
        model: data.model,
        input: data.input,
        output: data.errorMessage ? { error: data.errorMessage } : data.output,
        ...(data.usage ? { usageDetails: { input: data.usage.input ?? 0, output: data.usage.output ?? 0 } } : {}),
        metadata: { provider: data.provider, ...(data.usage?.cached ? { cachedInputTokens: String(data.usage.cached) } : {}) },
        ...(data.errorMessage ? { level: "ERROR", statusMessage: shorten(data.errorMessage) } : {})
      },
      { asType: "generation" }
    );
    stampTraceIdentity(child, turn);
    child.end();
  } catch (err) {
    logger.warn(`recordGeneration failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * What the turn actually wrote, next to what the reply claimed.
 *
 * Placing these on the same trace is the point: the recurring Zyra failure is a reply announcing
 * work the database never received, and side-by-side that is obvious rather than forensic.
 */
export function endZyraTurn(
  turn: TurnHandle,
  data: { reply: string; actionType: string; createdTestcaseIds?: string[]; operationsRequested?: number; operationsApplied?: number }
): void {
  if (!turn.span) return;
  try {
    (turn.span as Observation).update({
      output: {
        reply: shorten(data.reply, 2000),
        actionType: data.actionType,
        operationsRequested: data.operationsRequested ?? 0,
        operationsApplied: data.operationsApplied ?? 0,
        createdTestcaseIds: data.createdTestcaseIds ?? []
      }
    });
    (turn.span as Observation).end();
  } catch (err) {
    logger.warn(`endZyraTurn failed: ${err instanceof Error ? err.message : err}`);
  }
}
