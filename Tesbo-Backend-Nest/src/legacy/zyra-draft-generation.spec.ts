import { Logger } from "@nestjs/common";
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

type DraftOut = { title: string; preconditions: string; stepsJson: string; expectedSummary: string; priority: string; tags: string[]; techniques: string[] };

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
  normalizeZyraTechniques: (raw: unknown) => string[];
  zyraSystemPrompt: () => string;
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
  zyraGenerateTimeoutMs: (requestedCount: number) => number;
  zyraGatedBacklogMeta: (enabled: boolean, items: Array<Record<string, unknown>>, disabledReason: string) => Record<string, unknown>;
  dedupeZyraKnowledgeItems: <T extends { title: string; citation?: { sourceId?: string } }>(items: T[]) => T[];
  tallyZyraOperationTypes: (operations: Array<{ type: string }>) => Record<string, number>;
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

/*
 * Investigation (ZYRA_IMPLEMENTATION_LOG.md, "does the actual Zyra generation prompt implement
 * §5–§9's test-design technique pipeline?") found the real prompt named only 2 of 8 techniques,
 * as bare keywords with no method guidance, and that `tags` was a free-form field the model was
 * never instructed to use for technique attribution at all. zyraSystemPrompt() now names and
 * gives concrete guidance for all eight (ZYRA_TICKET_WORKFLOW.md §6/§8) and instructs a new
 * `techniques` field. These tests pin that the exact guidance text reaches the real outgoing
 * request body for BOTH providers (not just that the source string contains it) — the prompt is
 * plumbed through generateZyraWithOpenAi's messages array and generateZyraWithAnthropic's system
 * block differently, so asserting on zyraSystemPrompt()'s return value alone wouldn't prove either
 * provider actually receives it.
 */
describe("Zyra generation prompt — test design technique guidance reaches both providers", () => {
  let svc: LegacyService;
  const originalFetch = global.fetch;
  const TECHNIQUE_NAMES = [
    "Equivalence Partitioning",
    "Boundary Value Analysis",
    "Decision Table Testing",
    "State Testing",
    "Use Case Testing",
    "Pairwise Testing",
    "Error Guessing",
    "Security Perspective"
  ];
  const TECHNIQUE_SLUGS = [
    "equivalence_partitioning",
    "boundary_value_analysis",
    "decision_table",
    "state_testing",
    "use_case_testing",
    "pairwise_testing",
    "error_guessing",
    "security_perspective",
    "general"
  ];

  beforeEach(() => {
    svc = makeLegacy();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("zyraSystemPrompt() itself names all eight techniques with concrete, per-technique guidance, not a bare keyword list", () => {
    const prompt = internals(svc).zyraSystemPrompt();
    for (const name of TECHNIQUE_NAMES) {
      if (!prompt.includes(name)) throw new Error(`missing technique name: ${name}`);
    }
    // "concrete guidance" — not just the name, a description of what applying it actually means.
    expect(prompt).toMatch(/valid and invalid classes/i); // Equivalence Partitioning
    expect(prompt).toMatch(/min-1, min, min\+1, max-1, max, max\+1/); // Boundary Value Analysis
    expect(prompt).toMatch(/combinations as rows/i); // Decision Table Testing
    expect(prompt).toMatch(/valid transition/i); // State Testing
    expect(prompt).toMatch(/alternate or exception flow/i); // Use Case Testing
    expect(prompt).toMatch(/every pair of dimension values/i); // Pairwise Testing
    expect(prompt).toMatch(/double-submit|empty\/null state/i); // Error Guessing
    expect(prompt).toMatch(/auth\/authorization boundaries/i); // Security Perspective
    // The old one-sentence, two-of-eight version is fully replaced, not left alongside the new one.
    expect(prompt).not.toContain("Prioritize edge cases, boundary values, negative paths, permissions, data integrity, state transitions, and traceability.");
  });

  it("zyraSystemPrompt() instructs the model to tag every draft's techniques from the exact fixed set", () => {
    const prompt = internals(svc).zyraSystemPrompt();
    expect(prompt).toContain('"techniques":[""]');
    for (const slug of TECHNIQUE_SLUGS) {
      if (!prompt.includes(slug)) throw new Error(`missing technique slug: ${slug}`);
    }
  });

  it("OpenAI: the system message actually sent to the provider carries the technique guidance", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      json: () => Promise.resolve({
        choices: [{ message: { content: JSON.stringify({ drafts: [{ title: "x", stepsJson: "[]" }] }) } }],
        usage: {}
      })
    }) as unknown as typeof fetch;

    await internals(svc).generateZyraWithOpenAi({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test", projectId: "p1", input: emptyInput() });

    const fetchMock = global.fetch as jest.Mock;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const systemMessage = sentBody.messages.find((m: { role: string }) => m.role === "system").content;
    for (const name of TECHNIQUE_NAMES) {
      if (!systemMessage.includes(name)) throw new Error(`OpenAI system message missing: ${name}`);
    }
    expect(systemMessage).toContain('"techniques":[""]');
  });

  it("Anthropic: the system block actually sent to the provider carries the technique guidance", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      json: () => Promise.resolve({
        content: [{ type: "text", text: JSON.stringify({ drafts: [{ title: "x", stepsJson: "[]" }] }) }],
        usage: {}
      })
    }) as unknown as typeof fetch;

    await internals(svc).generateZyraWithAnthropic({ provider: "anthropic", model: "claude-sonnet", apiKey: "sk-test", projectId: "p1", input: emptyInput() });

    const fetchMock = global.fetch as jest.Mock;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const systemText = sentBody.system[0].text;
    for (const name of TECHNIQUE_NAMES) {
      if (!systemText.includes(name)) throw new Error(`Anthropic system block missing: ${name}`);
    }
    expect(systemText).toContain('"techniques":[""]');
  });

  it("both providers receive byte-identical technique guidance — enterprise consistency, not just the interactive path", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      json: () => Promise.resolve({
        choices: [{ message: { content: JSON.stringify({ drafts: [] }) } }],
        content: [{ type: "text", text: JSON.stringify({ drafts: [] }) }],
        usage: {}
      })
    }) as unknown as typeof fetch;

    await internals(svc).generateZyraWithOpenAi({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test", projectId: "p1", input: emptyInput() }).catch(() => undefined);
    const openAiSystem = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).messages.find((m: { role: string }) => m.role === "system").content;

    (global.fetch as jest.Mock).mockClear();
    await internals(svc).generateZyraWithAnthropic({ provider: "anthropic", model: "claude-sonnet", apiKey: "sk-test", projectId: "p1", input: emptyInput() }).catch(() => undefined);
    const anthropicSystem = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).system[0].text;

    // Anthropic's system block is `${zyraSystemPrompt()}\n\n${zyraStaticSourcePrompt()}` — the
    // technique guidance is the prefix, so it must appear byte-identical at the start of both.
    expect(anthropicSystem.startsWith(openAiSystem)).toBe(true);
  });
});

