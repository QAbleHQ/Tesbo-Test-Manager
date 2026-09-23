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
 * Archive-sweep sub-task C's two LegacyService additions, tested in isolation (same boundary every
 * spec in this session uses): fetchLiveJiraTicketCategoriesBulk (the JQL-batched Jira path sub-task
 * B's log recommended and this sub-task built) and stageArchiveSweepProposal (the race-safe staging
 * write, backed by V108's partial unique index). ZyraArchiveSweepService's own orchestration
 * (grouping, dedup pre-filter, partial-failure isolation, summary counts) is covered separately in
 * zyra-archive-sweep.service.spec.ts, against a mocked LegacyService — this file is the layer below
 * that mock boundary.
 */

type Body = Record<string, any>;

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000099";
const TESTCASE_ID = "00000000-0000-4000-8000-000000000010";

function makeLegacy(): { svc: LegacyService; dbQuery: jest.Mock } {
  const dbQuery = jest.fn();
  const db = { query: dbQuery } as unknown as DatabaseService;
  const ragIngestion = { enqueueTestcaseEmbedding: jest.fn().mockResolvedValue(undefined) } as unknown as RagIngestionService;
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
    {} as unknown as SuitesCacheService,
    {} as unknown as TestcasesListCacheService,
    {} as unknown as ProjectOverviewCacheService,
    {} as unknown as CustomFieldsService,
    {} as unknown as CustomTagsService
  );
  return { svc, dbQuery };
}

const JIRA_CONNECTION_ROW = {
  id: "conn-1",
  organization_id: ORG_ID,
  provider: "jira",
  external_id: "cloud-1",
  site_url: "https://acme.atlassian.net",
  access_token: "",
  refresh_token: "",
  token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
  cloud_id: "cloud-1"
};

function mockJiraConnectionLookup(dbQuery: jest.Mock): void {
  dbQuery.mockResolvedValueOnce({ rows: [{ organization_id: ORG_ID }] }); // projectOrganizationId
  dbQuery.mockResolvedValueOnce({ rows: [JIRA_CONNECTION_ROW] }); // integration_connections SELECT
}

function mockFetchOnce(status: number, jsonBody: Body): void {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => jsonBody,
    text: async () => JSON.stringify(jsonBody)
  } as never);
}

