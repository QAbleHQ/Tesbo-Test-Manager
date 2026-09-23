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
import { RequestCacheService } from "../request-cache/request-cache.service";
import { ProjectLookupService } from "../request-cache/project-lookup.service";
import type { KbExtractionRunnerService } from "./kb-extraction-runner.service";
import { SuitesCacheService } from "../cache/suites-cache.service";
import { TestcasesListCacheService } from "../cache/testcases-list-cache.service";
import { ProjectOverviewCacheService } from "../cache/project-overview-cache.service";
import type Redis from "ioredis";

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/*
 * Feature #4 wiring: generateZyraChatTestcasesWithAi()'s per-draft semantic similarity check
 * (RagRetrievalService.findSimilarTestcases against TESTCASE_SIMILARITY_THRESHOLD) and the
 * bounded follow-up generation call it triggers when a match is found — see that function's own
 * comment in legacy.service.ts. The >= threshold comparison itself is covered in
 * rag/rag-retrieval.service.spec.ts (that's where it actually lives); this file covers the
 * wiring — does a match reach the drafting call's own `feedback`, and does "no match" leave the
 * create path unchanged (exactly one generation call, same as before this feature).
 */

type Body = Record<string, any>;

function makeLegacy(findSimilarTestcases: jest.Mock, dbQuery: jest.Mock): LegacyService {
  const db = { query: dbQuery } as unknown as DatabaseService;
  const ragRetrieval = { findSimilarTestcases } as unknown as RagRetrievalService;
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
    ragRetrieval,
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

// Every mock here first has to answer zyraSimilarityFeedbackForDrafts' own early-exit probe
// (`SELECT EXISTS(... FROM testcase_embeddings ...)`) before anything else runs — hasEmbeddings
// controls that. `testcaseRow`, when given, answers the title lookup for a draft that's expected
// to match. Every other query (rememberZyraTurn's AI-memory folder/document lookups, run
// regardless as part of generateZyraChatTestcasesWithAi's normal end-of-turn bookkeeping) gets an
// empty result, keeping rememberZyraMemory on its early-return ("no AI Memory folder") branch
// instead of tripping over a row shaped for a different table entirely.
function makeDbQuery(hasEmbeddings: boolean, testcaseRow?: { id: string; external_id: string; title: string }): jest.Mock {
  return jest.fn((sql: string) => {
    if (String(sql).includes("EXISTS") && String(sql).includes("testcase_embeddings")) {
      return Promise.resolve({ rows: [{ exists: hasEmbeddings }] });
    }
    if (testcaseRow && String(sql).includes("FROM testcases")) {
      return Promise.resolve({ rows: [testcaseRow] });
    }
    return Promise.resolve({ rows: [] });
  });
}

type SimilarityMatch = { testcaseId: string; cosineSimilarity: number } | null;

type Internals = {
  zyraSimilarityFeedbackForDrafts: (
    projectId: string,
    drafts: Body[]
  ) => Promise<{ feedback: string | null; matchesByIndex: SimilarityMatch[] }>;
  generateZyraChatTestcasesWithAi: (params: Body) => Promise<{ reply: string; testcases: Body[]; operations: Body[] }>;
};

function internals(svc: LegacyService): Internals {
  return svc as unknown as Internals;
}

function fetchJsonResponse(drafts: Body[], usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }) {
  return {
    ok: true,
    headers: { get: () => null },
    json: () =>
      Promise.resolve({
        choices: [{ message: { content: JSON.stringify({ drafts }) } }],
        usage
      })
  };
}

const baseGenerateParams: Body = {
  projectId: "p1",
  userId: "u1",
  provider: "openai",
  model: "gpt-4o-mini",
  key: { api_key: "sk-test", provider: "openai" },
  message: "generate login test cases",
  knowledge: [],
  existingTestcases: [],
  jiraIssueKeys: [],
  requestedCount: 1,
  suites: [],
  jira: [],
  bugs: []
};

