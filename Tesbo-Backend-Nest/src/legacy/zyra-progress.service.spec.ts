import { ZyraProgressService, type ZyraProgressEvent } from "./zyra-progress.service";

/*
 * The SSE progress side-channel's core correctness properties — see the file header of
 * zyra-progress.service.ts for why each of these matters: this service must never be able to
 * affect the actual Zyra pipeline, only narrate it, and must never leak one turn's narration to
 * the wrong owner or leave a stream open forever.
 */

function collect(subject: { subscribe: (fn: (event: ZyraProgressEvent) => void) => void }): ZyraProgressEvent[] {
  const events: ZyraProgressEvent[] = [];
  subject.subscribe((event) => events.push(event));
  return events;
}

describe("ZyraProgressService", () => {
  let svc: ZyraProgressService;
  const owner = { projectId: "p1", sessionId: "s1", userId: "u1" };

  beforeEach(() => {
    svc = new ZyraProgressService();
  });

  afterEach(() => {
    svc.onModuleDestroy();
  });

  it("replays every stage emitted so far to a subscriber that attaches late", () => {
    const onStage = svc.stageEmitter("turn-1", owner);
    onStage("routing");
    onStage("generating", { count: 3 });

    // Subscribing AFTER both stages already fired — the whole point of ReplaySubject over Subject.
    const subject = svc.subscribe("turn-1", owner)!;
    expect(subject).not.toBeNull();
    const events = collect(subject);
    expect(events).toEqual([
      { kind: "stage", stage: "routing", meta: undefined },
      { kind: "stage", stage: "generating", meta: { count: 3 } },
    ]);
  });

  it("delivers the terminal complete event and then closes the stream", () => {
    const onStage = svc.stageEmitter("turn-2", owner);
    onStage("routing");
    svc.complete("turn-2", { reply: "done" });

    const subject = svc.subscribe("turn-2", owner);
    // complete() already removed the entry — a subscriber attaching after completion sees nothing
    // more to attach to, exactly like "already finished" (see subscribe()'s own doc comment).
    expect(subject).toBeNull();
  });

  it("a subscriber already attached before complete() still receives the final event", () => {
    const onStage = svc.stageEmitter("turn-3", owner);
    const subject = svc.subscribe("turn-3", owner)!;
    const events: ZyraProgressEvent[] = [];
    let completed = false;
    subject.subscribe({ next: (e) => events.push(e), complete: () => { completed = true; } });

    onStage("routing");
    svc.complete("turn-3", { reply: "ok" });

    expect(events).toEqual([
      { kind: "stage", stage: "routing", meta: undefined },
      { kind: "complete", payload: { reply: "ok" } },
    ]);
    expect(completed).toBe(true);
  });

  it("never returns a foreign owner's subject — a turnId collision degrades to silence, not leakage", () => {
    svc.stageEmitter("turn-4", owner);
    const otherOwner = { projectId: "p2", sessionId: "s2", userId: "u2" };

    // A second party's onStage callback for the same turnId, wrong owner — must be a harmless no-op,
    // not an exception and not a write into the first owner's stream.
    const foreignOnStage = svc.stageEmitter("turn-4", otherOwner);
    expect(() => foreignOnStage("should-not-appear")).not.toThrow();

    const subjectForRealOwner = svc.subscribe("turn-4", owner)!;
    const events = collect(subjectForRealOwner);
    expect(events.some((e) => "stage" in e && e.stage === "should-not-appear")).toBe(false);

    // The wrong owner querying the same turnId must also see nothing, not the real owner's stream.
    expect(svc.subscribe("turn-4", otherOwner)).toBeNull();
  });

  it("complete() and completeWithError() are idempotent — a double call never throws", () => {
    svc.stageEmitter("turn-5", owner);
    expect(() => {
      svc.complete("turn-5", { ok: true });
      svc.complete("turn-5", { ok: true }); // second call: entry already gone, must no-op
      svc.completeWithError("turn-5", "too late"); // also must no-op, not resurrect the entry
    }).not.toThrow();
    expect(svc.subscribe("turn-5", owner)).toBeNull();
  });

  it("completeWithError delivers an error event and closes the stream", () => {
    const onStage = svc.stageEmitter("turn-6", owner);
    const subject = svc.subscribe("turn-6", owner)!;
    const events: ZyraProgressEvent[] = [];
    let completed = false;
    subject.subscribe({ next: (e) => events.push(e), complete: () => { completed = true; } });

    onStage("generating");
    svc.completeWithError("turn-6", "generation failed");

    expect(events).toEqual([
      { kind: "stage", stage: "generating", meta: undefined },
      { kind: "error", message: "generation failed" },
    ]);
    expect(completed).toBe(true);
  });

  it("an onStage call for a turn that was never registered (or already completed) is a silent no-op", () => {
    expect(() => {
      const onStage = svc.stageEmitter("turn-7", owner);
      svc.complete("turn-7", {});
      onStage("late-stage-after-completion"); // must not throw, must not resurrect the entry
    }).not.toThrow();
    expect(svc.subscribe("turn-7", owner)).toBeNull();
  });

  it("subscribing to a turnId that was never registered at all returns null, never throws", () => {
    expect(svc.subscribe("never-existed", owner)).toBeNull();
  });

  it("two independent turns never cross-contaminate each other's stages", () => {
    const onStageA = svc.stageEmitter("turn-a", owner);
    const onStageB = svc.stageEmitter("turn-b", owner);
    onStageA("routing");
    onStageB("generating");
    onStageA("staging");

    const eventsA = collect(svc.subscribe("turn-a", owner)!);
    const eventsB = collect(svc.subscribe("turn-b", owner)!);
    expect(eventsA.map((e) => (e as { stage: string }).stage)).toEqual(["routing", "staging"]);
    expect(eventsB.map((e) => (e as { stage: string }).stage)).toEqual(["generating"]);
  });
});
