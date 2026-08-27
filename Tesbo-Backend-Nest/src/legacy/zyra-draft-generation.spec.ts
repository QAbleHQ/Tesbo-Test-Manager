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

function makeLegacy(): LegacyService {
  return new LegacyService(
    { query: jest.fn(() => Promise.resolve({ rows: [] })) } as unknown as DatabaseService,
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

type DraftOut = { title: string; preconditions: string; stepsJson: string; expectedSummary: string; priority: string; tags: string[] };

// normalizeAiDrafts is private implementation detail — reached here directly for the same
// reason as zyra-response-parsing.spec.ts: this is a text-in/text-out contract test against the
// exact malformed shapes a model has been observed to emit, with no provider round trip.
type Internals = {
  normalizeAiDrafts: (raw: unknown, requestedCount: number) => DraftOut[];
};

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
