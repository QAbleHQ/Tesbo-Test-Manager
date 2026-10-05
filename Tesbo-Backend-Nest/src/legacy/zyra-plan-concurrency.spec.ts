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
 * Direct coverage for zyraPlanTransition / zyraSupersedePlan — the row-lock mechanism added to close
 * a confirmed race: continueZyraChatPlan (the background "generate all possible cases" batch loop)
 * never claimed sendZyraChatMessage's processing_since lock, so an interactive turn and a running
 * plan could write zyra_chat_sessions.active_plan concurrently, with only a non-atomic
 * read-then-later-write planId check as protection.
 *
 * This does not drive the full HTTP stack (that would make the actual race timing-dependent and
 * flaky) — it proves the mutual-exclusion PROPERTY directly: a fake `transaction()` that genuinely
 * serializes concurrent callers on one mutex (the same way Postgres serializes two `SELECT ... FOR
 * UPDATE` callers on the same row) backs a shared in-memory `active_plan` value, so two overlapping
 * calls interleave for real — deterministically, not by chance timing — and the assertions are on
 * what each one actually observed and wrote.
 */

/** A FIFO mutex standing in for Postgres row-locking one zyra_chat_sessions row via FOR UPDATE. */
function makeRowLockedDb(initialActivePlan: Record<string, unknown> | null): { db: DatabaseService; getActivePlan: () => Record<string, unknown> | null } {
  let activePlan = initialActivePlan;
  let chain: Promise<void> = Promise.resolve();

  const db = {
    query: jest.fn(() => Promise.resolve({ rows: [] })),
    transaction: jest.fn((fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
      const prev = chain;
      let release: () => void = () => undefined;
      chain = new Promise((resolve) => {
        release = resolve;
      });
      return prev.then(async () => {
        const client = {
          query: jest.fn((sql: string, params: unknown[] = []) => {
            if (sql.includes("SELECT active_plan") && sql.includes("FOR UPDATE")) {
              return Promise.resolve({ rows: [{ active_plan: activePlan }] });
            }
            if (sql.includes("UPDATE zyra_chat_sessions SET active_plan = NULL")) {
              activePlan = null;
              return Promise.resolve({ rows: [] });
            }
            if (sql.includes("UPDATE zyra_chat_sessions SET active_plan")) {
              activePlan = JSON.parse(String(params[1]));
              return Promise.resolve({ rows: [] });
            }
            // INSERT INTO zyra_chat_messages / plain UPDATE updated_at from postZyraPlanMessage —
            // not relevant to the lock itself, just needs to resolve.
            return Promise.resolve({ rows: [] });
          })
        };
        try {
          return await fn(client);
        } finally {
          release();
        }
      });
    })
  } as unknown as DatabaseService;

  return { db, getActivePlan: () => activePlan };
}

function makeLegacy(db: DatabaseService): LegacyService {
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
    {} as unknown as CustomFieldsService,
    {} as unknown as CustomTagsService
  );
}

type Internals = {
  zyraPlanTransition: (
    sessionId: string,
    planId: string,
    expectedDoneCount: number | null,
    apply: (client: { query: jest.Mock }, current: Record<string, unknown>) => Promise<void>
  ) => Promise<boolean>;
  zyraSupersedePlan: (sessionId: string) => Promise<void>;
  postZyraPlanMessage: (
    client: { query: jest.Mock },
    projectId: string,
    sessionId: string,
    userId: string | null,
    reply: string,
    testcases: unknown[],
    activity: unknown[],
    actionType?: "create" | "answer",
    trace?: unknown,
    reviewRequestId?: string | null
  ) => Promise<void>;
};

function internals(svc: LegacyService): Internals {
  return svc as unknown as Internals;
}