describe("zyraSimilarityFeedbackForDrafts — zero-embeddings early exit", () => {
  it("skips the check entirely (findSimilarTestcases never called) when the project has zero embedded test cases", async () => {
    const findSimilarTestcases = jest.fn().mockResolvedValue({ matches: [{ testcaseId: "tc-1", cosineSimilarity: 0.99 }], semanticSearchRan: true, reason: "" });
    const svc = makeLegacy(findSimilarTestcases, makeDbQuery(false));

    const { feedback, matchesByIndex } = await internals(svc).zyraSimilarityFeedbackForDrafts("p1", [{ title: "Anything", expectedSummary: "..." }]);

    expect(feedback).toBeNull();
    expect(matchesByIndex).toEqual([null]);
    // findSimilarTestcases is mocked to report a match here specifically to prove the early exit
    // is what produced `null` — not a coincidental "no match found" outcome.
    expect(findSimilarTestcases).not.toHaveBeenCalled();
  });

  it("still runs the check (findSimilarTestcases is called) when the project has at least one embedded test case", async () => {
    const findSimilarTestcases = jest.fn().mockResolvedValue({ matches: [], semanticSearchRan: true, reason: "" });
    const svc = makeLegacy(findSimilarTestcases, makeDbQuery(true));

    await internals(svc).zyraSimilarityFeedbackForDrafts("p1", [{ title: "Anything", expectedSummary: "..." }]);

    expect(findSimilarTestcases).toHaveBeenCalledTimes(1);
  });
});

describe("zyraSimilarityFeedbackForDrafts — building the surfaced-match note", () => {
  it("returns null feedback and all-null matches when nothing in the batch has a match", async () => {
    const findSimilarTestcases = jest.fn().mockResolvedValue({ matches: [], semanticSearchRan: true, reason: "" });
    const svc = makeLegacy(findSimilarTestcases, makeDbQuery(true));

    const { feedback, matchesByIndex } = await internals(svc).zyraSimilarityFeedbackForDrafts("p1", [{ title: "A brand-new scenario", expectedSummary: "..." }]);
    expect(feedback).toBeNull();
    expect(matchesByIndex).toEqual([null]);
  });

  it("surfaces the matched test case's external id, title, and similarity score for a draft that matches", async () => {
    const findSimilarTestcases = jest.fn().mockResolvedValue({ matches: [{ testcaseId: "tc-1", cosineSimilarity: 0.91 }], semanticSearchRan: true, reason: "" });
    const svc = makeLegacy(findSimilarTestcases, makeDbQuery(true, { id: "tc-1", external_id: "EAD-12", title: "Session expiry blocks login" }));

    const { feedback, matchesByIndex } = await internals(svc).zyraSimilarityFeedbackForDrafts("p1", [{ title: "Login rejects an expired session", expectedSummary: "..." }]);
    expect(feedback).toContain("EAD-12");
    expect(feedback).toContain("Session expiry blocks login");
    expect(feedback).toContain("0.91");
    expect(feedback).toContain("Login rejects an expired session");
    expect(matchesByIndex).toEqual([{ testcaseId: "tc-1", cosineSimilarity: 0.91 }]);
  });

  it("returns the match in matchesByIndex even when it also clears the update threshold — the redirect decision itself lives in the caller, not here", async () => {
    const findSimilarTestcases = jest.fn().mockResolvedValue({ matches: [{ testcaseId: "tc-1", cosineSimilarity: 0.97 }], semanticSearchRan: true, reason: "" });
    const svc = makeLegacy(findSimilarTestcases, makeDbQuery(true, { id: "tc-1", external_id: "EAD-12", title: "Session expiry blocks login" }));

    const { feedback, matchesByIndex } = await internals(svc).zyraSimilarityFeedbackForDrafts("p1", [{ title: "Login rejects an expired session", expectedSummary: "..." }]);
    // Still just a surfaced signal at this layer — same advisory feedback text as any other match.
    expect(feedback).toContain("EAD-12");
    expect(matchesByIndex).toEqual([{ testcaseId: "tc-1", cosineSimilarity: 0.97 }]);
  });

  it("only surfaces the drafts that actually matched, out of a mixed batch", async () => {
    const findSimilarTestcases = jest
      .fn()
      .mockResolvedValueOnce({ matches: [{ testcaseId: "tc-1", cosineSimilarity: 0.9 }], semanticSearchRan: true, reason: "" })
      .mockResolvedValueOnce({ matches: [], semanticSearchRan: true, reason: "" });
    const svc = makeLegacy(findSimilarTestcases, makeDbQuery(true, { id: "tc-1", external_id: "EAD-12", title: "Session expiry blocks login" }));

    const { feedback, matchesByIndex } = await internals(svc).zyraSimilarityFeedbackForDrafts("p1", [
      { title: "Matches something", expectedSummary: "..." },
      { title: "Genuinely new", expectedSummary: "..." }
    ]);
    expect(feedback).toContain("Matches something");
    expect(feedback).not.toContain("Genuinely new");
    expect(matchesByIndex).toEqual([{ testcaseId: "tc-1", cosineSimilarity: 0.9 }, null]);
  });

  it("never throws — a failure in the similarity check itself just skips the pass", async () => {
    const findSimilarTestcases = jest.fn().mockRejectedValue(new Error("embeddings provider unreachable"));
    const svc = makeLegacy(findSimilarTestcases, makeDbQuery(true));

    const { feedback, matchesByIndex } = await internals(svc).zyraSimilarityFeedbackForDrafts("p1", [{ title: "X", expectedSummary: "Y" }]);
    expect(feedback).toBeNull();
    expect(matchesByIndex).toEqual([null]);
  });

  it("never throws — a failure in the early-exit EXISTS probe itself also just skips the pass", async () => {
    const findSimilarTestcases = jest.fn().mockResolvedValue({ matches: [{ testcaseId: "tc-1", cosineSimilarity: 0.99 }], semanticSearchRan: true, reason: "" });
    const svc = makeLegacy(findSimilarTestcases, jest.fn().mockRejectedValue(new Error("db unavailable")));

    const { feedback, matchesByIndex } = await internals(svc).zyraSimilarityFeedbackForDrafts("p1", [{ title: "X", expectedSummary: "Y" }]);
    expect(feedback).toBeNull();
    expect(matchesByIndex).toEqual([null]);
  });
});

