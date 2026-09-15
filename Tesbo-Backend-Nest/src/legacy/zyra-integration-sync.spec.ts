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
import { RequestCacheService } from "../request-cache/request-cache.service";
import { ProjectLookupService } from "../request-cache/project-lookup.service";
import type { KbExtractionRunnerService } from "./kb-extraction-runner.service";
import { SuitesCacheService } from "../cache/suites-cache.service";
import { TestcasesListCacheService } from "../cache/testcases-list-cache.service";
import { ProjectOverviewCacheService } from "../cache/project-overview-cache.service";
import type Redis from "ioredis";

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/*
 * jira_sync_test_case / linear_sync_test_case (ZYRA_TICKET_WORKFLOW.md §13) —
 * syncTestCaseActionToIntegrations() and its two private per-provider helpers.
 *
 * Comment-only capability: posts a comment on the linked Jira/Linear issue via the existing
 * jiraComment()/linearComment(), gated by the existing jiraStatus()/linearStatus() connection
 * check. Not wired into any live code path yet (see ZYRA_BINDING_REPORT.md §11), so these tests
 * exercise the new method directly rather than through zyraSave or any HTTP route.
 *
 * jiraStatus/linearStatus/jiraComment/linearComment are mocked at the instance level (jest.spyOn)
 * rather than mocking db.query/fetch underneath them — those four methods are the documented
 * integration points the new capability was explicitly asked to reuse, so asserting on how it
 * calls them (or doesn't) is the right boundary for these tests, not their own internals.
 */

const FRONTEND_URL = "https://app.example.com";

function makeLegacy(): LegacyService {
  const db = { query: jest.fn(() => Promise.resolve({ rows: [] })) } as unknown as DatabaseService;
  const requestCache = new RequestCacheService({} as unknown as AppConfigService);
  const suitesCache = new SuitesCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  const testcasesListCache = new TestcasesListCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  const projectOverviewCache = new ProjectOverviewCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  return new LegacyService(
    db,
    {} as unknown as EmailService,
    {} as unknown as PasswordService,
    { frontendUrl: FRONTEND_URL } as unknown as AppConfigService,
    {} as unknown as StorageService,
    {} as unknown as RagIngestionService,
    {} as unknown as RagRetrievalService,
    {} as unknown as IntegrationSyncService,
    {} as unknown as ApiTokenService,
    {} as unknown as PlanLimitsService,
    requestCache,
    new ProjectLookupService(db, requestCache),
    {} as unknown as KbExtractionRunnerService,
    suitesCache,
    testcasesListCache,
    projectOverviewCache,
    {} as unknown as CustomFieldsService
  );
}

const KB_URL = `${FRONTEND_URL}/projects/p1/testcases/tc-1`;

const TESTCASE = { id: "tc-1", title: "Login rejects an expired session", jiraIssueKey: "EAD-11215" };

function mockConnected(svc: LegacyService, connected: boolean) {
  jest.spyOn(svc, "jiraStatus").mockResolvedValue({ connected, connectedProjects: [], history: [] } as never);
  jest.spyOn(svc, "linearStatus").mockResolvedValue({ connected, connectedProjects: [], history: [] } as never);
}

describe("syncTestCaseActionToIntegrations — connection check", () => {
  it("skips Jira silently (not an error) when the project has no Jira connection", async () => {
    const svc = makeLegacy();
    mockConnected(svc, false);
    const jiraComment = jest.spyOn(svc, "jiraComment").mockResolvedValue({ ok: true } as never);

    const results = await svc.syncTestCaseActionToIntegrations("p1", "u1", TESTCASE, "add");

    expect(results).toEqual([
      expect.objectContaining({ provider: "jira", attempted: false, posted: false, comment: null })
    ]);
    expect(jiraComment).not.toHaveBeenCalled();
  });

  it("skips Linear silently (not an error) when the project has no Linear connection", async () => {
    const svc = makeLegacy();
    mockConnected(svc, false);
    const linearComment = jest.spyOn(svc, "linearComment").mockResolvedValue({ ok: true } as never);

    const results = await svc.syncTestCaseActionToIntegrations("p1", "u1", { ...TESTCASE, jiraIssueKey: undefined, linearIssueKey: "ENG-42" }, "update");

    expect(results).toEqual([
      expect.objectContaining({ provider: "linear", attempted: false, posted: false, comment: null })
    ]);
    expect(linearComment).not.toHaveBeenCalled();
  });

  it("resolves to an empty array for a test case linked to neither Jira nor Linear", async () => {
    const svc = makeLegacy();
    mockConnected(svc, true);
    await expect(svc.syncTestCaseActionToIntegrations("p1", "u1", { id: "tc-2", title: "Unlinked case" }, "add")).resolves.toEqual([]);
  });

  it("attempts both providers when a test case is linked to both", async () => {
    const svc = makeLegacy();
    mockConnected(svc, true);
    jest.spyOn(svc, "jiraComment").mockResolvedValue({ ok: true } as never);
    jest.spyOn(svc, "linearComment").mockResolvedValue({ ok: true } as never);

    const results = await svc.syncTestCaseActionToIntegrations(
      "p1",
      "u1",
      { ...TESTCASE, linearIssueKey: "ENG-42" },
      "add",
      { dryRun: false }
    );

    expect(results.map((r) => r.provider).sort()).toEqual(["jira", "linear"]);
  });
});

