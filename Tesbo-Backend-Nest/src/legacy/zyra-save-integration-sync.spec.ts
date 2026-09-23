import { LegacyService } from "./legacy.service";
import type { DatabaseService } from "../database/database.service";
import type { EmailService } from "../auth/email.service";
import type { PasswordService } from "../auth/password.service";
import type { AppConfigService } from "../config/app-config.service";
import type { StorageService } from "../storage/storage.service";
import type { RagIngestionService } from "../rag/rag-ingestion.service";
import type { RagRetrievalService } from "../rag/rag-retrieval.service";
import type { IntegrationSyncService } from "../integration-sync/integration-sync.service";
import type { ApiTokenService } from "../auth/api-token.service";
import type { PlanLimitsService } from "../plan-limits/plan-limits.service";
import type { CustomFieldsService } from "../custom-fields/custom-fields.service";
import type { CustomTagsService } from "../custom-tags/custom-tags.service";
import type { RequestCacheService } from "../request-cache/request-cache.service";
import type { ProjectLookupService } from "../request-cache/project-lookup.service";
import type { KbExtractionRunnerService } from "./kb-extraction-runner.service";
import type { SuitesCacheService } from "../cache/suites-cache.service";
import type { TestcasesListCacheService } from "../cache/testcases-list-cache.service";
import type { ProjectOverviewCacheService } from "../cache/project-overview-cache.service";

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/*
 * zyraSave()'s post-commit integration-sync wiring — see its own comment in legacy.service.ts for
 * why this lives here rather than inside zyraSaveAttempt's transaction (same discipline as feature
 * #1's embedding enqueue: nested WithClient methods don't enqueue themselves; the caller that owns
 * the outermost committed transaction does, once, after it has actually committed).
 *
 * zyraSaveAttempt() itself (the transaction, the advisory lock, insertTestCaseWithClient/
 * updateTestCaseWithClient/patchTestCaseFromZyraWithClient) is unmodified by this feature — only
 * its RETURN SHAPE gained one new field (`touchedActions`). So these tests mock zyraSaveAttempt's
 * result directly rather than re-simulating its whole transaction, the same boundary choice
 * zyra-similarity-feedback.spec.ts made for generateZyraWithProvider: trust what isn't being
 * changed, test what is — zyraSave()'s own orchestration of the (now-committed) result.
 */

type Body = Record<string, any>;

function makeLegacy(): { svc: LegacyService; enqueueTestcaseEmbedding: jest.Mock; suitesInvalidate: jest.Mock; testcasesInvalidate: jest.Mock } {
  const db = { query: jest.fn().mockResolvedValue({ rows: [] }) } as unknown as DatabaseService;
  const enqueueTestcaseEmbedding = jest.fn().mockResolvedValue(undefined);
  const ragIngestion = { enqueueTestcaseEmbedding } as unknown as RagIngestionService;
  const suitesInvalidate = jest.fn().mockResolvedValue(undefined);
  const testcasesInvalidate = jest.fn().mockResolvedValue(undefined);
  const svc = new LegacyService(
    db,
    {} as unknown as EmailService,
    {} as unknown as PasswordService,
    {} as unknown as AppConfigService,
    {} as unknown as StorageService,
    ragIngestion,
    {} as unknown as RagRetrievalService,
    {} as unknown as IntegrationSyncService,
    {} as unknown as ApiTokenService,
    {} as unknown as PlanLimitsService,
    {} as unknown as RequestCacheService,
    {} as unknown as ProjectLookupService,
    {} as unknown as KbExtractionRunnerService,
    { invalidate: suitesInvalidate } as unknown as SuitesCacheService,
    { invalidate: testcasesInvalidate } as unknown as TestcasesListCacheService,
    {} as unknown as ProjectOverviewCacheService,
    {} as unknown as CustomFieldsService,
    {} as unknown as CustomTagsService
  );
  return { svc, enqueueTestcaseEmbedding, suitesInvalidate, testcasesInvalidate };
}

function mockZyraSaveAttempt(svc: LegacyService, result: Body): jest.SpyInstance {
  return jest.spyOn(svc as unknown as { zyraSaveAttempt: (...a: unknown[]) => Promise<Body> }, "zyraSaveAttempt").mockResolvedValue(result);
}

// zyraSave() itself does real authorization (requireProjectAccess) before ever reaching the
// save-attempt/sync logic this file tests — bypassed here the same way, and for the same reason,
// zyra-similarity-feedback.spec.ts bypasses generateZyraChatTestcasesWithAi's unrelated machinery:
// this file is testing the post-commit wiring, not auth, which has its own coverage elsewhere.
function mockAuth(svc: LegacyService): void {
  jest.spyOn(svc as unknown as { requireProjectAccess: (...a: unknown[]) => Promise<unknown> }, "requireProjectAccess").mockResolvedValue({});
}

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const TASK_ID = "00000000-0000-4000-8000-000000000002";

const CREATED_ROW = { id: "tc-new", externalId: "EAD-TC-1", title: "New login test", jiraIssueKey: "EAD-11215", linearIssueKey: null };
const UPDATED_ROW = { id: "tc-1", externalId: "EAD-TC-2", title: "Updated login test", jiraIssueKey: "EAD-11215", linearIssueKey: null };
const ARCHIVED_ROW = { id: "tc-2", externalId: "EAD-TC-3", title: "Archived login test", jiraIssueKey: "EAD-11215", linearIssueKey: null };
const NO_LINK_ROW = { id: "tc-3", externalId: "EAD-TC-4", title: "Unlinked test", jiraIssueKey: null, linearIssueKey: null };

