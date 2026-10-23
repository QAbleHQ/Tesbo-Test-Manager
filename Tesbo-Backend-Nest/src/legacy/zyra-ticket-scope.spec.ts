import { BadRequestException, ConflictException } from "@nestjs/common";
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
 * "[Zyra] Warn Users About the 100-Test-Case Limit When Generating for Multiple Tickets".
 *
 * A create naming many tickets was planned in one call capped at 100 scenarios for all of them, so
 * ~30 tickets came back as ~98 test cases and the reply said "all N scenarios are now covered". Above
 * an estimate of 60 (tickets × the project's per-task count) Zyra now asks first, with clickable
 * options; "all in batches" runs a plan that pages one ticket at a time and accounts for every ticket.
 */

type Body = Record<string, unknown>;
type Query = jest.Mock<Promise<{ rows: Body[] }>, [string, unknown[]?]>;

function makeLegacy(query: Query = jest.fn(() => Promise.resolve({ rows: [] })) as unknown as Query, extraDb: Partial<DatabaseService> = {}): LegacyService {
  const db = { query, ...extraDb } as unknown as DatabaseService;
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
    new SuitesCacheService({} as unknown as Redis, {} as unknown as AppConfigService),
    new TestcasesListCacheService({} as unknown as Redis, {} as unknown as AppConfigService),
    new ProjectOverviewCacheService({} as unknown as Redis, {} as unknown as AppConfigService),
    {} as unknown as CustomFieldsService,
    {} as unknown as CustomTagsService
  );
}

type Options = { kind: string; choices: Array<{ id: string; label: string; description?: string; message?: string }>; answeredId?: string | null; context?: Body };
type Decision = { reply: string; actionType: string; operations: unknown[]; options?: Options };
type Scope = { ticketKeys: string[] | null; ticketCount: number; perTicket: number; limit: number; unspecified: boolean } | null;

type Internals = {
  chatTestcasePlan: (message: string, range: string, routed?: Body) => { requestedCount: number; testcaseRange?: string };
  zyraTicketScope: (
    projectId: string,
    message: string,
    plan: { requestedCount: number; testcaseRange?: string },
    options: { projectTestcaseRange: string; knowledgeConfidence?: string; routedScope?: string; referencedKeys?: string[] }
  ) => Promise<Scope>;
  getProject: (projectId: string) => Promise<Body>;
  zyraTicketScopeQuestion: (message: string, scope: NonNullable<Scope>, exhaustive: boolean, routedSuite: Body | null) => Decision;
  zyraTicketSelectionPrompt: (projectId: string, context: Body, problem?: Body) => Promise<Decision>;
  zyraParseTicketSelection: (message: string) => { keys: string[]; oversizedRange?: { from: string; to: string; size: number } };
  zyraResolveChoice: (projectId: string, sessionId: string, rawChoice: unknown, message: string) => Promise<{ options: Options; choice: { id: string; message?: string } } | null>;
  zyraPlanScopedTicketRound: (params: Body) => Promise<{ scenarios: string[]; cursor: string | null; hasMore: boolean; tickets: number; emptyKeys?: string[] }>;
  generateZyraChatCreateDecision: (params: Body) => Promise<Decision>;
  continueZyraChatPlanInLanguage: (projectId: string, userId: string | null, sessionId: string, planId: string) => Promise<void>;
  zyraDecisionForChoice: (turn: Body, answer: { options: Options; choice: { id: string; label: string; message?: string } }, onStage?: unknown) => Promise<Decision>;
  buildZyraChatDecision: (...args: unknown[]) => Promise<Decision>;
  zyraProjectCapabilities: (projectId: string) => Promise<{ knowledgeBase: boolean }>;
  zyraSessionLanguage: (projectId: string, sessionId: string) => Promise<string>;
  startZyraChatPlan: (params: Body) => Promise<Decision>;
  generateZyraChatTestcasesWithAi: (params: Body) => Promise<Decision>;
  planZyraChatScenarios: (params: Body) => Promise<string[]>;
  existingTestcaseSnapshot: (...args: unknown[]) => Promise<unknown[]>;
  postZyraPlanMessage: (...args: unknown[]) => Promise<void>;
};

const internals = (svc: LegacyService) => svc as unknown as Internals;
const statics = LegacyService as unknown as {
  zyraPublicOptions: (raw: unknown) => Body | null;
  zyraRoutedScope: (raw: unknown) => string | undefined;
  zyraTicketPlanSummary: (plan: Body, final: boolean) => string;
  zyraBatchTicketKeys: (batch: string[]) => string[];
};

const keys = (count: number) => Array.from({ length: count }, (_, i) => `QAB-${i + 1}`);

// ---------------------------------------------------------------------------------------------------
// When to ask
// ---------------------------------------------------------------------------------------------------

/*
 * "[Zyra] Semantic Intent Detection and Consistent Batch Confirmation" — the limit is the project's
 * own setting (one generation under "Test cases per task": 10 / 30 / 50 / 100), not the fixed 60 this
 * used to compare against, and the scope is the router's semantic reading (`routedScope`), so
 * "write all test cases" and "… for all tickets" reach the same decision. The keyword test survives
 * only as the fallback when the router reports no scope, which the older cases below still exercise.
 */
type ScopeOpts = { synced?: number; knowledgeBase?: boolean; confidence?: string; prefixes?: string[]; routedScope?: string; exhaustive?: boolean; requestedCount?: number; referencedKeys?: string[] };