/*
 * normalizeZyraTechniques is the validation layer between the model's raw `techniques` output and
 * what a draft is actually tagged with — per the standing error-handling bar, tagging is an
 * enhancement, never a blocking requirement, so every malformed shape here must degrade to
 * ["general"] rather than throwing or silently corrupting the draft. Tested directly (isolated,
 * exhaustive edge cases) and once more through normalizeAiDrafts (proves it's actually wired into
 * the real per-draft normalization, not just callable on its own).
 */
describe("Zyra draft technique tagging — normalizeZyraTechniques", () => {
  let svc: LegacyService;

  beforeEach(() => {
    svc = makeLegacy();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("passes through a single recognized technique", () => {
    expect(internals(svc).normalizeZyraTechniques(["boundary_value_analysis"])).toEqual(["boundary_value_analysis"]);
  });

  it("keeps every recognized technique when a case genuinely combines several, deduped", () => {
    const result = internals(svc).normalizeZyraTechniques(["boundary_value_analysis", "state_testing", "boundary_value_analysis"]);
    expect(result).toEqual(["boundary_value_analysis", "state_testing"]);
  });

  it("drops an unrecognized entry but keeps the recognized ones alongside it, and logs the unrecognized one", () => {
    const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const result = internals(svc).normalizeZyraTechniques(["equivalence_partitioning", "made_up_technique"]);
    expect(result).toEqual(["equivalence_partitioning"]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("made_up_technique"));
  });

  it("falls back to general when every entry is unrecognized — never an empty array, never a throw", () => {
    const result = internals(svc).normalizeZyraTechniques(["invented_one", "invented_two"]);
    expect(result).toEqual(["general"]);
  });

  it("falls back to general when the field is missing entirely (undefined)", () => {
    expect(internals(svc).normalizeZyraTechniques(undefined)).toEqual(["general"]);
  });

  it("falls back to general when the field is an empty array", () => {
    expect(internals(svc).normalizeZyraTechniques([])).toEqual(["general"]);
  });

  it("falls back to general when the field is not an array at all (a lone string, a number, an object)", () => {
    expect(internals(svc).normalizeZyraTechniques("boundary_value_analysis")).toEqual(["general"]);
    expect(internals(svc).normalizeZyraTechniques(42)).toEqual(["general"]);
    expect(internals(svc).normalizeZyraTechniques({ technique: "boundary_value_analysis" })).toEqual(["general"]);
  });

  it("accepts an explicit general tag on its own", () => {
    expect(internals(svc).normalizeZyraTechniques(["general"])).toEqual(["general"]);
  });

  it("is case- and whitespace-tolerant, since a model is not guaranteed to echo the slug byte-exact", () => {
    expect(internals(svc).normalizeZyraTechniques([" Boundary_Value_Analysis  "])).toEqual(["boundary_value_analysis"]);
  });

  it("is wired into normalizeAiDrafts — the real per-draft normalization the model's response actually flows through", () => {
    const raw = JSON.stringify({
      drafts: [
        { title: "A boundary case", stepsJson: "[]", techniques: ["boundary_value_analysis"] },
        { title: "An untagged case", stepsJson: "[]" },
        { title: "A case with a bogus tag", stepsJson: "[]", techniques: ["not_a_real_technique"] }
      ]
    });
    const drafts = internals(svc).normalizeAiDrafts(raw, 10);
    expect(drafts[0].techniques).toEqual(["boundary_value_analysis"]);
    expect(drafts[1].techniques).toEqual(["general"]);
    expect(drafts[2].techniques).toEqual(["general"]);
  });

  // Edge case explicitly called out in the task: an older-format cached/stored draft with no
  // techniques field at all. Confirmed by trace (not assumed) that this is actually unreachable in
  // a live code path: normalizeAiDrafts only ever runs on a FRESH raw model response for a NEW
  // generation call (see generateZyraWithOpenAi/generateZyraWithAnthropic) — an already-persisted
  // ai_generation_requests.generated_payload row from before this change is never re-parsed
  // through normalizeAiDrafts on a later read; formatAiTask reads such a row's fields directly. So
  // there is no live path where a missing `techniques` field reaches this function via "old cached
  // data" rather than "a fresh model response that simply omitted it" — the same fallback handles
  // both identically regardless, which this test pins.
  it("a draft with no techniques field at all (old-format shape) falls back to general, not a throw", () => {
    const raw = JSON.stringify({ drafts: [{ title: "Pre-existing-shape draft", stepsJson: "[]" }] });
    const drafts = internals(svc).normalizeAiDrafts(raw, 10);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].techniques).toEqual(["general"]);
  });
});

