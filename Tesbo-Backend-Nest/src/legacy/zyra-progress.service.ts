import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ReplaySubject } from "rxjs";

/**
 * A live, best-effort narration of one Zyra chat turn's pipeline — "reading the knowledge base",
 * "generating test cases", and so on — observed over an SSE stream (see the `/turns/:turnId/events`
 * route in legacy.controller.ts) while `POST .../messages` runs its course exactly as it always has.
 *
 * This is the whole risk-reduction idea behind this feature, worth restating here because every
 * method below exists to protect it: the POST is completely unaware this service exists unless the
 * caller opts in by passing a `turnId`, and even then this service can only ever ADD an optional
 * side channel — it can never slow down, alter the result of, or fail the actual generation. If
 * this file has a bug, the worst case is a chat turn with no progress narration; it can never be
 * the reason a chat turn fails.
 *
 * Kill switch: set ZYRA_PROGRESS_STREAMING_ENABLED=false to disable the whole feature without a
 * revert — see LegacyController, which checks this before ever registering a turn here.
 */

export type ZyraProgressEvent =
  | { kind: "stage"; stage: string; meta?: Record<string, unknown> }
  | { kind: "complete"; payload: unknown }
  | { kind: "error"; message: string }
  | { kind: "unknown" };

interface ZyraProgressOwner {
  projectId: string;
  sessionId: string;
  userId: string;
}

interface ZyraProgressEntry {
  subject: ReplaySubject<ZyraProgressEvent>;
  owner: ZyraProgressOwner;
  createdAt: number;
}

function sameOwner(a: ZyraProgressOwner, b: ZyraProgressOwner): boolean {
  return a.projectId === b.projectId && a.sessionId === b.sessionId && a.userId === b.userId;
}

@Injectable()
export class ZyraProgressService implements OnModuleDestroy {
  private readonly logger = new Logger(ZyraProgressService.name);
  private readonly turns = new Map<string, ZyraProgressEntry>();

  // A turn that somehow never reaches complete()/completeWithError() (a bug here, a process
  // restart mid-turn) must not accumulate forever in a long-lived process. This is the backstop —
  // normal operation always cleans up via the POST handler's own finally block before this ever
  // fires. Generous on purpose: real turns finish well inside ZYRA_GENERATE_TIMEOUT_MS (180s).
  private static readonly ABANDONED_AFTER_MS = 10 * 60 * 1000;
  private readonly sweepInterval = setInterval(() => this.sweep(), 60 * 1000);

  onModuleDestroy(): void {
    clearInterval(this.sweepInterval);
  }

  private sweep(): void {
    const cutoff = Date.now() - ZyraProgressService.ABANDONED_AFTER_MS;
    for (const [turnId, entry] of this.turns) {
      if (entry.createdAt > cutoff) continue;
      this.logger.warn(`Sweeping abandoned Zyra progress turn ${turnId} (never completed).`);
      this.completeWithError(turnId, "This turn's progress stream was never closed.");
    }
  }

  /**
   * Registers (or re-attaches to) the subject for a turn. Returns "foreign" instead of the real
   * subject when a turnId already exists under a DIFFERENT owner — this should be practically
   * unreachable (turnId is a client-generated v4 UUID with no path for one party to guess
   * another's), but costs nothing to guard: a caller that gets "foreign" back should treat it
   * exactly like the feature being off — degrade silently, never attach to someone else's stream.
   */
  private registerOrAttach(turnId: string, owner: ZyraProgressOwner): { status: "ok"; subject: ReplaySubject<ZyraProgressEvent> } | { status: "foreign" } {
    const existing = this.turns.get(turnId);
    if (existing) {
      if (!sameOwner(existing.owner, owner)) return { status: "foreign" };
      return { status: "ok", subject: existing.subject };
    }
    // Bounded replay buffer: generous enough for every stage this turn will ever emit (single
    // digits — up to ~9 named stages per chat turn as of the progress-backlog work, plus one
    // terminal complete/error), small enough that a turn nobody ever reads back costs nothing
    // meaningful.
    const subject = new ReplaySubject<ZyraProgressEvent>(50);
    this.turns.set(turnId, { subject, owner, createdAt: Date.now() });
    return { status: "ok", subject };
  }

  /**
   * Builds an `onStage` callback for `LegacyService.sendZyraChatMessage` — bound to this one turn,
   * safe to call any number of times, and guaranteed never to throw into its caller regardless of
   * what goes wrong here. Returns a plain no-op when the turn is unknown/foreign, so the pipeline
   * that invokes it never needs to branch on whether streaming is actually active.
   */
  stageEmitter(turnId: string, owner: ZyraProgressOwner): (stage: string, meta?: Record<string, unknown>) => void {
    const attached = this.registerOrAttach(turnId, owner);
    if (attached.status !== "ok") return () => {};
    const subject = attached.subject;
    return (stage, meta) => {
      try {
        subject.next({ kind: "stage", stage, meta });
      } catch (err) {
        // Must never propagate into the generation pipeline — a broken progress feature can only
        // ever cost the user the progress narration, never the generation itself.
        this.logger.warn(`Failed to emit Zyra progress stage '${stage}' for turn ${turnId}: ${String(err)}`);
      }
    };
  }

  /** Terminal, success case — carries the same payload the POST response itself returns. */
  complete(turnId: string, payload: unknown): void {
    const entry = this.turns.get(turnId);
    if (!entry) return; // already completed, or no subscriber ever registered — nothing to do
    try {
      entry.subject.next({ kind: "complete", payload });
      entry.subject.complete();
    } catch (err) {
      this.logger.warn(`Failed to complete Zyra progress turn ${turnId}: ${String(err)}`);
    } finally {
      this.turns.delete(turnId);
    }
  }

  /** Terminal, failure case. `message` must already be safe to show a client — see the caller. */
  completeWithError(turnId: string, message: string): void {
    const entry = this.turns.get(turnId);
    if (!entry) return;
    try {
      entry.subject.next({ kind: "error", message });
      entry.subject.complete();
    } catch (err) {
      this.logger.warn(`Failed to error-complete Zyra progress turn ${turnId}: ${String(err)}`);
    } finally {
      this.turns.delete(turnId);
    }
  }

  /**
   * The read side, for the SSE route. Deliberately read-only (never creates an entry) — only the
   * POST handler's stageEmitter() creates one. A turnId this process never registered (or
   * registered under a different owner) is treated identically to "already finished": a single
   * `unknown` event and done, never an error, since a POST the caller is also awaiting is the real
   * source of truth regardless of what this stream shows.
   *
   * This makes request ORDER load-bearing for whether live narration is seen at all (not for
   * correctness — the POST is unaffected either way): the frontend must fire the POST before
   * opening this stream, not after or "concurrently" in a way that could reorder them. Node
   * processes both on one event loop, so firing the POST first in the same script turn makes it
   * overwhelmingly likely to register before this GET asks — but if this GET still loses that race
   * on some request, the correct behavior is exactly what's implemented here: say `unknown` and let
   * the client fall back to its POST promise, not add a second creation path to chase a rarer race.
   */
  subscribe(turnId: string, owner: ZyraProgressOwner): ReplaySubject<ZyraProgressEvent> | null {
    const existing = this.turns.get(turnId);
    if (!existing || !sameOwner(existing.owner, owner)) return null;
    return existing.subject;
  }
}