describe("zyraTicketScope — asks when the workload is over one generation under the project's setting", () => {
  const scopeFor = async (message: string, range: string, opts: ScopeOpts = {}) => {
    const query = jest.fn((sql: string, params: unknown[] = []) => {
      // Prefixes this project has synced tickets under — QAB unless a test says otherwise.
      if (sql.includes("AS prefix")) return Promise.resolve({ rows: (opts.prefixes ?? ["QAB"]).filter((p) => (params[1] as string[]).includes(p)).map((prefix) => ({ prefix })) });
      return Promise.resolve({ rows: [{ count: String(opts.synced ?? 0) }] });
    }) as unknown as Query;
    const svc = makeLegacy(query);
    jest.spyOn(internals(svc), "zyraProjectCapabilities").mockResolvedValue({ knowledgeBase: opts.knowledgeBase ?? true });
    // The router's reading — exhaustive and scope — as the real turn passes it in.
    const plan = internals(svc).chatTestcasePlan(message, range, opts.exhaustive || opts.requestedCount ? { exhaustive: opts.exhaustive, requestedCount: opts.requestedCount } : undefined);
    return internals(svc).zyraTicketScope("p1", message, plan, {
      projectTestcaseRange: range,
      knowledgeConfidence: opts.confidence,
      routedScope: opts.routedScope,
      referencedKeys: opts.referencedKeys
    });
  };

  it("asks for two named tickets on the 'all' range — 200 is over one generation of 100", async () => {
    expect(await scopeFor("Generate test cases for QAB-1 and QAB-2", "all")).toEqual({
      ticketKeys: ["QAB-1", "QAB-2"], ticketCount: 2, perTicket: 100, limit: 100, unspecified: false
    });
  });

  it("regression: a project set to 1-10, 10-30 or 30-50 is never asked — only 'all' can span several generations", async () => {
    for (const range of ["1-10", "10-30", "30-50"]) {
      expect(await scopeFor("Generate test cases for QAB-1 and QAB-2", range)).toBeNull();
      expect(await scopeFor(`Generate test cases for ${keys(10).join(", ")}`, range)).toBeNull();
      expect(await scopeFor("Generate test cases for all the tickets", range, { routedScope: "all_tickets", synced: 243 })).toBeNull();
      // Even an 'all possible' wording: the range is the ceiling, not a reason to ask.
      expect(await scopeFor("Generate all possible test cases for all tickets", range, { routedScope: "all_tickets", exhaustive: true, synced: 243 })).toBeNull();
    }
  });

  it("below, at and over the limit on 'all': what fits one generation is not asked about", async () => {
    // Below: one ticket is one generation's worth.
    expect(await scopeFor("Generate test cases for QAB-1", "all")).toBeNull();
    // At: every ticket of a project that only has one fits exactly — still one generation.
    expect(await scopeFor("Generate test cases for all the tickets", "all", { routedScope: "all_tickets", synced: 1 })).toBeNull();
    // Over: two tickets at 100 each need two generations.
    expect((await scopeFor("Generate test cases for all the tickets", "all", { routedScope: "all_tickets", synced: 2 }))?.ticketCount).toBe(2);
  });

  it("never asks about a single ticket, however large its budget", async () => {
    expect(await scopeFor("Generate all possible test cases for QAB-1", "all", { exhaustive: true })).toBeNull();
  });

  it("an explicit count is the user's own budget and is never second-guessed", async () => {
    expect(await scopeFor(`Generate 20 test cases for ${keys(10).join(", ")}`, "all")).toBeNull();
  });

  it("does not count key-shaped words that are not this project's tickets", async () => {
    expect(await scopeFor("Generate test cases for UTF-8 and ISO-8859 encoding", "all")).toBeNull();
    // Mixed: only the real tickets count — here one, so nothing to ask.
    expect(await scopeFor("Generate test cases for QAB-1 with UTF-8 input", "all")).toBeNull();
    // An unsynced key under a known prefix still counts; it is reported as not synced later.
    expect((await scopeFor("Generate test cases for QAB-1 and QAB-999", "all"))?.ticketKeys).toEqual(["QAB-1", "QAB-999"]);
  });

  it("counts every synced ticket for 'all the tickets'", async () => {
    expect(await scopeFor("Generate test cases for all the Jira tickets", "all", { synced: 12 })).toEqual({
      ticketKeys: null, ticketCount: 12, perTicket: 100, limit: 100, unspecified: false
    });
  });

  it("does not read 'the login requirement' as every ticket there is", async () => {
    expect(await scopeFor("Generate test cases for the login requirement", "all", { synced: 500 })).toBeNull();
  });

  it("does not ask about all tickets when the knowledge base is off, or a search matched strongly", async () => {
    expect(await scopeFor("Generate test cases for all the tickets", "all", { synced: 12, knowledgeBase: false })).toBeNull();
    expect(await scopeFor("Generate test cases for all the tickets", "all", { synced: 12, confidence: "strong" })).toBeNull();
  });
});

