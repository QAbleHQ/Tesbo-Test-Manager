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

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

// Reported behaviour: Zyra answered "how many total test cases?" with 46, but its own suite-wise
// breakdown only summed to 32 — the 14 testcases with no suite_id were counted into the total by
// zyraChatProjectSnapshot's plain COUNT(*), yet silently dropped by projectSuiteSummaries' suite
// JOIN, and nothing in the model's context said the difference was testcases outside any suite.
// These tests pin the snapshot's arithmetic so the model is always given a number that reconciles
// the total against the per-suite rows, instead of a gap it has to be asked about to explain.
function makeLegacy(query: jest.Mock): LegacyService {
  return new LegacyService(
    { query } as unknown as DatabaseService,
    {} as unknown as EmailService,
    {} as unknown as PasswordService,
    {} as unknown as AppConfigService,
    {} as unknown as StorageService,
    {} as unknown as RagIngestionService,
    {} as unknown as RagRetrievalService,
    {} as unknown as IntegrationSyncService,
    {} as unknown as ApiTokenService,
    {} as unknown as PlanLimitsService,
    {} as unknown as CustomFieldsService
  );
}

type Internals = {
  zyraChatProjectSnapshot: (projectId: string) => Promise<{
    suites: Array<{ id: string; name: string; testCaseCount: number }>;
    testcaseCount: number;
    unassignedTestCaseCount: number;
  }>;
};

function queryMock(opts: { suites: Array<{ id: string; name: string; test_case_count: number }>; testcaseCount: number }): jest.Mock {
  return jest.fn((sql: unknown) => {
    const s = String(sql);
    if (s.includes("FROM suites s LEFT JOIN")) return Promise.resolve({ rows: opts.suites });
    if (s.includes("AS testcase_count")) return Promise.resolve({ rows: [{ testcase_count: opts.testcaseCount, linked_jira_testcase_count: 0 }] });
    return Promise.resolve({ rows: [] });
  });
}

describe("zyraChatProjectSnapshot", () => {
  it("surfaces testcases with no suite as an explicit unassigned count, not a silent gap", async () => {
    const svc = makeLegacy(
      queryMock({
        suites: [
          { id: "s1", name: "API - Jira Flight Bookings", test_case_count: 16 },
          { id: "s2", name: "Email Login", test_case_count: 10 },
          { id: "s3", name: "Mobile Login", test_case_count: 6 },
          { id: "s4", name: "login (empty)", test_case_count: 0 }
        ],
        testcaseCount: 46
      })
    );

    const snapshot = await (svc as unknown as Internals).zyraChatProjectSnapshot("project-1");

    expect(snapshot.testcaseCount).toBe(46);
    const suiteTotal = snapshot.suites.reduce((sum, suite) => sum + suite.testCaseCount, 0);
    expect(suiteTotal).toBe(32);
    expect(snapshot.unassignedTestCaseCount).toBe(14);
    // The invariant the reported bug violated: total must reconcile against suites + unassigned.
    expect(suiteTotal + snapshot.unassignedTestCaseCount).toBe(snapshot.testcaseCount);
  });

  it("reports zero unassigned when every testcase already belongs to a suite", async () => {
    const svc = makeLegacy(
      queryMock({
        suites: [{ id: "s1", name: "Login", test_case_count: 10 }],
        testcaseCount: 10
      })
    );

    const snapshot = await (svc as unknown as Internals).zyraChatProjectSnapshot("project-1");

    expect(snapshot.unassignedTestCaseCount).toBe(0);
  });
});
