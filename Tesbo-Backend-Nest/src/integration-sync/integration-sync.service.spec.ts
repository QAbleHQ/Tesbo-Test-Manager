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
