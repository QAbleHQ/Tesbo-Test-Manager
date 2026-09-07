import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { DatabaseService } from "../database/database.service";
import type { PlanLimitsService } from "../plan-limits/plan-limits.service";
import type { RagIngestionService } from "../rag/rag-ingestion.service";
import { IntegrationConnectionInvalidError, IntegrationSyncClient } from "./integration-sync.client";
import { IntegrationSyncDecisions } from "./integration-sync-decisions";
import { IntegrationSyncDocumentBuilder } from "./integration-sync-document.builder";
import { INTEGRATION_SYNC_NIGHTLY_JIRA_JOB, INTEGRATION_SYNC_RUN_JOB } from "./integration-sync.constants";
import { IntegrationSyncProcessor } from "./integration-sync.processor";
import { IntegrationSyncService } from "./integration-sync.service";
import { RemoteTicket, SyncProvider, SyncRunJobPayload } from "./integration-sync.types";

/** Drives IntegrationSyncProcessor through its public `process(job)` entrypoint, matching how
 *  BullMQ actually dispatches — exercising the real, unmocked wiring between the orchestrator's
 *  per-target loop / tally and startRun's return shape, and between processRun's catch block and
 *  failRun, rather than asserting against the private methods directly. */
function job(name: string, data: unknown): Job {
  return { name, data } as Job;
}

function makeProcessor(overrides: {
  runs?: Partial<IntegrationSyncService>;
  client?: Partial<IntegrationSyncClient>;
  db?: { query: jest.Mock };
} = {}) {
  const runs = {
    listNightlySyncTargets: jest.fn().mockResolvedValue([]),
    getLastSuccessfulRunStart: jest.fn().mockResolvedValue(null),
    startRun: jest.fn(),
    markRunning: jest.fn().mockResolvedValue(undefined),
    failRun: jest.fn().mockResolvedValue(undefined),
    ensureProviderFolder: jest.fn().mockResolvedValue("folder-1"),
    setStage: jest.fn().mockResolvedValue(undefined),
    setTotals: jest.fn().mockResolvedValue(undefined),
    enqueueTicketJobs: jest.fn().mockResolvedValue(undefined),
    finishRun: jest.fn().mockResolvedValue(undefined),
    ...overrides.runs
  } as unknown as IntegrationSyncService;

  const client = {
    loadConnection: jest.fn(),
    ...overrides.client
  } as unknown as IntegrationSyncClient;

  const db = (overrides.db ?? { query: jest.fn().mockResolvedValue({ rows: [] }) }) as unknown as DatabaseService;

  const processor = new IntegrationSyncProcessor(
    db,
    runs,
    client,
    {} as unknown as IntegrationSyncDocumentBuilder,
    {} as unknown as IntegrationSyncDecisions,
    {} as unknown as RagIngestionService,
    {} as unknown as PlanLimitsService
  );
  return { processor, runs, client, db };
}

describe("IntegrationSyncProcessor — nightly orchestrator observability", () => {
  it("logs a start line and an end-of-run tally reflecting started/deduped/failed targets", async () => {
    const logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const targets = [
      { organizationId: "org-1", projectId: "proj-1", remoteKey: "KAN" },
      { organizationId: "org-2", projectId: "proj-2", remoteKey: "SCRUM" },
      { organizationId: "org-3", projectId: "proj-3", remoteKey: "ECF" }
    ];
    const { processor, runs } = makeProcessor({
      runs: {
        listNightlySyncTargets: jest.fn().mockResolvedValue(targets),
        startRun: jest
          .fn()
          .mockResolvedValueOnce({ run: { id: "run-1" }, alreadyRunning: false })
          .mockResolvedValueOnce({ run: { id: "run-2" }, alreadyRunning: true })
          .mockRejectedValueOnce(new Error("connection revoked"))
      }
    });

    await processor.process(job(INTEGRATION_SYNC_NIGHTLY_JIRA_JOB, {}));

    expect(runs.startRun).toHaveBeenCalledTimes(3);
    const lines = logSpy.mock.calls.map((call) => call[0]);
    expect(lines.some((l) => String(l).includes("starting for 3 targets"))).toBe(true);
    expect(lines.some((l) => String(l).includes("1 started, 1 already ran this cycle, 1 failed to start"))).toBe(true);
    logSpy.mockRestore();
  });
});

