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
 * Integration-level coverage for the router salvage-retry path added to buildZyraChatDecision
 * (legacy.service.ts). Unlike zyra-response-parsing.spec.ts (pure text-in/text-out on the parsing
 * helpers) and zyra-chat-intent.spec.ts, this drives buildZyraChatDecision itself end to end against
 * a mocked provider fetch, because the behaviour under test — "retry once on a salvaged router
 * response, give up honestly on a second salvage" — only exists as orchestration inside that method,
 * not as a separately callable unit.
 *
 * The reported bug this closes: a router completion that fails to parse falls back to a partial
 * text-salvage of just reply/reasoningSummary, and the turn silently became a confident "answer"
 * reply with zero operations — a phantom success. See docs/zyra-agent-behaviour.md's changelog and
 * the RCA this spec was written from.
 */

const AI_KEY_ROW = {
  id: "key-1",
  name: "Test key",
  provider: "openai",
  default_model: "gpt-4o",
  base_url: null,
  auth_header_name: null,
  auth_scheme: null,
  is_active: true,
  api_key: "sk-test-000"
};

function makeLegacy(): { svc: LegacyService; dbQuery: jest.Mock } {
  const dbQuery = jest.fn((sql: string) => {
    if (typeof sql === "string" && sql.includes("project_ai_key_allocations")) {
      return Promise.resolve({ rows: [AI_KEY_ROW] });
    }
    return Promise.resolve({ rows: [] });
  });
  const db = { query: dbQuery, transaction: jest.fn() } as unknown as DatabaseService;
  const requestCache = new RequestCacheService({} as unknown as AppConfigService);
  const suitesCache = new SuitesCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  const testcasesListCache = new TestcasesListCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  const projectOverviewCache = new ProjectOverviewCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  const svc = new LegacyService(
    db,
    {} as unknown as EmailService,
    {} as unknown as PasswordService,
    {} as unknown as AppConfigService,
    {} as unknown as StorageService,
    {} as unknown as RagIngestionService,
    { retrieveWithDiagnostics: jest.fn().mockResolvedValue({ items: [], semanticSearchRan: false, reason: "no embeddings key" }) } as unknown as RagRetrievalService,
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
  // logProjectActivity does its own db.query("INSERT INTO activity ...") — already covered by the
  // generic dbQuery stub above, no separate mock needed.
  return { svc, dbQuery };
}

/** A router completion body shaped like OpenAI's chat/completions response. */
function openAiCompletion(content: string) {
  return {
    ok: true,
    json: () => Promise.resolve({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })
  };
}

// Truncated mid-array — the shape that actually reproduces production truncation: reply/
// reasoningSummary are early in the envelope and survive salvage; action/operations never appear.
const TRUNCATED_CREATE_RESPONSE = JSON.stringify({
  reply: "Here are 8 flight booking test cases drafted and staged for your review.",
  reasoningSummary: "Sources used: KAN-1. I focus on gaps: passenger details, payment, confirmation."
}).slice(0, -1) + ',"operations":[{"type":"create","draft":{"title":"Search flights';

const CLEAN_ANSWER_RESPONSE = JSON.stringify({
  reply: "There are 12 login test cases already covering this flow.",
  reasoningSummary: "Matched 12 existing cases.",
  action: "answer",
  actionType: "answer",
  operations: [],
  testcases: []
});

describe("Zyra router salvage-retry (buildZyraChatDecision)", () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch" as never);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("retries once on a salvaged router response and returns the clean retry's decision", async () => {
    const { svc } = makeLegacy();
    fetchSpy
      .mockResolvedValueOnce(openAiCompletion(TRUNCATED_CREATE_RESPONSE) as never)
      .mockResolvedValueOnce(openAiCompletion(CLEAN_ANSWER_RESPONSE) as never);

    const decision = await (svc as unknown as { buildZyraChatDecision: (...args: unknown[]) => Promise<{ reply: string; actionType: string; __salvaged?: boolean }> })
      .buildZyraChatDecision("project-1", "user-1", "session-1", "generate flight booking test cases");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(decision.actionType).toBe("answer");
    expect(decision.__salvaged).toBeFalsy();
    expect(decision.reply).toBe("There are 12 login test cases already covering this flow.");
    // The critical negative: the salvaged narrative from the FIRST (discarded) attempt must never
    // reach the user — this is the exact phantom-success text the bug reported.
    expect(decision.reply).not.toContain("flight booking");
  });

  it("returns an honest, non-phantom failure when the retry also salvages", async () => {
    const { svc, dbQuery } = makeLegacy();
    fetchSpy
      .mockResolvedValueOnce(openAiCompletion(TRUNCATED_CREATE_RESPONSE) as never)
      .mockResolvedValueOnce(openAiCompletion(TRUNCATED_CREATE_RESPONSE) as never);

    const decision = await (svc as unknown as { buildZyraChatDecision: (...args: unknown[]) => Promise<{ reply: string; actionType: string; operations: unknown[]; testcases: unknown[]; __salvaged?: boolean }> })
      .buildZyraChatDecision("project-1", "user-1", "session-1", "generate flight booking test cases");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(decision.actionType).toBe("answer");
    expect(decision.operations).toEqual([]);
    expect(decision.testcases).toEqual([]);
    expect(decision.__salvaged).toBe(true);
    // Never the salvaged narrative pretending to be a real decision.
    expect(decision.reply).not.toContain("flight booking");
    expect(decision.reply).not.toContain("staged for your review");
    // logProjectActivity's zyra_chat_ai_failed / routing_salvaged entry actually fired
    // (INSERT INTO audit_logs — logProjectActivity's real table — with the action name in $3).
    const activityCalls = dbQuery.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO audit_logs") && Array.isArray(call[1]) && call[1][2] === "zyra_chat_ai_failed"
    );
    expect(activityCalls.length).toBeGreaterThan(0);
  });

  it("does not retry at all when the router response parses cleanly the first time", async () => {
    const { svc } = makeLegacy();
    fetchSpy.mockResolvedValueOnce(openAiCompletion(CLEAN_ANSWER_RESPONSE) as never);

    const decision = await (svc as unknown as { buildZyraChatDecision: (...args: unknown[]) => Promise<{ reply: string; actionType: string }> })
      .buildZyraChatDecision("project-1", "user-1", "session-1", "how many login test cases exist?");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(decision.reply).toBe("There are 12 login test cases already covering this flow.");
  });

  it("does not retry when the model's own clean JSON happens to contain a field named 'salvaged'", async () => {
    // Guards the __salvaged rename: a bare "salvaged" key is not our internal marker, so a model
    // that (implausibly, but not impossibly) emits one in an otherwise well-formed answer must not
    // trip the retry/honesty path meant only for genuinely lost decision fields.
    const { svc } = makeLegacy();
    const cleanWithDecoyField = JSON.stringify({
      reply: "There are 12 login test cases already covering this flow.",
      reasoningSummary: "Matched 12 existing cases.",
      action: "answer",
      actionType: "answer",
      operations: [],
      testcases: [],
      salvaged: true
    });
    fetchSpy.mockResolvedValueOnce(openAiCompletion(cleanWithDecoyField) as never);

    const decision = await (svc as unknown as { buildZyraChatDecision: (...args: unknown[]) => Promise<{ reply: string; __salvaged?: boolean }> })
      .buildZyraChatDecision("project-1", "user-1", "session-1", "how many login test cases exist?");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(decision.__salvaged).toBeFalsy();
    expect(decision.reply).toBe("There are 12 login test cases already covering this flow.");
  });
});
