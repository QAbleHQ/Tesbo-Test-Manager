import type { Queue } from "bullmq";
import { DatabaseService } from "../database/database.service";
import type { PlanLimitsService } from "../plan-limits/plan-limits.service";
import { IntegrationSyncService } from "./integration-sync.service";
import { SyncProvider, SyncTriggerSource } from "./integration-sync.types";

/**
 * Regression coverage for the 2026-09-02 incident: a container restart landed in a window where
 * BullMQ's Job Scheduler fired the nightly orchestrator a second, unscheduled time ~10h21m after
 * the legitimate midnight-IST run, creating a second full batch of sync runs (all of which then
 * failed). The fix is a real unique index (idx_integration_sync_runs_nightly_cycle, V90 — on a
 * stored `nightly_cycle_date` column, not a SQL-side timezone expression, which is what V90's first
 * draft tried and which Postgres rejected as non-IMMUTABLE) plus a catch-block branch in startRun —
 * so this fake models the constraint as a real constraint, not a canned response, since the whole
 * point is proving startRun reacts correctly to it.
 */

interface FakeRun {
  id: string;
  organization_id: string;
  project_id: string;
  provider: SyncProvider;
  trigger_source: SyncTriggerSource;
  nightly_cycle_date: string | null;
  status: string;
  created_at: Date;
}

function toRow(r: FakeRun) {
  return {
    id: r.id,
    provider: r.provider,
    status: r.status,
    stage: "queued",
    remote_project_key: null,
    total_tickets: 0,
    processed_tickets: 0,
    failed_tickets: 0,
    documents_created: 0,
    documents_updated: 0,
    comments_synced: 0,
    decision_summaries: 0,
    error: null,
    started_at: null,
    finished_at: null,
    created_at: r.created_at.toISOString(),
    triggered_by_name: null
  };
}

