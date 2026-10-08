import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { DatabaseService } from "../database/database.service";
import type { PlanLimitsService } from "../plan-limits/plan-limits.service";
import type { RagIngestionService } from "../rag/rag-ingestion.service";
import { IntegrationConnectionInvalidError, IntegrationSyncClient, NotionNotSharedError } from "./integration-sync.client";
import { IntegrationSyncDecisions } from "./integration-sync-decisions";
import { IntegrationSyncDocumentBuilder } from "./integration-sync-document.builder";
import { INTEGRATION_SYNC_NIGHTLY_JIRA_JOB, INTEGRATION_SYNC_NIGHTLY_NOTION_JOB, INTEGRATION_SYNC_RUN_JOB, MAX_TICKETS_PER_RUN } from "./integration-sync.constants";
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

describe("IntegrationSyncProcessor#process — the run records the mapped project name, not just its key", () => {
  // A Linear Project mapping stores its opaque slugId in the key slot (V95); the Requirements sync
  // panel displayed that ("4081f3c6e1df") instead of the project's name.
  function emptyRun(provider: SyncProvider, mapping: { remote_key: string; remote_name: string }) {
    const dbQuery = jest.fn((sql: string) => {
      if (sql.includes("FROM jira_project_mappings") || sql.includes("FROM linear_project_mappings")) {
        return Promise.resolve({ rows: [{ remote_id: "remote-1", ...mapping, entity_type: "project" }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const fetchEmpty = jest.fn().mockResolvedValue({ total: 0, truncated: false });
    return makeProcessor({
      db: { query: dbQuery },
      client: { loadConnection: jest.fn().mockResolvedValue({ id: "conn-1" }), fetchJiraTickets: fetchEmpty, fetchLinearTickets: fetchEmpty }
    });
  }

  function keyUpdateParams(db: DatabaseService): unknown[] | undefined {
    return (db.query as unknown as jest.Mock).mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("SET remote_project_key")
    )?.[1];
  }

  it("stores the Linear Project name beside its slugId and names it in the 'no changes' note", async () => {
    const { processor, runs, db } = emptyRun("linear", { remote_key: "4081f3c6e1df", remote_name: "Namm Orange HRMS Project" });
    const payload: SyncRunJobPayload = { runId: "run-1", organizationId: "org-1", projectId: "proj-1", provider: "linear", triggeredBy: null, since: "2026-09-01T00:00:00.000Z" };

    await processor.process(job(INTEGRATION_SYNC_RUN_JOB, payload));

    expect(keyUpdateParams(db)).toEqual(["run-1", "4081f3c6e1df", "Namm Orange HRMS Project"]);
    expect(runs.finishRun).toHaveBeenCalledWith("run-1", "No changes in Namm Orange HRMS Project since the last sync.");
  });

  it("stores the Jira project name beside its key and names it in the 'no changes' note", async () => {
    const { processor, runs, db } = emptyRun("jira", { remote_key: "KAN", remote_name: "Kanban Board" });
    const payload: SyncRunJobPayload = { runId: "run-1", organizationId: "org-1", projectId: "proj-1", provider: "jira", triggeredBy: null, since: "2026-09-01T00:00:00.000Z" };

    await processor.process(job(INTEGRATION_SYNC_RUN_JOB, payload));

    expect(keyUpdateParams(db)).toEqual(["run-1", "KAN", "Kanban Board"]);
    expect(runs.finishRun).toHaveBeenCalledWith("run-1", "No changes in Kanban Board since the last sync.");
  });
});

describe("IntegrationSyncProcessor#process — a mapping with no name falls back to its key", () => {
  it("records a null name and keeps the key in the note", async () => {
    const dbQuery = jest.fn((sql: string) =>
      Promise.resolve(sql.includes("FROM jira_project_mappings") ? { rows: [{ remote_id: "remote-1", remote_key: "KAN", remote_name: "" }] } : { rows: [] })
    );
    const { processor, runs, db } = makeProcessor({
      db: { query: dbQuery },
      client: { loadConnection: jest.fn().mockResolvedValue({ id: "conn-1" }), fetchJiraTickets: jest.fn().mockResolvedValue({ total: 0, truncated: false }) }
    });
    const payload: SyncRunJobPayload = { runId: "run-1", organizationId: "org-1", projectId: "proj-1", provider: "jira", triggeredBy: null };

    await processor.process(job(INTEGRATION_SYNC_RUN_JOB, payload));

    const update = (db.query as unknown as jest.Mock).mock.calls.find(([sql]) => String(sql).includes("SET remote_project_key"));
    expect(update?.[1]).toEqual(["run-1", "KAN", null]);
    expect(runs.finishRun).toHaveBeenCalledWith("run-1", "No tickets found in KAN.");
  });
});

describe("IntegrationSyncProcessor, notion provider", () => {
  const payload: SyncRunJobPayload = { runId: "run-1", organizationId: "org-1", projectId: "proj-1", provider: "notion", triggeredBy: "user-1" };

  function notionDb() {
    return jest.fn((sql: string, _params: unknown[] = []) => {
      if (sql.includes("FROM notion_project_mappings")) {
        return Promise.resolve({ rows: [{ remote_id: "db-1", remote_key: "db-1", remote_name: "Product specs" }] });
      }
      if (sql.includes("INSERT INTO notion_pages")) return Promise.resolve({ rows: [{ id: "row-1" }] });
      return Promise.resolve({ rows: [] });
    });
  }

  it("fetches through fetchNotionPages with the mapped database id and upserts into notion_pages", async () => {
    const dbQuery = notionDb();
    const fetchNotionPages = jest.fn(async (_conn, _db, onPage) => {
      await onPage([remoteTicket({ issueId: "page-1", issueKey: "notion:aaaaaaaa", properties: { Status: "Open" }, archived: false })]);
      return { total: 1, truncated: false };
    });
    const { processor, runs, client } = makeProcessor({
      db: { query: dbQuery },
      client: { loadConnection: jest.fn().mockResolvedValue({ id: "conn-1" }), fetchNotionPages }
    });

    await processor.process(job(INTEGRATION_SYNC_RUN_JOB, { ...payload, since: "2026-01-01T00:00:00.000Z" }));

    expect(client.loadConnection).toHaveBeenCalledWith("org-1", "notion");
    expect(fetchNotionPages).toHaveBeenCalledWith({ id: "conn-1" }, "db-1", expect.any(Function), "2026-01-01T00:00:00.000Z");
    expect(runs.failRun).not.toHaveBeenCalled();
    const queued = (runs.enqueueTicketJobs as jest.Mock).mock.calls[0][0];
    expect(queued[0]).toMatchObject({ provider: "notion", issueId: "page-1", ticketId: "row-1" });

    const insert = dbQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO notion_pages"))!;
    const sql = String(insert[0]);
    expect(sql).toContain("properties_json");
    expect(sql).toContain("ON CONFLICT (integration_connection_id, notion_page_id, project_id)");
    // The body is read later, per ticket, so a re-sync must not blank the description already stored.
    expect(sql).not.toContain("description = EXCLUDED.description");
    expect(insert[1]).toEqual(expect.arrayContaining([JSON.stringify({ Status: "Open" }), false, "db-1"]));
  });

  it("shows a clear failure when the database is no longer shared", async () => {
    const { processor, runs } = makeProcessor({
      db: { query: notionDb() },
      client: {
        loadConnection: jest.fn().mockResolvedValue({ id: "conn-1" }),
        fetchNotionPages: jest.fn().mockRejectedValue(new NotionNotSharedError("The Notion database could not be found. Share it with the Tesbo integration."))
      }
    });
    await processor.process(job(INTEGRATION_SYNC_RUN_JOB, payload));
    expect(runs.failRun).toHaveBeenCalledWith("run-1", expect.stringMatching(/share it with the Tesbo integration/i));
  });

  it("fails the run when no database is mapped", async () => {
    const { processor, runs } = makeProcessor({
      db: { query: jest.fn().mockResolvedValue({ rows: [] }) },
      client: { loadConnection: jest.fn().mockResolvedValue({ id: "conn-1" }) }
    });
    await processor.process(job(INTEGRATION_SYNC_RUN_JOB, payload));
    expect(runs.failRun).toHaveBeenCalledWith("run-1", "No Notion database is mapped to this project yet.");
  });

  it("dispatches the nightly notion job to the notion orchestrator", async () => {
    const { processor, runs } = makeProcessor();
    await processor.process(job(INTEGRATION_SYNC_NIGHTLY_NOTION_JOB, {}));
    expect(runs.listNightlySyncTargets).toHaveBeenCalledWith("notion");
  });

  describe("nightly orchestrator", () => {
    const targets = [
      { organizationId: "org-1", projectId: "proj-1", remoteKey: "db-1" },
      { organizationId: "org-2", projectId: "proj-2", remoteKey: "db-2" },
      { organizationId: "org-3", projectId: "proj-3", remoteKey: "db-3" }
    ];

    it("starts a nightly notion run per target, keyed by database id, with a null actor", async () => {
      const startRun = jest.fn().mockResolvedValue({ run: { id: "run-x" }, alreadyRunning: false });
      const { processor } = makeProcessor({ runs: { listNightlySyncTargets: jest.fn().mockResolvedValue(targets), startRun } });
      await processor.process(job(INTEGRATION_SYNC_NIGHTLY_NOTION_JOB, {}));
      expect(startRun).toHaveBeenCalledTimes(3);
      expect(startRun).toHaveBeenNthCalledWith(1, "org-1", "proj-1", "notion", null, "db-1", { triggerSource: "nightly", since: null });
    });

    it("first-ever sync is a full fetch (since null); later syncs use the last start minus the buffer", async () => {
      const lastStart = new Date("2026-10-07T18:30:00.000Z");
      const startRun = jest.fn().mockResolvedValue({ run: { id: "run-x" }, alreadyRunning: false });
      const { processor } = makeProcessor({
        runs: {
          listNightlySyncTargets: jest.fn().mockResolvedValue(targets.slice(0, 2)),
          getLastSuccessfulRunStart: jest.fn().mockResolvedValueOnce(lastStart).mockResolvedValueOnce(null),
          startRun
        }
      });
      await processor.process(job(INTEGRATION_SYNC_NIGHTLY_NOTION_JOB, {}));
      expect(startRun.mock.calls[0][5].since).toBe("2026-10-07T18:20:00.000Z");
      expect(startRun.mock.calls[1][5].since).toBeNull();
    });

    it("one target failing to start (or an already-ran duplicate) never stops the rest", async () => {
      const startRun = jest
        .fn()
        .mockRejectedValueOnce(new Error("db blip"))
        .mockResolvedValueOnce({ run: { id: "run-2" }, alreadyRunning: true })
        .mockResolvedValueOnce({ run: { id: "run-3" }, alreadyRunning: false });
      const logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
      const { processor } = makeProcessor({ runs: { listNightlySyncTargets: jest.fn().mockResolvedValue(targets), startRun } });
      await expect(processor.process(job(INTEGRATION_SYNC_NIGHTLY_NOTION_JOB, {}))).resolves.toBeUndefined();
      expect(startRun).toHaveBeenCalledTimes(3);
      expect(logSpy.mock.calls.some(([l]) => String(l).includes("1 started, 1 already ran this cycle, 1 failed to start"))).toBe(true);
      logSpy.mockRestore();
    });

    it("a failing cursor lookup for one target is isolated like a failing startRun", async () => {
      const startRun = jest.fn().mockResolvedValue({ run: { id: "run-x" }, alreadyRunning: false });
      const { processor } = makeProcessor({
        runs: {
          listNightlySyncTargets: jest.fn().mockResolvedValue(targets.slice(0, 2)),
          getLastSuccessfulRunStart: jest.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(null),
          startRun
        }
      });
      await processor.process(job(INTEGRATION_SYNC_NIGHTLY_NOTION_JOB, {}));
      expect(startRun).toHaveBeenCalledTimes(1);
      expect(startRun.mock.calls[0][1]).toBe("proj-2");
    });

    it("an empty target list is a clean no-op", async () => {
      const { processor, runs } = makeProcessor();
      await processor.process(job(INTEGRATION_SYNC_NIGHTLY_NOTION_JOB, {}));
      expect(runs.startRun).not.toHaveBeenCalled();
    });
  });

  it("reads the page body per ticket, stores it, and falls back to the cached body when the read fails", async () => {
    const updates: unknown[][] = [];
    const row = {
      id: "row-1",
      notion_page_id: "page-1",
      notion_page_key: "notion:aaaaaaaa",
      summary: "Spec",
      description: "cached body",
      properties_json: { Status: "Open" },
      comments_hash: "",
      decision_summary_hash: ""
    };
    const build = jest.fn().mockReturnValue({ title: "t", markdown: "m", html: "h" });
    const fetchNotionBody = jest.fn().mockResolvedValueOnce("fresh body").mockRejectedValueOnce(new Error("boom"));
    const dbQuery = jest.fn((sql: string, params: unknown[] = []) => {
      if (sql.startsWith("SELECT * FROM notion_pages")) return Promise.resolve({ rows: [row] });
      if (sql.startsWith("UPDATE notion_pages SET description")) updates.push(params);
      return Promise.resolve({ rows: [] });
    });
    const processor = new IntegrationSyncProcessor(
      { query: dbQuery } as unknown as DatabaseService,
      { recordTicketResult: jest.fn() } as unknown as IntegrationSyncService,
      { loadConnection: jest.fn().mockResolvedValue({ id: "conn-1" }), fetchComments: jest.fn().mockResolvedValue([]), fetchNotionBody } as unknown as IntegrationSyncClient,
      { buildMirror: build } as unknown as IntegrationSyncDocumentBuilder,
      { resolveAllocation: jest.fn() } as unknown as IntegrationSyncDecisions,
      {} as unknown as RagIngestionService,
      { checkStorageAvailable: jest.fn().mockResolvedValue({ allowed: true }) } as unknown as PlanLimitsService
    );
    const ticketJob = {
      runId: "run-1",
      organizationId: "org-1",
      projectId: "proj-1",
      provider: "notion",
      ticketId: "row-1",
      issueId: "page-1",
      issueKey: "notion:aaaaaaaa",
      folderId: "f",
      triggeredBy: null
    };

    await processor.process(job("sync-ticket", ticketJob));
    expect(updates).toEqual([["row-1", "fresh body"]]);
    expect(build.mock.calls[0][0].description).toBe("- **Status:** Open\n\nfresh body");

    await processor.process(job("sync-ticket", ticketJob));
    expect(updates).toHaveLength(1);
    expect(build.mock.calls[1][0].description).toBe("- **Status:** Open\n\ncached body");
  });
});

/**
 * A backlog bigger than MAX_TICKETS_PER_RUN used to re-sync the same newest tickets on every Sync,
 * because every fetch starts at the newest ticket and nothing remembered how far the last run got. A
 * run now stops after MAX_TICKETS_PER_RUN tickets that still need syncing, marks its pass unfinished, and the next run
 * of the same pass skips what is already done. This drives three runs over a 5000-ticket backlog with a
 * stateful fake of the ticket table — a canned response could not show a ticket being skipped *because*
 * an earlier run stored it.
 */
describe.each<SyncProvider>(["jira", "linear", "notion"])("IntegrationSyncProcessor#process — a backlog over the cap is continued, not restarted (%s)", (provider) => {
  const PAGE = 100;
  const stamp = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + n * 60_000).toISOString();
  const backlog = (size: number, edited: Record<number, string> = {}) =>
    // Newest first, as every provider fetch returns them.
    Array.from({ length: size }, (_, i) => remoteTicket({ issueId: `id-${i}`, issueKey: `T-${i}`, updatedAt: edited[i] ?? stamp(size - i) }));

  function harness(tickets: RemoteTicket[]) {
    // issue id -> upstream updated time as stored, and whether the current pass already synced it.
    const stored = new Map<string, { updated: number; inPass: boolean }>();
    let truncatedMarks = 0;
    const dbQuery = jest.fn((sql: string, params: unknown[] = []) => {
      if (sql.includes("_project_mappings")) return Promise.resolve({ rows: [{ remote_id: "r-1", remote_key: "ENG", remote_name: "Engineering" }] });
      if (sql.includes("INSERT INTO ")) {
        const [issueId, updatedAt] = [params[2], params[13]];
        stored.set(String(issueId), { updated: new Date(String(updatedAt)).getTime(), inPass: true });
        return Promise.resolve({ rows: [{ id: `row-${issueId}` }] });
      }
      if (sql.includes("t.synced_at >= r.window_start") && sql.includes("ANY(")) {
        const ids = params[3] as string[];
        return Promise.resolve({
          rows: ids.filter((id) => stored.get(id)?.inPass).map((id) => ({ issue_id: id, updated_at: new Date(stored.get(id)!.updated).toISOString() }))
        });
      }
      if (sql.includes("count(*)")) return Promise.resolve({ rows: [{ n: [...stored.values()].filter((s) => s.inPass).length }] });
      if (sql.includes("SET truncated = true")) truncatedMarks++;
      return Promise.resolve({ rows: [] });
    });
    const fetch = jest.fn(async (_conn: unknown, _key: string, onPage: (page: RemoteTicket[]) => Promise<boolean | void>) => {
      let total = 0;
      for (let i = 0; i < tickets.length; i += PAGE) {
        const page = tickets.slice(i, i + PAGE);
        const stop = await onPage(page);
        total += page.length;
        if (stop) return { total, truncated: true };
      }
      return { total, truncated: false };
    });
    const made = makeProcessor({
      db: { query: dbQuery },
      client: { loadConnection: jest.fn().mockResolvedValue({ id: "conn-1" }), fetchJiraTickets: fetch, fetchLinearTickets: fetch, fetchNotionPages: fetch } as never
    });
    const payload: SyncRunJobPayload = { runId: "run-1", organizationId: "org-1", projectId: "proj-1", provider, triggeredBy: "user-1" };
    const run = async () => {
      (made.runs.enqueueTicketJobs as jest.Mock).mockClear();
      await made.processor.process(job(INTEGRATION_SYNC_RUN_JOB, payload));
      const calls = (made.runs.enqueueTicketJobs as jest.Mock).mock.calls;
      return { queued: (calls[0]?.[0] ?? []) as Array<{ issueKey: string }>, truncatedMarks, finish: (made.runs.finishRun as jest.Mock).mock.calls.at(-1)?.[1] as string | null | undefined };
    };
    return { run, stored, db: dbQuery, runs: made.runs };
  }

  it("syncs a cap's worth per run until the backlog is done — never the same ticket twice", async () => {
    const CAP = MAX_TICKETS_PER_RUN;
    const h = harness(backlog(CAP * 2 + 1000));

    const first = await h.run();
    expect(first.queued).toHaveLength(CAP);
    expect(first.queued[0].issueKey).toBe("T-0");
    expect(first.truncatedMarks).toBe(1);
    expect(String(h.db.mock.calls.find(([sql]) => String(sql).includes("SET error"))?.[1]?.[1])).toMatch(new RegExp(`${CAP}-ticket limit.*${CAP} tickets are synced so far.*run Sync again`));

    const second = await h.run();
    expect(second.queued).toHaveLength(CAP);
    expect(second.queued[0].issueKey).toBe(`T-${CAP}`);
    expect(second.truncatedMarks).toBe(2);

    const third = await h.run();
    expect(third.queued).toHaveLength(1000);
    expect(third.queued[0].issueKey).toBe(`T-${CAP * 2}`);
    // The pass reached the end: no further truncation mark, so the next Sync starts fresh.
    expect(third.truncatedMarks).toBe(2);
    expect(h.stored.size).toBe(CAP * 2 + 1000);
  });

  it("re-syncs a ticket that was edited upstream after the earlier run stored it", async () => {
    const tickets = backlog(MAX_TICKETS_PER_RUN + 500);
    const h = harness(tickets);
    await h.run();
    // T-5 changes in the provider between the two runs; its stored copy is now stale.
    tickets[5] = { ...tickets[5], updatedAt: stamp(999_999) };

    const second = await h.run();
    expect(second.queued.map((t) => t.issueKey)).toContain("T-5");
    expect(second.queued).toHaveLength(501);
  });

  it("does not report a limit when the backlog is exactly the cap", async () => {
    const h = harness(backlog(MAX_TICKETS_PER_RUN));
    const only = await h.run();
    expect(only.queued).toHaveLength(MAX_TICKETS_PER_RUN);
    expect(only.truncatedMarks).toBe(0);
  });

  it("finishes with a clear note when everything left was already synced in the pass", async () => {
    const h = harness(backlog(150));
    await h.run();
    const again = await h.run();
    expect(again.queued).toHaveLength(0);
    expect(again.finish).toBe("Every ticket in Engineering is already synced.");
  });
});
