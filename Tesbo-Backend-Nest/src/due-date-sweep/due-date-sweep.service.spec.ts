import { DueDateSweepService } from "./due-date-sweep.service";

type Row = Record<string, string | null>;

function build(opts: { runs?: Row[]; plans?: Row[]; assignees?: string[]; owners?: string[]; timezone?: string }) {
  const notifyUsers = jest.fn().mockResolvedValue(1);
  const query = jest.fn(async (sql: string) => {
    if (sql.includes("FROM cycles c")) return { rows: opts.runs ?? [] };
    if (sql.includes("FROM plans pl")) return { rows: opts.plans ?? [] };
    if (sql.includes("FROM executions e")) return { rows: (opts.assignees ?? []).map((assignee_id) => ({ assignee_id })) };
    if (sql.includes("FROM project_members")) return { rows: (opts.owners ?? []).map((user_id) => ({ user_id })) };
    return { rows: [] };
  });
  const service = new DueDateSweepService({ query } as never, { notifyUsers } as never);
  return { service, notifyUsers, query };
}

const run = (dueDate: string, extra: Row = {}): Row => ({
  id: "run-1",
  name: "Sprint 4",
  external_id: null,
  status: "In Progress",
  owner_id: "owner-1",
  project_id: "proj-1",
  project_name: "Project 2",
  due_date: dueDate,
  timezone: "Asia/Kolkata",
  ...extra
});

// 2026-10-25 09:30 in Asia/Kolkata (04:00 UTC).
const MORNING = new Date("2026-10-25T04:00:00Z");

describe("DueDateSweepService", () => {
  it("sends due-tomorrow, due-today and overdue under distinct types", async () => {
    for (const [due, type, title] of [
      ["2026-10-26", "test_run_due_soon", "Test run Sprint 4 is due tomorrow."],
      ["2026-10-25", "test_run_due_today", "Test run Sprint 4 is due today."],
      ["2026-10-24", "test_run_overdue", "Test run Sprint 4 is overdue."]
    ] as const) {
      const { service, notifyUsers } = build({ runs: [run(due)] });
      await service.run(MORNING);
      expect(notifyUsers).toHaveBeenCalledTimes(1);
      const [, opts] = notifyUsers.mock.calls[0];
      expect(opts.type).toBe(type);
      expect(opts.title).toBe(title);
    }
  });

  it("names project, due date and status in the body, and links to the run", async () => {
    const { service, notifyUsers } = build({ runs: [run("2026-10-25")] });
    await service.run(MORNING);
    const [, opts] = notifyUsers.mock.calls[0];
    expect(opts.body).toBe("Project: Project 2 · Due: 25 Oct 2026 · Status: In Progress");
    expect(opts.link).toEqual({ linkEntityType: "test_run", linkEntityId: "proj-1:run-1" });
  });

  it("keys the dedupe on the due date so a moved date starts fresh reminders", async () => {
    const a = build({ runs: [run("2026-10-25")] });
    await a.service.run(MORNING);
    const b = build({ runs: [run("2026-10-26")] });
    await b.service.run(MORNING);
    expect(a.notifyUsers.mock.calls[0][1].dedupeKey).toBe("due:run:run-1:2026-10-25:due_today");
    expect(b.notifyUsers.mock.calls[0][1].dedupeKey).toBe("due:run:run-1:2026-10-26:due_soon");
  });

  it("says nothing about a date more than a day out", async () => {
    const { service, notifyUsers } = build({ runs: [run("2026-10-30")] });
    await service.run(MORNING);
    expect(notifyUsers).not.toHaveBeenCalled();
  });

  it("waits until the workspace's local morning", async () => {
    // 2026-10-24 20:00 UTC is 01:30 on the 25th in Kolkata: due today there, but not yet 08:00.
    const { service, notifyUsers } = build({ runs: [run("2026-10-25")] });
    await service.run(new Date("2026-10-24T20:00:00Z"));
    expect(notifyUsers).not.toHaveBeenCalled();
  });

  it("judges the day in the workspace's zone, not UTC", async () => {
    // 2026-10-25 20:00 UTC is 09:00 on the 26th in Auckland, so a date of the 25th is overdue there
    // even though it is still "today" in UTC.
    const { service, notifyUsers } = build({ runs: [run("2026-10-25", { timezone: "Pacific/Auckland" })] });
    await service.run(new Date("2026-10-25T20:00:00Z"));
    expect(notifyUsers.mock.calls[0][1].type).toBe("test_run_overdue");
  });

  it("stops announcing an overdue date after the catch-up window", async () => {
    const { service, notifyUsers } = build({ runs: [run("2026-09-01")] });
    await service.run(MORNING);
    expect(notifyUsers).not.toHaveBeenCalled();
  });

  it("tells the owner and the assignees with unfinished cases", async () => {
    const { service, notifyUsers } = build({ runs: [run("2026-10-25")], assignees: ["qa-1", "owner-1"] });
    await service.run(MORNING);
    expect(new Set(notifyUsers.mock.calls[0][0])).toEqual(new Set(["owner-1", "qa-1"]));
    expect(notifyUsers.mock.calls[0][1].memberOf).toEqual({ projectId: "proj-1" });
  });

  it("falls back to project owners when the item has no owner and no assignees", async () => {
    const { service, notifyUsers } = build({ runs: [run("2026-10-25", { owner_id: null })], owners: ["po-1"] });
    await service.run(MORNING);
    expect(notifyUsers.mock.calls[0][0]).toEqual(["po-1"]);
  });

  it("sends nothing when there is nobody to tell", async () => {
    const { service, notifyUsers } = build({ runs: [run("2026-10-25", { owner_id: null })] });
    const summary = await service.run(MORNING);
    expect(notifyUsers).not.toHaveBeenCalled();
    expect(summary.notificationRows).toBe(0);
  });

  it("reminds about a plan with the plan wording and link", async () => {
    const plan: Row = { id: "plan-1", name: "Release 3", external_id: null, owner_id: "owner-1", project_id: "proj-1", project_name: "Project 2", due_date: "2026-10-25", timezone: "Asia/Kolkata", status: "Active" };
    const { service, notifyUsers } = build({ plans: [plan] });
    await service.run(MORNING);
    const [, opts] = notifyUsers.mock.calls[0];
    expect(opts.type).toBe("test_plan_due_today");
    expect(opts.title).toBe("Test plan Release 3 is due today.");
    expect(opts.link).toEqual({ linkEntityType: "test_plan", linkEntityId: "proj-1:plan-1" });
  });

  it("only asks the database for open items (completed runs and finished plans are filtered in SQL)", async () => {
    const { service, query } = build({});
    await service.run(MORNING);
    const sqls = query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("c.status <> 'Completed'") && s.includes("c.deleted_at IS NULL"))).toBe(true);
    expect(sqls.some((s) => s.includes("pl.deleted_at IS NULL") && s.includes("r.status <> 'Completed'"))).toBe(true);
  });

  it("keeps going when one item fails", async () => {
    const { service, notifyUsers } = build({ runs: [run("2026-10-25", { id: "bad" }), run("2026-10-25", { id: "good" })] });
    notifyUsers.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(1);
    const summary = await service.run(MORNING);
    expect(summary.failures).toBe(1);
    expect(summary.notifiedItems).toBe(1);
  });
});
