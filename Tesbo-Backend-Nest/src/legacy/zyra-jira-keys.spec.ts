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
 * Which Jira issue keys Zyra believes a message refers to.
 *
 * The regression: extractJiraIssueKeys' space-separated pattern carried the /i flag, so any word
 * followed by a number became an issue key. "create 10 first" became CREATE-10 — a ticket that
 * has never existed in any Jira, in a workspace with no Jira connection at all. Six of the eight
 * real production messages matching that shape invented one.
 *
 * It reached the user twice over: the reasoning summary reported the phantom key as a source Zyra
 * had "read directly", and jiraSnapshot live-fetches any key missing from the sync cache, so each
 * phantom fired a real Jira API request for a nonexistent issue on every message.
 *
 * Two defences, both covered below: the pattern now requires the uppercase a real project key has,
 * and resolveJiraIssueKeys checks the prefix against the project's configured Jira projects.
 */

type Internals = {
  extractJiraIssueKeys: (message: string) => string[];
  resolveJiraIssueKeys: (projectId: string, message: string) => Promise<string[]>;
};

function makeLegacy(mappedProjectKeys: string[] = []): LegacyService {
  const db = {
    query: jest.fn((sql: string) => {
      if (String(sql).includes("jira_project_mappings")) {
        return Promise.resolve({ rows: mappedProjectKeys.map((jira_project_key) => ({ jira_project_key })) });
      }
      return Promise.resolve({ rows: [] });
    })
  } as unknown as DatabaseService;
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
    {} as unknown as CustomFieldsService
  );
}

function internals(svc: LegacyService): Internals {
  return svc as unknown as Internals;
}

describe("extractJiraIssueKeys — pattern", () => {
  const svc = makeLegacy();

  // Verbatim from production zyra_chat_messages. Each of these used to manufacture a ticket.
  it.each([
    ["create 10 first", "CREATE-10"],
    ["create 3 edge test cases", "CREATE-3"],
    ["create 7 test case for login", "CREATE-7"],
    ["now create more 25", "MORE-25"],
    ["add 2  back", "ADD-2"],
    ["create 2 more happy integration floe", "CREATE-2"],
    ["Generate 100 test cases", "GENERATE-100"],
    ["give me 20 smoke tests", "ME-20"]
  ])("does not invent a Jira key from %j", (message, phantom) => {
    expect(internals(svc).extractJiraIssueKeys(message)).not.toContain(phantom);
  });

  it("still reads a hyphenated key, in any case the user types it", () => {
    expect(internals(svc).extractJiraIssueKeys("cover EAD-11215 please")).toContain("EAD-11215");
    expect(internals(svc).extractJiraIssueKeys("cover ead-11215 please")).toContain("EAD-11215");
  });

  it("still reads an uppercase key typed without its hyphen", () => {
    // The case the loose pattern exists for. Uppercase is what separates it from "create 10".
    expect(internals(svc).extractJiraIssueKeys("look at EAD 11215")).toContain("EAD-11215");
    expect(internals(svc).extractJiraIssueKeys("TTM 42 needs coverage")).toContain("TTM-42");
  });

  it("reads several keys from one message", () => {
    const keys = internals(svc).extractJiraIssueKeys("EAD-11215 and TTM-42 both need tests");
    expect(keys).toEqual(expect.arrayContaining(["EAD-11215", "TTM-42"]));
  });
});

describe("resolveJiraIssueKeys — the project's configured Jira is the authority", () => {
  it("keeps a key whose prefix is configured for this project", async () => {
    const svc = makeLegacy(["EAD", "TTM"]);
    await expect(internals(svc).resolveJiraIssueKeys("p1", "cover EAD-11215")).resolves.toEqual(["EAD-11215"]);
  });

  it("drops a key-shaped string whose prefix belongs to no configured project", async () => {
    // TEST-1 is a valid key SHAPE and a phrase a person writes by accident. Only the mapping
    // table can tell the difference, which is why pattern-matching alone is not enough.
    const svc = makeLegacy(["EAD"]);
    await expect(internals(svc).resolveJiraIssueKeys("p1", "see TEST-1 and EAD-9")).resolves.toEqual(["EAD-9"]);
  });

  it("resolves nothing for a project with no Jira mapping — it has no Jira to have read from", async () => {
    const svc = makeLegacy([]);
    await expect(internals(svc).resolveJiraIssueKeys("p1", "cover EAD-11215")).resolves.toEqual([]);
  });

  it("never queries the database for a message with no key-shaped text", async () => {
    // This runs on every chat message, so the common case must not cost a round trip.
    const svc = makeLegacy(["EAD"]);
    await internals(svc).resolveJiraIssueKeys("p1", "write some login tests please");
    expect((svc as unknown as { db: { query: jest.Mock } }).db.query).not.toHaveBeenCalled();
  });

  it("does not reach Jira for the message that caused the outage", async () => {
    const svc = makeLegacy(["CREATE"]);
    // Even with a (contrived) CREATE project configured, the pattern no longer produces
    // CREATE-10 from "create 10 first", so nothing is looked up.
    await expect(internals(svc).resolveJiraIssueKeys("p1", "create 10 first")).resolves.toEqual([]);
  });
});