describe("Zyra plan concurrency (zyraPlanTransition / zyraSupersedePlan)", () => {
  it("commits when planId and doneCount both still match under the lock", async () => {
    const { db, getActivePlan } = makeRowLockedDb({ planId: "plan-1", doneCount: 5, totalCount: 20, status: "running" });
    const svc = makeLegacy(db);

    const applied = await internals(svc).zyraPlanTransition("session-1", "plan-1", 5, async (client, current) => {
      await client.query("UPDATE zyra_chat_sessions SET active_plan = $2::jsonb WHERE id = $1", [
        "session-1",
        JSON.stringify({ ...current, doneCount: 10 })
      ]);
    });

    expect(applied).toBe(true);
    expect((getActivePlan() as Record<string, unknown>).doneCount).toBe(10);
  });

  it("does not apply, and does not write, when the planId no longer matches (superseded by a new message)", async () => {
    const { db, getActivePlan } = makeRowLockedDb({ planId: "plan-2", doneCount: 5, totalCount: 20, status: "running" });
    const svc = makeLegacy(db);
    const applyFn = jest.fn();

    const applied = await internals(svc).zyraPlanTransition("session-1", "plan-1-stale", 5, applyFn);

    expect(applied).toBe(false);
    expect(applyFn).not.toHaveBeenCalled();
    // The row is untouched — a discarded batch's own drafts are still staged elsewhere
    // (applyZyraChatOperations already ran before this point), just nothing about it is written here.
    expect(getActivePlan()).toEqual({ planId: "plan-2", doneCount: 5, totalCount: 20, status: "running" });
  });

  it("does not apply when doneCount has already moved past what this caller expected (duplicate loop instance)", async () => {
    const { db } = makeRowLockedDb({ planId: "plan-1", doneCount: 15, totalCount: 20, status: "running" });
    const svc = makeLegacy(db);
    const applyFn = jest.fn();

    // This caller started its batch believing doneCount was 5 — some other instance already
    // advanced it to 15 in the meantime (a concurrent loop for the SAME planId).
    const applied = await internals(svc).zyraPlanTransition("session-1", "plan-1", 5, applyFn);

    expect(applied).toBe(false);
    expect(applyFn).not.toHaveBeenCalled();
  });

  /*
   * The actual race this phase closes, proven under genuine interleaving rather than asserted from
   * reading the code: two "commit" attempts for the identical planId + expectedDoneCount fire at the
   * same instant (Promise.all — both already past their own async work, both about to write). Only
   * ONE may win; the other must observe the post-write state and back off, not stomp it.
   */
  it("under real overlapping calls, exactly one of two identical concurrent commits wins", async () => {
    const { db, getActivePlan } = makeRowLockedDb({ planId: "plan-1", doneCount: 5, totalCount: 20, status: "running" });
    const svc = makeLegacy(db);

    const attempt = (label: string) =>
      internals(svc).zyraPlanTransition("session-1", "plan-1", 5, async (client, current) => {
        await client.query("UPDATE zyra_chat_sessions SET active_plan = $2::jsonb WHERE id = $1", [
          "session-1",
          JSON.stringify({ ...current, doneCount: 10, winner: label })
        ]);
      });

    const [resultA, resultB] = await Promise.all([attempt("A"), attempt("B")]);

    // Exactly one committed — never both (double-advance) and never neither (the batch's work lost).
    expect([resultA, resultB].filter(Boolean)).toHaveLength(1);
    const finalPlan = getActivePlan() as Record<string, unknown>;
    expect(finalPlan.doneCount).toBe(10);
    // The winner's write is exactly what landed — not a merge, not corrupted by the loser.
    expect(["A", "B"]).toContain(finalPlan.winner);
  });

  it("zyraSupersedePlan clears whatever plan is active regardless of its planId", async () => {
    const { db, getActivePlan } = makeRowLockedDb({ planId: "plan-anything", doneCount: 1, totalCount: 2, status: "running" });
    const svc = makeLegacy(db);

    await internals(svc).zyraSupersedePlan("session-1");

    expect(getActivePlan()).toBeNull();
  });

  it("zyraSupersedePlan no-ops (and writes nothing) when there is nothing active", async () => {
    const { db } = makeRowLockedDb(null);
    const svc = makeLegacy(db);
    const updateCalls: unknown[] = [];
    (db.transaction as jest.Mock).mockImplementationOnce(async (fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
      const client = {
        query: jest.fn((sql: string) => {
          if (sql.includes("FOR UPDATE")) return Promise.resolve({ rows: [{ active_plan: null }] });
          updateCalls.push(sql);
          return Promise.resolve({ rows: [] });
        })
      };
      return fn(client);
    });

    await internals(svc).zyraSupersedePlan("session-1");

    expect(updateCalls).toHaveLength(0);
  });

  /*
   * Two triggers racing to resume the SAME paused plan (an explicit "Resume" click and a server
   * restart's resumeInterruptedZyraChatPlans) both change planId under the lock — only one can win,
   * proven the same way as the batch-commit race above: real overlapping calls, not asserted timing.
   */
  it("under real overlapping resume attempts, only one reactivation wins", async () => {
    const { db, getActivePlan } = makeRowLockedDb({ planId: "old-plan", doneCount: 5, totalCount: 20, status: "paused", remainingScenarios: ["a", "b"] });
    const svc = makeLegacy(db);

    const attemptResume = (newPlanId: string) =>
      internals(svc).zyraPlanTransition("session-1", "old-plan", null, async (client, current) => {
        if (current.status !== "paused") throw new Error("ZYRA_PLAN_NOT_PAUSED");
        await client.query("UPDATE zyra_chat_sessions SET active_plan = $2::jsonb WHERE id = $1", [
          "session-1",
          JSON.stringify({ ...current, planId: newPlanId, status: "running" })
        ]);
      }).catch((err) => {
        if (err instanceof Error && err.message === "ZYRA_PLAN_NOT_PAUSED") return false;
        throw err;
      });

    const [resultA, resultB] = await Promise.all([attemptResume("resume-A"), attemptResume("resume-B")]);

    expect([resultA, resultB].filter(Boolean)).toHaveLength(1);
    const finalPlan = getActivePlan() as Record<string, unknown>;
    expect(finalPlan.status).toBe("running");
    expect(["resume-A", "resume-B"]).toContain(finalPlan.planId);
  });

  /*
   * Regression found by review: postZyraPlanMessage used to hardcode action_type = 'create' for
   * every plan message, including pure status/progress ones (stop, resume, no key, capability
   * disabled, paused-on-error) that always carry testcases: []. With that literal, every one of
   * those tripped the frontend's missingStructuredData defense-in-depth guard (page.tsx) — a user
   * clicking Stop would see "Stopped at your request..." immediately followed by "Zyra didn't
   * return structured data for this reply" on a message that was never supposed to carry any.
   */
  describe("postZyraPlanMessage action_type", () => {
    function makeClient(): { query: jest.Mock; inserted: () => Record<string, unknown> | null } {
      let inserted: Record<string, unknown> | null = null;
      const query = jest.fn((sql: string, params: unknown[] = []) => {
        if (sql.includes("INSERT INTO zyra_chat_messages")) {
          inserted = { content: params[3], actionType: params[5], testcases: JSON.parse(String(params[6])) };
        }
        return Promise.resolve({ rows: [] });
      });
      return { query, inserted: () => inserted };
    }

    it("defaults to 'answer' for a pure status message with no testcases", async () => {
      const svc = makeLegacy({ query: jest.fn(() => Promise.resolve({ rows: [] })) } as unknown as DatabaseService);
      const client = makeClient();
      await internals(svc).postZyraPlanMessage(client, "project-1", "session-1", "user-1", "Stopped at your request — 5/20 scenarios covered.", [], []);
      expect(client.inserted()?.actionType).toBe("answer");
    });

    it("uses 'create' only when the caller explicitly passes it (a batch that genuinely staged rows)", async () => {
      const svc = makeLegacy({ query: jest.fn(() => Promise.resolve({ rows: [] })) } as unknown as DatabaseService);
      const client = makeClient();
      await internals(svc).postZyraPlanMessage(client, "project-1", "session-1", "user-1", "Here are 5 more test case(s)...", [{ id: null, title: "A case" }], [], "create");
      expect(client.inserted()?.actionType).toBe("create");
      expect(client.inserted()?.testcases as unknown[]).toHaveLength(1);
    });

    it("a 'batch saved nothing' message (testcases: []) still defaults to 'answer' even on the success-path call site's own explicit branching", async () => {
      // Mirrors continueZyraChatPlan's own call: testcases.length ? "create" : "answer".
      const svc = makeLegacy({ query: jest.fn(() => Promise.resolve({ rows: [] })) } as unknown as DatabaseService);
      const client = makeClient();
      const testcases: unknown[] = [];
      await internals(svc).postZyraPlanMessage(client, "project-1", "session-1", "user-1", "This batch saved nothing...", testcases, [], testcases.length ? "create" : "answer");
      expect(client.inserted()?.actionType).toBe("answer");
    });
  });

  /*
   * "All – Exhaustive" batches after the first showed "N test cases drafted for review" with nothing
   * under them: this insert never wrote review_request_id, and the chat renders proposed rows only
   * inside a review panel addressed by that column. e2e ZCC-B-17 proves it through the real loop.
   */
  describe("postZyraPlanMessage review_request_id", () => {
    function makeClient(): { query: jest.Mock; inserted: () => { sql: string; reviewRequestId: unknown } | null } {
      let inserted: { sql: string; reviewRequestId: unknown } | null = null;
      const query = jest.fn((sql: string, params: unknown[] = []) => {
        if (sql.includes("INSERT INTO zyra_chat_messages")) inserted = { sql, reviewRequestId: params[9] };
        return Promise.resolve({ rows: [] });
      });
      return { query, inserted: () => inserted };
    }

    it("stores the batch's review request id on a batch message", async () => {
      const svc = makeLegacy({ query: jest.fn(() => Promise.resolve({ rows: [] })) } as unknown as DatabaseService);
      const client = makeClient();
      await internals(svc).postZyraPlanMessage(client, "project-1", "session-1", "user-1", "Here are 5 more test case(s)...", [{ id: null, title: "A case", action: "proposed-create", reviewRequestId: "req-2" }], [], "create", null, "req-2");
      expect(client.inserted()?.sql).toMatch(/review_request_id\)\s*VALUES/);
      expect(client.inserted()?.reviewRequestId).toBe("req-2");
    });

    it("stores no review link on a status message", async () => {
      const svc = makeLegacy({ query: jest.fn(() => Promise.resolve({ rows: [] })) } as unknown as DatabaseService);
      const client = makeClient();
      await internals(svc).postZyraPlanMessage(client, "project-1", "session-1", "user-1", "Stopped at your request — 5/20 scenarios covered.", [], []);
      expect(client.inserted()?.reviewRequestId).toBeNull();
    });
  });

  /*
   * A batch asked for 5 scenarios came back with 4 drafts in most batches of a real exhaustive run,
   * and nothing knew which scenario was missing — it was neither retried nor reported. Each draft now
   * names its scenario, so the missing one is retried once, and progress counts only covered ones.
   */
  describe("plan batch accounting", () => {
    type Outcome = (batch: string[], draftScenarios: Array<number | null>, retried: string[]) => { covered: number; requeue: string[]; skipped: number; unmapped: number };
    type Reply = (p: { drafted: number; covered: number; totalCount: number; remaining: number; requeued: number; skipped: number; unmapped: number }) => string;
    const outcome = (LegacyService as unknown as { zyraPlanBatchOutcome: Outcome }).zyraPlanBatchOutcome;
    const reply = (LegacyService as unknown as { zyraPlanBatchReply: Reply }).zyraPlanBatchReply;
    const batch = ["A", "B", "C", "D", "E"];

    it("finds exactly which scenario came back without a draft and queues it for one retry", () => {
      expect(outcome(batch, [1, 2, 4, 5], [])).toEqual({ covered: 4, requeue: ["C"], skipped: 0, unmapped: 0 });
    });

    it("gives up on a scenario that comes back empty on its retry instead of looping", () => {
      expect(outcome(["C", "F"], [2], ["C"])).toEqual({ covered: 1, requeue: [], skipped: 1, unmapped: 0 });
    });

    it("counts two drafts for the same scenario once, and still finds the one left out", () => {
      expect(outcome(batch, [1, 1, 2, 3, 5], [])).toEqual({ covered: 4, requeue: ["D"], skipped: 0, unmapped: 0 });
    });

    it("retries every scenario of a batch that drafted nothing", () => {
      expect(outcome(["A", "B"], [], [])).toEqual({ covered: 0, requeue: ["A", "B"], skipped: 0, unmapped: 0 });
    });

    it("only counts the shortfall when a draft has no valid scenario number — nothing to retry", () => {
      expect(outcome(batch, [1, null, 3, 4], [])).toEqual({ covered: 4, requeue: [], skipped: 0, unmapped: 1 });
      expect(outcome(batch, [1, 2, 3, 9], [])).toEqual({ covered: 4, requeue: [], skipped: 0, unmapped: 1 });
    });

    it("keeps the original wording when every scenario in the batch produced a test case", () => {
      expect(reply({ drafted: 5, covered: 10, totalCount: 49, remaining: 39, requeued: 0, skipped: 0, unmapped: 0 })).toBe(
        "Here are 5 more test case(s) — 10/49 scenarios covered so far. Still working on the remaining 39; I'll post the next batch shortly."
      );
      expect(reply({ drafted: 4, covered: 49, totalCount: 49, remaining: 0, requeued: 0, skipped: 0, unmapped: 0 })).toBe(
        "Here are the final 4 test case(s) — all 49 scenarios are now covered. Feel free to review and let me know if you'd like any changes."
      );
    });

    it("counts only covered scenarios and says a dropped one will be retried", () => {
      const text = reply({ drafted: 4, covered: 14, totalCount: 100, remaining: 86, requeued: 1, skipped: 0, unmapped: 0 });
      expect(text).toContain("Here are 4 more test case(s) — 14/100 scenarios covered so far.");
      expect(text).toContain("1 scenario(s) in this batch came back without a test case and will be retried in a later batch.");
    });

    it("never calls the plan fully covered when scenarios were given up", () => {
      const text = reply({ drafted: 2, covered: 98, totalCount: 100, remaining: 0, requeued: 0, skipped: 1, unmapped: 0 });
      expect(text).toContain("98 of 100 scenarios are covered; 2 produced no test case.");
      expect(text).toContain("1 scenario(s) still produced no test case after a retry and were skipped.");
      expect(text).not.toContain("now covered");
    });

    it("asks the batch generator to number each draft by the scenario it covers", () => {
      const svc = makeLegacy({ query: jest.fn(() => Promise.resolve({ rows: [] })) } as unknown as DatabaseService);
      const message = (svc as unknown as { zyraBatchMessage: (m: string, b: string[]) => string }).zyraBatchMessage("Generate all", ["A", "B"]);
      expect(message).toContain("1. A\n2. B");
      expect(message).toContain("already checked against the existing testcases");
      expect(message).toContain('Set "scenario" on every draft to the number (1-2)');
    });
  });
});