// Mirrors IntegrationSyncService's private nightlyCycleDate() exactly, so seeded fixtures and the
// real code under test always agree on "today"/"yesterday" without importing a private function.
function cycleDate(d: Date): string {
  return new Date(d.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const TODAY = cycleDate(new Date());
const YESTERDAY = cycleDate(new Date(Date.now() - 24 * 60 * 60 * 1000));

function makeRunsDb(seed: FakeRun[] = []) {
  const runs: FakeRun[] = [...seed];
  let nextId = 1;

  const query = jest.fn((sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM integration_connections")) {
      return Promise.resolve({ rows: [] });
    }

    if (sql.includes("INSERT INTO integration_sync_runs")) {
      const [organizationId, projectId, provider, , , , triggerSource, nightlyCycleDate] = params as [
        string,
        string,
        SyncProvider,
        string | null,
        string | null,
        string | null,
        SyncTriggerSource,
        string | null
      ];

      if (triggerSource === "nightly") {
        const dup = runs.find(
          (r) => r.project_id === projectId && r.provider === provider && r.trigger_source === "nightly" && r.nightly_cycle_date === nightlyCycleDate
        );
        if (dup) return Promise.reject(pgUniqueViolation("idx_integration_sync_runs_nightly_cycle"));
      } else {
        const dup = runs.find(
          (r) => r.project_id === projectId && r.provider === provider && (r.status === "queued" || r.status === "running")
        );
        if (dup) return Promise.reject(pgUniqueViolation("idx_integration_sync_runs_active"));
      }

      const run: FakeRun = {
        id: `run-${nextId++}`,
        organization_id: organizationId,
        project_id: projectId,
        provider,
        trigger_source: triggerSource || "manual",
        nightly_cycle_date: nightlyCycleDate,
        status: "queued",
        created_at: new Date()
      };
      runs.push(run);
      return Promise.resolve({ rows: [{ id: run.id }] });
    }

    if (sql.includes("trigger_source = 'nightly'") && sql.includes("nightly_cycle_date = $3")) {
      const [projectId, provider, wantCycleDate] = params as [string, SyncProvider, string];
      const match = runs
        .filter((r) => r.project_id === projectId && r.provider === provider && r.trigger_source === "nightly" && r.nightly_cycle_date === wantCycleDate)
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
      return Promise.resolve({ rows: match ? [toRow(match)] : [] });
    }

    if (sql.includes("WHERE r.project_id = $1 AND r.provider = $2 ORDER BY")) {
      const [projectId, provider] = params as [string, SyncProvider];
      const match = runs
        .filter((r) => r.project_id === projectId && r.provider === provider)
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
      return Promise.resolve({ rows: match ? [toRow(match)] : [] });
    }

    if (sql.includes("WHERE r.id = $1")) {
      const [id] = params as [string];
      const match = runs.find((r) => r.id === id);
      return Promise.resolve({ rows: match ? [toRow(match)] : [] });
    }

    return Promise.resolve({ rows: [] });
  });

  return { db: { query } as unknown as DatabaseService, runs };
}

function pgUniqueViolation(constraint: string): Error & { code: string } {
  const err = new Error(`duplicate key value violates unique constraint "${constraint}"`) as Error & { code: string };
  err.code = "23505";
  return err;
}

function makeService(runs: FakeRun[] = []) {
  const { db, runs: store } = makeRunsDb(runs);
  const queue = { add: jest.fn().mockResolvedValue(undefined) } as unknown as Queue;
  const service = new IntegrationSyncService(queue, db, {} as unknown as PlanLimitsService);
  return { service, store };
}

describe("IntegrationSyncService#startRun — nightly idempotency (V90 regression)", () => {
  it("creates a nightly run when none exists yet today", async () => {
    const { service, store } = makeService();
    const { alreadyRunning } = await service.startRun("org-1", "proj-1", "jira", null, "KAN", { triggerSource: "nightly" });
    expect(alreadyRunning).toBe(false);
    expect(store).toHaveLength(1);
    expect(store[0].nightly_cycle_date).toBe(TODAY);
  });

  it("suppresses a second nightly trigger for the same project+provider the same day", async () => {
    const { service, store } = makeService();
    const first = await service.startRun("org-1", "proj-1", "jira", null, "KAN", { triggerSource: "nightly" });
    const second = await service.startRun("org-1", "proj-1", "jira", null, "KAN", { triggerSource: "nightly" });

    expect(store).toHaveLength(1);
    expect(second.alreadyRunning).toBe(true);
    expect(second.run.id).toBe(first.run.id);
  });

  it("still suppresses a re-fire even when today's first nightly run already failed", async () => {
    const seeded: FakeRun = {
      id: "run-seed",
      organization_id: "org-1",
      project_id: "proj-1",
      provider: "jira",
      trigger_source: "nightly",
      nightly_cycle_date: TODAY,
      status: "failed",
      created_at: new Date()
    };
    const { service, store } = makeService([seeded]);

    const { alreadyRunning, run } = await service.startRun("org-1", "proj-1", "jira", null, "KAN", { triggerSource: "nightly" });

    expect(store).toHaveLength(1);
    expect(alreadyRunning).toBe(true);
    expect(run.id).toBe("run-seed");
  });

  it("does not block tomorrow's nightly run with yesterday's", async () => {
    const yesterday: FakeRun = {
      id: "run-yesterday",
      organization_id: "org-1",
      project_id: "proj-1",
      provider: "jira",
      trigger_source: "nightly",
      nightly_cycle_date: YESTERDAY,
      status: "succeeded",
      created_at: new Date(Date.now() - 24 * 60 * 60 * 1000)
    };
    const { service, store } = makeService([yesterday]);

    const { alreadyRunning } = await service.startRun("org-1", "proj-1", "jira", null, "KAN", { triggerSource: "nightly" });

    expect(alreadyRunning).toBe(false);
    expect(store).toHaveLength(2);
  });

  it("does not block a manual Sync click on a day a (finished) nightly run already covered", async () => {
    const nightly: FakeRun = {
      id: "run-nightly",
      organization_id: "org-1",
      project_id: "proj-1",
      provider: "jira",
      trigger_source: "nightly",
      nightly_cycle_date: TODAY,
      status: "succeeded",
      created_at: new Date()
    };
    const { service, store } = makeService([nightly]);

    const { alreadyRunning } = await service.startRun("org-1", "proj-1", "jira", "user-1", "KAN");

    expect(alreadyRunning).toBe(false);
    expect(store).toHaveLength(2);
    // A manual run carries no nightly cycle date — it's outside the guard's scope entirely.
    expect(store[1].nightly_cycle_date).toBeNull();
  });

  it("leaves the pre-existing concurrent-manual-click dedup unchanged", async () => {
    const running: FakeRun = {
      id: "run-active",
      organization_id: "org-1",
      project_id: "proj-1",
      provider: "jira",
      trigger_source: "manual",
      nightly_cycle_date: null,
      status: "running",
      created_at: new Date()
    };
    const { service, store } = makeService([running]);

    const { alreadyRunning, run } = await service.startRun("org-1", "proj-1", "jira", "user-1", "KAN");

    expect(store).toHaveLength(1);
    expect(alreadyRunning).toBe(true);
    expect(run.id).toBe("run-active");
  });
});

/**
 * Regression coverage for the 2026-09-02/03 incident: a nightly run sat 'running' for 13.5 hours
 * (total_tickets stuck at 0 the whole time) before a restart's old resume-by-reset logic finally
 * closed it out. failInterruptedRuns/failStaleRuns replace that with a single atomic UPDATE — no
 * read-then-write gap to race, and no reliance on BullMQ still holding a specific job.
 */
interface FakeStuckRun {
  id: string;
  status: string;
  error: string | null;
  updated_at: Date;
}

function makeStuckRunsDb(rows: FakeStuckRun[]) {
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    if (sql.includes("UPDATE integration_sync_runs") && sql.includes("make_interval")) {
      const [maxAgeMinutes, message] = params as [number, string];
      const cutoff = Date.now() - maxAgeMinutes * 60_000;
      const matched = rows.filter((r) => (r.status === "queued" || r.status === "running") && r.updated_at.getTime() < cutoff);
      for (const r of matched) {
        r.status = "failed";
        r.error = r.error ?? message; // mirrors COALESCE(error, $2)
        r.updated_at = new Date();
      }
      return Promise.resolve({ rows: matched.map((r) => ({ id: r.id })) });
    }
    return Promise.resolve({ rows: [] });
  });
  return { db: { query } as unknown as DatabaseService, rows };
}