describe("IntegrationSyncProcessor#process — sync-run auth failure surfaces the clean message", () => {
  it("passes an IntegrationConnectionInvalidError's curated message straight to failRun", async () => {
    const payload: SyncRunJobPayload = {
      runId: "run-1",
      organizationId: "org-1",
      projectId: "proj-1",
      provider: "jira",
      triggeredBy: null
    };
    const { processor, runs, client } = makeProcessor({
      client: {
        loadConnection: jest.fn().mockRejectedValue(new IntegrationConnectionInvalidError("Jira needs to be reconnected to this workspace."))
      }
    });

    await processor.process(job(INTEGRATION_SYNC_RUN_JOB, payload));

    expect(client.loadConnection).toHaveBeenCalledWith("org-1", "jira");
    expect(runs.failRun).toHaveBeenCalledWith("run-1", "Jira needs to be reconnected to this workspace.");
    // Never the raw provider shape from a real 401 response.
    const [, message] = (runs.failRun as jest.Mock).mock.calls[0];
    expect(message).not.toContain("code");
    expect(message).not.toContain("401");
  });
});

/**
 * Regression coverage for the prod incident: "value too long for type character varying(1024)"
 * on a Linear (and, identically, a Jira) ticket whose title overflowed a bounded column, thrown
 * from inside onPage's loop with no try/catch of its own — which aborted the ENTIRE run rather
 * than just the one bad ticket. Because incremental syncs cursor off the last *successful* run,
 * that failure was permanent for the affected project. This proves the fix — a bad ticket's
 * upsertTicket failure is now caught per-ticket, everything else on the page still syncs, and the
 * run finishes (not fails) with a note about what was skipped — for both providers, since they
 * share this exact code path.
 */
function remoteTicket(overrides: Partial<RemoteTicket> = {}): RemoteTicket {
  return {
    issueId: "id-1",
    issueKey: "GOOD-1",
    summary: "A perfectly normal title",
    description: "",
    issueType: "Bug",
    status: "Open",
    priority: "Medium",
    assignee: "",
    reporter: "",
    labels: "",
    createdAt: null,
    updatedAt: null,
    url: "https://example.invalid/GOOD-1",
    ...overrides
  };
}