describe("zyraTicketScope — the router's scope decides, whatever the wording", () => {
  const scopeFor = async (message: string, range: string, opts: ScopeOpts = {}) => {
    const query = jest.fn((sql: string, params: unknown[] = []) => {
      if (sql.includes("AS prefix")) return Promise.resolve({ rows: (opts.prefixes ?? ["QAB"]).filter((p) => (params[1] as string[]).includes(p)).map((prefix) => ({ prefix })) });
      return Promise.resolve({ rows: [{ count: String(opts.synced ?? 0) }] });
    }) as unknown as Query;
    const svc = makeLegacy(query);
    jest.spyOn(internals(svc), "zyraProjectCapabilities").mockResolvedValue({ knowledgeBase: opts.knowledgeBase ?? true });
    const plan = internals(svc).chatTestcasePlan(message, range, opts.exhaustive || opts.requestedCount ? { exhaustive: opts.exhaustive, requestedCount: opts.requestedCount } : undefined);
    return internals(svc).zyraTicketScope("p1", message, plan, {
      projectTestcaseRange: range,
      knowledgeConfidence: opts.confidence,
      routedScope: opts.routedScope,
      referencedKeys: opts.referencedKeys
    });
  };

  // The issue's own examples. The router reads each one; given the same reading and settings, the
  // decision must be identical — none of the words below may change it.
  const everyTicketPhrasings = [
    "write all test cases for all tickets",
    "generate test cases for everything",
    "create test cases for every ticket",
    "cover all tickets with test cases",
    "create test cases for the entire project",
    "please make sure each story has its tests"
  ];

  it("equivalent requests with the same scope and settings reach the same decision", async () => {
    const decisions = await Promise.all(
      everyTicketPhrasings.map((message) => scopeFor(message, "all", { routedScope: "all_tickets", exhaustive: true, synced: 243 }))
    );
    for (const [i, decision] of decisions.entries()) {
      expect({ message: everyTicketPhrasings[i], decision }).toEqual({
        message: everyTicketPhrasings[i],
        decision: { ticketKeys: null, ticketCount: 243, perTicket: 100, limit: 100, unspecified: false }
      });
    }
  });

  it("regression: 'write all test cases' (no ticket word) no longer skips the question — it asks which scope", async () => {
    // Before: no ticket word, so the keyword test returned null and Zyra planned silently from
    // whatever the search matched. Now an unstated scope that every ticket would overflow is asked.
    expect(await scopeFor("write all test cases", "all", { routedScope: "unspecified", exhaustive: true, synced: 243 })).toEqual({
      ticketKeys: null, ticketCount: 243, perTicket: 100, limit: 100, unspecified: true
    });
  });

  it("regression: 'write all test cases for all tickets' still asks, from the router's reading or the fallback", async () => {
    const expected = { ticketKeys: null, ticketCount: 243, perTicket: 100, limit: 100, unspecified: false };
    expect(await scopeFor("write all test cases for all tickets", "all", { routedScope: "all_tickets", exhaustive: true, synced: 243 })).toEqual(expected);
    expect(await scopeFor("write all test cases for all tickets", "all", { exhaustive: true, synced: 243 })).toEqual(expected);
  });

  it("does not force a question on small, unambiguous or ordinary requests", async () => {
    // An unstated scope that is not 'all possible' is an ordinary request: generate as before.
    expect(await scopeFor("write test cases", "30-50", { routedScope: "unspecified", synced: 243 })).toBeNull();
    // One feature, even worded with "all … requirements".
    expect(await scopeFor("write all test cases for the login requirements", "all", { routedScope: "feature", exhaustive: true, synced: 243 })).toBeNull();
    // Every ticket in a project that has none synced — nothing to estimate, nothing to ask.
    expect(await scopeFor("write all test cases", "all", { routedScope: "unspecified", exhaustive: true, synced: 0 })).toBeNull();
    // An explicit count is the user's own budget, whatever the scope.
    expect(await scopeFor("generate 100 test cases", "all", { routedScope: "all_tickets", requestedCount: 100, synced: 243 })).toBeNull();
  });

  it("regression: a named count under 100 never asks, even when the router also flags the request exhaustive", async () => {
    for (const requestedCount of [20, 50, 99]) {
      expect(
        await scopeFor(`generate ${requestedCount} test cases for all tickets`, "all", { routedScope: "all_tickets", exhaustive: true, requestedCount, synced: 243 })
      ).toBeNull();
    }
    // The regex fallback (router reported nothing) honours the number in the text the same way.
    expect(await scopeFor("generate 20 test cases for all tickets", "all", { exhaustive: true, synced: 243 })).toBeNull();
  });

  it("'all' means all of what the user refers to: tickets named earlier, not every ticket", async () => {
    const referenced = { routedScope: "referenced", referencedKeys: ["QAB-1", "QAB-2", "QAB-3"], synced: 243 };
    expect(await scopeFor("write test cases for all of them", "all", referenced)).toEqual({
      ticketKeys: ["QAB-1", "QAB-2", "QAB-3"], ticketCount: 3, perTicket: 100, limit: 100, unspecified: false
    });
    // The same carried keys do not widen a request the router read as one feature.
    expect(await scopeFor("write test cases for the login page", "all", { ...referenced, routedScope: "feature" })).toBeNull();
    // And with no router scope (the fallback), only the tickets this message names count, as before.
    expect(await scopeFor("write test cases for all of them", "all", { ...referenced, routedScope: undefined })).toBeNull();
  });

  it("the router's reading wins over a strong search match that used to suppress the question", async () => {
    expect((await scopeFor("generate test cases for everything", "all", { routedScope: "project", exhaustive: true, synced: 20, confidence: "strong" }))?.ticketCount).toBe(20);
  });

  it("an unknown scope from the router is ignored, falling back to the old reading", () => {
    expect(statics.zyraRoutedScope("all_tickets")).toBe("all_tickets");
    expect(statics.zyraRoutedScope("galaxy")).toBeUndefined();
    expect(statics.zyraRoutedScope(null)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------
// The question and its options
// ---------------------------------------------------------------------------------------------------

describe("zyraTicketScopeQuestion — the two options, and what the client sees of them", () => {
  const question = () =>
    internals(makeLegacy()).zyraTicketScopeQuestion(
      "Generate test cases for QAB-1 … QAB-30",
      { ticketKeys: keys(30), ticketCount: 30, perTicket: 50, limit: 50, unspecified: false },
      false,
      { id: "s1", name: "Login" }
    );

  it("is an answer that writes nothing, says why, and offers both options", () => {
    const decision = question();
    expect(decision.actionType).toBe("answer");
    expect(decision.operations).toEqual([]);
    expect(decision.reply).toMatch(/30 tickets/);
    expect(decision.reply).toMatch(/roughly 1500 test cases/);
    expect(decision.options?.choices.map((c) => c.label)).toEqual(["Generate in smaller batches", "Generate all tickets in batches"]);
    expect(decision.options?.choices[0].description).toMatch(/1–2 tickets at a time/);
  });

  it("states the project's own limit, never a fixed 100", () => {
    const at30 = internals(makeLegacy()).zyraTicketScopeQuestion("x", { ticketKeys: keys(4), ticketCount: 4, perTicket: 30, limit: 30, unspecified: false }, false, null);
    expect(at30.reply).toMatch(/one generation holds 30 under this project's settings/);
    expect(at30.options?.choices.find((c) => c.id === "all")?.description).toMatch(/batches of up to 30 test cases/);
    expect(JSON.stringify(at30)).not.toMatch(/\b100\b/);
  });

  it("an unstated scope gets the clarifying variant: what 'all' could mean, the estimate, and the narrow reading as an option", () => {
    const decision = internals(makeLegacy()).zyraTicketScopeQuestion(
      "write all test cases",
      { ticketKeys: null, ticketCount: 243, perTicket: 100, limit: 100, unspecified: true },
      true,
      null
    );
    expect(decision.reply).toMatch(/could mean all 243 synced tickets/);
    expect(decision.reply).toMatch(/roughly 24300 test cases — more than one generation of 100/);
    expect(decision.options?.choices.map((c) => c.id)).toEqual(["matched", "smaller", "all"]);
    expect(decision.options?.context).toMatchObject({ originalMessage: "write all test cases", ticketKeys: null, limit: 100, exhaustive: true });
  });

  it("keeps what acting on it needs server-side only", () => {
    const options = question().options!;
    expect(options.context).toMatchObject({ ticketKeys: keys(30), perTicket: 50, limit: 50, routedSuite: { id: "s1", name: "Login" } });
    const visible = statics.zyraPublicOptions(options);
    expect(visible).toEqual({ kind: "ticket_scope", choices: options.choices, answeredId: null });
    expect(JSON.stringify(visible)).not.toContain("originalMessage");
  });

  it("a message without options shows none", () => {
    expect(statics.zyraPublicOptions(null)).toBeNull();
  });
});

describe("zyraTicketSelectionPrompt — 'smaller batches' asks which tickets, it does not list them", () => {
  it("asks for ids or a range, with real examples, how many fit a batch, and 'all' one click away", async () => {
    const decision = await internals(makeLegacy()).zyraTicketSelectionPrompt("p1", { ticketKeys: keys(30), perTicket: 50, limit: 50, exhaustive: true });
    expect(decision.reply).toMatch(/Type the ticket IDs or a range — for example `QAB-1, QAB-2` or `QAB-1 to QAB-2`/);
    expect(decision.reply).toMatch(/30 tickets are in scope; for the best coverage name up to 2 at a time/);
    expect(decision.options?.kind).toBe("ticket_selection");
    // One option however many tickets there are — never a row per ticket.
    expect(decision.options?.choices.map((c) => c.id)).toEqual(["all"]);
    expect(decision.options?.choices[0].description).toMatch(/all 30 tickets/);
    expect(decision.options?.context).toMatchObject({ ticketKeys: keys(30), perTicket: 50 });
  });

  it("for 'all the tickets' counts and samples the synced tickets in number order, never listing them", async () => {
    const query = jest.fn((sql: string) => Promise.resolve({
      rows: sql.includes("count(*)") ? [{ count: "10000" }] : [{ ticket_key: "KAN-1" }, { ticket_key: "KAN-2" }]
    })) as unknown as Query;
    const decision = await internals(makeLegacy(query)).zyraTicketSelectionPrompt("p1", { ticketKeys: null, perTicket: 10, limit: 10 });
    expect(decision.reply).toMatch(/10000 tickets are in scope; for the best coverage name up to 10 at a time/);
    expect(decision.reply).toMatch(/`KAN-1 to KAN-10`/);
    expect(decision.options?.choices).toHaveLength(1);
    const sampled = query.mock.calls.find(([sql]) => sql.includes("ORDER BY split_part"))!;
    // KAN-2 sorts before KAN-10: ordered by the key's number, not its text.
    expect(sampled[0]).toMatch(/regexp_replace\(ticket_key, '\^\.\*-', ''\)\)::bigint/);
  });

  it("says why it is asking again: nothing typed was a synced ticket, or the range was too large", async () => {
    const svc = makeLegacy();
    const unknown = await internals(svc).zyraTicketSelectionPrompt("p1", { ticketKeys: keys(3), perTicket: 50, limit: 50 }, { unknown: ["KAN-999"] });
    expect(unknown.reply).toMatch(/^None of KAN-999 is a synced ticket in this project\./);
    expect(unknown.options?.kind).toBe("ticket_selection");
    const tooLarge = await internals(svc).zyraTicketSelectionPrompt("p1", { ticketKeys: keys(3), perTicket: 50, limit: 50 }, { oversizedRange: { from: "KAN-1", to: "KAN-9000", size: 9000 } });
    expect(tooLarge.reply).toMatch(/^KAN-1 to KAN-9000 covers 9000 tickets — name at most 500 at a time/);
  });

  it("a question asked before it carried a limit reads the project's setting, not a fixed 100", async () => {
    const svc = makeLegacy();
    jest.spyOn(internals(svc), "getProject").mockResolvedValue({ settings: { zyraAgent: { testcaseRange: "10-30" } } });
    const decision = await internals(svc).zyraTicketSelectionPrompt("p1", { ticketKeys: keys(4), perTicket: 30 });
    expect(decision.options?.choices[0].description).toMatch(/batches of up to 30 test cases/);
  });

  it("with nothing synced for 'all tickets', says so and asks nothing", async () => {
    const decision = await internals(makeLegacy(jest.fn(() => Promise.resolve({ rows: [{ count: "0" }] })) as unknown as Query)).zyraTicketSelectionPrompt("p1", { ticketKeys: null, perTicket: 50, limit: 50 });
    expect(decision.options).toBeUndefined();
    expect(decision.reply).toMatch(/None of these tickets is synced/);
  });
});

describe("zyraParseTicketSelection — ids and ranges typed in chat", () => {
  const parse = (message: string) => internals(makeLegacy()).zyraParseTicketSelection(message);

  it("reads a list of ids, any provider's, deduplicated in the order typed", () => {
    expect(parse("KAN-1, KAN-10 and ENG-7, kan-1").keys).toEqual(["KAN-1", "KAN-10", "ENG-7"]);
  });

  it("expands every range spelling in number order", () => {
    for (const range of ["KAN-3 to KAN-6", "KAN-3..KAN-6", "KAN-3 - KAN-6", "KAN-3 to 6", "KAN-6 to KAN-3", "kan-3 through kan-6"]) {
      expect({ range, keys: parse(`Do ${range}`).keys }).toEqual({ range, keys: ["KAN-3", "KAN-4", "KAN-5", "KAN-6"] });
    }
  });

  it("mixes ranges and ids", () => {
    expect(parse("KAN-1 to KAN-3, ENG-9").keys).toEqual(["KAN-1", "KAN-2", "KAN-3", "ENG-9"]);
  });

  it("two different projects either side of a dash are two tickets, not a range", () => {
    expect(parse("KAN-1 - ENG-4").keys).toEqual(["KAN-1", "ENG-4"]);
  });

  it("a range over 500 is reported, not expanded or cut short", () => {
    const result = parse("KAN-1 to KAN-9000");
    expect(result.keys).toEqual([]);
    expect(result.oversizedRange).toEqual({ from: "KAN-1", to: "KAN-9000", size: 9000 });
    expect(parse("KAN-1 to KAN-500").keys).toHaveLength(500);
  });

  it("finds nothing in a message that names no ticket", () => {
    expect(parse("just do the important ones").keys).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------------------------------

describe("zyraResolveChoice — a click or a typed answer, acted on once", () => {
  const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
  const OTHER_ID = "22222222-2222-4222-8222-222222222222";
  const open = (): Options => ({
    kind: "ticket_scope",
    choices: [{ id: "smaller", label: "Generate in smaller batches" }, { id: "all", label: "Generate all tickets in batches" }],
    answeredId: null,
    context: { ticketKeys: ["QAB-1", "QAB-2"] }
  });
  function setup(latest: { id: string; options: Options | null } | null, claimSucceeds = true) {
    const query = jest.fn((sql: string, params: unknown[] = []) => {
      if (sql.startsWith("SELECT id, options")) return Promise.resolve({ rows: latest ? [latest] : [] });
      if (sql.includes("UPDATE zyra_chat_messages SET options")) {
        return Promise.resolve({ rows: claimSucceeds && latest?.options ? [{ options: { ...latest.options, answeredId: params[1] } }] : [] });
      }
      return Promise.resolve({ rows: [] });
    }) as unknown as Query;
    return { svc: makeLegacy(query), query };
  }
  const resolve = (svc: LegacyService, raw: unknown, message = "x") => internals(svc).zyraResolveChoice("p1", "s1", raw, message);

  it("a click on the latest open question resolves and marks it answered", async () => {
    const { svc, query } = setup({ id: MESSAGE_ID, options: open() });
    const result = await resolve(svc, { messageId: MESSAGE_ID, optionId: "all" });
    expect(result?.choice.id).toBe("all");
    expect(result?.options.answeredId).toBe("all");
    const update = query.mock.calls.find(([sql]) => sql.includes("UPDATE zyra_chat_messages SET options"))!;
    expect(update[0]).toMatch(/options->>'answeredId' IS NULL/);
  });

  it("a typed number or the exact label answers it; anything else is an ordinary message", async () => {
    expect((await resolve(setup({ id: MESSAGE_ID, options: open() }).svc, undefined, "2"))?.choice.id).toBe("all");
    expect((await resolve(setup({ id: MESSAGE_ID, options: open() }).svc, undefined, "generate in smaller batches."))?.choice.id).toBe("smaller");
    expect(await resolve(setup({ id: MESSAGE_ID, options: open() }).svc, undefined, "Generate tests for login")).toBeNull();
    expect(await resolve(setup({ id: MESSAGE_ID, options: open() }).svc, undefined, "3")).toBeNull();
  });

  it("an open which-tickets question is answered by typing ticket ids or a range; other text is not an answer", async () => {
    const selection: Options = { kind: "ticket_selection", choices: [{ id: "all", label: "Generate all tickets in batches" }], answeredId: null, context: {} };
    expect((await resolve(setup({ id: MESSAGE_ID, options: selection }).svc, undefined, "KAN-1, KAN-10"))?.choice.id).toBe("typed");
    // Too large is still an answer — it is re-asked with the reason.
    expect((await resolve(setup({ id: MESSAGE_ID, options: selection }).svc, undefined, "KAN-1 to KAN-9000"))?.choice.id).toBe("typed");
    expect((await resolve(setup({ id: MESSAGE_ID, options: selection }).svc, undefined, "1"))?.choice.id).toBe("all");
    expect(await resolve(setup({ id: MESSAGE_ID, options: selection }).svc, undefined, "what does this mean?")).toBeNull();
    // On the first question, a typed ticket list is an ordinary message, not an answer.
    expect(await resolve(setup({ id: MESSAGE_ID, options: open() }).svc, undefined, "KAN-1, KAN-10")).toBeNull();
  });

  it("a typed answer never reopens an answered question, and no question means nothing to answer", async () => {
    expect(await resolve(setup({ id: MESSAGE_ID, options: { ...open(), answeredId: "all" } }).svc, undefined, "1")).toBeNull();
    expect(await resolve(setup({ id: MESSAGE_ID, options: null }).svc, undefined, "1")).toBeNull();
  });

  it("refuses a click on a question that is not the latest, or already answered (409)", async () => {
    await expect(resolve(setup({ id: MESSAGE_ID, options: open() }).svc, { messageId: OTHER_ID, optionId: "all" })).rejects.toBeInstanceOf(ConflictException);
    await expect(resolve(setup({ id: MESSAGE_ID, options: { ...open(), answeredId: "smaller" } }).svc, { messageId: MESSAGE_ID, optionId: "all" })).rejects.toBeInstanceOf(ConflictException);
    // Lost the race between the read and the write: a second click on the same option.
    await expect(resolve(setup({ id: MESSAGE_ID, options: open() }, false).svc, { messageId: MESSAGE_ID, optionId: "all" })).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses a malformed choice or an unknown option (400)", async () => {
    const { svc } = setup({ id: MESSAGE_ID, options: open() });
    await expect(resolve(svc, { messageId: "not-a-uuid", optionId: "all" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(resolve(svc, { messageId: MESSAGE_ID })).rejects.toBeInstanceOf(BadRequestException);
    await expect(resolve(svc, "all")).rejects.toBeInstanceOf(BadRequestException);
    await expect(resolve(svc, { messageId: MESSAGE_ID, optionId: "everything" })).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ---------------------------------------------------------------------------------------------------
// The create path
// ---------------------------------------------------------------------------------------------------

describe("generateZyraChatCreateDecision — asks before generating, and plans once answered", () => {
  function setup() {
    // The project has synced QAB tickets, so QAB keys count as tickets (see zyraTicketScope).
    const svc = makeLegacy(jest.fn((sql: string) => Promise.resolve({ rows: sql.includes("AS prefix") ? [{ prefix: "QAB" }] : [] })) as unknown as Query);
    jest.spyOn(internals(svc), "zyraSessionLanguage").mockResolvedValue("en");
    jest.spyOn(internals(svc), "zyraProjectCapabilities").mockResolvedValue({ knowledgeBase: true });
    const plan = jest.spyOn(internals(svc), "startZyraChatPlan").mockResolvedValue({ reply: "planned", actionType: "create", operations: [] });
    const single = jest.spyOn(internals(svc), "generateZyraChatTestcasesWithAi").mockResolvedValue({ reply: "generated", actionType: "create", operations: [] });
    return { svc, plan, single };
  }
  const create = (svc: LegacyService, message: string, routedCount?: Body, projectTestcaseRange = "30-50") =>
    internals(svc).generateZyraChatCreateDecision({
      projectId: "p1", userId: "u1", sessionId: "s1", provider: "openai", model: "m", key: {}, message, knowledge: [], existingTestcases: [],
      jiraIssueKeys: [], projectTestcaseRange, suites: [], routedSuite: null, routedCount
    });

  it("many tickets: returns the question and generates nothing", async () => {
    const { svc, plan, single } = setup();
    const decision = await create(svc, `Generate test cases for ${keys(10).join(", ")}`, undefined, "all");
    expect(decision.options?.kind).toBe("ticket_scope");
    expect(plan).not.toHaveBeenCalled();
    expect(single).not.toHaveBeenCalled();
  });

  it("answered 'all in batches': a ticket-scoped plan, not the question again", async () => {
    const { svc, plan } = setup();
    await create(svc, `Generate test cases for ${keys(10).join(", ")}`, { exhaustive: true, ticketScope: { ticketKeys: keys(10), perTicket: 50 } });
    expect(plan).toHaveBeenCalledTimes(1);
    expect(plan.mock.calls[0][0]).toMatchObject({ ticketScope: { ticketKeys: keys(10), perTicket: 50 } });
  });

  it("answered 'all in batches' for all the tickets: the existing paged plan, not the question again", async () => {
    const { svc, plan } = setup();
    const decision = await create(svc, "Generate all possible test cases for all the Jira tickets.", { exhaustive: true, scopeDecided: true }, "all");
    expect(decision.options).toBeUndefined();
    expect(plan).toHaveBeenCalledTimes(1);
    expect((plan.mock.calls[0][0] as Body).ticketScope).toBeUndefined();
  });

  it("one ticket: unchanged — generated straight away", async () => {
    const { svc, single } = setup();
    const decision = await create(svc, "Generate test cases for QAB-1");
    expect(decision.options).toBeUndefined();
    expect(single).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------------
// Ticket-scoped planning
// ---------------------------------------------------------------------------------------------------

describe("zyraPlanScopedTicketRound — one ticket per round, each scenario labelled with its key", () => {
  function setup(rows: Body[], planned: string[]) {
    const query = jest.fn(() => Promise.resolve({ rows })) as unknown as Query;
    const svc = makeLegacy(query);
    const planner = jest.spyOn(internals(svc), "planZyraChatScenarios").mockResolvedValue(planned);
    jest.spyOn(internals(svc), "existingTestcaseSnapshot").mockResolvedValue([]);
    return { svc, query, planner };
  }
  const round = (svc: LegacyService, cursor: string | null) =>
    internals(svc).zyraPlanScopedTicketRound({ projectId: "p1", provider: "openai", model: "m", key: {}, message: "all of them", cursor, scope: { ticketKeys: ["QAB-1", "QAB-2"], perTicket: 30 } });

  it("reads only the selected tickets after the cursor, one at a time, with that ticket's own budget", async () => {
    const { svc, query, planner } = setup([{ id: "d1", title: "QAB-1: Login", content_text: "Body", ticket_key: "QAB-1" }], ["Valid login", "Locked account"]);
    const result = await round(svc, "d0");
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/= ANY\(\$2::text\[\]\)/);
    expect(sql).toMatch(/LIMIT 2/);
    expect(params).toEqual(["p1", ["QAB-1", "QAB-2"], "d0"]);
    const plannerCall = planner.mock.calls[0][0] as { maxScenarios: number; message: string };
    expect(plannerCall.maxScenarios).toBe(30);
    expect(plannerCall.message).toMatch(/for QAB-1 only/);
    // One row back: this was the last ticket, and the round already knows it.
    expect(result).toEqual({ scenarios: ["[QAB-1] Valid login", "[QAB-1] Locked account"], cursor: "d1", hasMore: false, tickets: 1, emptyKeys: [] });
  });

  it("reads one ticket ahead: plans only the first, and reports more when a second is there", async () => {
    const { svc, planner } = setup([
      { id: "d1", title: "QAB-1: Login", content_text: "", ticket_key: "QAB-1" },
      { id: "d2", title: "QAB-2: Logout", content_text: "", ticket_key: "QAB-2" }
    ], ["Valid login"]);
    const result = await round(svc, null);
    expect(planner).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ scenarios: ["[QAB-1] Valid login"], cursor: "d1", hasMore: true, tickets: 1, emptyKeys: [] });
  });

  it("a ticket that plans nothing is named, not silently dropped", async () => {
    const { svc } = setup([{ id: "d2", title: "QAB-2: Logout", content_text: "", ticket_key: "QAB-2" }], []);
    expect((await round(svc, "d1")).emptyKeys).toEqual(["QAB-2"]);
  });

  it("past the last ticket the plan ends, with no planner call", async () => {
    const { svc, planner } = setup([], ["unused"]);
    expect(await round(svc, "d9")).toEqual({ scenarios: [], cursor: "d9", hasMore: false, tickets: 0, emptyKeys: [] });
    expect(planner).not.toHaveBeenCalled();
  });

  it("a batch's tickets are read back from those labels", () => {
    expect(statics.zyraBatchTicketKeys(["[QAB-1] a", "[qab-1] b", "[QAB-2] c", "no label"])).toEqual(["QAB-1", "QAB-2"]);
  });
});

describe("zyraTicketPlanSummary — every ticket accounted for", () => {
  it("progress while running", () => {
    expect(statics.zyraTicketPlanSummary({ ticketsTotal: 30, ticketsSynced: 28, ticketsDone: 5 }, false)).toMatch(/Tickets planned: 5 of 28/);
  });

  it("at the end: all processed, or which were not and why", () => {
    expect(statics.zyraTicketPlanSummary({ ticketsTotal: 3, unprocessedTickets: [] }, true)).toMatch(/All 3 ticket\(s\) processed/);
    const partial = statics.zyraTicketPlanSummary({
      ticketsTotal: 4,
      unprocessedTickets: [{ key: "QAB-3", reason: "not_synced" }, { key: "QAB-4", reason: "no_scenarios" }]
    }, true);
    expect(partial).toMatch(/2 of 4 ticket\(s\) got test cases/);
    expect(partial).toMatch(/- QAB-3 — not synced to Tesbo yet/);
    expect(partial).toMatch(/- QAB-4 — no new scenarios/);
  });

  it("lists at most 50 by name and counts the rest", () => {
    const unprocessed = keys(60).map((key) => ({ key, reason: "no_scenarios" }));
    const text = statics.zyraTicketPlanSummary({ ticketsTotal: 60, unprocessedTickets: unprocessed }, true);
    expect(text).toMatch(/…and 10 more\./);
    expect(text).not.toMatch(/QAB-51 —/);
  });
});

describe("a ticket-scoped plan never just stops", () => {
  it("posts the ticket summary when the last tickets planned nothing and the queue is empty", async () => {
    let activePlan: Body | null = {
      planId: "plan-1", status: "running", remainingScenarios: [], batchSize: 50, doneCount: 10, totalCount: 10, coveredCount: 10,
      ticketsHasMore: false, ticketScope: { ticketKeys: ["QAB-1", "QAB-2"], perTicket: 50 }, ticketsTotal: 2, ticketsSynced: 2, ticketsDone: 2,
      unprocessedTickets: [{ key: "QAB-2", reason: "no_scenarios" }]
    };
    const query = jest.fn((sql: string) => Promise.resolve({ rows: sql.includes("SELECT active_plan, language") ? [{ active_plan: activePlan, language: "en" }] : [] })) as unknown as Query;
    const transaction = jest.fn(async (fn: (client: { query: jest.Mock }) => Promise<unknown>) => fn({
      query: jest.fn((sql: string) => {
        if (sql.includes("SELECT active_plan") && sql.includes("FOR UPDATE")) return Promise.resolve({ rows: [{ active_plan: activePlan }] });
        if (sql.includes("SET active_plan = NULL")) activePlan = null;
        return Promise.resolve({ rows: [] });
      })
    }));
    const svc = makeLegacy(query, { transaction } as unknown as Partial<DatabaseService>);
    const posted: unknown[][] = [];
    jest.spyOn(internals(svc), "postZyraPlanMessage").mockImplementation(async (...args) => { posted.push(args); });

    await internals(svc).continueZyraChatPlanInLanguage("p1", "u1", "s1", "plan-1");

    expect(activePlan).toBeNull();
    expect(posted).toHaveLength(1);
    const reply = String(posted[0][4]);
    expect(reply).toMatch(/Finished working through the tickets/);
    expect(reply).toMatch(/1 of 2 ticket\(s\) got test cases/);
    expect(reply).toMatch(/QAB-2 — no new scenarios/);
  });
});

describe("zyraDecisionForChoice — what each answer runs", () => {
  const turn = { projectId: "p1", uid: "u1", sessionId: "s1", message: "2", userMessageId: "m1" };
  const scopeOptions = (ticketKeys: string[] | null): Options => ({
    kind: "ticket_scope",
    choices: [{ id: "smaller", label: "Generate in smaller batches" }, { id: "all", label: "Generate all tickets in batches" }],
    answeredId: "all",
    context: { originalMessage: "Generate test cases for the tickets", ticketKeys, perTicket: 50, limit: 50, exhaustive: false, routedSuite: { id: "s9", name: "Checkout" } }
  });
  function setup() {
    const svc = makeLegacy();
    const build = jest.spyOn(internals(svc), "buildZyraChatDecision").mockResolvedValue({ reply: "built", actionType: "create", operations: [] });
    return { svc, build };
  }

  it("'all' for named tickets re-runs the ORIGINAL request, routed, as a ticket-scoped plan", async () => {
    const { svc, build } = setup();
    await internals(svc).zyraDecisionForChoice(turn, { options: scopeOptions(["QAB-1", "QAB-2"]), choice: { id: "all", label: "Generate all tickets in batches" } });
    const [, , , message, userMessageId, resume] = build.mock.calls[0];
    expect(message).toBe("Generate test cases for the tickets");
    expect(userMessageId).toBe("m1");
    expect(resume).toEqual({
      routedSuite: { id: "s9", name: "Checkout" },
      routedCount: { exhaustive: true, scopeDecided: true, ticketScope: { ticketKeys: ["QAB-1", "QAB-2"], perTicket: 50 } }
    });
  });

  it("'all' for all the tickets is the paged plan — decided, with no ticket scope", async () => {
    const { svc, build } = setup();
    await internals(svc).zyraDecisionForChoice(turn, { options: scopeOptions(null), choice: { id: "all", label: "Generate all tickets in batches" } });
    expect((build.mock.calls[0][5] as Body).routedCount).toEqual({ exhaustive: true, scopeDecided: true, scope: "all_tickets" });
  });

  it("'smaller batches' asks which tickets, without calling the model", async () => {
    const { svc, build } = setup();
    const decision = await internals(svc).zyraDecisionForChoice(turn, { options: scopeOptions(["QAB-1", "QAB-2"]), choice: { id: "smaller", label: "Generate in smaller batches" } });
    expect(build).not.toHaveBeenCalled();
    expect(decision.options?.kind).toBe("ticket_selection");
  });

  it("'just what this request matched' re-runs the original request, decided, on the narrow reading", async () => {
    const { svc, build } = setup();
    const options: Options = {
      kind: "ticket_scope",
      choices: [{ id: "matched", label: "Just what this request matched" }, { id: "smaller", label: "Generate in smaller batches" }, { id: "all", label: "Generate all tickets in batches" }],
      answeredId: "matched",
      context: { originalMessage: "write all test cases", ticketKeys: null, perTicket: 100, limit: 100, exhaustive: true, routedSuite: null }
    };
    await internals(svc).zyraDecisionForChoice(turn, { options, choice: { id: "matched", label: "Just what this request matched" } });
    const [, , , message, , resume] = build.mock.calls[0];
    expect(message).toBe("write all test cases");
    // scopeDecided: an approved scope is respected — the follow-up turn is not asked again.
    expect(resume).toEqual({ routedSuite: null, routedCount: { exhaustive: true, scopeDecided: true, scope: "feature" } });
  });

  const selectionOptions = (ticketKeys: string[] | null): Options => ({
    kind: "ticket_selection",
    choices: [{ id: "all", label: "Generate all tickets in batches" }],
    answeredId: "typed",
    context: { originalMessage: "Generate all possible test cases on all tickets", ticketKeys, perTicket: 50, limit: 50, exhaustive: true, routedSuite: null }
  });
  function setupSelection(syncedKeys: string[]) {
    const query = jest.fn((sql: string, params: unknown[] = []) => {
      if (sql.includes("ORDER BY split_part")) return Promise.resolve({ rows: syncedKeys.filter((k) => !params[1] || (params[1] as string[]).includes(k)).map((ticket_key) => ({ ticket_key })) });
      if (sql.includes("count(*)")) return Promise.resolve({ rows: [{ count: String(syncedKeys.length) }] });
      return Promise.resolve({ rows: [] });
    }) as unknown as Query;
    const svc = makeLegacy(query);
    const build = jest.spyOn(internals(svc), "buildZyraChatDecision").mockResolvedValue({ reply: "built", actionType: "create", operations: [] });
    return { svc, build };
  }
  const typed = (message: string) => ({ choice: { id: "typed", label: message } });

  it("typed tickets run as a ticket-scoped plan of their own — unsynced ones included, so the plan names them", async () => {
    const { svc, build } = setupSelection(["KAN-1", "KAN-2", "KAN-3"]);
    await internals(svc).zyraDecisionForChoice({ ...turn, message: "KAN-1 to KAN-3, KAN-999" }, { options: selectionOptions(null), ...typed("KAN-1 to KAN-3, KAN-999") });
    const [, , , request, , resume] = build.mock.calls[0];
    expect(request).toBe("Generate all possible test cases for KAN-1, KAN-2, KAN-3, KAN-999");
    expect(resume).toEqual({
      routedSuite: null,
      routedCount: { exhaustive: true, scopeDecided: true, ticketScope: { ticketKeys: ["KAN-1", "KAN-2", "KAN-3", "KAN-999"], perTicket: 50 } }
    });
  });

  it("nothing typed is a synced ticket: asks again, says which, and generates nothing", async () => {
    const { svc, build } = setupSelection(["KAN-1"]);
    const decision = await internals(svc).zyraDecisionForChoice({ ...turn, message: "KAN-998, KAN-999" }, { options: selectionOptions(null), ...typed("KAN-998, KAN-999") });
    expect(build).not.toHaveBeenCalled();
    expect(decision.reply).toMatch(/^None of KAN-998, KAN-999 is a synced ticket/);
    expect(decision.options?.kind).toBe("ticket_selection");
  });

  it("a range that is too large: asks again with the reason, and generates nothing", async () => {
    const { svc, build } = setupSelection(["KAN-1"]);
    const decision = await internals(svc).zyraDecisionForChoice({ ...turn, message: "KAN-1 to KAN-9000" }, { options: selectionOptions(null), ...typed("KAN-1 to KAN-9000") });
    expect(build).not.toHaveBeenCalled();
    expect(decision.reply).toMatch(/covers 9000 tickets/);
  });

  it("'all' on the which-tickets question is the same as on the first question", async () => {
    const { svc, build } = setupSelection([]);
    await internals(svc).zyraDecisionForChoice(turn, { options: selectionOptions(null), choice: { id: "all", label: "Generate all tickets in batches" } });
    expect((build.mock.calls[0][5] as Body).routedCount).toEqual({ exhaustive: true, scopeDecided: true, scope: "all_tickets" });
  });

  it("a ticket group from an older message still runs its own request, not the typed '1'", async () => {
    const { svc, build } = setup();
    const groups: Options = { kind: "ticket_group", choices: [{ id: "group-1", label: "QAB-1", message: "Generate test cases for QAB-1" }], answeredId: "group-1" };
    await internals(svc).zyraDecisionForChoice({ ...turn, message: "1" }, { options: groups, choice: groups.choices[0] });
    expect(build.mock.calls[0][3]).toBe("Generate test cases for QAB-1");
    expect(build.mock.calls[0][5]).toBeUndefined();
  });
});

describe("the paged plan for 'all the tickets' reports ticket progress too", () => {
  it("a batch message of a paged plan carries 'Tickets planned: X of Y'", () => {
    expect(statics.zyraTicketPlanSummary({ ticketsDone: 25, ticketsSynced: 243 }, false)).toMatch(/Tickets planned: 25 of 243/);
    expect(statics.zyraTicketPlanSummary({ ticketsTotal: 243 }, true)).toMatch(/All 243 ticket\(s\) processed/);
  });

  it("only plans that record ticket counts get the lines — an older plan is left as it was", () => {
    const tracks = (LegacyService as unknown as { zyraPlanTracksTickets: (plan: Body) => boolean }).zyraPlanTracksTickets;
    expect(tracks({ ticketsSynced: 243 })).toBe(true);
    expect(tracks({ ticketsHasMore: true, ticketCursor: "c1" })).toBe(false);
  });
});
