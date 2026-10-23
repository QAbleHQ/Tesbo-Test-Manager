// Provider calls go through safeFetch (common/safe-fetch.ts), which refuses non-public addresses and so
// could never reach the stubs below. Route it to the global fetch these tests already mock; the real
// behaviour of safeFetch is covered in common/safe-fetch.spec.ts.
jest.mock("../common/safe-fetch", () => ({
  ...jest.requireActual("../common/safe-fetch"),
  safeFetch: (input: unknown, init?: unknown) => (globalThis.fetch as unknown as (a: unknown, b?: unknown) => Promise<Response>)(input, init)
}));

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
 * "Generate test cases for all tickets" with the "All – Exhaustive" range planned at most 100 scenarios
 * (from the ~25 tickets the search showed) and generated them 5 at a time. A batch now holds as many test
 * cases as the project's range allows (10 / 30 / 50 / 100), the model call can write that many, and a
 * request about the tickets as a whole walks the project's tickets page by page instead of stopping at 100.
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

type Round = { scenarios: string[]; cursor: string | null; hasMore: boolean; tickets: number };

type Internals = {
  generateZyraWithAnthropic: (params: { provider: string; model: string; apiKey: string; projectId: string; input: Body }) => Promise<{ drafts: unknown[]; usage: unknown }>;
  zyraPlanTicketRound: (params: Body) => Promise<Round>;
  zyraPlanFill: (params: Body) => Promise<Round>;
  zyraRefillPlan: (projectId: string, userId: string | null, sessionId: string, plan: Body, batchSize: number) => Promise<boolean>;
  planZyraChatScenarios: (params: Body) => Promise<string[]>;
  existingTestcaseSnapshot: (projectId: string, story: string, context: string) => Promise<unknown[]>;
  zyraProjectCapabilities: (projectId: string) => Promise<{ knowledgeBase: boolean }>;
  zyraAiAllocation: (projectId: string) => Promise<{ key?: Body; reason?: string }>;
  postZyraPlanMessage: (...args: unknown[]) => Promise<void>;
  notifyUsers: (...args: unknown[]) => Promise<void>;
};

function internals(svc: LegacyService): Internals {
  return svc as unknown as Internals;
}

const statics = LegacyService as unknown as {
  zyraBatchSize: (range: string) => number;
  zyraModelTokenCeiling: (message: string) => number | null;
  zyraGenerateTimeoutMs: (n: number) => number;
  zyraPlanBatchReply: (p: Body) => string;
  ZYRA_CHAT_MAX_OPERATIONS: number;
  ZYRA_PLAN_TICKET_PAGE: number;
};

// ---------------------------------------------------------------------------------------------------
// Batch size by range
// ---------------------------------------------------------------------------------------------------

describe("plan batch size follows the project's test case range", () => {
  it("is each range's own ceiling: 1-10 -> 10, 10-30 -> 30, 30-50 -> 50, All -> 100", () => {
    expect(statics.zyraBatchSize("1-10")).toBe(10);
    expect(statics.zyraBatchSize("10-30")).toBe(30);
    expect(statics.zyraBatchSize("30-50")).toBe(50);
    expect(statics.zyraBatchSize("all")).toBe(100);
  });

  it("resolves an unset or unknown range to the 30-50 default, as the range config does", () => {
    for (const range of ["", "undefined", "1-1000", "ALL", "constructor", "__proto__"]) {
      expect(statics.zyraBatchSize(range)).toBe(50);
    }
  });

  it("stages a full batch whole: the per-message operation cap covers the largest batch", () => {
    expect(statics.ZYRA_CHAT_MAX_OPERATIONS).toBeGreaterThanOrEqual(statics.zyraBatchSize("all"));
  });

  it("sizes the generation timeout for a 100-testcase batch well past the old 6-minute ceiling", () => {
    expect(statics.zyraGenerateTimeoutMs(100)).toBe(990_000);
    expect(statics.zyraGenerateTimeoutMs(10)).toBe(180_000);
    expect(statics.zyraGenerateTimeoutMs(999_999)).toBe(1_200_000);
  });
});

// ---------------------------------------------------------------------------------------------------
// Model call: token ceiling, streaming
// ---------------------------------------------------------------------------------------------------