function makeServiceForStuckRuns(rows: FakeStuckRun[]) {
  const { db, rows: store } = makeStuckRunsDb(rows);
  const queue = { add: jest.fn().mockResolvedValue(undefined) } as unknown as Queue;
  const service = new IntegrationSyncService(queue, db, {} as unknown as PlanLimitsService);
  return { service, store };
}

// The "+ 25" guards against a real-clock race with the fake's own `Date.now()` call inside
// failStuckRuns: with n=0, a row timestamped at the exact same millisecond as the query's cutoff
// is not "< cutoff" and the assertion flakes. A tiny, fixed backdate removes the tie without
// meaningfully changing what minutesAgo(5)/minutesAgo(25)/minutesAgo(60) assert.
function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60_000 - 25);
}

describe("IntegrationSyncService#failInterruptedRuns — boot recovery (no more resume-by-reset)", () => {
  it("fails every queued/running run regardless of how recently it was touched", async () => {
    const { service, store } = makeServiceForStuckRuns([
      { id: "run-1", status: "running", error: null, updated_at: minutesAgo(0) },
      { id: "run-2", status: "queued", error: null, updated_at: minutesAgo(0) }
    ]);

    await service.failInterruptedRuns();

    expect(store.every((r) => r.status === "failed")).toBe(true);
    expect(store[0].error).toMatch(/interrupted/i);
  });

  it("never touches a run that already reached a terminal status", async () => {
    const { service, store } = makeServiceForStuckRuns([{ id: "run-1", status: "succeeded", error: null, updated_at: minutesAgo(60) }]);

    await service.failInterruptedRuns();

    expect(store[0].status).toBe("succeeded");
  });

  it("preserves an existing error instead of overwriting it", async () => {
    const { service, store } = makeServiceForStuckRuns([
      { id: "run-1", status: "running", error: "Jira needs to be reconnected to this workspace.", updated_at: minutesAgo(0) }
    ]);

    await service.failInterruptedRuns();

    expect(store[0].error).toBe("Jira needs to be reconnected to this workspace.");
  });

  it("does not throw when the underlying query fails", async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error("connection reset")) } as unknown as DatabaseService;
    const queue = { add: jest.fn() } as unknown as Queue;
    const service = new IntegrationSyncService(queue, db, {} as unknown as PlanLimitsService);

    await expect(service.failInterruptedRuns()).resolves.toBeUndefined();
  });
});

