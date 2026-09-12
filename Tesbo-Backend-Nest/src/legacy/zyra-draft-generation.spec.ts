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

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

function makeLegacy(): LegacyService {
  const db = { query: jest.fn(() => Promise.resolve({ rows: [] })) } as unknown as DatabaseService;
  const requestCache = new RequestCacheService({} as unknown as AppConfigService);
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
    {} as unknown as CustomFieldsService
  );
}

type DraftOut = { title: string; preconditions: string; stepsJson: string; expectedSummary: string; priority: string; tags: string[] };

type GenerationInput = {
  story: string; context: string; acceptanceCriteria: string; feedback: string;
  knowledge: Array<{ title: string; content: string }>;
  jira: Array<{ key: string; summary: string; description: string }>;
  linear: Array<{ key: string; summary: string; description: string }>;
  existingTestcases: Array<{ externalId: string; title: string; description: string; priority: string; status: string; stepsSummary: string }>;
  requestedCount: number;
  testcaseRange?: string;
};

// normalizeAiDrafts is private implementation detail — reached here directly for the same
// reason as zyra-response-parsing.spec.ts: this is a text-in/text-out contract test against the
// exact malformed shapes a model has been observed to emit, with no provider round trip.
type Internals = {
  normalizeAiDrafts: (raw: unknown, requestedCount: number) => DraftOut[];
  generateZyraWithOpenAi: (params: { provider: string; model: string; apiKey: string; projectId: string; input: GenerationInput }) => Promise<unknown>;
  generateZyraWithAnthropic: (params: { provider: string; model: string; apiKey: string; projectId: string; input: GenerationInput }) => Promise<unknown>;
  zyraDynamicTaskPrompt: (input: GenerationInput & { knowledgeConfidence?: "none" | "weak" | "strong" }) => string;
  generateZyraChatTestcasesWithAi: (params: {
    projectId: string;
    userId: string | null;
    provider: string;
    model: string;
    key: Body;
    message: string;
    knowledge: Array<{ title: string; content: string }>;
    existingTestcases: GenerationInput["existingTestcases"];
    jiraIssueKeys: string[];
    requestedCount: number;
    suites: Array<{ id: string; name: string }>;
    jira?: Array<{ key: string; summary: string; description: string }>;
    bugs?: unknown[];
    knowledgeConfidence?: "none" | "weak" | "strong";
  }) => Promise<{ reply: string }>;
};

type Body = Record<string, unknown>;

type StaticInternals = {
  zyraUngroundedNote: (count: number) => string;
  zyraWeakGroundingNote: (count: number) => string;
};

function staticInternals(): StaticInternals {
  return LegacyService as unknown as StaticInternals;
}

const emptyInput = (): GenerationInput => ({
  story: "As a user I want to sign in",
  context: "",
  acceptanceCriteria: "",
  feedback: "",
  knowledge: [],
  jira: [],
  linear: [],
  existingTestcases: [],
  requestedCount: 5
});

function internals(svc: LegacyService): Internals {
  return svc as unknown as Internals;
}

describe("Zyra testcase draft generation — malformed model output", () => {
  let svc: LegacyService;

  beforeEach(() => {
    svc = makeLegacy();
  });

  it("parses a well-formed drafts envelope unchanged", () => {
    const raw = JSON.stringify({
      drafts: [
        { title: "Search returns matches", preconditions: "Posts exist", stepsJson: "[]", expectedSummary: "Results shown", priority: "P1", tags: ["search"] }
      ]
    });
    const drafts = internals(svc).normalizeAiDrafts(raw, 10);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].title).toBe("Search returns matches");
  });

  // The bug: "Same story and generation process were used twice. The first attempt resulted in
  // Generation Failed, while the second attempt successfully generated the test cases." LLM
  // output is non-deterministic, so the same story can occasionally come back with one
  // unescaped quote inside a long field — this is the exact break already documented on
  // repairLooseJson for the chat-reply path, reproduced here for the draft-generation path.
  it("recovers drafts when a field contains an unescaped quote (fails before the fix, passes after)", () => {
    const raw = '{"drafts":[{"title":"Search highlights the "remember me" filter","preconditions":"none","stepsJson":"[]","expectedSummary":"ok","priority":"P1","tags":["search"]}]}';
    expect(() => JSON.parse(raw)).toThrow(); // confirms this is genuinely malformed, not a test bug
    const drafts = internals(svc).normalizeAiDrafts(raw, 10);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].title).toContain('"remember me"');
  });

  it("recovers drafts when a field contains a literal newline", () => {
    const raw = '{"drafts":[{"title":"Multi-line\nexpected result","preconditions":"none","stepsJson":"[]","expectedSummary":"ok","priority":"P1","tags":[]}]}';
    expect(() => JSON.parse(raw)).toThrow();
    const drafts = internals(svc).normalizeAiDrafts(raw, 10);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].title).toContain("Multi-line");
  });

  // A response cut short by the provider's token ceiling (e.g. Anthropic max_tokens) is not
  // fixable by re-escaping characters — the JSON is genuinely incomplete. The complete drafts
  // earlier in the array should still come back instead of the whole batch failing.
  it("salvages the complete leading drafts when the array is truncated mid-object", () => {
    const raw = '{"drafts":[' +
      '{"title":"First case","preconditions":"none","stepsJson":"[]","expectedSummary":"ok","priority":"P1","tags":[]},' +
      '{"title":"Second case","preconditions":"none","stepsJson":"[]","expectedSummary":"ok","priority":"P1","tags":[]},' +
      '{"title":"Third, cut off mid-o';
    expect(() => JSON.parse(raw)).toThrow();
    const drafts = internals(svc).normalizeAiDrafts(raw, 10);
    expect(drafts.map((d) => d.title)).toEqual(["First case", "Second case"]);
  });

  it("still throws when the output holds no recoverable draft at all", () => {
    // BadRequestException.message is the generic "Bad Request Exception" (see
    // extractAiErrorMessage's comment in legacy.service.ts) — the real reason is in getResponse().
    const errorOf = (fn: () => unknown): { error?: string } => {
      try {
        fn();
        throw new Error("expected fn() to throw");
      } catch (error) {
        return (error as { getResponse: () => { error?: string } }).getResponse();
      }
    };
    expect(errorOf(() => internals(svc).normalizeAiDrafts("Here is a plain answer with no JSON.", 10)).error)
      .toMatch(/no testcase drafts/i);
    expect(errorOf(() => internals(svc).normalizeAiDrafts("", 10)).error).toMatch(/no testcase drafts/i);
  });

  it("still respects requestedCount as a cap after recovery", () => {
    const raw = JSON.stringify({
      drafts: Array.from({ length: 5 }, (_, i) => ({ title: `Case ${i}`, stepsJson: "[]" }))
    });
    const drafts = internals(svc).normalizeAiDrafts(raw, 2);
    expect(drafts).toHaveLength(2);
  });
});

