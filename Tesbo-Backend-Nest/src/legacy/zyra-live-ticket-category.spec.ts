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
 * Archive-sweep sub-task B: fetchLiveTicketCategory(projectId, provider, issueKey) — a live (never
 * jira_tickets/linear_tickets cache) lookup of one linked issue's normalized done/not-done category.
 * Not wired into anything yet (that's sub-task C) — this is coverage for the function in isolation,
 * the same boundary choice every other spec in this session has made for a not-yet-wired capability.
 *
 * global.fetch is mocked directly rather than going through jiraFetch/linearGraphQL's own callers,
 * because this function's whole job is calling those two shared helpers correctly and handling
 * everything that can come back from them — the real HTTP layer is exactly what needs exercising.
 */

type Body = Record<string, any>;

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000099";

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

const LINEAR_CONNECTION_ROW = {
  id: "conn-2",
  organization_id: ORG_ID,
  provider: "linear",
  external_id: null,
  site_url: "https://linear.app/acme",
  access_token: "",
  refresh_token: "",
  token_expires_at: new Date(Date.now() + 3600_000).toISOString()
};

function mockFetchOnce(status: number, jsonBody: Body): void {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => jsonBody,
    text: async () => JSON.stringify(jsonBody)
  } as never);
}

describe("fetchLiveTicketCategory — Jira", () => {
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch");
  });
  afterEach(() => jest.restoreAllMocks());

  function mockJiraConnectionLookup(dbQuery: jest.Mock): void {
    dbQuery.mockResolvedValueOnce({ rows: [{ organization_id: ORG_ID }] }); // projectOrganizationId
    dbQuery.mockResolvedValueOnce({ rows: [JIRA_CONNECTION_ROW] }); // integration_connections SELECT
  }

  it("a Done issue (statusCategory.key = 'done') is reported as done", async () => {
    const { svc, dbQuery } = makeLegacy();
    mockJiraConnectionLookup(dbQuery);
    mockFetchOnce(200, { fields: { status: { name: "Done", statusCategory: { key: "done" } } } });

    const result = await svc.fetchLiveTicketCategory(PROJECT_ID, "jira", "EAD-11215");

    expect(result).toEqual({ found: true, doneness: "done", rawCategory: "done", reason: "ok" });
  });

  it("a To Do issue (statusCategory.key = 'new') is reported as not done", async () => {
    const { svc, dbQuery } = makeLegacy();
    mockJiraConnectionLookup(dbQuery);
    mockFetchOnce(200, { fields: { status: { name: "To Do", statusCategory: { key: "new" } } } });

    const result = await svc.fetchLiveTicketCategory(PROJECT_ID, "jira", "EAD-1");

    expect(result).toEqual({ found: true, doneness: "not_done", rawCategory: "new", reason: "ok" });
  });

  it("an In Progress issue (statusCategory.key = 'indeterminate') is reported as not done", async () => {
    const { svc, dbQuery } = makeLegacy();
    mockJiraConnectionLookup(dbQuery);
    mockFetchOnce(200, { fields: { status: { name: "In Progress", statusCategory: { key: "indeterminate" } } } });

    const result = await svc.fetchLiveTicketCategory(PROJECT_ID, "jira", "EAD-2");

    expect(result.doneness).toBe("not_done");
  });

  it("no Jira connection for the project — reports not_connected, never throws", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [{ organization_id: ORG_ID }] }); // projectOrganizationId
    dbQuery.mockResolvedValueOnce({ rows: [] }); // no integration_connections row

    const result = await svc.fetchLiveTicketCategory(PROJECT_ID, "jira", "EAD-1");

    expect(result).toEqual({ found: false, doneness: null, rawCategory: null, reason: "not_connected" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a 404 from Jira (unknown/deleted/inaccessible issue) is reported as not_found, not error", async () => {
    const { svc, dbQuery } = makeLegacy();
    mockJiraConnectionLookup(dbQuery);
    mockFetchOnce(404, {});

    const result = await svc.fetchLiveTicketCategory(PROJECT_ID, "jira", "EAD-999");

    expect(result).toEqual({ found: false, doneness: null, rawCategory: null, reason: "not_found" });
  });

  it("a 429 (rate limited) or 5xx from Jira is reported as error, distinctly from not_found", async () => {
    const { svc, dbQuery } = makeLegacy();
    mockJiraConnectionLookup(dbQuery);
    mockFetchOnce(429, {});

    const result = await svc.fetchLiveTicketCategory(PROJECT_ID, "jira", "EAD-1");

    expect(result.found).toBe(false);
    expect(result.reason).toBe("error");
    expect(result.detail).toBeDefined();
  });

  it("a network failure (fetch rejects outright) is reported as error, not thrown", async () => {
    const { svc, dbQuery } = makeLegacy();
    mockJiraConnectionLookup(dbQuery);
    fetchSpy.mockRejectedValueOnce(new Error("fetch failed"));

    const result = await svc.fetchLiveTicketCategory(PROJECT_ID, "jira", "EAD-1");

    expect(result.found).toBe(false);
    expect(result.reason).toBe("error");
  });

  it("a genuinely unmapped/absent statusCategory.key is reported as unmapped_category, never defaulted to done", async () => {
    const { svc, dbQuery } = makeLegacy();
    mockJiraConnectionLookup(dbQuery);
    mockFetchOnce(200, { fields: { status: { name: "Some Custom Status" } } }); // no statusCategory at all

    const result = await svc.fetchLiveTicketCategory(PROJECT_ID, "jira", "EAD-1");

    expect(result.found).toBe(true);
    expect(result.doneness).toBeNull();
    expect(result.reason).toBe("unmapped_category");
  });

  it("an empty/whitespace-only issue key is reported as not_found without making any call", async () => {
    const { svc, dbQuery } = makeLegacy();

    const result = await svc.fetchLiveTicketCategory(PROJECT_ID, "jira", "   ");

    expect(result).toEqual({ found: false, doneness: null, rawCategory: null, reason: "not_found" });
    expect(dbQuery).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("fetchLiveTicketCategory — Linear", () => {
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch");
  });
  afterEach(() => jest.restoreAllMocks());

  function mockLinearLookup(dbQuery: jest.Mock): void {
    dbQuery.mockResolvedValueOnce({ rows: [{ organization_id: ORG_ID }] }); // projectOrganizationId
    dbQuery.mockResolvedValueOnce({ rows: [LINEAR_CONNECTION_ROW] }); // integration_connections SELECT
  }

  it("a Completed issue (state.type = 'completed') is reported as done", async () => {
    const { svc, dbQuery } = makeLegacy();
    mockLinearLookup(dbQuery);
    mockFetchOnce(200, { data: { issue: { id: "uuid-1", identifier: "ENG-1", state: { type: "completed" } } } });

    const result = await svc.fetchLiveTicketCategory(PROJECT_ID, "linear", "ENG-1");

    expect(result).toEqual({ found: true, doneness: "done", rawCategory: "completed", reason: "ok" });
  });

  it("a Cancelled issue counts as done — an abandoned ticket is as much an archive signal as a shipped one", async () => {
    const { svc, dbQuery } = makeLegacy();
    mockLinearLookup(dbQuery);
    mockFetchOnce(200, { data: { issue: { id: "uuid-1", identifier: "ENG-2", state: { type: "cancelled" } } } });

    const result = await svc.fetchLiveTicketCategory(PROJECT_ID, "linear", "ENG-2");

    expect(result.doneness).toBe("done");
  });

  it("a Backlog/Unstarted/Started issue is reported as not done", async () => {
    const { svc, dbQuery } = makeLegacy();
    mockLinearLookup(dbQuery);
    mockFetchOnce(200, { data: { issue: { id: "uuid-1", identifier: "ENG-3", state: { type: "started" } } } });

    const result = await svc.fetchLiveTicketCategory(PROJECT_ID, "linear", "ENG-3");

    expect(result.doneness).toBe("not_done");
  });

  it("no Linear connection for the project's organization — reports not_connected, never throws", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [{ organization_id: ORG_ID }] });
    dbQuery.mockResolvedValueOnce({ rows: [] }); // no integration_connections row

    const result = await svc.fetchLiveTicketCategory(PROJECT_ID, "linear", "ENG-1");

    expect(result).toEqual({ found: false, doneness: null, rawCategory: null, reason: "not_connected" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the project itself no longer exists (deleted mid-sweep) — reports not_connected, never throws NotFoundException", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [] }); // projects SELECT finds nothing -> projectOrganizationId throws

    const result = await svc.fetchLiveTicketCategory(PROJECT_ID, "linear", "ENG-1");

    expect(result).toEqual({ found: false, doneness: null, rawCategory: null, reason: "not_connected" });
  });

  it("Linear resolves an unknown/inaccessible key to issue: null (not a thrown GraphQL error) — reported as not_found", async () => {
    const { svc, dbQuery } = makeLegacy();
    mockLinearLookup(dbQuery);
    mockFetchOnce(200, { data: { issue: null } });

    const result = await svc.fetchLiveTicketCategory(PROJECT_ID, "linear", "ENG-999");

    expect(result).toEqual({ found: false, doneness: null, rawCategory: null, reason: "not_found" });
  });

  it("a GraphQL-level error response (data.errors) is reported as error, not thrown", async () => {
    const { svc, dbQuery } = makeLegacy();
    mockLinearLookup(dbQuery);
    mockFetchOnce(200, { errors: [{ message: "Authentication required" }] });

    const result = await svc.fetchLiveTicketCategory(PROJECT_ID, "linear", "ENG-1");

    expect(result.found).toBe(false);
    expect(result.reason).toBe("error");
  });

  it("a genuinely unmapped/absent state.type is reported as unmapped_category, never defaulted to done", async () => {
    const { svc, dbQuery } = makeLegacy();
    mockLinearLookup(dbQuery);
    mockFetchOnce(200, { data: { issue: { id: "uuid-1", identifier: "ENG-1", state: {} } } });

    const result = await svc.fetchLiveTicketCategory(PROJECT_ID, "linear", "ENG-1");

    expect(result.found).toBe(true);
    expect(result.doneness).toBeNull();
    expect(result.reason).toBe("unmapped_category");
  });
});