/** A Messages API server-sent-event response, split mid-event on purpose. */
function sseResponse(textParts: string[], opts: { inputTokens?: number; outputTokens?: number; errorEvent?: string } = {}): unknown {
  const events = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: opts.inputTokens ?? 11 } } })}\n\n`,
    ...textParts.map((text) => `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}\n\n`),
    ...(opts.errorEvent ? [`event: error\ndata: ${JSON.stringify({ type: "error", error: { message: opts.errorEvent } })}\n\n`] : []),
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: opts.outputTokens ?? 22 } })}\n\n`
  ].join("");
  const bytes = new TextEncoder().encode(events);
  const mid = Math.floor(bytes.length / 2);
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: (async function* () {
      yield bytes.slice(0, mid);
      yield bytes.slice(mid);
    })()
  };
}

describe("Anthropic generation of a large batch", () => {
  const originalFetch = global.fetch;
  const drafts = (n: number) => JSON.stringify({ drafts: Array.from({ length: n }, (_, i) => ({ title: `Case ${i + 1}`, stepsJson: "[]" })) });
  const plainOk = (n: number) => ({ ok: true, headers: { get: () => null }, json: () => Promise.resolve({ content: [{ type: "text", text: drafts(n) }], usage: {} }) });
  const run = (requestedCount: number) =>
    internals(makeLegacy()).generateZyraWithAnthropic({
      provider: "anthropic", model: "claude-sonnet", apiKey: "sk-test", projectId: "p1",
      input: { story: "s", context: "", acceptanceCriteria: "", feedback: "", knowledge: [], jira: [], linear: [], existingTestcases: [], requestedCount }
    });
  const sentBody = (call = 0) => JSON.parse(String((global.fetch as jest.Mock).mock.calls[call][1].body)) as Body;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("asks a 100-testcase batch for up to 100000 tokens and streams it", async () => {
    global.fetch = jest.fn().mockResolvedValue(sseResponse([drafts(100)])) as unknown as typeof fetch;
    const result = await run(100);
    expect(sentBody()).toMatchObject({ max_tokens: 100_000, stream: true });
    expect(result.drafts).toHaveLength(100);
  });

  it("reads text and usage from a stream split across chunks", async () => {
    global.fetch = jest.fn().mockResolvedValue(sseResponse([drafts(3).slice(0, 20), drafts(3).slice(20)], { inputTokens: 900, outputTokens: 60 })) as unknown as typeof fetch;
    const result = await run(30);
    expect(result.drafts).toHaveLength(3);
    expect(result.usage).toMatchObject({ input: 900, output: 60, total: 960 });
  });

  it("scales max_tokens with the batch, and does not stream a batch of 10 or fewer", async () => {
    global.fetch = jest.fn().mockResolvedValue(plainOk(2)) as unknown as typeof fetch;
    await run(10);
    expect(sentBody()).toMatchObject({ max_tokens: 17_000 });
    expect(sentBody()).not.toHaveProperty("stream");
  });

  it("retries once at the model's own output ceiling when it rejects max_tokens", async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, statusText: "Bad Request", headers: { get: () => null }, json: () => Promise.resolve({ error: { message: "max_tokens: 9500 > 4000, which is the maximum allowed number of output tokens for claude-sonnet" } }) })
      .mockResolvedValueOnce(plainOk(2)) as unknown as typeof fetch;
    const result = await run(5);
    expect(result.drafts).toHaveLength(2);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);
    expect(sentBody(0)).toMatchObject({ max_tokens: 9_500 });
    expect(sentBody(1)).toMatchObject({ max_tokens: 4_000 });
  });

  it("retries a streamed batch at the ceiling too, and the retry is streamed", async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, statusText: "Bad Request", headers: { get: () => null }, json: () => Promise.resolve({ error: { message: "max_tokens: 100000 > 64000, which is the maximum allowed number of output tokens for claude-sonnet-4" } }) })
      .mockResolvedValueOnce(sseResponse([drafts(100)])) as unknown as typeof fetch;
    const result = await run(100);
    expect(result.drafts).toHaveLength(100);
    expect(sentBody(1)).toMatchObject({ max_tokens: 64_000, stream: true });
  });

  it("does not retry a 'ceiling' that is not below what was asked, so it can never loop", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, statusText: "Bad Request", headers: { get: () => null }, json: () => Promise.resolve({ error: { message: "max_tokens: 9500 > 99999, nonsense" } }) }) as unknown as typeof fetch;
    await expect(run(5)).rejects.toBeDefined();
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it("surfaces an error the provider reports inside a 200 stream instead of returning no drafts", async () => {
    global.fetch = jest.fn().mockResolvedValue(sseResponse([drafts(1).slice(0, 10)], { errorEvent: "Overloaded" })) as unknown as typeof fetch;
    await expect(run(30)).rejects.toThrow(/Overloaded/);
  });

  it("keeps the complete drafts when a streamed batch is cut off mid-object at the model's ceiling", async () => {
    const full = drafts(3);
    global.fetch = jest.fn().mockResolvedValue(sseResponse([full.slice(0, full.lastIndexOf("{") + 8)])) as unknown as typeof fetch;
    const result = await run(30);
    expect(result.drafts).toHaveLength(2);
  });

  it("parses the model's ceiling out of the rejection, and nothing else", () => {
    expect(statics.zyraModelTokenCeiling("max_tokens: 100000 > 64000, which is the maximum allowed number of output tokens for claude-sonnet-4")).toBe(64_000);
    expect(statics.zyraModelTokenCeiling("invalid x-api-key")).toBeNull();
    expect(statics.zyraModelTokenCeiling("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------
// Ticket paging
// ---------------------------------------------------------------------------------------------------

describe("zyraPlanTicketRound — one page of tickets planned into scenarios", () => {
  const ticketRows = (from: number, count: number): Body[] =>
    Array.from({ length: count }, (_, i) => ({ id: `id-${String(from + i).padStart(4, "0")}`, title: `PRJ-${from + i}: Ticket ${from + i}`, content_text: `Body of ticket ${from + i}` }));

  function setup(rows: Body[]) {
    const query = jest.fn(() => Promise.resolve({ rows })) as unknown as Query;
    const svc = makeLegacy(query);
    const planner = jest.spyOn(internals(svc), "planZyraChatScenarios").mockResolvedValue(["Scenario A", "Scenario B"]);
    jest.spyOn(internals(svc), "existingTestcaseSnapshot").mockResolvedValue([]);
    return { svc, query, planner };
  }
  const round = (svc: LegacyService, cursor: string | null) =>
    internals(svc).zyraPlanTicketRound({ projectId: "p1", provider: "openai", model: "m", key: {}, message: "all tickets", cursor });

  it("reads tickets in id order after the cursor, and hands only that page to the planner", async () => {
    const { svc, query, planner } = setup(ticketRows(1, 3));
    const result = await round(svc, "id-0000");
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/ORDER BY id\s+LIMIT \$3/);
    expect(sql).toMatch(/id > \$2::uuid/);
    expect(params).toEqual(["p1", "id-0000", statics.ZYRA_PLAN_TICKET_PAGE]);
    expect(planner).toHaveBeenCalledTimes(1);
    const planned = planner.mock.calls[0][0] as { knowledge: Array<{ title: string }>; maxScenarios: number };
    expect(planned.knowledge.map((k) => k.title)).toEqual(["PRJ-1: Ticket 1", "PRJ-2: Ticket 2", "PRJ-3: Ticket 3"]);
    expect(result).toMatchObject({ scenarios: ["Scenario A", "Scenario B"], cursor: "id-0003", hasMore: false, tickets: 3 });
  });

  it("is the last page when it comes back short, and has more when it comes back full", async () => {
    const full = setup(ticketRows(1, statics.ZYRA_PLAN_TICKET_PAGE));
    expect((await round(full.svc, null)).hasMore).toBe(true);
    const short = setup(ticketRows(1, statics.ZYRA_PLAN_TICKET_PAGE - 1));
    expect((await round(short.svc, null)).hasMore).toBe(false);
  });

  it("past the last ticket: nothing planned, no planner call, cursor unchanged, no more pages", async () => {
    const { svc, planner } = setup([]);
    expect(await round(svc, "id-9999")).toEqual({ scenarios: [], cursor: "id-9999", hasMore: false, tickets: 0 });
    expect(planner).not.toHaveBeenCalled();
  });

  it("a ticket with no body is still planned from its title", async () => {
    const { svc, planner } = setup([{ id: "id-1", title: "PRJ-1: Title only", content_text: null }]);
    await round(svc, null);
    expect((planner.mock.calls[0][0] as { knowledge: Array<{ content: string }> }).knowledge[0].content).toBe("");
  });

  it("a database failure throws, so the caller pauses instead of treating it as the end of the tickets", async () => {
    const query = jest.fn(() => Promise.reject(new Error("connection reset"))) as unknown as Query;
    await expect(round(makeLegacy(query), null)).rejects.toThrow("connection reset");
  });

  it("a planner failure throws and does not advance the cursor", async () => {
    const { svc, planner } = setup(ticketRows(1, 3));
    planner.mockRejectedValue(new Error("provider down"));
    await expect(round(svc, null)).rejects.toThrow("provider down");
  });
});

describe("zyraPlanFill — plans pages until a batch is full or the tickets run out", () => {
  const roundOf = (scenarios: string[], cursor: string, hasMore: boolean): Round => ({ scenarios, cursor, hasMore, tickets: 25 });
  const fill = (svc: LegacyService, over: Body = {}) =>
    internals(svc).zyraPlanFill({ projectId: "p1", provider: "openai", model: "m", key: {}, message: "all tickets", scenarios: [], cursor: null, target: 4, maxRounds: 4, ...over });

  it("stops as soon as the target is reached, keeping the cursor of the last page it planned", async () => {
    const svc = makeLegacy();
    const spy = jest.spyOn(internals(svc), "zyraPlanTicketRound")
      .mockResolvedValueOnce(roundOf(["a", "b"], "c1", true))
      .mockResolvedValueOnce(roundOf(["c", "d"], "c2", true))
      .mockResolvedValueOnce(roundOf(["e"], "c3", true));
    const result = await fill(svc);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ scenarios: ["a", "b", "c", "d"], cursor: "c2", hasMore: true });
  });

  it("stops when the tickets run out even though the target was not reached", async () => {
    const svc = makeLegacy();
    jest.spyOn(internals(svc), "zyraPlanTicketRound").mockResolvedValueOnce(roundOf(["a"], "c1", false));
    expect(await fill(svc)).toMatchObject({ scenarios: ["a"], cursor: "c1", hasMore: false });
  });

  it("is bounded by maxRounds, so a run of fully-covered pages returns its cursor instead of looping", async () => {
    const svc = makeLegacy();
    const spy = jest.spyOn(internals(svc), "zyraPlanTicketRound").mockImplementation(async (p) => roundOf([], `${String(p.cursor)}+`, true));
    const result = await fill(svc, { maxRounds: 3, cursor: "c" });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ scenarios: [], cursor: "c+++", hasMore: true });
  });

  it("drops a scenario a later page repeats, ignoring case and spacing", async () => {
    const svc = makeLegacy();
    jest.spyOn(internals(svc), "zyraPlanTicketRound")
      .mockResolvedValueOnce(roundOf(["Login works", "Logout works"], "c1", true))
      .mockResolvedValueOnce(roundOf(["login   WORKS", "Reset password"], "c2", false));
    expect((await fill(svc, { target: 99 })).scenarios).toEqual(["Login works", "Logout works", "Reset password"]);
  });

  it("keeps what is already queued and counts it toward the target", async () => {
    const svc = makeLegacy();
    const spy = jest.spyOn(internals(svc), "zyraPlanTicketRound").mockResolvedValueOnce(roundOf(["c"], "c1", true));
    const result = await fill(svc, { scenarios: ["a", "b", "x"], target: 4 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.scenarios).toEqual(["a", "b", "x", "c"]);
  });

  it("an error from a page propagates with nothing half-applied", async () => {
    const svc = makeLegacy();
    jest.spyOn(internals(svc), "zyraPlanTicketRound")
      .mockResolvedValueOnce(roundOf(["a"], "c1", true))
      .mockRejectedValueOnce(new Error("provider down"));
    await expect(fill(svc, { target: 99 })).rejects.toThrow("provider down");
  });
});