describe("IntegrationSyncService#failStaleRuns — periodic watchdog for a run stuck without a restart", () => {
  it("fails a run with no progress for longer than the stale threshold", async () => {
    const { service, store } = makeServiceForStuckRuns([{ id: "run-stale", status: "running", error: null, updated_at: minutesAgo(25) }]);

    await service.failStaleRuns();

    expect(store[0].status).toBe("failed");
    expect(store[0].error).toMatch(/timed out/i);
  });

  it("leaves a run that updated recently alone, no matter how large or long-running", async () => {
    const { service, store } = makeServiceForStuckRuns([{ id: "run-active", status: "running", error: null, updated_at: minutesAgo(5) }]);

    await service.failStaleRuns();

    expect(store[0].status).toBe("running");
  });
});

describe("IntegrationSyncService#listNightlySyncTargets, notion", () => {
  function nightlyService(isIntegrationAllowed: jest.Mock) {
    const query = jest.fn().mockResolvedValue({
      rows: [
        { organization_id: "org-1", project_id: "p1", remote_key: "db-1" },
        { organization_id: "org-2", project_id: "p2", remote_key: "db-2" }
      ]
    });
    const service = new IntegrationSyncService({} as unknown as Queue, { query } as unknown as DatabaseService, { isIntegrationAllowed } as unknown as PlanLimitsService);
    return { service, query };
  }

  it("reads notion_project_mappings keyed by database id and passes each workspace through the entitlement check", async () => {
    const isIntegrationAllowed = jest.fn(async (orgId: string) => orgId === "org-1");
    const { service, query } = nightlyService(isIntegrationAllowed);
    const targets = await service.listNightlySyncTargets("notion");
    expect(targets).toEqual([{ organizationId: "org-1", projectId: "p1", remoteKey: "db-1" }]);
    expect(isIntegrationAllowed).toHaveBeenCalledWith("org-1", "notion");
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("notion_project_mappings");
    expect(sql).toContain("m.notion_database_id AS remote_key");
    expect(sql).toContain("m.integration_connection_id");
  });

  it("does not entitlement-check jira, and checks linear under its own name", async () => {
    const isIntegrationAllowed = jest.fn().mockResolvedValue(true);
    const { service } = nightlyService(isIntegrationAllowed);
    await service.listNightlySyncTargets("jira");
    expect(isIntegrationAllowed).not.toHaveBeenCalled();
    await service.listNightlySyncTargets("linear");
    expect(isIntegrationAllowed).toHaveBeenCalledWith("org-1", "linear");
  });
});

describe("IntegrationSyncService#startRun, notion", () => {
  it("records the mapped database name on the run", async () => {
    const { db } = makeRunsDb([]);
    const queue = { add: jest.fn().mockResolvedValue(undefined) } as unknown as Queue;
    const service = new IntegrationSyncService(queue, db, {} as unknown as PlanLimitsService);
    await service.startRun("org-1", "proj-1", "notion", "user-1", "db-1");
    const insertSql = (db.query as jest.Mock).mock.calls.map((c) => String(c[0])).find((s) => s.includes("INSERT INTO integration_sync_runs"))!;
    expect(insertSql).toContain("SELECT notion_database_name FROM notion_project_mappings");
  });
});