describe("generateZyraChatTestcasesWithAi — create-path wiring", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("a project with zero embedded test cases skips the check entirely — exactly one drafting call, findSimilarTestcases never called", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(fetchJsonResponse([{ title: "Brand-new scenario", stepsJson: "[]" }]))
      .mockResolvedValue(fetchJsonResponse([])); // rememberZyraTurn's memory-summarization call
    global.fetch = fetchMock as unknown as typeof fetch;

    const findSimilarTestcases = jest.fn().mockResolvedValue({ matches: [{ testcaseId: "tc-1", cosineSimilarity: 0.99 }], semanticSearchRan: true, reason: "" });
    const svc = makeLegacy(findSimilarTestcases, makeDbQuery(false));

    const decision = await internals(svc).generateZyraChatTestcasesWithAi(baseGenerateParams);

    expect(findSimilarTestcases).not.toHaveBeenCalled();
    expect(decision.testcases.map((tc) => tc.title)).toEqual(["Brand-new scenario"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a candidate with no similarity match proceeds as a normal create, unchanged — exactly one drafting call", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(fetchJsonResponse([{ title: "Brand-new scenario", stepsJson: "[]" }]))
      .mockResolvedValue(fetchJsonResponse([])); // rememberZyraTurn's memory-summarization call
    global.fetch = fetchMock as unknown as typeof fetch;

    const findSimilarTestcases = jest.fn().mockResolvedValue({ matches: [], semanticSearchRan: true, reason: "" });
    const svc = makeLegacy(findSimilarTestcases, makeDbQuery(true));

    const decision = await internals(svc).generateZyraChatTestcasesWithAi(baseGenerateParams);

    expect(findSimilarTestcases).toHaveBeenCalledTimes(1);
    expect(decision.testcases.map((tc) => tc.title)).toEqual(["Brand-new scenario"]);
    expect(decision.operations[0].type).toBe("create");
    // 1 drafting call + 1 memory-summarization call — never a second drafting/revision call.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a candidate with a similarity match gets the match surfaced in the follow-up call's context, and the final result reflects the revision", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(fetchJsonResponse([{ title: "Login rejects an expired session", stepsJson: "[]" }]))
      .mockResolvedValueOnce(fetchJsonResponse([{ title: "Login rejects an expired session (differentiated from EAD-12)", stepsJson: "[]" }]))
      .mockResolvedValue(fetchJsonResponse([])); // rememberZyraTurn's memory-summarization call
    global.fetch = fetchMock as unknown as typeof fetch;

    const findSimilarTestcases = jest.fn().mockResolvedValue({ matches: [{ testcaseId: "tc-1", cosineSimilarity: 0.91 }], semanticSearchRan: true, reason: "" });
    const svc = makeLegacy(findSimilarTestcases, makeDbQuery(true, { id: "tc-1", external_id: "EAD-12", title: "Session expiry blocks login" }));

    const decision = await internals(svc).generateZyraChatTestcasesWithAi(baseGenerateParams);

    // drafting call + revision call + memory-summarization call
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const revisionCallBody = String((fetchMock.mock.calls[1] as unknown as [string, { body?: string }])[1]?.body || "");
    expect(revisionCallBody).toContain("EAD-12");
    expect(revisionCallBody).toContain("Session expiry blocks login");
    expect(revisionCallBody).toContain("0.91");

    // The final testcases/operations reflect the SECOND (revised) call's drafts, not the first —
    // proving the surfaced match actually reached and influenced the drafting decision.
    expect(decision.testcases.map((tc) => tc.title)).toEqual(["Login rejects an expired session (differentiated from EAD-12)"]);
    expect(decision.operations[0].draft.title).toBe("Login rejects an expired session (differentiated from EAD-12)");
  });

  it("a match between the two thresholds (advisory only) stays a 'create' operation — unchanged existing behavior", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(fetchJsonResponse([{ title: "Login rejects an expired session", stepsJson: "[]" }]))
      .mockResolvedValueOnce(fetchJsonResponse([{ title: "Login rejects an expired session", stepsJson: "[]" }]))
      .mockResolvedValue(fetchJsonResponse([]));
    global.fetch = fetchMock as unknown as typeof fetch;

    // 0.90 clears TESTCASE_SIMILARITY_THRESHOLD (0.86) but not TESTCASE_UPDATE_THRESHOLD (0.95).
    const findSimilarTestcases = jest.fn().mockResolvedValue({ matches: [{ testcaseId: "tc-1", cosineSimilarity: 0.9 }], semanticSearchRan: true, reason: "" });
    const svc = makeLegacy(findSimilarTestcases, makeDbQuery(true, { id: "tc-1", external_id: "EAD-12", title: "Session expiry blocks login" }));

    const decision = await internals(svc).generateZyraChatTestcasesWithAi(baseGenerateParams);
    expect(decision.operations[0].type).toBe("create");
    expect(decision.operations[0].draft).toBeDefined();
  });

  it("a match AT the update threshold (>=, not >) is redirected to 'update', targeting the matched test case's real id, with the (revised) drafted content as the payload", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(fetchJsonResponse([{ title: "Login rejects an expired session", stepsJson: "[]" }]))
      .mockResolvedValueOnce(
        fetchJsonResponse([{ title: "Login rejects an expired session", expectedSummary: "Session is invalidated", stepsJson: "[]", preconditions: "User was logged in", priority: "P1" }])
      )
      .mockResolvedValue(fetchJsonResponse([]));
    global.fetch = fetchMock as unknown as typeof fetch;

    const findSimilarTestcases = jest.fn().mockResolvedValue({ matches: [{ testcaseId: "tc-1", cosineSimilarity: 0.95 }], semanticSearchRan: true, reason: "" });
    const svc = makeLegacy(findSimilarTestcases, makeDbQuery(true, { id: "tc-1", external_id: "EAD-12", title: "Session expiry blocks login" }));

    const decision = await internals(svc).generateZyraChatTestcasesWithAi(baseGenerateParams);

    expect(decision.operations).toHaveLength(1);
    const op = decision.operations[0];
    expect(op.type).toBe("update");
    expect(op.testcaseId).toBe("tc-1");
    expect(op.draft).toBeUndefined();
    // Payload is the FINAL (revised, from the second fetch call) drafted content, not the original.
    expect(op.fields).toMatchObject({
      title: "Login rejects an expired session",
      description: "Session is invalidated",
      preconditions: "User was logged in",
      priority: "P1"
    });
    // Never a fresh row's defaults, and never a status reset — see the operations-mapping comment.
    expect(op.fields.status).toBeUndefined();
    expect(op.fields.suiteId).toBeUndefined();
  });

  it("a match just below the update threshold stays a 'create' operation — the boundary is exclusive on the low side", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(fetchJsonResponse([{ title: "Login rejects an expired session", stepsJson: "[]" }]))
      .mockResolvedValueOnce(fetchJsonResponse([{ title: "Login rejects an expired session", stepsJson: "[]" }]))
      .mockResolvedValue(fetchJsonResponse([]));
    global.fetch = fetchMock as unknown as typeof fetch;

    const findSimilarTestcases = jest.fn().mockResolvedValue({ matches: [{ testcaseId: "tc-1", cosineSimilarity: 0.949 }], semanticSearchRan: true, reason: "" });
    const svc = makeLegacy(findSimilarTestcases, makeDbQuery(true, { id: "tc-1", external_id: "EAD-12", title: "Session expiry blocks login" }));

    const decision = await internals(svc).generateZyraChatTestcasesWithAi(baseGenerateParams);
    expect(decision.operations[0].type).toBe("create");
  });

  it("a match well above the update threshold is also redirected to 'update'", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(fetchJsonResponse([{ title: "Login rejects an expired session", stepsJson: "[]" }]))
      .mockResolvedValueOnce(fetchJsonResponse([{ title: "Login rejects an expired session", stepsJson: "[]" }]))
      .mockResolvedValue(fetchJsonResponse([]));
    global.fetch = fetchMock as unknown as typeof fetch;

    const findSimilarTestcases = jest.fn().mockResolvedValue({ matches: [{ testcaseId: "tc-1", cosineSimilarity: 0.99 }], semanticSearchRan: true, reason: "" });
    const svc = makeLegacy(findSimilarTestcases, makeDbQuery(true, { id: "tc-1", external_id: "EAD-12", title: "Session expiry blocks login" }));

    const decision = await internals(svc).generateZyraChatTestcasesWithAi(baseGenerateParams);
    expect(decision.operations[0].type).toBe("update");
    expect(decision.operations[0].testcaseId).toBe("tc-1");
  });

  it("an update-redirected operation stages via applyZyraChatOperations exactly like a normal update — proposed-update, real target row, nothing written yet", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(fetchJsonResponse([{ title: "Login rejects an expired session", stepsJson: "[]" }]))
      .mockResolvedValueOnce(fetchJsonResponse([{ title: "Login rejects an expired session (revised)", stepsJson: "[]" }]))
      .mockResolvedValue(fetchJsonResponse([]));
    global.fetch = fetchMock as unknown as typeof fetch;

    const findSimilarTestcases = jest.fn().mockResolvedValue({ matches: [{ testcaseId: "tc-1", cosineSimilarity: 0.97 }], semanticSearchRan: true, reason: "" });
    const capabilities = { generation: true, knowledgeBase: true, testcaseStorage: true, suiteOperations: true };
    const dbQuery = jest.fn((sql: string) => {
      if (String(sql).includes("EXISTS") && String(sql).includes("testcase_embeddings")) return Promise.resolve({ rows: [{ exists: true }] });
      if (String(sql).includes("SELECT id, external_id, title FROM testcases")) return Promise.resolve({ rows: [{ id: "tc-1", external_id: "EAD-12", title: "Session expiry blocks login" }] });
      if (String(sql).includes("SELECT id FROM testcases")) return Promise.resolve({ rows: [{ id: "tc-1" }] }); // findProjectTestcase
      if (String(sql).includes("SELECT * FROM testcases")) return Promise.resolve({ rows: [{ id: "tc-1", external_id: "EAD-12", title: "Session expiry blocks login", status: "Approved" }] }); // getTestCase
      if (String(sql).includes("INSERT INTO ai_generation_requests")) return Promise.resolve({ rows: [{ id: "review-1" }] });
      return Promise.resolve({ rows: [] });
    });
    const svc = makeLegacy(findSimilarTestcases, dbQuery);
    jest.spyOn(svc as unknown as { zyraProjectCapabilities: (...a: unknown[]) => Promise<unknown> }, "zyraProjectCapabilities").mockResolvedValue(capabilities);
    jest.spyOn(svc as unknown as { resolveZyraActor: (...a: unknown[]) => Promise<unknown> }, "resolveZyraActor").mockResolvedValue("actor-1");

    const decision = await internals(svc).generateZyraChatTestcasesWithAi(baseGenerateParams);
    const applied = await (svc as unknown as { applyZyraChatOperations: (...a: unknown[]) => Promise<Body> }).applyZyraChatOperations(
      "p1",
      "u1",
      "session-1",
      decision.operations
    );

    expect(applied.testcases).toHaveLength(1);
    expect(applied.testcases[0].action).toBe("proposed-update");
    expect(applied.testcases[0].id).toBe("tc-1"); // the REAL existing id — this is an update, not a staged create
    // Nothing written directly: only a query mock exists for reads (SELECT ...) — an UPDATE/INSERT
    // against `testcases` here would either be missing from the mock (returning []) or, if it were
    // ever added, would be the thing this assertion is guarding against. The only actual write this
    // path performs is the batch's own ai_generation_requests staging row, handled by the caller
    // (zyraSave), not exercised here — see legacy.service.ts's own comment: "Staged only — the real
    // row is untouched until zyraSave applies `fields` to it."
    expect(dbQuery.mock.calls.some(([sql]) => /UPDATE\s+testcases\b/i.test(String(sql)))).toBe(false);
  });

  /*
   * Not a similarity-feedback test — reuses this file's generateZyraChatTestcasesWithAi ->
   * applyZyraChatOperations harness (the only place in the suite that already drives both
   * together) to cover a real gap the "surface techniques to reviewers" work found: a model's
   * `techniques` survives generateZyraChatTestcasesWithAi's own drafts array (spread verbatim
   * into `operations[].draft` — legacy.service.ts:~12184), but applyZyraChatOperations' create
   * branch used to rebuild `draftPayload` from op.draft with its own separate field allowlist
   * that did not include `techniques` — silently dropping it the moment a chat-confirmed create
   * was staged, even though chatDraftRow (the render function) was already fixed to show it. Both
   * had to be fixed together; this proves the write path, not just the render function in
   * isolation.
   */
  it("a plain create (no similarity redirect) keeps its techniques through applyZyraChatOperations — both the immediate preview and the persisted staging row", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fetchJsonResponse([
        { title: "Reject usernames over 64 characters", stepsJson: "[]", techniques: ["boundary_value_analysis", "error_guessing"] }
      ])
    ) as unknown as typeof fetch;

    const findSimilarTestcases = jest.fn();
    // No embedded test cases at all -> zyraSimilarityFeedbackForDrafts' own early exit, so
    // findSimilarTestcases is never called and this can never become an update-redirect.
    const dbQuery = jest.fn((sql: string, _params?: unknown[]) => {
      if (String(sql).includes("EXISTS") && String(sql).includes("testcase_embeddings")) return Promise.resolve({ rows: [{ exists: false }] });
      if (String(sql).includes("INSERT INTO ai_generation_requests")) return Promise.resolve({ rows: [{ id: "review-1" }] });
      return Promise.resolve({ rows: [] });
    });
    const svc = makeLegacy(findSimilarTestcases, dbQuery);
    jest.spyOn(svc as unknown as { zyraProjectCapabilities: (...a: unknown[]) => Promise<unknown> }, "zyraProjectCapabilities")
      .mockResolvedValue({ generation: true, knowledgeBase: true, testcaseStorage: true, suiteOperations: true });
    jest.spyOn(svc as unknown as { resolveZyraActor: (...a: unknown[]) => Promise<unknown> }, "resolveZyraActor").mockResolvedValue("actor-1");
    jest.spyOn(svc as unknown as { resolveOrCreateSuiteByName: (...a: unknown[]) => Promise<unknown> }, "resolveOrCreateSuiteByName")
      .mockResolvedValue({ id: "suite-1", name: "Zyra Drafts", created: false });
    jest.spyOn(svc as unknown as { recordZyraPendingReviewRequest: (...a: unknown[]) => Promise<unknown> }, "recordZyraPendingReviewRequest")
      .mockResolvedValue(undefined);

    const decision = await internals(svc).generateZyraChatTestcasesWithAi(baseGenerateParams);
    expect(decision.operations[0].type).toBe("create"); // confirms this test exercises the create branch, not a redirect
    expect((decision.operations[0] as Body).draft.techniques).toEqual(["boundary_value_analysis", "error_guessing"]); // survives generateZyraChatTestcasesWithAi's own mapping

    const applied = await (svc as unknown as { applyZyraChatOperations: (...a: unknown[]) => Promise<Body> }).applyZyraChatOperations(
      "p1",
      "u1",
      "session-1",
      decision.operations
    );

    expect(applied.testcases[0].techniques).toEqual(["boundary_value_analysis", "error_guessing"]);

    // The row actually persisted, not just the preview — proves draftPayload's own allowlist
    // (the deeper fix) carries techniques through to what a later re-read (formatAiTask) sees.
    const insertCall = dbQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO ai_generation_requests"));
    expect(insertCall).toBeTruthy();
    const insertParams = insertCall![1] as unknown[];
    const persistedPayload = JSON.parse(insertParams[4] as string); // $5 = generated_payload
    expect(persistedPayload[0].draft.techniques).toEqual(["boundary_value_analysis", "error_guessing"]);
  });

  it("a plain create with no techniques at all (an older-shaped draft) stages and renders an empty array, not a crash", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fetchJsonResponse([{ title: "Untagged case", stepsJson: "[]" }])
    ) as unknown as typeof fetch;

    const findSimilarTestcases = jest.fn();
    const dbQuery = jest.fn((sql: string) => {
      if (String(sql).includes("EXISTS") && String(sql).includes("testcase_embeddings")) return Promise.resolve({ rows: [{ exists: false }] });
      if (String(sql).includes("INSERT INTO ai_generation_requests")) return Promise.resolve({ rows: [{ id: "review-2" }] });
      return Promise.resolve({ rows: [] });
    });
    const svc = makeLegacy(findSimilarTestcases, dbQuery);
    jest.spyOn(svc as unknown as { zyraProjectCapabilities: (...a: unknown[]) => Promise<unknown> }, "zyraProjectCapabilities")
      .mockResolvedValue({ generation: true, knowledgeBase: true, testcaseStorage: true, suiteOperations: true });
    jest.spyOn(svc as unknown as { resolveZyraActor: (...a: unknown[]) => Promise<unknown> }, "resolveZyraActor").mockResolvedValue("actor-1");
    jest.spyOn(svc as unknown as { resolveOrCreateSuiteByName: (...a: unknown[]) => Promise<unknown> }, "resolveOrCreateSuiteByName")
      .mockResolvedValue({ id: "suite-1", name: "Zyra Drafts", created: false });
    jest.spyOn(svc as unknown as { recordZyraPendingReviewRequest: (...a: unknown[]) => Promise<unknown> }, "recordZyraPendingReviewRequest")
      .mockResolvedValue(undefined);

    const decision = await internals(svc).generateZyraChatTestcasesWithAi(baseGenerateParams);
    // normalizeZyraTechniques already defaulted this to ["general"] at generation time (feature
    // #5's own contract) — not re-tested here, this test is about what happens downstream of it.
    expect((decision.operations[0] as Body).draft.techniques).toEqual(["general"]);

    const applied = await (svc as unknown as { applyZyraChatOperations: (...a: unknown[]) => Promise<Body> }).applyZyraChatOperations(
      "p1",
      "u1",
      "session-1",
      decision.operations
    );

    expect(applied.testcases[0].techniques).toEqual(["general"]);
  });
});