/*
 * Basecamp: with the Zyra settings default changed from "1-10" to "30-50", generation started
 * timing out at the "generate" stage — the provider budget (zyraGenerateTimeoutMs, née the flat
 * ZYRA_GENERATE_TIMEOUT_MS constant) never scaled with how much was actually requested, so a
 * 40-testcase batch got the same 180s a 5-testcase batch did, even though it has to fill much
 * closer to the same max_tokens=16000 ceiling and so genuinely takes longer to finish.
 */
describe("Zyra generation timeout scales with how much was requested", () => {
  let svc: LegacyService;
  const originalFetch = global.fetch;

  beforeEach(() => {
    svc = makeLegacy();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("matches the old fixed 180s budget for a batch at or under the old default (10)", () => {
    expect(staticInternals().zyraGenerateTimeoutMs(1)).toBe(180_000);
    expect(staticInternals().zyraGenerateTimeoutMs(5)).toBe(180_000);
    expect(staticInternals().zyraGenerateTimeoutMs(10)).toBe(180_000);
  });

  it("grows for a larger batch and caps at 360s", () => {
    // 40 = the new "30-50" tier's requestedCount.
    expect(staticInternals().zyraGenerateTimeoutMs(40)).toBe(315_000);
    // 50 = the "all" tier's requestedCount — the point the new formula caps at.
    expect(staticInternals().zyraGenerateTimeoutMs(50)).toBe(360_000);
    // A malformed/oversized requestedCount must never demand an unbounded wait.
    expect(staticInternals().zyraGenerateTimeoutMs(999)).toBe(360_000);
  });

  it("OpenAI: a 40-testcase request gets a longer provider timeout than a 10-testcase one", async () => {
    const timeoutSpy = jest.spyOn(AbortSignal, "timeout");
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ drafts: [{ title: "x", stepsJson: "[]" }] }) } }], usage: {} })
    }) as unknown as typeof fetch;

    await internals(svc).generateZyraWithOpenAi({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test", projectId: "p1", input: { ...emptyInput(), requestedCount: 40 } });
    expect(timeoutSpy).toHaveBeenCalledWith(315_000);

    timeoutSpy.mockClear();
    await internals(svc).generateZyraWithOpenAi({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test", projectId: "p1", input: { ...emptyInput(), requestedCount: 10 } });
    expect(timeoutSpy).toHaveBeenCalledWith(180_000);
  });

  it("Anthropic: a 40-testcase request gets a longer provider timeout than a 10-testcase one", async () => {
    const timeoutSpy = jest.spyOn(AbortSignal, "timeout");
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      json: () => Promise.resolve({ content: [{ type: "text", text: JSON.stringify({ drafts: [{ title: "x", stepsJson: "[]" }] }) }], usage: {} })
    }) as unknown as typeof fetch;

    await internals(svc).generateZyraWithAnthropic({ provider: "anthropic", model: "claude-sonnet", apiKey: "sk-test", projectId: "p1", input: { ...emptyInput(), requestedCount: 40 } });
    expect(timeoutSpy).toHaveBeenCalledWith(315_000);

    timeoutSpy.mockClear();
    await internals(svc).generateZyraWithAnthropic({ provider: "anthropic", model: "claude-sonnet", apiKey: "sk-test", projectId: "p1", input: { ...emptyInput(), requestedCount: 10 } });
    expect(timeoutSpy).toHaveBeenCalledWith(180_000);
  });
});