// A response with no recoverable draft (the previous describe block) is still a BILLED provider
// call — the tokens were spent before "still throws when the output holds no recoverable draft at
// all" fires. Without this, that usage silently vanished: it's exactly why 4 of the task-board's
// 'failed' rows in production carry token_total=0 despite a real provider call having happened
// (see recordZyraTokenUsage / the zyraUsage property on the thrown error in legacy.service.ts).
describe("Zyra provider call wrappers — usage survives a parse failure", () => {
  let svc: LegacyService;
  const originalFetch = global.fetch;

  beforeEach(() => {
    svc = makeLegacy();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("OpenAI: a billed response with no usable drafts still attaches usage to the thrown error", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: "Here is a plain answer with no JSON." } }],
        usage: { prompt_tokens: 800, completion_tokens: 50, total_tokens: 850 }
      })
    }) as unknown as typeof fetch;

    await expect(
      internals(svc).generateZyraWithOpenAi({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test", projectId: "p1", input: emptyInput() })
    ).rejects.toMatchObject({ zyraUsage: { input: 800, output: 50, total: 850 } });
  });

  it("Anthropic: a billed response with no usable drafts still attaches usage to the thrown error", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ type: "text", text: "Here is a plain answer with no JSON." }],
        usage: { input_tokens: 900, output_tokens: 60 }
      })
    }) as unknown as typeof fetch;

    await expect(
      internals(svc).generateZyraWithAnthropic({ provider: "anthropic", model: "claude-sonnet", apiKey: "sk-test", projectId: "p1", input: emptyInput() })
    ).rejects.toMatchObject({ zyraUsage: { input: 900, output: 60, total: 960 } });
  });

  it("OpenAI: a successful, parseable response is unaffected — usage still comes back on the result, not just on failure", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      json: () => Promise.resolve({
        choices: [{ message: { content: JSON.stringify({ drafts: [{ title: "Sign in works", stepsJson: "[]" }] }) } }],
        usage: { prompt_tokens: 400, completion_tokens: 120, total_tokens: 520 }
      })
    }) as unknown as typeof fetch;

    const result = await internals(svc).generateZyraWithOpenAi({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test", projectId: "p1", input: emptyInput() });
    expect(result).toMatchObject({ usage: { input: 400, output: 120, total: 520 } });
  });
});

/*
 * Phase 4 (RAG relevancy) coverage: "8 items" and "8 items, top score 0.31" used to be
 * indistinguishable both to the model (zyraDynamicTaskPrompt carried no confidence signal) and to
 * the user (the reply used identical "grounded" framing regardless of match quality). These test
 * the two places that changed: the extra prompt instruction told to the model, and the distinct
 * reply text (zyraWeakGroundingNote vs. zyraUngroundedNote) a viewer sees afterward.
 */