// ---------------------------------------------------------------------------------------------------
// Refill of a running paged plan
// ---------------------------------------------------------------------------------------------------

/** The same row-lock stand-in the plan-concurrency spec uses: one shared active_plan behind a mutex. */
function makePlanDb(initial: Body | null): { svc: LegacyService; plan: () => Body | null; messages: unknown[][] } {
  let activePlan = initial;
  const messages: unknown[][] = [];
  let chain: Promise<void> = Promise.resolve();
  const transaction = jest.fn((fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
    const prev = chain;
    let release: () => void = () => undefined;
    chain = new Promise((resolve) => { release = resolve; });
    return prev.then(async () => {
      const client = {
        query: jest.fn((sql: string, params: unknown[] = []) => {
          if (sql.includes("SELECT active_plan") && sql.includes("FOR UPDATE")) return Promise.resolve({ rows: [{ active_plan: activePlan }] });
          if (sql.includes("SET active_plan = NULL")) { activePlan = null; return Promise.resolve({ rows: [] }); }
          if (sql.includes("SET active_plan")) { activePlan = JSON.parse(String(params[1])); return Promise.resolve({ rows: [] }); }
          return Promise.resolve({ rows: [] });
        })
      };
      try { return await fn(client); } finally { release(); }
    });
  });
  const svc = makeLegacy(undefined, { transaction } as unknown as Partial<DatabaseService>);
  jest.spyOn(internals(svc), "postZyraPlanMessage").mockImplementation(async (...args) => { messages.push(args); });
  jest.spyOn(internals(svc), "notifyUsers").mockResolvedValue(undefined);
  return { svc, plan: () => activePlan, messages };
}