/*
 * The live progress backlog: a capability-gated step must never report what was fetched when the
 * capability is off, even though the raw data already exists in memory — this is the accuracy
 * guarantee the whole feature is built around (Basecamp: "the data should be accurate"), pulled
 * out into its own pure function specifically so it has direct coverage independent of
 * buildZyraChatDecision's much larger surface.
 */
describe("Zyra chat progress backlog — accuracy-critical meta building", () => {
  it("reports items and a real count when the capability is on", () => {
    const meta = staticInternals().zyraGatedBacklogMeta(true, [{ title: "Login flow" }, { title: "Checkout API" }], "unused");
    expect(meta).toEqual({ items: [{ title: "Login flow" }, { title: "Checkout API" }], count: 2 });
  });

  it("never reports items or a count when the capability is off, regardless of what was fetched", () => {
    // The items array here stands in for real, already-fetched data (buildZyraChatDecision fetches
    // knowledge/bugs unconditionally, before capabilities are even known) — this must still be
    // fully suppressed, not just emptied, so the backlog step reads as "skipped", not "checked, 0
    // found".
    const meta = staticInternals().zyraGatedBacklogMeta(false, [{ title: "Login flow" }], "Knowledge base access is off for this project");
    expect(meta).toEqual({ skipped: true, reason: "Knowledge base access is off for this project" });
    expect(meta).not.toHaveProperty("items");
    expect(meta).not.toHaveProperty("count");
  });

  it("reports zero found, not skipped, when the capability is on but nothing matched", () => {
    const meta = staticInternals().zyraGatedBacklogMeta(true, [], "unused");
    expect(meta).toEqual({ items: [], count: 0 });
  });

  it("dedupes a knowledge item that reached both the folder match and RAG/recency fallback", () => {
    const items = [
      { title: "Login flow", citation: { sourceId: "doc-1" } },
      { title: "Checkout API", citation: { sourceId: "doc-2" } },
      { title: "Login flow", citation: { sourceId: "doc-1" } },
    ];
    expect(staticInternals().dedupeZyraKnowledgeItems(items)).toEqual([
      { title: "Login flow", citation: { sourceId: "doc-1" } },
      { title: "Checkout API", citation: { sourceId: "doc-2" } },
    ]);
  });

  it("falls back to title for dedup when a source id is missing (e.g. a recency-fallback doc)", () => {
    const items = [{ title: "Untitled note" }, { title: "Untitled note" }, { title: "Other note" }];
    expect(staticInternals().dedupeZyraKnowledgeItems(items)).toEqual([{ title: "Untitled note" }, { title: "Other note" }]);
  });

  it("tallies staged operations by type for the 'staging' step", () => {
    const counts = staticInternals().tallyZyraOperationTypes([
      { type: "create" }, { type: "create" }, { type: "move_to_suite" }, { type: "create" },
    ]);
    expect(counts).toEqual({ create: 3, move_to_suite: 1 });
  });

  it("tallies an empty operations array to an empty object, not a throw", () => {
    expect(staticInternals().tallyZyraOperationTypes([])).toEqual({});
  });
});