describe("Zyra generation prompt — knowledge confidence", () => {
  let svc: LegacyService;

  beforeEach(() => {
    svc = makeLegacy();
  });

  it("adds a hedging instruction when knowledge is only weakly related", () => {
    const prompt = internals(svc).zyraDynamicTaskPrompt({ ...emptyInput(), knowledge: [{ title: "Loosely related doc", content: "..." }], knowledgeConfidence: "weak" });
    expect(prompt).toMatch(/loose match|make their assumptions explicit/i);
  });

  it("tells the model to treat knowledge as ungrounded when present but below the relevance floor", () => {
    const prompt = internals(svc).zyraDynamicTaskPrompt({ ...emptyInput(), knowledge: [{ title: "Barely related doc", content: "..." }], knowledgeConfidence: "none" });
    expect(prompt).toMatch(/did not clear the relevance bar|general practice/i);
  });

  it("does not add either hedge when the match is confident — no unwanted noise on the regression case", () => {
    const prompt = internals(svc).zyraDynamicTaskPrompt({ ...emptyInput(), knowledge: [{ title: "Strongly related doc", content: "..." }], knowledgeConfidence: "strong" });
    expect(prompt).not.toMatch(/loose match|did not clear the relevance bar/i);
  });

  it("does not add either hedge when no confidence signal was ever resolved (an undefined caller, not a known-weak one)", () => {
    const prompt = internals(svc).zyraDynamicTaskPrompt({ ...emptyInput(), knowledge: [{ title: "Some doc", content: "..." }] });
    expect(prompt).not.toMatch(/loose match|did not clear the relevance bar/i);
  });

  it("does not add the 'ungrounded' hedge when there is simply no knowledge at all — that's zyraUngroundedNote's job, a separate reply path entirely", () => {
    const prompt = internals(svc).zyraDynamicTaskPrompt({ ...emptyInput(), knowledge: [], knowledgeConfidence: "none" });
    expect(prompt).not.toMatch(/did not clear the relevance bar/i);
  });

  it("zyraWeakGroundingNote is honest about a loose match, and distinct from zyraUngroundedNote's 'nothing found' wording", () => {
    const weak = staticInternals().zyraWeakGroundingNote(3);
    const none = staticInternals().zyraUngroundedNote(3);
    expect(weak).toMatch(/loosely matches|not a strong enough match/i);
    expect(weak).not.toContain("I don't have anything about this");
    expect(none).toContain("I don't have anything about this");
    expect(weak).not.toBe(none);
  });

  /*
   * Regression test for a real gap found by review, before this shipped: the reply-shaping logic in
   * generateZyraChatTestcasesWithAi originally only branched on knowledgeConfidence === "weak" — a
   * turn with knowledgeConfidence "none" but non-empty `knowledge` (FTS-only matches with no
   * embeddings key, or every semantic candidate below RAG_MIN_SIMILARITY — both real,
   * RagRetrievalService-confirmed states, not hypothetical) fell through to the fully-confident
   * groundedReply text, even though zyraDynamicTaskPrompt correctly told the MODEL to hedge for the
   * exact same case. The model wrote cautiously; the reply the user read still claimed confident
   * coverage. Drives the real function end to end (mocked fetch only) rather than re-deriving the
   * condition in isolation, so a future edit to the actual branch is what this test exercises.
   */
  it("uses the weak-grounding reply, not the confident one, when knowledge is present but confidence is 'none'", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      json: () => Promise.resolve({
        choices: [{ message: { content: JSON.stringify({ drafts: [{ title: "Sign in works", stepsJson: "[]" }] }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
      })
    }) as unknown as typeof fetch;

    const decision = await internals(svc).generateZyraChatTestcasesWithAi({
      projectId: "p1",
      userId: "u1",
      provider: "openai",
      model: "gpt-4o-mini",
      key: { api_key: "sk-test", provider: "openai" },
      message: "generate login test cases",
      knowledge: [{ title: "A loosely related doc found only by keyword", content: "..." }],
      existingTestcases: [],
      jiraIssueKeys: [],
      requestedCount: 1,
      suites: [],
      jira: [],
      bugs: [],
      knowledgeConfidence: "none"
    });

    expect(decision.reply).toMatch(/loosely matches|not a strong enough match/i);
    expect(decision.reply).not.toMatch(/I drafted 1 test case\(s\) after reading/);
  });

  it("regression: still uses the confident reply when knowledge is present and confidence is 'strong'", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      json: () => Promise.resolve({
        choices: [{ message: { content: JSON.stringify({ drafts: [{ title: "Sign in works", stepsJson: "[]" }] }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
      })
    }) as unknown as typeof fetch;

    const decision = await internals(svc).generateZyraChatTestcasesWithAi({
      projectId: "p1",
      userId: "u1",
      provider: "openai",
      model: "gpt-4o-mini",
      key: { api_key: "sk-test", provider: "openai" },
      message: "generate login test cases",
      knowledge: [{ title: "A strongly related doc", content: "..." }],
      existingTestcases: [],
      jiraIssueKeys: [],
      requestedCount: 1,
      suites: [],
      jira: [],
      bugs: [],
      knowledgeConfidence: "strong"
    });

    expect(decision.reply).toMatch(/I drafted 1 test case\(s\) after reading/);
    expect(decision.reply).not.toMatch(/loosely matches|not a strong enough match/i);
  });
});