/**
 * A run the per-run ticket cap cut off leaves its pass unfinished (V134); the next run must continue it
 * rather than start over, or the same newest tickets are re-synced forever. startRun decides that
 * from the latest completed run, so the fake answers exactly that lookup and records what the INSERT and
 * the queued payload were given.
 */
describe("IntegrationSyncService#startRun — continuing a pass the cap cut off", () => {
  const WINDOW = new Date("2026-10-01T08:00:00.000Z");
  const SINCE = new Date("2026-09-30T00:00:00.000Z");
  type Prior = { truncated: boolean; remote_project_key: string | null; window_start: Date | null; sync_since: Date | null };

  function setup(prior?: Partial<Prior>, opts: { nightly?: boolean; since?: string | null } = {}) {
    const query = jest.fn((sql: string, _params: unknown[] = []) => {
      if (sql.includes("FROM integration_connections")) return Promise.resolve({ rows: [] });
      if (sql.includes("SELECT truncated, remote_project_key, window_start, sync_since")) {
        return Promise.resolve({ rows: prior ? [{ truncated: true, remote_project_key: "KAN", window_start: WINDOW, sync_since: null, ...prior }] : [] });
      }
      if (sql.includes("INSERT INTO integration_sync_runs")) return Promise.resolve({ rows: [{ id: "run-new" }] });
      return Promise.resolve({ rows: [] });
    });
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const service = new IntegrationSyncService(queue as unknown as Queue, { query } as unknown as DatabaseService, {} as unknown as PlanLimitsService);
    const start = () =>
      service.startRun("org-1", "proj-1", "jira", opts.nightly ? null : "user-1", "KAN", { triggerSource: opts.nightly ? "nightly" : "manual", since: opts.since ?? null });
    const insertParams = () => query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO integration_sync_runs"))![1] as unknown[];
    return { start, insertParams, queue, query };
  }

  it("inherits the pass's window and since when the latest completed run was truncated", async () => {
    const { start, insertParams, queue } = setup({ sync_since: SINCE });
    await start();
    // $10 window_start, $11 sync_since
    expect(insertParams()[9]).toBe(WINDOW);
    expect(insertParams()[10]).toBe(SINCE.toISOString());
    expect(queue.add.mock.calls[0][1].since).toBe(SINCE.toISOString());
  });

  it("starts a fresh pass when the latest completed run reached the end of the backlog", async () => {
    const { start, insertParams } = setup({ truncated: false });
    await start();
    expect(insertParams()[9]).toBeNull();
  });

  it("starts a fresh pass when there is no earlier run", async () => {
    const { start, insertParams } = setup(undefined);
    await start();
    expect(insertParams()[9]).toBeNull();
  });

  it("starts a fresh pass when the project is now mapped to a different remote project", async () => {
    const { start, insertParams } = setup({ remote_project_key: "OTHER" });
    await start();
    expect(insertParams()[9]).toBeNull();
  });

  it("a manual run continuing an incremental pass keeps that pass's since, not a full resync", async () => {
    const { start, queue } = setup({ sync_since: SINCE });
    await start();
    expect(queue.add.mock.calls[0][1].since).toBe(SINCE.toISOString());
  });

  it("a nightly run's own since applies only when it is not continuing a pass", async () => {
    const fresh = setup({ truncated: false }, { nightly: true, since: "2026-10-06T00:00:00.000Z" });
    await fresh.start();
    expect(fresh.queue.add.mock.calls[0][1].since).toBe("2026-10-06T00:00:00.000Z");
  });

  it("looks only at completed runs, so a failed run mid-pass does not discard the progress", async () => {
    const { start, query } = setup({});
    await start();
    // The filter lives in the SQL (the fake cannot model it), so assert the statement carries it.
    const lookup = String(query.mock.calls.find(([sql]) => String(sql).includes("SELECT truncated, remote_project_key"))![0]);
    expect(lookup).toContain("status IN ('succeeded', 'partial')");
    expect(lookup).toContain("ORDER BY created_at DESC LIMIT 1");
  });
});