describe("zyraSave — integration-sync wiring", () => {
  afterEach(() => jest.restoreAllMocks());

  it("a successful save with a linked Jira issue posts the correctly-mapped comment for add/update/archive", async () => {
    const { svc } = makeLegacy();
    mockZyraSaveAttempt(svc, {
      savedCount: 3,
      suiteId: "suite-1",
      testcases: [CREATED_ROW, UPDATED_ROW, ARCHIVED_ROW],
      touchedActions: ["add", "update", "archive"],
      remaining: 0
    });
    const jiraComment = jest.spyOn(svc, "jiraComment").mockResolvedValue({ ok: true } as never);
    jest.spyOn(svc, "jiraStatus").mockResolvedValue({ connected: true, connectedProjects: [], history: [] } as never);

    mockAuth(svc);
    await svc.zyraSave(PROJECT_ID, "u1", TASK_ID, {});

    expect(jiraComment).toHaveBeenCalledTimes(3);
    const bodies = jiraComment.mock.calls.map((call) => call[2] as Body);
    expect(bodies[0].comment).toContain("Test case added by Zyra");
    expect(bodies[0].comment).toContain(CREATED_ROW.title);
    expect(bodies[1].comment).toContain("Test case updated by Zyra");
    expect(bodies[1].comment).toContain(UPDATED_ROW.title);
    expect(bodies[2].comment).toContain("Test case archived by Zyra");
    expect(bodies[2].comment).toContain(ARCHIVED_ROW.title);
    expect(bodies.every((b) => b.issueKey === "EAD-11215")).toBe(true);
  });

  it("a testcase with no linked issue skips sync silently — unchanged from before", async () => {
    const { svc } = makeLegacy();
    mockZyraSaveAttempt(svc, { savedCount: 1, suiteId: null, testcases: [NO_LINK_ROW], touchedActions: ["add"], remaining: 0 });
    const jiraComment = jest.spyOn(svc, "jiraComment").mockResolvedValue({ ok: true } as never);
    const linearComment = jest.spyOn(svc, "linearComment").mockResolvedValue({ ok: true } as never);

    mockAuth(svc);
    const result = await svc.zyraSave(PROJECT_ID, "u1", TASK_ID, {});

    expect(jiraComment).not.toHaveBeenCalled();
    expect(linearComment).not.toHaveBeenCalled();
    expect(result.savedCount).toBe(1);
  });

  it("a testcase linked to Jira but with no connected integration skips sync silently — unchanged from before", async () => {
    const { svc } = makeLegacy();
    mockZyraSaveAttempt(svc, { savedCount: 1, suiteId: null, testcases: [UPDATED_ROW], touchedActions: ["update"], remaining: 0 });
    const jiraComment = jest.spyOn(svc, "jiraComment").mockResolvedValue({ ok: true } as never);
    jest.spyOn(svc, "jiraStatus").mockResolvedValue({ connected: false, connectedProjects: [], history: [] } as never);

    mockAuth(svc);
    const result = await svc.zyraSave(PROJECT_ID, "u1", TASK_ID, {});

    expect(jiraComment).not.toHaveBeenCalled();
    expect(result.savedCount).toBe(1);
  });

  it("a save that succeeds but whose sync call fails still reports the save as successful to the caller", async () => {
    const { svc } = makeLegacy();
    const savedResult = { savedCount: 1, suiteId: "suite-1", testcases: [UPDATED_ROW], touchedActions: ["update"], remaining: 0 };
    mockZyraSaveAttempt(svc, savedResult);
    // A hard failure well below the already-caught jiraComment layer — proves the backstop
    // .catch() at the enqueue call site, not just syncTestCaseActionToIntegrations' own internal
    // try/catch, is what keeps this from ever reaching zyraSave's caller.
    jest.spyOn(svc, "syncTestCaseActionToIntegrations").mockRejectedValue(new Error("unexpected failure"));

    mockAuth(svc);
    const result = await svc.zyraSave(PROJECT_ID, "u1", TASK_ID, {});

    expect(result).toMatchObject({ savedCount: 1, suiteId: "suite-1", remaining: 0 });
    expect(result.testcases).toEqual([UPDATED_ROW]);
  });

  it("never calls syncTestCaseActionToIntegrations with dryRun true — this is the live save path, not a preview", async () => {
    const { svc } = makeLegacy();
    mockZyraSaveAttempt(svc, { savedCount: 1, suiteId: null, testcases: [UPDATED_ROW], touchedActions: ["update"], remaining: 0 });
    const sync = jest.spyOn(svc, "syncTestCaseActionToIntegrations").mockResolvedValue([]);

    mockAuth(svc);
    await svc.zyraSave(PROJECT_ID, "u1", TASK_ID, {});

    expect(sync).toHaveBeenCalledWith(PROJECT_ID, "u1", UPDATED_ROW, "update", { dryRun: false });
  });

  it("strips touchedActions from the returned result — internal bookkeeping never reaches the API response", async () => {
    const { svc } = makeLegacy();
    mockZyraSaveAttempt(svc, { savedCount: 1, suiteId: null, testcases: [UPDATED_ROW], touchedActions: ["update"], remaining: 0 });
    jest.spyOn(svc, "syncTestCaseActionToIntegrations").mockResolvedValue([]);

    mockAuth(svc);
    const result = await svc.zyraSave(PROJECT_ID, "u1", TASK_ID, {});

    expect(result).not.toHaveProperty("touchedActions");
  });
});