/*
 * "All – Exhaustive" should plan close to 100 scenarios. The planner was told "List up to 100", and
 * a real run planned 49 — the model stops where it feels done, so 100 was only ever a ceiling.
 */
describe("planZyraChatScenarios targets the exhaustive ceiling", () => {
  type Plan = (p: Record<string, unknown>) => Promise<string[]>;
  const labels = (from: number, count: number) => Array.from({ length: count }, (_, i) => `Scenario ${from + i}`);

  function setup(replies: Array<unknown | Error>) {
    const svc = makeLegacy({ query: jest.fn(() => Promise.resolve({ rows: [] })) } as unknown as DatabaseService);
    const prompts: string[] = [];
    const completion = jest.fn((_p: string, _m: string, _k: unknown, _s: string, user: string) => {
      prompts.push(user);
      const next = replies.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next as Record<string, unknown>);
    });
    const internal = svc as unknown as { zyraJsonCompletion: typeof completion; planZyraChatScenarios: Plan };
    internal.zyraJsonCompletion = completion;
    const plan = () => internal.planZyraChatScenarios.call(svc, { projectId: "project-1", provider: "openai", model: "m", key: {}, message: "Generate all possible cases", knowledge: [], existingTestcases: [], maxScenarios: 100 });
    return { plan, prompts, completion };
  }

  it("asks for the target, not 'up to' it", async () => {
    const { plan, prompts } = setup([{ scenarios: labels(1, 100) }]);
    expect(await plan()).toHaveLength(100);
    expect(prompts[0]).toContain("List 100 scenarios");
    expect(prompts[0]).not.toContain("List up to");
    expect(prompts[0]).toContain("until you reach 100");
  });

  it("tops up a plan that stopped well short, without repeating what it already has", async () => {
    // 49 first, then 60 more of which 5 repeat the first list (one with different case/spacing).
    const repeats = ["scenario 1", "Scenario  2", "Scenario 3", "Scenario 4", "Scenario 5"];
    const { plan, prompts, completion } = setup([{ scenarios: labels(1, 49) }, { scenarios: [...repeats, ...labels(50, 55)] }]);
    const result = await plan();
    expect(completion).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toContain("49. Scenario 49");
    expect(prompts[1]).toContain("up to 51 MORE distinct scenarios");
    expect(result).toHaveLength(100);
    expect(new Set(result.map((l) => l.toLowerCase().replace(/\s+/g, " "))).size).toBe(100);
    expect(result.slice(0, 49)).toEqual(labels(1, 49));
  });

  it("does not pad when the top-up finds nothing more", async () => {
    const { plan } = setup([{ scenarios: labels(1, 30) }, { scenarios: [] }]);
    expect(await plan()).toEqual(labels(1, 30));
  });

  it("skips the top-up once the plan is near the target", async () => {
    const { plan, completion } = setup([{ scenarios: labels(1, 92) }]);
    expect(await plan()).toHaveLength(92);
    expect(completion).toHaveBeenCalledTimes(1);
  });

  it("keeps the first plan when the top-up call fails", async () => {
    const { plan } = setup([{ scenarios: labels(1, 40) }, new Error("provider timeout")]);
    expect(await plan()).toEqual(labels(1, 40));
  });

  it("leaves a too-small plan to the single-batch fallback instead of topping it up", async () => {
    const { plan, completion } = setup([{ scenarios: ["Only one"] }]);
    expect(await plan()).toEqual(["Only one"]);
    expect(completion).toHaveBeenCalledTimes(1);
  });
});