describe("zyraRefillPlan — a paged plan plans its next tickets when the queue can't fill a batch", () => {
  const base = (): Body => ({
    planId: "plan-1", status: "running", originalMessage: "generate for all tickets", batchSize: 50,
    remainingScenarios: ["q1", "q2"], doneCount: 10, coveredCount: 10, totalCount: 12,
    ticketCursor: "c1", ticketsHasMore: true
  });
  const stub = (svc: LegacyService, over: { knowledgeBase?: boolean; key?: Body | null } = {}) => {
    jest.spyOn(internals(svc), "zyraProjectCapabilities").mockResolvedValue({ knowledgeBase: over.knowledgeBase ?? true });
    jest.spyOn(internals(svc), "zyraAiAllocation").mockResolvedValue(over.key === null ? { reason: "No key" } : { key: over.key ?? { provider: "openai", default_model: "gpt-4o" } });
  };

  it("queues the new scenarios, grows the plan's total by what was added, and saves the cursor", async () => {
    const { svc, plan } = makePlanDb(base());
    stub(svc);
    const fill = jest.spyOn(internals(svc), "zyraPlanFill").mockResolvedValue({ scenarios: ["q1", "q2", "n1", "n2", "n3"], cursor: "c3", hasMore: true, tickets: 50 });
    expect(await internals(svc).zyraRefillPlan("p1", "u1", "s1", base(), 50)).toBe(true);
    expect(fill.mock.calls[0][0]).toMatchObject({ scenarios: ["q1", "q2"], cursor: "c1", target: 50, message: "generate for all tickets" });
    expect(plan()).toMatchObject({ remainingScenarios: ["q1", "q2", "n1", "n2", "n3"], totalCount: 15, ticketCursor: "c3", ticketsHasMore: true, doneCount: 10, status: "running" });
  });

  it("records the end of the tickets, so the plan can finish once the queue drains", async () => {
    const { svc, plan } = makePlanDb(base());
    stub(svc);
    jest.spyOn(internals(svc), "zyraPlanFill").mockResolvedValue({ scenarios: ["q1", "q2"], cursor: "c9", hasMore: false, tickets: 7 });
    expect(await internals(svc).zyraRefillPlan("p1", "u1", "s1", base(), 50)).toBe(true);
    expect(plan()).toMatchObject({ ticketsHasMore: false, totalCount: 12, ticketCursor: "c9" });
  });

  it("pauses with a message and keeps the cursor when planning fails, so 'continue' retries the same page", async () => {
    const { svc, plan, messages } = makePlanDb(base());
    stub(svc);
    jest.spyOn(internals(svc), "zyraPlanFill").mockRejectedValue(new Error("provider down"));
    expect(await internals(svc).zyraRefillPlan("p1", "u1", "s1", base(), 50)).toBe(false);
    expect(plan()).toMatchObject({ status: "paused", ticketCursor: "c1", ticketsHasMore: true, remainingScenarios: ["q1", "q2"] });
    expect(String(messages[0][4])).toMatch(/Pausing here/);
    expect(String(messages[0][4])).toMatch(/provider down/);
  });

  it("pauses when the project has no AI key any more", async () => {
    const { svc, plan } = makePlanDb(base());
    stub(svc, { key: null });
    const fill = jest.spyOn(internals(svc), "zyraPlanFill");
    expect(await internals(svc).zyraRefillPlan("p1", "u1", "s1", base(), 50)).toBe(false);
    expect(fill).not.toHaveBeenCalled();
    expect(plan()).toMatchObject({ status: "paused" });
  });

  it("with knowledge-base access turned off mid-plan, stops paging and keeps what is queued", async () => {
    const { svc, plan } = makePlanDb(base());
    stub(svc, { knowledgeBase: false });
    const fill = jest.spyOn(internals(svc), "zyraPlanFill");
    expect(await internals(svc).zyraRefillPlan("p1", "u1", "s1", base(), 50)).toBe(true);
    expect(fill).not.toHaveBeenCalled();
    expect(plan()).toMatchObject({ ticketsHasMore: false, remainingScenarios: ["q1", "q2"], ticketCursor: "c1" });
  });

  it("writes nothing when the plan was superseded while it was planning", async () => {
    // A new message replaced the plan (a new planId) while the planner call was in flight.
    const superseded: Body = { ...base(), planId: "plan-2" };
    const { svc, plan } = makePlanDb(superseded);
    stub(svc);
    jest.spyOn(internals(svc), "zyraPlanFill").mockResolvedValue({ scenarios: ["q1", "q2", "n"], cursor: "c2", hasMore: true, tickets: 25 });
    expect(await internals(svc).zyraRefillPlan("p1", "u1", "s1", base(), 50)).toBe(false);
    expect(plan()).toEqual(superseded);
  });

  it("writes nothing when another loop already advanced the plan (stale doneCount)", async () => {
    const advanced: Body = { ...base(), doneCount: 60 };
    const { svc, plan } = makePlanDb(advanced);
    stub(svc);
    jest.spyOn(internals(svc), "zyraPlanFill").mockResolvedValue({ scenarios: ["q1", "q2", "n"], cursor: "c2", hasMore: true, tickets: 25 });
    expect(await internals(svc).zyraRefillPlan("p1", "u1", "s1", base(), 50)).toBe(false);
    expect(plan()).toEqual(advanced);
  });
});

// ---------------------------------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------------------------------

describe("plan batch reply for a paged plan", () => {
  const reply = (over: Body) => statics.zyraPlanBatchReply({ drafted: 100, covered: 100, totalCount: 100, remaining: 0, requeued: 0, skipped: 0, unmapped: 0, ...over });

  it("is not a finish line while tickets are still to be planned, even with an empty queue", () => {
    const text = reply({ moreTickets: true });
    expect(text).toMatch(/100\/100 scenarios covered so far/);
    expect(text).toMatch(/More tickets are still to be planned/);
    expect(text).not.toMatch(/all 100 scenarios are now covered/);
  });

  it("is unchanged for a plan that is not paged", () => {
    expect(reply({})).toMatch(/all 100 scenarios are now covered/);
    expect(reply({ remaining: 20, totalCount: 120 })).toMatch(/Still working on the remaining 20/);
  });

  it("still reports retried and skipped scenarios on a paged plan", () => {
    expect(reply({ moreTickets: true, requeued: 3 })).toMatch(/3 scenario\(s\) in this batch came back without a test case/);
  });
});