describe.each<SyncProvider>(["jira", "linear"])(
  "IntegrationSyncProcessor#process — a single bad ticket does not abort the %s run",
  (provider) => {
    it("skips only the failing ticket, still syncs the rest, and finishes (not fails) the run", async () => {
      const goodTicket = remoteTicket({ issueId: "id-good", issueKey: "GOOD-1" });
      const badTicket = remoteTicket({ issueId: "id-bad", issueKey: "BAD-1", summary: "A".repeat(2000) });

      const dbQuery = jest.fn((sql: string, params: unknown[] = []) => {
        if (sql.includes("FROM jira_project_mappings") || sql.includes("FROM linear_project_mappings")) {
          return Promise.resolve({ rows: [{ remote_id: "team-1", remote_key: "ENG", remote_name: "Engineering" }] });
        }
        if (sql.includes("INSERT INTO jira_tickets") || sql.includes("INSERT INTO linear_tickets")) {
          const issueKey = params[3];
          if (issueKey === "BAD-1") return Promise.reject(new Error('value too long for type character varying(1024)'));
          return Promise.resolve({ rows: [{ id: `ticket-${issueKey}` }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const { processor, runs, client, db } = makeProcessor({
        db: { query: dbQuery },
        client: {
          loadConnection: jest.fn().mockResolvedValue({ id: "conn-1" }),
          fetchJiraTickets: jest.fn(async (_conn, _key, onPage) => {
            await onPage([goodTicket, badTicket]);
            return { total: 2, truncated: false };
          }),
          fetchLinearTickets: jest.fn(async (_conn, _id, onPage) => {
            await onPage([goodTicket, badTicket]);
            return { total: 2, truncated: false };
          })
        }
      });

      const payload: SyncRunJobPayload = {
        runId: "run-1",
        organizationId: "org-1",
        projectId: "proj-1",
        provider,
        triggeredBy: "user-1"
      };

      await processor.process(job(INTEGRATION_SYNC_RUN_JOB, payload));

      // The run must NEVER abort because of one bad ticket.
      expect(runs.failRun).not.toHaveBeenCalled();

      // Only the good ticket is queued for document-building.
      expect(runs.enqueueTicketJobs).toHaveBeenCalledTimes(1);
      const queued = (runs.enqueueTicketJobs as jest.Mock).mock.calls[0][0];
      expect(queued).toHaveLength(1);
      expect(queued[0].issueKey).toBe("GOOD-1");

      // The skip is surfaced on the run, not silently dropped.
      const errorUpdateCall = (db.query as unknown as jest.Mock).mock.calls.find(
        ([sql]) => typeof sql === "string" && sql.includes("UPDATE integration_sync_runs SET error")
      );
      expect(errorUpdateCall).toBeDefined();
      expect(String(errorUpdateCall?.[1]?.[1])).toMatch(/1 ticket.*invalid data/i);
    });

    it("finishes (not fails) a run where every ticket on the page was bad", async () => {
      const badTicket = remoteTicket({ issueId: "id-bad", issueKey: "BAD-1", summary: "A".repeat(2000) });

      const dbQuery = jest.fn((sql: string) => {
        if (sql.includes("FROM jira_project_mappings") || sql.includes("FROM linear_project_mappings")) {
          return Promise.resolve({ rows: [{ remote_id: "team-1", remote_key: "ENG", remote_name: "Engineering" }] });
        }
        if (sql.includes("INSERT INTO jira_tickets") || sql.includes("INSERT INTO linear_tickets")) {
          return Promise.reject(new Error('value too long for type character varying(1024)'));
        }
        return Promise.resolve({ rows: [] });
      });

      const { processor, runs } = makeProcessor({
        db: { query: dbQuery },
        client: {
          loadConnection: jest.fn().mockResolvedValue({ id: "conn-1" }),
          fetchJiraTickets: jest.fn(async (_conn, _key, onPage) => {
            await onPage([badTicket]);
            return { total: 1, truncated: false };
          }),
          fetchLinearTickets: jest.fn(async (_conn, _id, onPage) => {
            await onPage([badTicket]);
            return { total: 1, truncated: false };
          })
        }
      });

      const payload: SyncRunJobPayload = { runId: "run-1", organizationId: "org-1", projectId: "proj-1", provider, triggeredBy: "user-1" };

      jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      await processor.process(job(INTEGRATION_SYNC_RUN_JOB, payload));
      (Logger.prototype.warn as jest.Mock).mockRestore();

      expect(runs.failRun).not.toHaveBeenCalled();
      expect(runs.enqueueTicketJobs).not.toHaveBeenCalled();
      // Distinguishable from "nothing changed"/"empty project" — every ticket found was skipped.
      expect(runs.finishRun).toHaveBeenCalledWith("run-1", expect.stringMatching(/all 1.*invalid data/i));
    });
  }
);

/**
 * Regression coverage for "tickets from all projects are displayed after sync instead of only the
 * selected project": jira_tickets/linear_tickets used to carry no record of which remote
 * project/team a ticket actually came from, so once a Tesbo project's mapping was ever switched,
 * every past entity's tickets stayed mixed into the same project_id-scoped view forever. Tagging
 * each ticket with the mapping's remote_id at sync time (read back out by legacy.service.ts's
 * "current mapping only" filter) is what makes that filter possible.
 */
describe.each<SyncProvider>(["jira", "linear"])(
  "IntegrationSyncProcessor#process — tags every synced %s ticket with its source mapping",
  (provider) => {
    it("writes mapped_remote_id from the mapping lookup's remote_id", async () => {
      const ticket = remoteTicket({ issueId: "id-1", issueKey: "ENG-1" });
      const insertCalls: unknown[][] = [];

      const dbQuery = jest.fn((sql: string, params: unknown[] = []) => {
        if (sql.includes("FROM jira_project_mappings") || sql.includes("FROM linear_project_mappings")) {
          return Promise.resolve({ rows: [{ remote_id: "remote-team-42", remote_key: "ENG", remote_name: "Engineering" }] });
        }
        if (sql.includes("INSERT INTO jira_tickets") || sql.includes("INSERT INTO linear_tickets")) {
          insertCalls.push(params);
          return Promise.resolve({ rows: [{ id: "ticket-1" }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const { processor } = makeProcessor({
        db: { query: dbQuery },
        client: {
          loadConnection: jest.fn().mockResolvedValue({ id: "conn-1" }),
          fetchJiraTickets: jest.fn(async (_conn, _key, onPage) => {
            await onPage([ticket]);
            return { total: 1, truncated: false };
          }),
          fetchLinearTickets: jest.fn(async (_conn, _id, onPage) => {
            await onPage([ticket]);
            return { total: 1, truncated: false };
          })
        }
      });

      const payload: SyncRunJobPayload = { runId: "run-1", organizationId: "org-1", projectId: "proj-1", provider, triggeredBy: "user-1" };
      await processor.process(job(INTEGRATION_SYNC_RUN_JOB, payload));

      expect(insertCalls).toHaveLength(1);
      // mapped_remote_id is the last bound column (see upsertTicket's INSERT column list).
      expect(insertCalls[0][insertCalls[0].length - 1]).toBe("remote-team-42");
    });

    it("re-tags a ticket with the new mapping's remote_id after a mapping switch, leaving the old mapping's tag alone", async () => {
      // Two syncs for the same Tesbo project/issue, under two different mappings — simulates a
      // project/team switch. Only the second sync's row should end up tagged with the new entity.
      const ticket = remoteTicket({ issueId: "id-1", issueKey: "ENG-1" });
      let currentRemoteId = "remote-team-A";
      const insertCalls: unknown[][] = [];

      const dbQuery = jest.fn((sql: string, params: unknown[] = []) => {
        if (sql.includes("FROM jira_project_mappings") || sql.includes("FROM linear_project_mappings")) {
          return Promise.resolve({ rows: [{ remote_id: currentRemoteId, remote_key: "ENG", remote_name: "Engineering" }] });
        }
        if (sql.includes("INSERT INTO jira_tickets") || sql.includes("INSERT INTO linear_tickets")) {
          insertCalls.push(params);
          return Promise.resolve({ rows: [{ id: "ticket-1" }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const { processor } = makeProcessor({
        db: { query: dbQuery },
        client: {
          loadConnection: jest.fn().mockResolvedValue({ id: "conn-1" }),
          fetchJiraTickets: jest.fn(async (_conn, _key, onPage) => {
            await onPage([ticket]);
            return { total: 1, truncated: false };
          }),
          fetchLinearTickets: jest.fn(async (_conn, _id, onPage) => {
            await onPage([ticket]);
            return { total: 1, truncated: false };
          })
        }
      });

      const payload: SyncRunJobPayload = { runId: "run-1", organizationId: "org-1", projectId: "proj-1", provider, triggeredBy: "user-1" };
      await processor.process(job(INTEGRATION_SYNC_RUN_JOB, payload));

      currentRemoteId = "remote-team-B";
      await processor.process(job(INTEGRATION_SYNC_RUN_JOB, { ...payload, runId: "run-2" }));

      expect(insertCalls).toHaveLength(2);
      expect(insertCalls[0][insertCalls[0].length - 1]).toBe("remote-team-A");
      expect(insertCalls[1][insertCalls[1].length - 1]).toBe("remote-team-B");
    });
  }
);
