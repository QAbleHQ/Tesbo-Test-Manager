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
import { SyncRunJobPayload } from "./integration-sync.types";

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
} = {}) {
  const runs = {
    listNightlySyncTargets: jest.fn().mockResolvedValue([]),
    getLastSuccessfulRunStart: jest.fn().mockResolvedValue(null),
    startRun: jest.fn(),
    markRunning: jest.fn().mockResolvedValue(undefined),
    failRun: jest.fn().mockResolvedValue(undefined),
    ...overrides.runs
  } as unknown as IntegrationSyncService;

  const client = {
    loadConnection: jest.fn(),
    ...overrides.client
  } as unknown as IntegrationSyncClient;

  const processor = new IntegrationSyncProcessor(
    {} as unknown as DatabaseService,
    runs,
    client,
    {} as unknown as IntegrationSyncDocumentBuilder,
    {} as unknown as IntegrationSyncDecisions,
    {} as unknown as RagIngestionService,
    {} as unknown as PlanLimitsService
  );
  return { processor, runs, client };
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