describe("syncTestCaseActionToIntegrations — dry run (the default)", () => {
  it("produces the real comment content without calling jiraComment", async () => {
    const svc = makeLegacy();
    mockConnected(svc, true);
    const jiraComment = jest.spyOn(svc, "jiraComment").mockResolvedValue({ ok: true } as never);

    // No opts passed at all — dry run must be the default, not something the caller opts into.
    const results = await svc.syncTestCaseActionToIntegrations("p1", "u1", TESTCASE, "add");

    expect(jiraComment).not.toHaveBeenCalled();
    expect(results).toEqual([
      expect.objectContaining({
        provider: "jira",
        issueKey: "EAD-11215",
        attempted: true,
        posted: false,
        dryRun: true,
        comment: `Test case added by Zyra: ${TESTCASE.title} — ${KB_URL}`
      })
    ]);
  });

  it("still requires dryRun explicitly set to false — dryRun: true behaves identically to the default", async () => {
    const svc = makeLegacy();
    mockConnected(svc, true);
    const jiraComment = jest.spyOn(svc, "jiraComment").mockResolvedValue({ ok: true } as never);

    await svc.syncTestCaseActionToIntegrations("p1", "u1", TESTCASE, "add", { dryRun: true });

    expect(jiraComment).not.toHaveBeenCalled();
  });

  it("makes a real write when dryRun is explicitly false", async () => {
    const svc = makeLegacy();
    mockConnected(svc, true);
    const jiraComment = jest.spyOn(svc, "jiraComment").mockResolvedValue({ ok: true } as never);

    const results = await svc.syncTestCaseActionToIntegrations("p1", "u1", TESTCASE, "update", { dryRun: false });

    expect(jiraComment).toHaveBeenCalledWith("p1", "u1", {
      issueKey: "EAD-11215",
      comment: `Test case updated by Zyra: ${TESTCASE.title} — ${KB_URL}`
    });
    expect(results).toEqual([expect.objectContaining({ posted: true, dryRun: false })]);
  });

  it("reports a posting failure without throwing, so the caller isn't blown up by a best-effort side action", async () => {
    const svc = makeLegacy();
    mockConnected(svc, true);
    jest.spyOn(svc, "jiraComment").mockRejectedValue(new Error("Jira issue EAD-11215 not found"));

    const results = await svc.syncTestCaseActionToIntegrations("p1", "u1", TESTCASE, "archive", { dryRun: false });

    expect(results).toEqual([
      expect.objectContaining({ attempted: true, posted: false, reason: "Jira issue EAD-11215 not found" })
    ]);
  });
});

describe("syncTestCaseActionToIntegrations — per-action message format", () => {
  it.each([
    ["add", `Test case added by Zyra: ${TESTCASE.title} — ${KB_URL}`],
    ["update", `Test case updated by Zyra: ${TESTCASE.title} — ${KB_URL}`],
    ["archive", `Test case archived by Zyra: ${TESTCASE.title} — ${KB_URL}`]
  ] as const)("formats a distinct message for action=%s", async (action, expected) => {
    const svc = makeLegacy();
    mockConnected(svc, true);
    jest.spyOn(svc, "jiraComment").mockResolvedValue({ ok: true } as never);

    const [result] = await svc.syncTestCaseActionToIntegrations("p1", "u1", TESTCASE, action);
    expect(result.comment).toBe(expected);
  });

  it("keeps all three formats distinct from one another", async () => {
    const svc = makeLegacy();
    mockConnected(svc, true);
    jest.spyOn(svc, "jiraComment").mockResolvedValue({ ok: true } as never);

    const comments = await Promise.all(
      (["add", "update", "archive"] as const).map(async (action) => {
        const [result] = await svc.syncTestCaseActionToIntegrations("p1", "u1", TESTCASE, action);
        return result.comment;
      })
    );
    expect(new Set(comments).size).toBe(3);
  });
});

describe("syncTestCaseActionToIntegrations — the KB link", () => {
  it("points at this backend's own frontend test-case route, not a guessed URL shape", async () => {
    const svc = makeLegacy();
    mockConnected(svc, true);
    jest.spyOn(svc, "jiraComment").mockResolvedValue({ ok: true } as never);

    const [result] = await svc.syncTestCaseActionToIntegrations("proj-7", "u1", { id: "case-99", title: "T", jiraIssueKey: "EAD-1" }, "add");
    expect(result.comment).toContain(`${FRONTEND_URL}/projects/proj-7/testcases/case-99`);
  });
});
