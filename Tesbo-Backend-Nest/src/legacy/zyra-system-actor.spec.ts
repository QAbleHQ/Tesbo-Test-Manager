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
import type { RequestCacheService } from "../request-cache/request-cache.service";
import type { ProjectLookupService } from "../request-cache/project-lookup.service";
import type { KbExtractionRunnerService } from "./kb-extraction-runner.service";
import type { SuitesCacheService } from "../cache/suites-cache.service";
import type { TestcasesListCacheService } from "../cache/testcases-list-cache.service";
import type { ProjectOverviewCacheService } from "../cache/project-overview-cache.service";

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/*
 * V107_ai_generation_requests_system_actor.sql (sub-task A of the archive-sweep feature) dropped
 * ai_generation_requests.requested_by's NOT NULL constraint so a future headless sweep job can
 * stage a proposal with requested_by = NULL — no human in a chat session triggered it. The FK's
 * ON DELETE CASCADE is deliberately untouched (see the migration's own comment for why: it's what
 * keeps NULL meaning exactly one thing, unlike integration_sync_runs.triggered_by's ON DELETE SET
 * NULL, which needed a whole extra trigger_source column to stay unambiguous).
 *
 * This file is schema-level regression coverage, not sweep-feature coverage — no sweep job exists
 * yet to test. It proves the one thing sub-task A actually changed behavior for: the *read* path
 * (zyraTask -> formatAiTask) that every existing ai_generation_requests row already flows through
 * must not choke on a row that has requested_by = NULL, now that the column can hold one. Every
 * existing INSERT into this table is unaffected by construction — DROP NOT NULL only ever *widens*
 * what's legal, so a real actor id still round-trips exactly as before (verified by the same spy,
 * same assertion shape, with a non-null id).
 */

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const TASK_ID = "00000000-0000-4000-8000-000000000003";

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
    {} as unknown as CustomFieldsService
  );
  return { svc, dbQuery };
}

function mockAuth(svc: LegacyService): void {
  jest.spyOn(svc as unknown as { requireProjectAccess: (...a: unknown[]) => Promise<unknown> }, "requireProjectAccess").mockResolvedValue({});
}

const BASE_ROW = {
  id: TASK_ID,
  provider: "anthropic",
  model: "claude-sonnet-5",
  user_story: "As a user...",
  acceptance_criteria: null,
  custom_prompt: null,
  style: "strict",
  requested_count: 5,
  generated_count: 0,
  generated_payload: "[]",
  saved_count: 0,
  save_events: "[]",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  agent_name: "zyra",
  task_status: "todo",
  feedback: null,
  context: null,
  jira_issue_keys: "[]",
  token_input: 0,
  token_output: 0,
  token_total: 0,
  source_summary: "[]",
  activity_log: "[]"
};

describe("ai_generation_requests.requested_by — nullable system-actor column (V107)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("a system-initiated row (requested_by NULL) reads back through zyraTask without throwing, and stays null", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValue({ rows: [{ ...BASE_ROW, requested_by: null, provider: "zyra_archive_sweep" }] });
    mockAuth(svc);

    const result = await svc.zyraTask(PROJECT_ID, "u1", TASK_ID);

    expect(result.requestedBy).toBeNull();
    expect(result.provider).toBe("zyra_archive_sweep");
  });

  it("a normal human-initiated row (requested_by a real user id) is unaffected — same read path, non-null value round-trips exactly", async () => {
    const { svc, dbQuery } = makeLegacy();
    const userId = "00000000-0000-4000-8000-0000000000aa";
    dbQuery.mockResolvedValue({ rows: [{ ...BASE_ROW, requested_by: userId }] });
    mockAuth(svc);

    const result = await svc.zyraTask(PROJECT_ID, "u1", TASK_ID);

    expect(result.requestedBy).toBe(userId);
  });

  it("a NULL requested_by row carries no other missing/undefined fields — toCamel maps every column through regardless of value", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValue({ rows: [{ ...BASE_ROW, requested_by: null }] });
    mockAuth(svc);

    const result = await svc.zyraTask(PROJECT_ID, "u1", TASK_ID);

    expect(result).toHaveProperty("requestedBy", null);
    expect(result.taskStatus).toBe("todo");
    expect(result.agentName).toBe("zyra");
  });
});
