/**
 * The per-request record of what Zyra actually did — the steps the chat UI shows as its trace.
 *
 * Nothing here decides what a step IS: every step is opened by an `onStage(...)` call at the real
 * branch point in legacy.service.ts that just did that work, with `meta` built from the data that
 * work produced. A branch that never ran never opens a step, so the trace cannot list a source or
 * operation the request did not use. This class only orders, times, closes and persists them.
 *
 * Two consumers, one source: the live SSE narration (via `forward`, unchanged in shape — a plain
 * `stage` event per step, plus `update` events for a step whose outcome became known after it
 * opened) and the persisted `zyra_chat_messages.trace` column, which is what a reload, a second
 * tab, the message history, or an API caller reads. The persisted copy is authoritative; SSE is a
 * live preview of it.
 *
 * Like the progress service, this must never be the reason a turn fails: every write is
 * best-effort and swallowed, and nothing it does is awaited by the pipeline except the final flush.
 */

export type ZyraTraceStepStatus = "active" | "ok" | "empty" | "skipped" | "blocked" | "failed" | "timed_out";
export type ZyraTraceOutcome = "running" | "completed" | "completed_with_errors" | "timed_out" | "failed";

export interface ZyraTraceStep {
  stage: string;
  /** 1 for the first time this stage ran in the request, 2 for a retry of it, and so on. */
  attempt: number;
  status: ZyraTraceStepStatus;
  meta?: Record<string, unknown>;
  startedAt: string;
  endedAt: string | null;
}

export interface ZyraTurnTrace {
  version: 1;
  outcome: ZyraTraceOutcome;
  startedAt: string;
  endedAt: string | null;
  steps: ZyraTraceStep[];
}

/**
 * `mode: "update"` merges `meta` into the most recent step named `stage` (or, for
 * ZYRA_TRACE_CURRENT_STEP, whichever step is currently open) instead of opening a new one — how a
 * step records an outcome only known after it started (the router's decision, a timeout, a block).
 */
export type ZyraOnStage = (stage: string, meta?: Record<string, unknown>, mode?: "update") => void;

/** Targets whichever step is currently open — for a catch block that can fail any of several. */
export const ZYRA_TRACE_CURRENT_STEP = "*";

const EXPLICIT_STATUSES = new Set<ZyraTraceStepStatus>(["blocked", "failed", "timed_out", "skipped", "empty", "ok"]);
// Enough to name what was read; `count` keeps the true total when a list is longer than this.
const MAX_PERSISTED_ITEMS = 20;
const MAX_ITEM_TEXT = 200;

/** A closed step's status, read off what the step itself reported — never assumed. */
export function zyraTraceStepStatus(meta: Record<string, unknown> | undefined): ZyraTraceStepStatus {
  const explicit = meta?.status;
  if (typeof explicit === "string" && EXPLICIT_STATUSES.has(explicit as ZyraTraceStepStatus)) return explicit as ZyraTraceStepStatus;
  if (meta?.skipped) return "skipped";
  if (Array.isArray(meta?.items) && meta!.items.length === 0) return "empty";
  return "ok";
}

function boundedMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  if (!Array.isArray(meta.items)) return meta;
  const items = (meta.items as unknown[]).slice(0, MAX_PERSISTED_ITEMS).map((item) => {
    if (!item || typeof item !== "object") return item;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      out[key] = typeof value === "string" && value.length > MAX_ITEM_TEXT ? `${value.slice(0, MAX_ITEM_TEXT)}…` : value;
    }
    return out;
  });
  return { ...meta, items, count: typeof meta.count === "number" ? meta.count : (meta.items as unknown[]).length };
}

export class ZyraTurnTraceRecorder {
  private readonly steps: ZyraTraceStep[] = [];
  private readonly startedAt = new Date().toISOString();
  private endedAt: string | null = null;
  private outcome: ZyraTraceOutcome = "running";
  private frozen = false;
  private writer: ((trace: ZyraTurnTrace) => Promise<unknown>) | null = null;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly forward?: ZyraOnStage) {}

  /** The callback threaded through the pipeline in place of the raw SSE emitter. */
  readonly onStage: ZyraOnStage = (stage, meta, mode) => {
    try {
      if (this.frozen) return;
      if (mode === "update") this.update(stage, meta || {});
      else this.open(stage, meta);
      this.forward?.(stage, meta, mode);
      this.schedulePersist();
    } catch {
      // A broken trace costs the user the trace, never the turn.
    }
  };

  /**
   * Starts persisting to `writer` — called once the row that owns this trace exists (the user
   * message is inserted after `received` already fired). Writes are chained so they land in order.
   */
  attach(writer: (trace: ZyraTurnTrace) => Promise<unknown>): void {
    this.writer = writer;
    this.schedulePersist();
  }

  /**
   * Closes the open step and freezes the trace; later onStage calls are ignored. `outcome` defaults
   * to what the steps show: any failed or timed-out step makes a finished turn "completed_with_errors".
   */
  finish(outcome?: Exclude<ZyraTraceOutcome, "running">): ZyraTurnTrace {
    if (!this.frozen) {
      this.closeOpenStep();
      this.frozen = true;
      this.endedAt = new Date().toISOString();
      this.outcome = outcome ?? (this.steps.some((s) => s.status === "failed" || s.status === "timed_out") ? "completed_with_errors" : "completed");
    }
    return this.snapshot();
  }

  /** Marks the open step failed (with a client-safe reason) and finishes the trace as failed. */
  fail(reason: string): ZyraTurnTrace {
    if (!this.frozen) {
      const open = this.openStep();
      if (open) open.meta = { ...(open.meta || {}), status: "failed", reason };
    }
    return this.finish("failed");
  }

  /** Waits for every in-flight intermediate write, so a final write can never be overtaken by one. */
  async drain(): Promise<void> {
    await this.writes;
  }

  snapshot(): ZyraTurnTrace {
    return {
      version: 1,
      outcome: this.outcome,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      steps: this.steps.map((s) => ({ ...s, meta: boundedMeta(s.meta) }))
    };
  }

  private openStep(): ZyraTraceStep | undefined {
    const last = this.steps[this.steps.length - 1];
    return last && last.status === "active" ? last : undefined;
  }

  private closeOpenStep(): void {
    const open = this.openStep();
    if (!open) return;
    open.status = zyraTraceStepStatus(open.meta);
    open.endedAt = new Date().toISOString();
  }

  private open(stage: string, meta: Record<string, unknown> | undefined): void {
    this.closeOpenStep();
    const attempt = this.steps.filter((s) => s.stage === stage).length + 1;
    this.steps.push({ stage, attempt, status: "active", meta, startedAt: new Date().toISOString(), endedAt: null });
  }

  private update(stage: string, patch: Record<string, unknown>): void {
    const target = stage === ZYRA_TRACE_CURRENT_STEP
      ? this.openStep() ?? this.steps[this.steps.length - 1]
      : [...this.steps].reverse().find((s) => s.stage === stage);
    if (!target) return;
    target.meta = { ...(target.meta || {}), ...patch };
    // An already-closed step re-derives its status from the patched meta (e.g. a routing step
    // closed by the next step opening, then marked blocked once the capability gate ran).
    if (target.status !== "active") target.status = zyraTraceStepStatus(target.meta);
  }

  private schedulePersist(): void {
    const writer = this.writer;
    if (!writer) return;
    const trace = this.snapshot();
    this.writes = this.writes.then(() => writer(trace)).catch(() => undefined);
  }
}