describe("fetchLiveJiraTicketCategoriesBulk", () => {
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch");
  });
  afterEach(() => jest.restoreAllMocks());

  it("empty input makes no DB or HTTP call and returns an empty map", async () => {
    const { svc, dbQuery } = makeLegacy();
    const result = await svc.fetchLiveJiraTicketCategoriesBulk(PROJECT_ID, []);
    expect(result.size).toBe(0);
    expect(dbQuery).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no Jira connection maps every key to not_connected without any HTTP call", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [{ organization_id: ORG_ID }] });
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const result = await svc.fetchLiveJiraTicketCategoriesBulk(PROJECT_ID, ["A-1", "A-2"]);

    expect(result.get("A-1")).toEqual({ found: false, doneness: null, rawCategory: null, reason: "not_connected" });
    expect(result.get("A-2")).toEqual({ found: false, doneness: null, rawCategory: null, reason: "not_connected" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps each returned issue's statusCategory, and a key Jira silently omits to not_found", async () => {
    const { svc, dbQuery } = makeLegacy();
    mockJiraConnectionLookup(dbQuery);
    mockFetchOnce(200, {
      issues: [
        { key: "A-1", fields: { status: { statusCategory: { key: "done" } } } },
        { key: "A-2", fields: { status: { statusCategory: { key: "new" } } } }
        // A-3 deliberately absent — deleted/inaccessible
      ]
    });

    const result = await svc.fetchLiveJiraTicketCategoriesBulk(PROJECT_ID, ["A-1", "A-2", "A-3"]);

    expect(result.get("A-1")).toEqual({ found: true, doneness: "done", rawCategory: "done", reason: "ok" });
    expect(result.get("A-2")).toEqual({ found: true, doneness: "not_done", rawCategory: "new", reason: "ok" });
    expect(result.get("A-3")).toEqual({ found: false, doneness: null, rawCategory: null, reason: "not_found" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("chunks more than JIRA_PAGE_SIZE keys into multiple JQL calls, and one chunk's failure doesn't blank out the other", async () => {
    const { svc, dbQuery } = makeLegacy();
    mockJiraConnectionLookup(dbQuery);
    const keys = Array.from({ length: 101 }, (_, i) => `A-${i + 1}`);
    // First chunk (100 keys) fails outright; second chunk (1 key) succeeds.
    fetchSpy.mockRejectedValueOnce(new Error("network blip"));
    mockFetchOnce(200, { issues: [{ key: "A-101", fields: { status: { statusCategory: { key: "done" } } } }] });

    const result = await svc.fetchLiveJiraTicketCategoriesBulk(PROJECT_ID, keys);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.get("A-1")).toMatchObject({ found: false, reason: "error" });
    expect(result.get("A-101")).toEqual({ found: true, doneness: "done", rawCategory: "done", reason: "ok" });
  });

  it("deduplicates repeated keys in the input", async () => {
    const { svc, dbQuery } = makeLegacy();
    mockJiraConnectionLookup(dbQuery);
    mockFetchOnce(200, { issues: [{ key: "A-1", fields: { status: { statusCategory: { key: "done" } } } }] });

    await svc.fetchLiveJiraTicketCategoriesBulk(PROJECT_ID, ["A-1", "A-1", "A-1"]);

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as Body).body);
    expect(body.jql).toBe('key in ("A-1")');
  });

  it("a genuinely unmapped statusCategory.key is reported as unmapped_category, never defaulted to done", async () => {
    const { svc, dbQuery } = makeLegacy();
    mockJiraConnectionLookup(dbQuery);
    mockFetchOnce(200, { issues: [{ key: "A-1", fields: { status: {} } }] });

    const result = await svc.fetchLiveJiraTicketCategoriesBulk(PROJECT_ID, ["A-1"]);

    expect(result.get("A-1")).toEqual({ found: true, doneness: null, rawCategory: null, reason: "unmapped_category" });
  });
});

describe("stageArchiveSweepProposal", () => {
  afterEach(() => jest.restoreAllMocks());

  const ACTIVE_ROW = {
    id: TESTCASE_ID,
    project_id: PROJECT_ID,
    external_id: "EAD-TC-1",
    title: "Login test",
    status: "Active"
  };

  it("stages a proposal in the exact shape applyZyraChatOperations' archive branch builds", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [ACTIVE_ROW] }); // getTestCase
    dbQuery.mockResolvedValueOnce({ rows: [] }); // INSERT

    const outcome = await svc.stageArchiveSweepProposal(PROJECT_ID, TESTCASE_ID, "ticket is done");

    expect(outcome).toBe("staged");
    const insertCall = dbQuery.mock.calls[1];
    expect(String(insertCall[0])).toContain("INSERT INTO ai_generation_requests");
    const params = insertCall[1] as unknown[];
    expect(params[0]).toBe(PROJECT_ID); // project_id
    expect(params[1]).toBe(ZYRA_ARCHIVE_SWEEP_PROVIDER_FOR_TEST);
    const payload = JSON.parse(params[3] as string);
    expect(payload).toEqual([{ opType: "archive", testcaseId: TESTCASE_ID, externalId: "EAD-TC-1", fields: { status: "Archived" }, reason: "ticket is done" }]);
    expect(params[6]).toBe(TESTCASE_ID); // sweep_testcase_id
  });

  it("populates jira_issue_keys from the test case's own jiraIssueKey when set", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [{ ...ACTIVE_ROW, jira_issue_key: "EAD-11215" }] });
    dbQuery.mockResolvedValueOnce({ rows: [] });

    await svc.stageArchiveSweepProposal(PROJECT_ID, TESTCASE_ID, "ticket is done");

    const params = dbQuery.mock.calls[1][1] as unknown[];
    expect(JSON.parse(params[7] as string)).toEqual(["EAD-11215"]);
    expect(JSON.parse(params[8] as string)).toEqual([]);
  });

  it("populates linear_issue_keys from the test case's own linearIssueKey when set", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [{ ...ACTIVE_ROW, linear_issue_key: "ENG-42" }] });
    dbQuery.mockResolvedValueOnce({ rows: [] });

    await svc.stageArchiveSweepProposal(PROJECT_ID, TESTCASE_ID, "ticket is done");

    const params = dbQuery.mock.calls[1][1] as unknown[];
    expect(JSON.parse(params[7] as string)).toEqual([]);
    expect(JSON.parse(params[8] as string)).toEqual(["ENG-42"]);
  });

  it("populates BOTH jira_issue_keys and linear_issue_keys when a test case genuinely has both linked", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [{ ...ACTIVE_ROW, jira_issue_key: "EAD-11215", linear_issue_key: "ENG-42" }] });
    dbQuery.mockResolvedValueOnce({ rows: [] });

    await svc.stageArchiveSweepProposal(PROJECT_ID, TESTCASE_ID, "ticket is done");

    const params = dbQuery.mock.calls[1][1] as unknown[];
    expect(JSON.parse(params[7] as string)).toEqual(["EAD-11215"]);
    expect(JSON.parse(params[8] as string)).toEqual(["ENG-42"]);
  });

  it("populates neither when the test case (defensively) has no linked ticket key at all", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [ACTIVE_ROW] });
    dbQuery.mockResolvedValueOnce({ rows: [] });

    await svc.stageArchiveSweepProposal(PROJECT_ID, TESTCASE_ID, "ticket is done");

    const params = dbQuery.mock.calls[1][1] as unknown[];
    expect(JSON.parse(params[7] as string)).toEqual([]);
    expect(JSON.parse(params[8] as string)).toEqual([]);
  });

  it("requested_by is NULL in the INSERT — no chat/task-board actor, matching V107's system-actor design", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [ACTIVE_ROW] });
    dbQuery.mockResolvedValueOnce({ rows: [] });

    await svc.stageArchiveSweepProposal(PROJECT_ID, TESTCASE_ID, "ticket is done");

    const insertSql = String(dbQuery.mock.calls[1][0]);
    expect(insertSql).toMatch(/VALUES\s*\(\s*\$1,\s*NULL,\s*\$2/);
  });

  it("a test case that no longer exists (deleted since the candidate query ran) is skipped, never inserted", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [] }); // getTestCase finds nothing -> throws NotFoundException

    const outcome = await svc.stageArchiveSweepProposal(PROJECT_ID, TESTCASE_ID, "ticket is done");

    expect(outcome).toBe("skipped");
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it("a test case belonging to a different project is skipped, never inserted", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [{ ...ACTIVE_ROW, project_id: "00000000-0000-4000-8000-0000000000ff" }] });

    const outcome = await svc.stageArchiveSweepProposal(PROJECT_ID, TESTCASE_ID, "ticket is done");

    expect(outcome).toBe("skipped");
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it("a test case already archived (race since the candidate query ran) is skipped, never inserted", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [{ ...ACTIVE_ROW, status: "Archived" }] });

    const outcome = await svc.stageArchiveSweepProposal(PROJECT_ID, TESTCASE_ID, "ticket is done");

    expect(outcome).toBe("skipped");
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it("a dedup-index conflict (23505 on the sweep-archive-dedup index) is reported as already_staged, not thrown", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [ACTIVE_ROW] });
    dbQuery.mockRejectedValueOnce(Object.assign(new Error("duplicate key"), { code: "23505", constraint: "idx_ai_generation_requests_sweep_archive_dedup" }));

    const outcome = await svc.stageArchiveSweepProposal(PROJECT_ID, TESTCASE_ID, "ticket is done");

    expect(outcome).toBe("already_staged");
  });

  it("an unrelated unique-violation (a different constraint) is rethrown, not silently swallowed as already_staged", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [ACTIVE_ROW] });
    dbQuery.mockRejectedValueOnce(Object.assign(new Error("duplicate key"), { code: "23505", constraint: "some_other_constraint" }));

    await expect(svc.stageArchiveSweepProposal(PROJECT_ID, TESTCASE_ID, "ticket is done")).rejects.toThrow("duplicate key");
  });

  it("a non-constraint DB error (connection drop) is rethrown, not silently swallowed", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [ACTIVE_ROW] });
    dbQuery.mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));

    await expect(svc.stageArchiveSweepProposal(PROJECT_ID, TESTCASE_ID, "ticket is done")).rejects.toThrow("Connection terminated unexpectedly");
  });
});

const ZYRA_ARCHIVE_SWEEP_PROVIDER_FOR_TEST = "zyra_archive_sweep";
