import { LegacyService } from "./legacy.service";
import { encryptSecret } from "../common/crypto.util";
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
import { RequestCacheService } from "../request-cache/request-cache.service";
import { ProjectLookupService } from "../request-cache/project-lookup.service";
import type { KbExtractionRunnerService } from "./kb-extraction-runner.service";
import { SuitesCacheService } from "../cache/suites-cache.service";
import { TestcasesListCacheService } from "../cache/testcases-list-cache.service";
import { ProjectOverviewCacheService } from "../cache/project-overview-cache.service";
import type Redis from "ioredis";

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/*
 * jiraSnapshot()/linearSnapshot() — extended to surface `status`, which was already fetched and
 * persisted to jira_tickets.status/linear_tickets.status but never read back (per
 * ZYRA_BINDING_REPORT.md §2). Additive only: existing key/summary/description fields are
 * untouched, and no new Jira/Linear API call was introduced for the cache-hit path.
 *
 * Both are private, so accessed through the same `internals()` casting pattern
 * zyra-jira-keys.spec.ts already established for this file's other private helpers.
 */

type Internals = {
  jiraSnapshot: (projectId: string, keys: string[]) => Promise<Array<{ key: string; summary: string; description: string; status: string }>>;
  linearSnapshot: (projectId: string, keys: string[]) => Promise<Array<{ key: string; summary: string; description: string; status: string }>>;
};

function internals(svc: LegacyService): Internals {
  return svc as unknown as Internals;
}

function makeLegacy(query: jest.Mock): LegacyService {
  const db = { query } as unknown as DatabaseService;
  const requestCache = new RequestCacheService({} as unknown as AppConfigService);
  const suitesCache = new SuitesCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  const testcasesListCache = new TestcasesListCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  const projectOverviewCache = new ProjectOverviewCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  return new LegacyService(
    db,
    {} as unknown as EmailService,
    {} as unknown as PasswordService,
    {} as unknown as AppConfigService,
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
    {} as unknown as CustomFieldsService,
    {} as unknown as CustomTagsService
  );
}

describe("jiraSnapshot — status in the returned shape", () => {
  it("includes status from the jira_tickets cache alongside key/summary/description", async () => {
    const query = jest.fn((sql: string) => {
      if (String(sql).includes("FROM jira_tickets")) {
        return Promise.resolve({
          rows: [{ jira_issue_key: "EAD-1", summary: "Login fails", description: "Steps to repro", status: "In Progress" }]
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const svc = makeLegacy(query);

    const [snapshot] = await internals(svc).jiraSnapshot("p1", ["EAD-1"]);
    expect(snapshot).toEqual({ key: "EAD-1", summary: "Login fails", description: "Steps to repro", status: "In Progress" });
  });

  it("fetches status live (via fields.status.name) and persists it, for a key missing from the cache", async () => {
    const query = jest.fn((sql: string, _params?: unknown[]) => {
      if (String(sql).includes("FROM jira_tickets")) return Promise.resolve({ rows: [] }); // cache miss
      if (String(sql).startsWith("INSERT INTO jira_tickets")) return Promise.resolve({ rows: [] }); // the upsert
      return Promise.resolve({ rows: [] });
    });
    const svc = makeLegacy(query);

    jest.spyOn(svc as unknown as { getJiraConnection: (...a: unknown[]) => Promise<unknown> }, "getJiraConnection").mockResolvedValue({
      id: "conn-1",
      cloud_id: "cloud-1",
      site_url: "https://example.atlassian.net",
      access_token: encryptSecret("token")
    });
    jest.spyOn(svc as unknown as { jiraFetch: (...a: unknown[]) => Promise<unknown> }, "jiraFetch").mockResolvedValue({
      id: "10001",
      key: "EAD-2",
      fields: { summary: "Session expires early", description: null, status: { name: "Done" } }
    });

    const [snapshot] = await internals(svc).jiraSnapshot("p1", ["EAD-2"]);
    expect(snapshot).toEqual(expect.objectContaining({ key: "EAD-2", summary: "Session expires early", status: "Done" }));

    // The upsert must have carried the same status, not just the in-memory return value.
    const insertCall = query.mock.calls.find((call) => String(call[0]).startsWith("INSERT INTO jira_tickets"));
    expect(insertCall).toBeDefined();
    expect(insertCall?.[1]).toContain("Done");
  });

  it("still returns a status field (empty string) for a key that couldn't be resolved at all", async () => {
    const query = jest.fn(() => Promise.resolve({ rows: [] }));
    const svc = makeLegacy(query);
    jest.spyOn(svc as unknown as { getJiraConnection: (...a: unknown[]) => Promise<unknown> }, "getJiraConnection").mockResolvedValue(null);

    const [snapshot] = await internals(svc).jiraSnapshot("p1", ["MISSING-1"]);
    expect(snapshot).toEqual(expect.objectContaining({ key: "MISSING-1", status: "" }));
  });
});

describe("linearSnapshot — status in the returned shape", () => {
  it("includes status from the linear_tickets cache alongside key/summary/description", async () => {
    const query = jest.fn((sql: string) => {
      if (String(sql).includes("FROM linear_tickets")) {
        return Promise.resolve({
          rows: [{ linear_issue_key: "ENG-42", summary: "Crash on save", description: "Repro steps", status: "Todo" }]
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const svc = makeLegacy(query);

    const [snapshot] = await internals(svc).linearSnapshot("p1", ["ENG-42"]);
    expect(snapshot).toEqual({ key: "ENG-42", summary: "Crash on save", description: "Repro steps", status: "Todo" });
  });

  it("still returns a status field (empty string) for a key not in the cache", async () => {
    const query = jest.fn(() => Promise.resolve({ rows: [] }));
    const svc = makeLegacy(query);

    const [snapshot] = await internals(svc).linearSnapshot("p1", ["ENG-99"]);
    expect(snapshot).toEqual(expect.objectContaining({ key: "ENG-99", status: "" }));
  });
});
