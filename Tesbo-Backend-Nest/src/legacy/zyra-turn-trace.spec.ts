import { ZYRA_TRACE_CURRENT_STEP, ZyraTurnTraceRecorder, zyraTraceStepStatus, type ZyraTurnTrace } from "./zyra-turn-trace";

/*
 * The recorder only orders, closes and persists what the pipeline reports — these pin that it
 * never invents a status, never lets a late write overtake the final one, and never throws into
 * the turn it is describing.
 */
describe("ZyraTurnTraceRecorder", () => {
  it("closes each step when the next opens, and derives its status from what the step reported", () => {
    const r = new ZyraTurnTraceRecorder();
    r.onStage("received");
    r.onStage("context:knowledge", { skipped: true, reason: "off" });
    r.onStage("context:jira", { items: [], count: 0 });
    r.onStage("context:testcases", { items: [{ externalId: "TC-1", title: "Login" }], count: 1 });
    const trace = r.finish();
    expect(trace.steps.map((s) => [s.stage, s.status])).toEqual([
      ["received", "ok"],
      ["context:knowledge", "skipped"],
      ["context:jira", "empty"],
      ["context:testcases", "ok"]
    ]);
    expect(trace.outcome).toBe("completed");
    expect(trace.steps.every((s) => s.endedAt !== null)).toBe(true);
  });

  it("an update lands on the named step even after it closed, and re-derives its status", () => {
    const r = new ZyraTurnTraceRecorder();
    r.onStage("routing", { totalContextItems: 3 });
    r.onStage("generating", { requestedCount: 5 });
    r.onStage("routing", { action: "create", status: "blocked", reason: "off" }, "update");
    const trace = r.finish();
    expect(trace.steps[0]).toMatchObject({ stage: "routing", status: "blocked", meta: { totalContextItems: 3, action: "create", reason: "off" } });
  });

  it("numbers repeated stages as attempts, and a failed attempt marks the turn completed_with_errors", () => {
    const r = new ZyraTurnTraceRecorder();
    r.onStage("generating", { requestedCount: 20 });
    r.onStage("generating", { status: "failed", reason: "incomplete" }, "update");
    r.onStage("generating", { requestedCount: 5, retry: true });
    const trace = r.finish();
    expect(trace.steps.map((s) => [s.attempt, s.status])).toEqual([[1, "failed"], [2, "ok"]]);
    expect(trace.outcome).toBe("completed_with_errors");
  });

  it("the current-step target and fail() mark the open step, and fail() finishes the trace as failed", () => {
    const r = new ZyraTurnTraceRecorder();
    r.onStage("routing");
    r.onStage(ZYRA_TRACE_CURRENT_STEP, { status: "timed_out" }, "update");
    expect(r.finish("timed_out").steps[0].status).toBe("timed_out");

    const f = new ZyraTurnTraceRecorder();
    f.onStage("received");
    f.onStage("routing");
    const failed = f.fail("This turn did not complete.");
    expect(failed.outcome).toBe("failed");
    expect(failed.steps[1]).toMatchObject({ status: "failed", meta: { reason: "This turn did not complete." } });
  });

  it("ignores everything after finish, forwarding included", () => {
    const forwarded: string[] = [];
    const r = new ZyraTurnTraceRecorder((stage) => forwarded.push(stage));
    r.onStage("received");
    r.finish();
    r.onStage("late");
    expect(r.snapshot().steps).toHaveLength(1);
    expect(forwarded).toEqual(["received"]);
  });

  it("forwards updates to the live stream with their mode", () => {
    const forwarded: Array<[string, unknown, unknown]> = [];
    const r = new ZyraTurnTraceRecorder((stage, meta, mode) => forwarded.push([stage, meta, mode]));
    r.onStage("routing");
    r.onStage("routing", { action: "answer" }, "update");
    expect(forwarded).toEqual([["routing", undefined, undefined], ["routing", { action: "answer" }, "update"]]);
  });

  it("persists in order once attached, and drain() lets a final write land last", async () => {
    const written: ZyraTurnTrace[] = [];
    const r = new ZyraTurnTraceRecorder();
    r.onStage("received");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    r.attach(async (t) => {
      await gate;
      written.push(t);
    });
    r.onStage("routing");
    const final = r.finish();
    const drained = r.drain();
    release();
    await drained;
    written.push(final);
    expect(written.map((t) => t.steps.length)).toEqual([1, 2, 2]);
    expect(written[written.length - 1].outcome).toBe("completed");
  });

  it("a failing writer or forwarder never throws into the pipeline", async () => {
    const r = new ZyraTurnTraceRecorder(() => {
      throw new Error("sse down");
    });
    r.attach(() => Promise.reject(new Error("db down")));
    expect(() => r.onStage("received")).not.toThrow();
    await expect(r.drain()).resolves.toBeUndefined();
  });

  it("caps persisted item lists but keeps the true count", () => {
    const r = new ZyraTurnTraceRecorder();
    const items = Array.from({ length: 30 }, (_, i) => ({ title: `Doc ${i}`.padEnd(300, "x") }));
    r.onStage("context:knowledge", { items, count: 30 });
    const meta = r.finish().steps[0].meta as { items: Array<{ title: string }>; count: number };
    expect(meta.items).toHaveLength(20);
    expect(meta.count).toBe(30);
    expect(meta.items[0].title.length).toBeLessThanOrEqual(201);
  });

  it("an explicit status wins over the derived one; an unknown one is ignored", () => {
    expect(zyraTraceStepStatus({ status: "blocked", items: [] })).toBe("blocked");
    expect(zyraTraceStepStatus({ status: "whatever" })).toBe("ok");
    expect(zyraTraceStepStatus(undefined)).toBe("ok");
  });
});
