/*
 * Review Board backend, exercised against a REAL Postgres: real migrations, real SQL, real LegacyService
 * (membership / roles / test-case update) and real PlanLimitsService (effective-plan logic).
 *
 * Opt-in, and deliberately hard to point at the wrong database. It only runs when
 * REVIEW_BOARD_TEST_DATABASE_URL is set, and refuses unless the host is loopback AND the database name
 * starts with "rb_test" — a throwaway database that has had every migration applied (npm run migrate:dev).
 * It never reads DATABASE_URL, so a shell that happens to have the app's database configured cannot be hit.
 *
 * Without the variable the whole suite is skipped, so a plain `npm test` is unaffected.
 *
 * Stubbed: Redis caches, the BullMQ queue (the worker entry point runAnalysis() is called directly, and the
 * processor is covered separately), and the LegacyService collaborators this feature never reaches.
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Pool } from "pg";
import { DatabaseService } from "../database/database.service";
import { LegacyService } from "../legacy/legacy.service";
import { PlanLimitsService } from "../plan-limits/plan-limits.service";
import { ProjectLookupService } from "../request-cache/project-lookup.service";
import { RequestCacheService } from "../request-cache/request-cache.service";
import { MAX_PAIRS_PER_RUN, MAX_TESTCASES_PER_RUN, REVIEW_BOARD_JOB } from "./review-board.constants";
import { ReviewBoardProcessor } from "./review-board.processor";
import { ReviewBoardService } from "./review-board.service";

const URL_ENV = process.env.REVIEW_BOARD_TEST_DATABASE_URL;
const suite = URL_ENV ? describe : describe.skip;

type Any = any;

suite("review board (real Postgres)", () => {
  jest.setTimeout(60_000);

  let pool: Pool;
  let db: DatabaseService;
  let svc: ReviewBoardService;
  let queue: { add: jest.Mock };
  let seq = 0;

  beforeAll(() => {
    const parsed = new URL(URL_ENV as string);
    const dbName = parsed.pathname.replace(/^\//, "");
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname) || !dbName.startsWith("rb_test")) {
      throw new Error(`Refusing to run: ${parsed.hostname}/${dbName} is not a loopback database named rb_test*.`);
    }
    pool = new Pool({ connectionString: URL_ENV, max: 12 });
    db = new DatabaseService(pool);

    const requestCache = new RequestCacheService({} as Any);
    const entitlementCache = { get: async () => undefined, set: async () => undefined, invalidate: async () => undefined };
    const planLimits = new PlanLimitsService(db, {} as Any, {} as Any, requestCache, entitlementCache as Any);
    const invalidating = { invalidate: async () => undefined };
    const legacy = new LegacyService(
      db,
      {} as Any, {} as Any, {} as Any, {} as Any, {} as Any, {} as Any, {} as Any, {} as Any,
      planLimits,
      requestCache,
      new ProjectLookupService(db, requestCache),
      {} as Any,
      invalidating as Any,
      invalidating as Any,
      invalidating as Any,
      { setValuesForTestCase: async () => undefined } as Any,
      { setTagsForTestCase: async () => undefined } as Any
    );
    (legacy as Any).enqueueTestcaseEmbedding = () => undefined;
    queue = { add: jest.fn().mockResolvedValue({}) };
    svc = new ReviewBoardService(db, planLimits, legacy, invalidating as Any, invalidating as Any, queue as Any);
  });

  afterAll(async () => {
    await pool?.end();
  });

  // ------------------------------------------------------------------ fixtures

  interface World {
    orgId: string;
    projectId: string;
    owner: string;
    manager: string;
    qa: string;
    viewer: string; // a role the code does not know
    outsider: string; // member of no project
    suiteId: string;
  }

  const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

  async function mkUser(orgId: string, projectId: string | null, role: string | null): Promise<string> {
    seq += 1;
    const u = await one("INSERT INTO users (email, name, active_organization_id) VALUES ($1, 'U', $2) RETURNING id", [`rb-${Date.now()}-${seq}@example.test`, orgId]);
    await pool.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, u.id]);
    if (projectId && role) await pool.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)", [projectId, u.id, role]);
    return u.id;
  }

  async function world(plan: "pro" | "launch" = "pro"): Promise<World> {
    seq += 1;
    const org = await one("INSERT INTO organizations (name, slug, plan) VALUES ('RB Org', $1, $2) RETURNING id", [`rb-org-${Date.now()}-${seq}`, plan]);
    const project = await one("INSERT INTO projects (organization_id, name, key) VALUES ($1, 'Repo One', $2) RETURNING id", [org.id, `P${seq}`.slice(0, 10)]);
    const suite = await one("INSERT INTO suites (project_id, name) VALUES ($1, 'Suite') RETURNING id", [project.id]);
    return {
      orgId: org.id,
      projectId: project.id,
      suiteId: suite.id,
      owner: await mkUser(org.id, project.id, "owner"),
      manager: await mkUser(org.id, project.id, "manager"),
      qa: await mkUser(org.id, project.id, "qa_engineer"),
      viewer: await mkUser(org.id, project.id, "viewer"),
      outsider: await mkUser(org.id, null, null)
    };
  }

  const LOGIN_STEPS = [
    { action: "Open the login page", expectedResult: "Form is shown" },
    { action: "Submit valid credentials", expectedResult: "Dashboard opens" }
  ];

  async function mkCase(projectId: string, over: Record<string, unknown> = {}): Promise<string> {
    seq += 1;
    const v = {
      title: "Login with valid credentials",
      preconditions: "User exists",
      postconditions: null,
      test_data: "user=alice",
      steps: JSON.stringify(LOGIN_STEPS),
      suite_id: null,
      owner_id: null,
      ...over
    };
    const r = await one(
      `INSERT INTO testcases (project_id, external_id, title, preconditions, postconditions, test_data, steps, suite_id, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9) RETURNING id`,
      [projectId, `TC-${seq}-${Math.floor(Math.random() * 1e6)}`, v.title, v.preconditions, v.postconditions, v.test_data, v.steps, v.suite_id, v.owner_id]
    );
    return r.id;
  }

  async function analyseNow(w: World, as = w.owner) {
    const started = await svc.startAnalysis(as, w.projectId);
    await svc.runAnalysis(started.analysis!.id);
    return (await svc.getLatestAnalysis(as, w.projectId)).analysis!;
  }

  const list = (w: World, query: Any = { status: "pending,kept,edited,removed,obsolete" }, as = w.owner) => svc.listRecommendations(as, w.projectId, query);
  const statusOf = async (id: string) => (await one("SELECT review_status FROM review_recommendations WHERE id = $1", [id])).review_status;

  /** A world with one Pro project and one exact-duplicate pair, analysed. */
  async function withPair() {
    const w = await world();
    const a = await mkCase(w.projectId, { suite_id: w.suiteId, owner_id: w.owner });
    const b = await mkCase(w.projectId);
    await analyseNow(w);
    const items = (await list(w)).items;
    expect(items).toHaveLength(1);
    return { w, a, b, rec: items[0] };
  }

  // ------------------------------------------------------------- schema

  describe("migration V141 — constraints and indexes", () => {
    it("rejects an out-of-order pair, a duplicate pair, and bad enum values", async () => {
      const w = await world();
      const x = await mkCase(w.projectId);
      const y = await mkCase(w.projectId);
      const [lo, hi] = x < y ? [x, y] : [y, x];
      const ins = (a: string, b: string, cls = "similar", st = "pending") =>
        pool.query(
          `INSERT INTO review_recommendations (project_id, testcase_a_id, testcase_b_id, classification, similarity, explanation, fingerprint_a, fingerprint_b, review_status)
           VALUES ($1, $2, $3, $4, 0.9, 'x', 'f', 'f', $5)`,
          [w.projectId, a, b, cls, st]
        );
      await expect(ins(hi, lo)).rejects.toMatchObject({ code: "23514" }); // ordered_pair check
      await ins(lo, hi);
      await expect(ins(lo, hi)).rejects.toMatchObject({ code: "23505" }); // unique pair
      await expect(ins(lo, hi, "bogus")).rejects.toMatchObject({ code: "23514" }); // classification check, evaluated before the unique index
      const z = await mkCase(w.projectId);
      const [lo2, hi2] = x < z ? [x, z] : [z, x];
      await expect(ins(lo2, hi2, "similar", "bogus")).rejects.toMatchObject({ code: "23514" });
    });

    it("allows only one queued/running run per project, but any number of finished ones", async () => {
      const w = await world();
      const other = await world();
      await pool.query("INSERT INTO review_analysis_runs (project_id, status) VALUES ($1, 'running')", [w.projectId]);
      await expect(pool.query("INSERT INTO review_analysis_runs (project_id, status) VALUES ($1, 'queued')", [w.projectId])).rejects.toMatchObject({ code: "23505" });
      await pool.query("INSERT INTO review_analysis_runs (project_id, status) VALUES ($1, 'running')", [other.projectId]); // other project is independent
      await pool.query("UPDATE review_analysis_runs SET status = 'completed' WHERE project_id = $1", [w.projectId]);
      await pool.query("INSERT INTO review_analysis_runs (project_id, status) VALUES ($1, 'completed')", [w.projectId]);
      await pool.query("INSERT INTO review_analysis_runs (project_id, status) VALUES ($1, 'failed')", [w.projectId]);
      await expect(pool.query("INSERT INTO review_analysis_runs (project_id, status) VALUES ($1, 'weird')", [w.projectId])).rejects.toMatchObject({ code: "23514" });
    });

    it("cascades when a test case is hard-deleted, and has the expected indexes", async () => {
      const { a, rec } = await withPair();
      await pool.query("DELETE FROM testcases WHERE id = $1", [a]);
      expect(await one("SELECT count(*)::int AS n FROM review_recommendations WHERE id = $1", [rec.id])).toEqual({ n: 0 });
      const idx = (await pool.query("SELECT indexname FROM pg_indexes WHERE tablename IN ('review_recommendations','review_analysis_runs')")).rows.map((r) => r.indexname);
      expect(idx).toEqual(expect.arrayContaining(["idx_review_runs_one_active", "idx_review_recs_project_status", "idx_review_recs_testcase_a", "idx_review_recs_testcase_b", "review_recommendations_unique_pair"]));
    });
  });

  // ------------------------------------------------------------- access

  describe("access control (project membership, effective Pro plan, role) on every endpoint", () => {
    async function everyEndpoint(w: World, as: string, recId: string, a: string) {
      return [
        () => svc.getLatestAnalysis(as, w.projectId),
        () => svc.startAnalysis(as, w.projectId),
        () => svc.listRecommendations(as, w.projectId, {}),
        () => svc.listHistory(as, w.projectId, {}),
        () => svc.keep(as, w.projectId, recId),
        () => svc.edit(as, w.projectId, recId, { testcaseId: a, title: "x", confirm: true }),
        () => svc.remove(as, w.projectId, recId, { testcaseId: a, confirm: true })
      ];
    }

    it("lets a Pro owner and a Pro manager in", async () => {
      const { w } = await withPair();
      await expect(svc.getLatestAnalysis(w.owner, w.projectId)).resolves.toBeDefined();
      await expect(svc.listRecommendations(w.manager, w.projectId, {})).resolves.toBeDefined();
    });

    it("rejects a QA engineer, and a role the code does not recognise, on every endpoint (403)", async () => {
      const { w, a, rec } = await withPair();
      for (const user of [w.qa, w.viewer]) {
        for (const call of await everyEndpoint(w, user, rec.id, a)) await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
      }
      expect(await statusOf(rec.id)).toBe("pending");
      expect(await one("SELECT deleted_at FROM testcases WHERE id = $1", [a])).toEqual({ deleted_at: null });
    });

    it("rejects a Launch workspace on every endpoint, even for its owner (403, Pro message)", async () => {
      const w = await world("launch");
      const a = await mkCase(w.projectId);
      const rec = "00000000-0000-4000-8000-000000000001";
      for (const call of await everyEndpoint(w, w.owner, rec, a)) {
        await expect(call()).rejects.toMatchObject({ response: { error: expect.stringMatching(/Pro plan/) } });
      }
    });

    it("honours the grace period (effective plan), so a just-downgraded workspace is still allowed", async () => {
      const w = await world("launch");
      await pool.query("UPDATE organizations SET plan_grace_ends_at = now() + interval '1 day' WHERE id = $1", [w.orgId]);
      await expect(svc.getLatestAnalysis(w.owner, w.projectId)).resolves.toBeDefined();
      await pool.query("UPDATE organizations SET plan_grace_ends_at = now() - interval '1 day' WHERE id = $1", [w.orgId]);
      await expect(svc.getLatestAnalysis(w.owner, w.projectId)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("answers 404 to a user who is not a member of the project, and to a malformed project id", async () => {
      const { w } = await withPair();
      await expect(svc.getLatestAnalysis(w.outsider, w.projectId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.getLatestAnalysis(w.owner, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("never lets a recommendation be reached through another project, even for a member of both", async () => {
      const { w, a, rec } = await withPair();
      // The same owner is also an owner of a second project in the same workspace.
      const p2 = await one("INSERT INTO projects (organization_id, name, key) VALUES ($1, 'Repo Two', $2) RETURNING id", [w.orgId, `Q${++seq}`.slice(0, 10)]);
      await pool.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')", [p2.id, w.owner]);
      await expect(svc.keep(w.owner, p2.id, rec.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.edit(w.owner, p2.id, rec.id, { testcaseId: a, title: "x", confirm: true })).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.remove(w.owner, p2.id, rec.id, { testcaseId: a, confirm: true })).rejects.toBeInstanceOf(NotFoundException);
      expect((await list(w)).items).toHaveLength(1);
      expect((await list({ ...w, projectId: p2.id })).items).toHaveLength(0);
      expect(await statusOf(rec.id)).toBe("pending");
    });
  });

  // ------------------------------------------------------------- lifecycle

  describe("starting and running an analysis", () => {
    it("start returns a queued run and enqueues exactly one job keyed by the run id", async () => {
      const w = await world();
      queue.add.mockClear();
      const { analysis } = await svc.startAnalysis(w.owner, w.projectId);
      expect(analysis).toMatchObject({ status: "queued", pairsFound: null });
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add.mock.calls[0][0]).toBe(REVIEW_BOARD_JOB);
      expect(queue.add.mock.calls[0][1]).toEqual({ runId: analysis!.id });
      expect(queue.add.mock.calls[0][2]).toMatchObject({ jobId: analysis!.id, attempts: 1 });
    });

    it("a second start while one is queued/running answers 409 with the active run, and enqueues nothing", async () => {
      const w = await world();
      const first = await svc.startAnalysis(w.owner, w.projectId);
      queue.add.mockClear();
      await expect(svc.startAnalysis(w.manager, w.projectId)).rejects.toMatchObject({
        status: 409,
        response: { analysis: { id: first.analysis!.id } }
      });
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("two simultaneous starts: exactly one wins, the other gets 409", async () => {
      const w = await world();
      const results = await Promise.allSettled([svc.startAnalysis(w.owner, w.projectId), svc.startAnalysis(w.manager, w.projectId)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);
      expect((await one("SELECT count(*)::int AS n FROM review_analysis_runs WHERE project_id = $1", [w.projectId])).n).toBe(1);
    });

    it("completes: counts the cases and pairs, and a new run can start afterwards", async () => {
      const w = await world();
      await mkCase(w.projectId);
      await mkCase(w.projectId);
      await mkCase(w.projectId, { title: "Export report as PDF", preconditions: "Report exists", test_data: "pdf", steps: JSON.stringify([{ action: "Click export", expectedResult: "PDF downloads" }]) });
      const run = await analyseNow(w);
      expect(run).toMatchObject({ status: "completed", testcasesAnalyzed: 3, pairsFound: 1, truncated: false, error: null });
      expect(run.finishedAt).toBeTruthy();
      await expect(svc.startAnalysis(w.owner, w.projectId)).resolves.toBeDefined();
    });

    it("an empty project completes with zero findings", async () => {
      const w = await world();
      const run = await analyseNow(w);
      expect(run).toMatchObject({ status: "completed", testcasesAnalyzed: 0, pairsFound: 0 });
      expect((await list(w)).items).toEqual([]);
    });

    it("a worker failure (plan lost before the worker ran) is recorded on the run and never thrown", async () => {
      const w = await world();
      await mkCase(w.projectId);
      const { analysis } = await svc.startAnalysis(w.owner, w.projectId);
      await pool.query("UPDATE organizations SET plan = 'launch' WHERE id = $1", [w.orgId]);
      await expect(svc.runAnalysis(analysis!.id)).resolves.toBeUndefined();
      const row = await one("SELECT status, error, finished_at FROM review_analysis_runs WHERE id = $1", [analysis!.id]);
      expect(row.status).toBe("failed");
      expect(row.error).toMatch(/Pro plan/);
      expect(row.finished_at).not.toBeNull();
      // and the project is not blocked afterwards
      await pool.query("UPDATE organizations SET plan = 'pro' WHERE id = $1", [w.orgId]);
      await expect(svc.startAnalysis(w.owner, w.projectId)).resolves.toBeDefined();
    });

    it(`fails a project over ${MAX_TESTCASES_PER_RUN} test cases instead of analysing a subset`, async () => {
      const w = await world();
      await pool.query(
        `INSERT INTO testcases (project_id, external_id, title, steps)
         SELECT $1, 'BULK-' || g, 'Bulk case ' || g, '[]'::jsonb FROM generate_series(1, $2) g`,
        [w.projectId, MAX_TESTCASES_PER_RUN + 1]
      );
      const run = await analyseNow(w);
      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/supports up to 5000/);
      expect((await list(w)).total).toBe(0);
    });

    it("the BullMQ processor delegates to runAnalysis and ignores unknown job names", async () => {
      const w = await world();
      await mkCase(w.projectId);
      const { analysis } = await svc.startAnalysis(w.owner, w.projectId);
      const processor = new ReviewBoardProcessor(svc);
      await processor.process({ name: "something-else", data: { runId: analysis!.id } } as Any);
      expect((await svc.getLatestAnalysis(w.owner, w.projectId)).analysis!.status).toBe("queued");
      await processor.process({ name: REVIEW_BOARD_JOB, data: { runId: analysis!.id } } as Any);
      expect((await svc.getLatestAnalysis(w.owner, w.projectId)).analysis!.status).toBe("completed");
    });

    it("a redelivered job for an already-completed run is a no-op", async () => {
      const w = await world();
      await mkCase(w.projectId);
      await mkCase(w.projectId);
      const run = await analyseNow(w);
      const before = await one("SELECT count(*)::int AS n, max(updated_at) AS u FROM review_recommendations WHERE project_id = $1", [w.projectId]);
      await svc.runAnalysis(run.id);
      expect(await one("SELECT count(*)::int AS n, max(updated_at) AS u FROM review_recommendations WHERE project_id = $1", [w.projectId])).toEqual(before);
    });
  });

  // ------------------------------------------------------------- failure injection / recovery

  describe("enqueue failure, expired leases and crash recovery", () => {
    it("fails the run and answers 503 when the job cannot be queued, leaving the project unblocked", async () => {
      const w = await world();
      queue.add.mockRejectedValueOnce(new Error("redis down"));
      await expect(svc.startAnalysis(w.owner, w.projectId)).rejects.toBeInstanceOf(ServiceUnavailableException);
      const row = await one("SELECT status, error FROM review_analysis_runs WHERE project_id = $1", [w.projectId]);
      expect(row.status).toBe("failed");
      expect(row.error).toMatch(/could not be queued/);
      await expect(svc.startAnalysis(w.owner, w.projectId)).resolves.toBeDefined();
    });

    it("expires a run whose worker went silent for 10+ minutes on the next status read, then allows a new run", async () => {
      const w = await world();
      const { analysis } = await svc.startAnalysis(w.owner, w.projectId);
      await pool.query("UPDATE review_analysis_runs SET status = 'running', heartbeat_at = now() - interval '11 minutes' WHERE id = $1", [analysis!.id]);
      const latest = (await svc.getLatestAnalysis(w.owner, w.projectId)).analysis!;
      expect(latest.status).toBe("failed");
      expect(latest.error).toMatch(/interrupted/);
      await expect(svc.startAnalysis(w.owner, w.projectId)).resolves.toBeDefined();
    });

    it("expires a queued run that never got a heartbeat, using its creation time", async () => {
      const w = await world();
      const { analysis } = await svc.startAnalysis(w.owner, w.projectId);
      await pool.query("UPDATE review_analysis_runs SET created_at = now() - interval '11 minutes' WHERE id = $1", [analysis!.id]);
      await expect(svc.startAnalysis(w.owner, w.projectId)).resolves.toBeDefined(); // start itself expires it first
      expect((await one("SELECT status FROM review_analysis_runs WHERE id = $1", [analysis!.id])).status).toBe("failed");
    });

    it("does NOT expire a run that is merely a few minutes old and still heartbeating", async () => {
      const w = await world();
      const { analysis } = await svc.startAnalysis(w.owner, w.projectId);
      await pool.query("UPDATE review_analysis_runs SET status = 'running', heartbeat_at = now() - interval '3 minutes' WHERE id = $1", [analysis!.id]);
      expect((await svc.getLatestAnalysis(w.owner, w.projectId)).analysis!.status).toBe("running");
      await expect(svc.startAnalysis(w.owner, w.projectId)).rejects.toBeInstanceOf(ConflictException);
    });

    it("lets a redelivered (stalled) job re-claim a running run silent for 2+ minutes, and finish it", async () => {
      const w = await world();
      await mkCase(w.projectId);
      await mkCase(w.projectId);
      const { analysis } = await svc.startAnalysis(w.owner, w.projectId);
      await pool.query("UPDATE review_analysis_runs SET status = 'running', started_at = now(), heartbeat_at = now() - interval '3 minutes' WHERE id = $1", [analysis!.id]);
      await svc.runAnalysis(analysis!.id);
      expect((await svc.getLatestAnalysis(w.owner, w.projectId)).analysis).toMatchObject({ status: "completed", pairsFound: 1 });
    });

    it("does not let a second worker steal a run that is actively heartbeating", async () => {
      const w = await world();
      await mkCase(w.projectId);
      await mkCase(w.projectId);
      const { analysis } = await svc.startAnalysis(w.owner, w.projectId);
      await pool.query("UPDATE review_analysis_runs SET status = 'running', heartbeat_at = now() WHERE id = $1", [analysis!.id]);
      await svc.runAnalysis(analysis!.id);
      expect((await one("SELECT status FROM review_analysis_runs WHERE id = $1", [analysis!.id])).status).toBe("running");
      expect((await list(w)).total).toBe(0);
    });

    it("an expired run that finishes late writes nothing at all (conditional completion, one transaction)", async () => {
      const { w, rec } = await withPair();
      const { analysis } = await svc.startAnalysis(w.owner, w.projectId);
      await pool.query("UPDATE review_analysis_runs SET status = 'failed', error = 'expired' WHERE id = $1", [analysis!.id]);
      // The late worker thinks there are no findings; if it were allowed to write, it would obsolete the pending pair.
      await (svc as Any).persist(analysis!.id, w.projectId, 0, [], false);
      expect(await statusOf(rec.id)).toBe("pending");
      expect((await one("SELECT status FROM review_analysis_runs WHERE id = $1", [analysis!.id])).status).toBe("failed");
    });

    it("a failure half-way through the write rolls the whole run back", async () => {
      const { w, rec } = await withPair();
      const { analysis } = await svc.startAnalysis(w.owner, w.projectId);
      await pool.query("UPDATE review_analysis_runs SET status = 'running', heartbeat_at = now() WHERE id = $1", [analysis!.id]);
      const bogus = { aId: "00000000-0000-4000-8000-0000000000aa", bId: "00000000-0000-4000-8000-0000000000bb", classification: "similar", similarity: 0.9, explanation: "x", differences: [], fingerprintA: "f", fingerprintB: "f" };
      await expect((svc as Any).persist(analysis!.id, w.projectId, 2, [bogus], false)).rejects.toBeDefined(); // FK violation on unknown test cases
      expect((await one("SELECT status FROM review_analysis_runs WHERE id = $1", [analysis!.id])).status).toBe("running"); // completion rolled back too
      expect(await statusOf(rec.id)).toBe("pending");
    });
  });

  // ------------------------------------------------------------- detection

  describe("detection through the real pipeline", () => {
    it("reports exact duplicates and similar cases with real differences, and ignores unrelated cases", async () => {
      const w = await world();
      const a = await mkCase(w.projectId);
      const exact = await mkCase(w.projectId, { title: "  LOGIN with valid credentials! " });
      const differentExpected = await mkCase(w.projectId, {
        steps: JSON.stringify([LOGIN_STEPS[0], { action: "Submit valid credentials", expectedResult: "An error banner appears" }])
      });
      await mkCase(w.projectId, { title: "Export report as PDF", preconditions: "Report exists", test_data: "pdf", steps: JSON.stringify([{ action: "Click export", expectedResult: "PDF downloads" }]) });
      await analyseNow(w);
      const { items, counts } = await list(w);
      const byPair = (x: string, y: string) => items.find((i) => [i.testcaseA.id, i.testcaseB.id].sort().join() === [x, y].sort().join());

      expect(byPair(a, exact)).toMatchObject({ classification: "exact_duplicate", similarity: 1, differences: [] });
      const similar = byPair(a, differentExpected)!;
      expect(similar.classification).toBe("similar");
      expect(similar.similarity).toBeLessThan(1);
      expect(similar.differences.map((d: Any) => d.field)).toEqual(["expectedResults"]);
      // Which case is "a" is decided by uuid order (random per run), so assert on the two sides as a set.
      const sides = [similar.differences[0].a, similar.differences[0].b];
      expect(sides.filter((x: string) => x.includes("Dashboard opens"))).toHaveLength(1);
      expect(sides.filter((x: string) => x.includes("An error banner appears"))).toHaveLength(1);
      expect(similar.explanation).toMatch(/Differs in: expected results/);
      expect(counts.pending).toBe(items.length);
      // exact duplicates sort before similar ones
      expect(items[0].classification).toBe("exact_duplicate");
      // every finding lists the project (repository) name and both test case ids/keys/titles
      for (const i of items) {
        expect(i.testcaseA.repositoryName).toBe("Repo One");
        expect(i.testcaseB).toMatchObject({ id: expect.any(String), externalId: expect.any(String), title: expect.any(String) });
        expect(i.lastAnalysis).toMatchObject({ status: "completed" });
      }
    });

    it("reads every steps format the table is known to hold, and survives garbage", async () => {
      const w = await world();
      const asArray = await mkCase(w.projectId, { steps: JSON.stringify(LOGIN_STEPS) }); // jsonb array
      const asEncodedString = await mkCase(w.projectId, { steps: JSON.stringify(JSON.stringify(LOGIN_STEPS)) }); // jsonb string holding JSON
      const asDoubleEncoded = await mkCase(w.projectId, { steps: JSON.stringify(JSON.stringify(JSON.stringify(LOGIN_STEPS))) }); // encoded twice
      const aliases = await mkCase(w.projectId, { steps: JSON.stringify([{ step: "Open the login page", expected: "Form is shown" }, { description: "Submit valid credentials", expected: "Dashboard opens" }]) });
      await mkCase(w.projectId, { title: "Garbage 1", steps: JSON.stringify([{ action: { nested: true }, expectedResult: ["x"] }, null, 7, true, [1]]) });
      await mkCase(w.projectId, { title: "Garbage 2", steps: JSON.stringify({ not: "an array" }) });
      await mkCase(w.projectId, { title: "Garbage 3", steps: "null" });
      await mkCase(w.projectId, { title: "Garbage 4", steps: JSON.stringify("plain text step") });
      const run = await analyseNow(w);
      expect(run.status).toBe("completed");
      const exacts = (await list(w)).items.filter((i) => i.classification === "exact_duplicate");
      // array, encoded string, and aliases are the same steps; double-encoded is a JSON string inside a string.
      const ids = new Set(exacts.flatMap((i) => [i.testcaseA.id, i.testcaseB.id]));
      expect(ids.has(asArray) && ids.has(asEncodedString) && ids.has(aliases)).toBe(true);
      expect(ids.has(asDoubleEncoded)).toBe(true);
    });

    it("never calls two garbage-step cases exact duplicates just because both stringify to the same junk", async () => {
      const w = await world();
      const junk = { steps: JSON.stringify([{ action: { nested: true } }]), preconditions: null, test_data: null };
      await mkCase(w.projectId, { title: "Junk A", ...junk });
      await mkCase(w.projectId, { title: "Junk B", ...junk });
      await analyseNow(w);
      expect((await list(w)).items.filter((i) => i.classification === "exact_duplicate")).toEqual([]);
    });

    it(`caps a run at ${MAX_PAIRS_PER_RUN} findings and says so (truncated)`, async () => {
      const w = await world();
      // 66 identical cases = 66*65/2 = 2145 exact pairs.
      await pool.query(
        `INSERT INTO testcases (project_id, external_id, title, preconditions, test_data, steps)
         SELECT $1, 'DUP-' || g, 'Login with valid credentials', 'User exists', 'user=alice', $2::jsonb FROM generate_series(1, 66) g`,
        [w.projectId, JSON.stringify(LOGIN_STEPS)]
      );
      const run = await analyseNow(w);
      expect(run).toMatchObject({ status: "completed", testcasesAnalyzed: 66, pairsFound: MAX_PAIRS_PER_RUN, truncated: true });
      expect((await one("SELECT count(*)::int AS n FROM review_recommendations WHERE project_id = $1", [w.projectId])).n).toBe(MAX_PAIRS_PER_RUN);
    });
  });

  // ------------------------------------------------------------- list

  describe("listing: filter, pagination, counts", () => {
    async function seeded() {
      const w = await world();
      // three independent exact-duplicate pairs
      for (const t of ["Alpha flow", "Bravo flow", "Charlie flow"]) {
        const steps = JSON.stringify([{ action: `Do ${t} thing`, expectedResult: `${t} works` }]);
        await mkCase(w.projectId, { title: t, steps, preconditions: null, test_data: null });
        await mkCase(w.projectId, { title: t, steps, preconditions: null, test_data: null });
      }
      await analyseNow(w);
      return w;
    }

    it("paginates deterministically without overlap and reports the total", async () => {
      const w = await seeded();
      const p1 = await list(w, { status: "pending", limit: "2", offset: "0" });
      const p2 = await list(w, { status: "pending", limit: "2", offset: "2" });
      const p3 = await list(w, { status: "pending", limit: "2", offset: "4" });
      expect(p1.total).toBe(3);
      expect([p1.items.length, p2.items.length, p3.items.length]).toEqual([2, 1, 0]);
      const ids = [...p1.items, ...p2.items].map((i) => i.id);
      expect(new Set(ids).size).toBe(3);
    });

    it("clamps limit to 1..100 and tolerates junk paging input", async () => {
      const w = await seeded();
      expect((await list(w, { status: "pending", limit: "0" })).items).toHaveLength(3); // 0 -> default 50
      expect((await list(w, { status: "pending", limit: "-5" })).items).toHaveLength(1); // clamped up to 1
      expect((await list(w, { status: "pending", limit: "99999" })).items).toHaveLength(3);
      expect((await list(w, { status: "pending", limit: "abc", offset: "xyz" })).items).toHaveLength(3);
    });

    it("filters by status, supports several at once, defaults to pending, and rejects unknown values (400)", async () => {
      const w = await seeded();
      const [first] = (await list(w, { status: "pending" })).items;
      await svc.keep(w.owner, w.projectId, first.id);
      expect((await svc.listRecommendations(w.owner, w.projectId, {})).items).toHaveLength(2); // default = pending
      expect((await list(w, { status: "kept" })).items.map((i) => i.id)).toEqual([first.id]);
      expect((await list(w, { status: "pending,kept" })).total).toBe(3);
      expect((await list(w, { status: "removed" })).total).toBe(0);
      await expect(list(w, { status: "bogus" })).rejects.toBeInstanceOf(BadRequestException);
      await expect(list(w, { status: "pending,bogus" })).rejects.toBeInstanceOf(BadRequestException);
      expect((await list(w, { status: "" })).total).toBe(2); // empty value falls back to the default (pending)
    });

    it("reports counts across ALL statuses regardless of the filter, excluding findings about deleted cases", async () => {
      const w = await seeded();
      const items = (await list(w, { status: "pending" })).items;
      await svc.keep(w.owner, w.projectId, items[0].id);
      await pool.query("UPDATE testcases SET deleted_at = now() WHERE id = $1", [items[1].testcaseA.id]); // soft-deleted elsewhere
      const res = await list(w, { status: "kept" });
      expect(res.counts).toEqual({ pending: 1, kept: 1, edited: 0, removed: 0, obsolete: 0 });
      expect((await list(w, { status: "pending" })).total).toBe(1);
    });

    it("stores differences as real JSONB (queryable) and returns them as objects", async () => {
      const w = await world();
      await mkCase(w.projectId);
      await mkCase(w.projectId, { test_data: "user=bob" });
      await analyseNow(w);
      const row = await one(
        "SELECT jsonb_typeof(differences) AS t, differences->0->>'field' AS field FROM review_recommendations WHERE project_id = $1",
        [w.projectId]
      );
      expect(row).toEqual({ t: "array", field: "testData" });
      const d = (await list(w)).items[0].differences[0];
      expect(d.field).toBe("testData");
      expect([d.a, d.b].sort()).toEqual(["user=alice", "user=bob"]); // side order follows random uuid order
    });
  });

  // ------------------------------------------------------------- decisions across runs

  describe("reviewer decisions across repeated runs", () => {
    it("never creates a second row for the same pair, however many times it is analysed", async () => {
      const { w } = await withPair();
      await analyseNow(w);
      await analyseNow(w);
      expect((await one("SELECT count(*)::int AS n FROM review_recommendations WHERE project_id = $1", [w.projectId])).n).toBe(1);
    });

    it("keeps a 'kept' decision (and who/when) while both test cases are unchanged", async () => {
      const { w, rec } = await withPair();
      await svc.keep(w.manager, w.projectId, rec.id);
      const before = await one("SELECT reviewed_by, reviewed_at FROM review_recommendations WHERE id = $1", [rec.id]);
      await analyseNow(w);
      expect(await statusOf(rec.id)).toBe("kept");
      expect(await one("SELECT reviewed_by, reviewed_at FROM review_recommendations WHERE id = $1", [rec.id])).toEqual(before);
      expect(before.reviewed_by).toBe(w.manager);
    });

    it("treats cosmetic edits (case, spacing, punctuation) as NOT material: the decision survives", async () => {
      const { w, a, rec } = await withPair();
      await svc.keep(w.owner, w.projectId, rec.id);
      await pool.query("UPDATE testcases SET title = '  LOGIN   with valid credentials!!!  ' WHERE id = $1", [a]);
      await analyseNow(w);
      expect(await statusOf(rec.id)).toBe("kept");
    });

    it("resets a 'kept' decision to pending, and clears the reviewer, after a material change — on the SAME row", async () => {
      const { w, a, rec } = await withPair();
      await svc.keep(w.owner, w.projectId, rec.id);
      await pool.query("UPDATE testcases SET test_data = 'user=mallory' WHERE id = $1", [a]);
      await analyseNow(w);
      const row = await one("SELECT id, review_status, reviewed_by, reviewed_at, classification FROM review_recommendations WHERE project_id = $1", [w.projectId]);
      expect(row).toMatchObject({ id: rec.id, review_status: "pending", reviewed_by: null, reviewed_at: null, classification: "similar" });
    });

    it("marks a pending finding obsolete once the cases no longer match, and revives it if they match again", async () => {
      const { w, a, rec } = await withPair();
      await pool.query("UPDATE testcases SET title = 'Something entirely different', steps = $2::jsonb, preconditions = 'None', test_data = 'n/a' WHERE id = $1", [
        a,
        JSON.stringify([{ action: "Click export", expectedResult: "PDF downloads" }])
      ]);
      await analyseNow(w);
      expect(await statusOf(rec.id)).toBe("obsolete");
      expect((await list(w, { status: "pending" })).total).toBe(0);
      await pool.query("UPDATE testcases SET title = 'Login with valid credentials', steps = $2::jsonb, preconditions = 'User exists', test_data = 'user=alice' WHERE id = $1", [a, JSON.stringify(LOGIN_STEPS)]);
      await analyseNow(w);
      expect(await statusOf(rec.id)).toBe("pending");
    });

    it("leaves a decided finding alone when the cases drift apart (only PENDING findings go obsolete)", async () => {
      const { w, a, rec } = await withPair();
      await svc.keep(w.owner, w.projectId, rec.id);
      await pool.query("UPDATE testcases SET title = 'Unrelated', steps = '[]'::jsonb, preconditions = NULL, test_data = NULL WHERE id = $1", [a]);
      await analyseNow(w);
      expect(await statusOf(rec.id)).toBe("kept");
    });

    it("never resurrects or modifies a 'removed' recommendation", async () => {
      const { w, a, rec } = await withPair();
      await svc.remove(w.owner, w.projectId, rec.id, { testcaseId: a, confirm: true });
      await analyseNow(w);
      expect(await statusOf(rec.id)).toBe("removed");
    });
  });

  // ------------------------------------------------------------- keep

  describe("Keep as is", () => {
    it("dismisses the finding, touches neither test case, and writes an audit entry", async () => {
      const { w, a, b, rec } = await withPair();
      const before = await pool.query("SELECT id, title, steps, updated_at, deleted_at FROM testcases WHERE id = ANY($1::uuid[]) ORDER BY id", [[a, b]]);
      const out = await svc.keep(w.owner, w.projectId, rec.id);
      expect(out).toEqual({ id: rec.id, reviewStatus: "kept" });
      expect((await pool.query("SELECT id, title, steps, updated_at, deleted_at FROM testcases WHERE id = ANY($1::uuid[]) ORDER BY id", [[a, b]])).rows).toEqual(before.rows);
      const audit = await one("SELECT actor_id, entity_type, diff FROM audit_logs WHERE entity_id = $1 AND action = 'review_board_kept'", [rec.id]);
      expect(audit).toMatchObject({ actor_id: w.owner, entity_type: "review_recommendation" });
    });

    it("is refused the second time (409), and for an unknown or malformed id (404)", async () => {
      const { w, rec } = await withPair();
      await svc.keep(w.owner, w.projectId, rec.id);
      await expect(svc.keep(w.owner, w.projectId, rec.id)).rejects.toBeInstanceOf(ConflictException);
      await expect(svc.keep(w.owner, w.projectId, "00000000-0000-4000-8000-00000000dead")).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.keep(w.owner, w.projectId, "nope")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("two reviewers pressing Keep at once: one wins, one gets 409, and exactly one audit entry exists", async () => {
      const { w, rec } = await withPair();
      const res = await Promise.allSettled([svc.keep(w.owner, w.projectId, rec.id), svc.keep(w.manager, w.projectId, rec.id)]);
      expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((res.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
      expect((await one("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = $1 AND action = 'review_board_kept'", [rec.id])).n).toBe(1);
    });
  });

  // ------------------------------------------------------------- edit

  describe("Edit", () => {
    it("changes only the requested fields and PRESERVES suite_id and owner_id (which the update would otherwise null)", async () => {
      const { w, a, rec } = await withPair(); // a has a suite and an owner; b has neither
      const before = await one("SELECT priority, status, type, preconditions, suite_id, owner_id FROM testcases WHERE id = $1", [a]);
      expect(before.suite_id).toBe(w.suiteId);
      expect(before.owner_id).toBe(w.owner);
      const out = await svc.edit(w.manager, w.projectId, rec.id, { testcaseId: a, title: "Login (edited)", confirm: true });
      expect(out).toMatchObject({ reviewStatus: "edited", editedTestcaseId: a });
      const after = await one("SELECT title, priority, status, type, preconditions, suite_id, owner_id, updated_by FROM testcases WHERE id = $1", [a]);
      expect(after).toMatchObject({ title: "Login (edited)", suite_id: w.suiteId, owner_id: w.owner, priority: before.priority, status: before.status, type: before.type, preconditions: before.preconditions });
      expect(after.updated_by).toBe(w.manager);
      expect(await statusOf(rec.id)).toBe("edited");
    });

    it("preserves a null suite/owner too (does not invent one), and the other test case is untouched", async () => {
      const { w, b, rec } = await withPair();
      const other = await one("SELECT title, updated_at FROM testcases WHERE id = $1", [rec.testcaseA.id === b ? rec.testcaseB.id : rec.testcaseA.id]);
      await svc.edit(w.owner, w.projectId, rec.id, { testcaseId: b, description: "added", confirm: true });
      expect(await one("SELECT suite_id, owner_id, description FROM testcases WHERE id = $1", [b])).toEqual({ suite_id: null, owner_id: null, description: "added" });
      expect(await one("SELECT title, updated_at FROM testcases WHERE id = $1", [rec.testcaseA.id === b ? rec.testcaseB.id : rec.testcaseA.id])).toEqual(other);
    });

    it("saves edited steps in the array shape the analyser reads, and writes the standard update audit plus a review audit", async () => {
      const { w, a, rec } = await withPair();
      const steps = [{ action: "Open the login page", expectedResult: "Form is shown" }, "Plain text step"];
      await svc.edit(w.owner, w.projectId, rec.id, { testcaseId: a, steps, confirm: true });
      expect(await one("SELECT jsonb_typeof(steps) AS t, steps FROM testcases WHERE id = $1", [a])).toEqual({ t: "array", steps });
      expect((await one("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = $1 AND action = 'testcase_updated'", [a])).n).toBe(1);
      expect(await one("SELECT diff->'fields' AS f FROM audit_logs WHERE entity_id = $1 AND action = 'review_board_edited'", [rec.id])).toEqual({ f: ["steps"] });
    });

    it("requires explicit confirmation and a test case that belongs to the pair", async () => {
      const { w, a, rec } = await withPair();
      const foreign = await mkCase(w.projectId);
      await expect(svc.edit(w.owner, w.projectId, rec.id, { testcaseId: a, title: "x" })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.edit(w.owner, w.projectId, rec.id, { testcaseId: a, title: "x", confirm: "true" })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.edit(w.owner, w.projectId, rec.id, { testcaseId: foreign, title: "x", confirm: true })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.edit(w.owner, w.projectId, rec.id, { title: "x", confirm: true })).rejects.toBeInstanceOf(BadRequestException);
      expect((await one("SELECT title FROM testcases WHERE id = $1", [foreign])).title).toBe("Login with valid credentials");
      expect(await statusOf(rec.id)).toBe("pending");
    });

    it("validates the payload: types, empty title, no editable fields, steps shape and size", async () => {
      const { w, a, rec } = await withPair();
      const bad = (body: Record<string, unknown>) => expect(svc.edit(w.owner, w.projectId, rec.id, { testcaseId: a, confirm: true, ...body })).rejects.toBeInstanceOf(BadRequestException);
      await bad({ title: 5 });
      await bad({ title: "   " });
      await bad({});
      await bad({ priority: "P0" }); // not an editable field => nothing editable provided
      await bad({ steps: "not an array" });
      await bad({ steps: [{ action: { x: 1 } }] });
      await bad({ steps: [5] });
      await bad({ steps: [["nested"]] });
      await bad({ steps: Array.from({ length: 201 }, () => "s") });
      await bad({ steps: [{ action: "x".repeat(5001) }] });
      expect(await statusOf(rec.id)).toBe("pending");
      expect((await one("SELECT title FROM testcases WHERE id = $1", [a])).title).toBe("Login with valid credentials");
    });

    it("cannot be used to change fields outside the allow-list (priority, status, suite, owner are ignored)", async () => {
      const { w, a, rec } = await withPair();
      await svc.edit(w.owner, w.projectId, rec.id, { testcaseId: a, title: "ok", confirm: true, priority: "P0", status: "Archived", suiteId: null, ownerId: w.qa, externalId: "HACK-1" });
      expect(await one("SELECT priority, status, suite_id, owner_id, external_id FROM testcases WHERE id = $1", [a])).toMatchObject({ suite_id: w.suiteId, owner_id: w.owner });
      const row = await one("SELECT priority, status, external_id FROM testcases WHERE id = $1", [a]);
      expect(row.priority).not.toBe("P0");
      expect(row.status).not.toBe("Archived");
      expect(row.external_id).not.toBe("HACK-1");
    });

    describe("the match is recalculated when an edit is saved", () => {
      it("a similar pair that is edited further apart shows a LOWER match, with fresh differences and explanation, on the same row", async () => {
        const w = await world();
        const a = await mkCase(w.projectId);
        await mkCase(w.projectId, { test_data: "user=bob" }); // similar, not identical
        await analyseNow(w);
        const rec = (await list(w)).items[0];
        expect(rec.classification).toBe("similar");
        const before = rec.similarity;

        const out = await svc.edit(w.owner, w.projectId, rec.id, { testcaseId: a, title: "Totally different topic", preconditions: "Another setup entirely", testData: "x=1", confirm: true });
        expect(out.similarity).toBeLessThan(before);

        const after = (await list(w, { status: "edited" })).items[0];
        expect(after.id).toBe(rec.id); // same row, no duplicate
        expect(after.similarity).toBe(out.similarity);
        expect(after.similarity).toBeLessThan(before);
        expect(after.explanation).not.toBe(rec.explanation);
        expect(after.differences.map((d: Any) => d.field)).toEqual(expect.arrayContaining(["title", "preconditions", "testData"]));
        expect(after.reviewStatus).toBe("edited");
      });

      it("an edit that makes the two cases identical turns the finding into an exact duplicate at 100%", async () => {
        const w = await world();
        const a = await mkCase(w.projectId, { test_data: "user=bob" });
        await mkCase(w.projectId);
        await analyseNow(w);
        const rec = (await list(w)).items[0];
        expect(rec.classification).toBe("similar");
        const out = await svc.edit(w.owner, w.projectId, rec.id, { testcaseId: a, testData: "user=alice", confirm: true });
        expect(out).toMatchObject({ classification: "exact_duplicate", similarity: 1 });
        expect((await list(w, { status: "edited" })).items[0]).toMatchObject({ classification: "exact_duplicate", similarity: 1, differences: [] });
      });

      it("a pair edited far below the analysis threshold still shows its real (low) match instead of disappearing or keeping the old number", async () => {
        const w = await world();
        const a = await mkCase(w.projectId);
        await mkCase(w.projectId);
        await analyseNow(w);
        const rec = (await list(w)).items[0];
        const out = await svc.edit(w.owner, w.projectId, rec.id, {
          testcaseId: a,
          title: "Export report as PDF",
          preconditions: "Report exists",
          testData: "pdf",
          steps: [{ action: "Click export", expectedResult: "A PDF downloads" }],
          confirm: true
        });
        expect(out.similarity).toBeLessThan(0.7);
        const row = (await list(w, { status: "edited" })).items[0];
        expect(row.similarity).toBe(out.similarity);
        expect(row.similarity).toBeLessThan(0.7);
      });

      it("the edited finding is current afterwards (not 'changed since analysis') and its stored fingerprints match both cases", async () => {
        const { w, a, rec } = await withPair();
        await svc.edit(w.owner, w.projectId, rec.id, { testcaseId: a, title: "Login (edited)", confirm: true });
        expect((await list(w, { status: "edited" })).items[0]).toMatchObject({ stale: false, staleReason: null });
      });

      it("a later analysis does not reopen the decision for the same content, and keeps the recalculated match", async () => {
        const w = await world();
        const a = await mkCase(w.projectId);
        await mkCase(w.projectId, { test_data: "user=bob" });
        await analyseNow(w);
        const rec = (await list(w)).items[0];
        const out = await svc.edit(w.owner, w.projectId, rec.id, { testcaseId: a, testData: "user=carol", confirm: true });
        await analyseNow(w);
        const row = await one("SELECT review_status, similarity::float AS similarity FROM review_recommendations WHERE id = $1", [rec.id]);
        expect(row.review_status).toBe("edited");
        expect(row.similarity).toBe(out.similarity);
      });

      it("the audit entry records the match before and after", async () => {
        const w = await world();
        const a = await mkCase(w.projectId);
        await mkCase(w.projectId, { test_data: "user=bob" });
        await analyseNow(w);
        const rec = (await list(w)).items[0];
        const out = await svc.edit(w.owner, w.projectId, rec.id, { testcaseId: a, testData: "x=1", confirm: true });
        const audit = await one("SELECT diff FROM audit_logs WHERE entity_id = $1 AND action = 'review_board_edited'", [rec.id]);
        expect(audit.diff).toMatchObject({ similarityBefore: rec.similarity, similarityAfter: out.similarity });
      });
    });

    describe("the Edited tab: only edited findings, each with its before and after", () => {
      it("an edited finding leaves To review and appears only under Edited, with the counts to match", async () => {
        const { w, a, rec } = await withPair();
        expect((await list(w, { status: "pending" })).total).toBe(1);
        await svc.edit(w.owner, w.projectId, rec.id, { testcaseId: a, title: "Login (edited)", confirm: true });
        const pending = await list(w, { status: "pending" });
        const kept = await list(w, { status: "kept" });
        const edited = await list(w, { status: "edited" });
        expect(pending.total).toBe(0);
        expect(kept.total).toBe(0);
        expect(edited.items.map((i: Any) => i.id)).toEqual([rec.id]);
        expect(edited.counts).toMatchObject({ pending: 0, kept: 0, edited: 1 });
      });

      it("records exactly what changed: each changed field with its before and after, who edited it and when", async () => {
        const { w, a, rec } = await withPair();
        const out = await svc.edit(w.manager, w.projectId, rec.id, {
          testcaseId: a,
          title: "Login (edited)",
          testData: "user=bob",
          steps: [{ action: "Open the login page", expectedResult: "Form is shown" }, { action: "Submit valid credentials", expectedResult: "An error banner appears" }],
          confirm: true
        });
        const item = (await list(w, { status: "edited" })).items[0];
        expect(item.edit).toMatchObject({ testcaseId: a, editedBy: "U", recorded: true, similarityBefore: rec.similarity, similarityAfter: out.similarity });
        expect(new Date(item.edit!.editedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
        expect(item.edit!.changes).toEqual([
          { field: "title", before: "Login with valid credentials", after: "Login (edited)" },
          {
            field: "steps",
            before: "1. Open the login page\n   Expected: Form is shown\n2. Submit valid credentials\n   Expected: Dashboard opens",
            after: "1. Open the login page\n   Expected: Form is shown\n2. Submit valid credentials\n   Expected: An error banner appears"
          },
          { field: "testData", before: "user=alice", after: "user=bob" }
        ]);
      });

      it("writes the before/after into the Review Board's OWN audit entry at save time (it does not depend on recovery)", async () => {
        const { w, a, rec } = await withPair();
        await svc.edit(w.owner, w.projectId, rec.id, { testcaseId: a, title: "Saved title", confirm: true });
        const audit = await one("SELECT diff FROM audit_logs WHERE entity_id = $1 AND action = 'review_board_edited'", [rec.id]);
        expect(audit.diff.changes).toEqual([{ field: "title", before: "Login with valid credentials", after: "Saved title" }]);
        expect(audit.diff).toMatchObject({ editedTestcaseId: a, similarityBefore: rec.similarity, similarityAfter: expect.any(Number) });
      });

      it("lists only the fields that changed (an untouched field is never shown as changed)", async () => {
        const { w, a, rec } = await withPair();
        await svc.edit(w.owner, w.projectId, rec.id, { testcaseId: a, description: "A new description", confirm: true });
        const changes = (await list(w, { status: "edited" })).items[0].edit!.changes;
        expect(changes).toEqual([{ field: "description", before: "", after: "A new description" }]);
      });

      it("the recorded before/after is a snapshot: later changes to the test case do not rewrite it", async () => {
        const { w, a, rec } = await withPair();
        await svc.edit(w.owner, w.projectId, rec.id, { testcaseId: a, title: "First edit", confirm: true });
        await pool.query("UPDATE testcases SET title = 'Changed again elsewhere' WHERE id = $1", [a]);
        const item = (await list(w, { status: "edited" })).items[0];
        expect(item.edit!.changes).toEqual([{ field: "title", before: "Login with valid credentials", after: "First edit" }]);
      });

      it("findings that were not edited carry no edit summary", async () => {
        const { w, rec } = await withPair();
        await svc.keep(w.owner, w.projectId, rec.id);
        const all = (await list(w)).items;
        expect(all).toHaveLength(1);
        expect(all[0].edit).toBeNull();
      });

      it("an edited finding STAYS in Edited through the next analysis, even if the test cases changed again — only its match refreshes", async () => {
        const w = await world();
        const a = await mkCase(w.projectId);
        await mkCase(w.projectId, { test_data: "user=bob" });
        await analyseNow(w);
        const rec = (await list(w)).items[0];
        await svc.edit(w.owner, w.projectId, rec.id, { testcaseId: a, testData: "user=carol", confirm: true });
        const before = await one("SELECT reviewed_by, reviewed_at FROM review_recommendations WHERE id = $1", [rec.id]);
        await pool.query("UPDATE testcases SET test_data = 'user=dave', title = 'Login again' WHERE id = $1", [a]); // changed once more, outside the board
        await analyseNow(w);
        expect(await statusOf(rec.id)).toBe("edited");
        expect((await list(w, { status: "pending" })).total).toBe(0);
        expect((await list(w, { status: "edited" })).items.map((i: Any) => i.id)).toEqual([rec.id]);
        expect(await one("SELECT reviewed_by, reviewed_at FROM review_recommendations WHERE id = $1", [rec.id])).toEqual(before); // who/when kept
        expect((await one("SELECT count(*)::int AS n FROM review_recommendations WHERE project_id = $1", [w.projectId])).n).toBe(1);
      });

      it("recovers the before/after of an edit saved before the Review Board recorded it, from the standard update entry", async () => {
        const { w, a, rec } = await withPair();
        await pool.query("UPDATE review_recommendations SET review_status = 'edited', reviewed_by = $2, reviewed_at = now() WHERE id = $1", [rec.id, w.owner]);
        const audit = (action: string, entityType: string, entityId: string, diff: object) =>
          pool.query(
            `INSERT INTO audit_logs (project_id, actor_id, action, entity_type, entity_id, diff, organization_id)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, (SELECT organization_id FROM projects WHERE id = $1))`,
            [w.projectId, w.owner, action, entityType, entityId, JSON.stringify(diff)]
          );
        // what an older save wrote: the standard update entry (full before/after rows), then the review entry WITHOUT changes
        await audit("testcase_updated", "testcase", a, {
          before: { title: "Old title", testData: "user=alice", steps: [{ action: "Open", expectedResult: "Shown" }] },
          after: { title: "New title", testData: "user=alice", steps: [{ action: "Open", expectedResult: "Shown" }] }
        });
        await audit("review_board_edited", "review_recommendation", rec.id, { editedTestcaseId: a, fields: ["title"] });
        const item = (await list(w, { status: "edited" })).items[0];
        expect(item.edit).toMatchObject({ testcaseId: a, recorded: true, similarityBefore: null, similarityAfter: null });
        expect(item.edit!.changes).toEqual([{ field: "title", before: "Old title", after: "New title" }]);
      });

      it("says plainly when nothing was recorded and nothing can be recovered", async () => {
        const { w, a, rec } = await withPair();
        await pool.query("UPDATE review_recommendations SET review_status = 'edited', reviewed_by = $2, reviewed_at = now() WHERE id = $1", [rec.id, w.owner]);
        await pool.query(
          `INSERT INTO audit_logs (project_id, actor_id, action, entity_type, entity_id, diff, organization_id)
           VALUES ($1, $2, 'review_board_edited', 'review_recommendation', $3, $4::jsonb, (SELECT organization_id FROM projects WHERE id = $1))`,
          [w.projectId, w.owner, rec.id, JSON.stringify({ editedTestcaseId: a, fields: ["title"] })]
        );
        const item = (await list(w, { status: "edited" })).items[0];
        expect(item.edit).toMatchObject({ recorded: false, changes: [] });
      });
    });

    it("the step agreement shown with the match is live: editing a step lowers 'N of M identical' and the % together", async () => {
      const w = await world();
      const a = await mkCase(w.projectId);
      await mkCase(w.projectId, { test_data: "user=bob" });
      await analyseNow(w);
      const rec = (await list(w)).items[0];
      expect(rec.stepAgreement).toEqual({ identical: 2, total: 2 });
      const out = await svc.edit(w.owner, w.projectId, rec.id, {
        testcaseId: a,
        steps: [LOGIN_STEPS[0], { action: "Submit valid credentials", expectedResult: "An error banner appears" }],
        confirm: true
      });
      const after = (await list(w, { status: "edited" })).items[0];
      expect(after.stepAgreement).toEqual({ identical: 1, total: 2 });
      expect(after.similarity).toBe(out.similarity);
      expect(after.similarity).toBeLessThan(rec.similarity);
      expect(after.explanation).toMatch(/1 of 2 steps identical/);
    });

    it("after an edit, the finding it came from can no longer be used to delete anything", async () => {
      const { w, a, rec } = await withPair();
      await svc.edit(w.owner, w.projectId, rec.id, { testcaseId: a, title: "Login (edited)", confirm: true });
      await expect(svc.remove(w.owner, w.projectId, rec.id, { testcaseId: a, confirm: true })).rejects.toBeInstanceOf(ConflictException); // already 'edited'
    });
  });

  // ------------------------------------------------------------- remove

  describe("Remove from project", () => {
    it("requires confirm:true and a test case from the pair; nothing changes otherwise", async () => {
      const { w, a, rec } = await withPair();
      const foreign = await mkCase(w.projectId);
      await expect(svc.remove(w.owner, w.projectId, rec.id, { testcaseId: a })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.remove(w.owner, w.projectId, rec.id, { testcaseId: a, confirm: "yes" })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.remove(w.owner, w.projectId, rec.id, { confirm: true })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.remove(w.owner, w.projectId, rec.id, { testcaseId: foreign, confirm: true })).rejects.toBeInstanceOf(BadRequestException);
      expect((await pool.query("SELECT 1 FROM testcases WHERE project_id = $1 AND deleted_at IS NOT NULL", [w.projectId])).rows).toHaveLength(0);
      expect(await statusOf(rec.id)).toBe("pending");
    });

    it("soft-deletes exactly the chosen case, keeps the other, resolves the finding and writes both audit entries", async () => {
      const { w, a, b, rec } = await withPair();
      const out = await svc.remove(w.manager, w.projectId, rec.id, { testcaseId: b, confirm: true });
      expect(out).toEqual({ id: rec.id, reviewStatus: "removed", removedTestcaseId: b, keptTestcaseId: a });
      const rows = (await pool.query("SELECT id, deleted_at, deleted_by FROM testcases WHERE id = ANY($1::uuid[])", [[a, b]])).rows;
      const del = rows.find((r) => r.id === b)!;
      expect(del.deleted_at).not.toBeNull(); // soft delete — the row is still there
      expect(del.deleted_by).toBe(w.manager);
      expect(rows.find((r) => r.id === a)!.deleted_at).toBeNull();
      expect(await one("SELECT review_status, reviewed_by, removed_testcase_id FROM review_recommendations WHERE id = $1", [rec.id])).toEqual({ review_status: "removed", reviewed_by: w.manager, removed_testcase_id: b });
      const std = await one("SELECT actor_id, project_id, diff FROM audit_logs WHERE entity_id = $1 AND action = 'testcase_deleted'", [b]);
      expect(std).toMatchObject({ actor_id: w.manager, project_id: w.projectId });
      expect(std.diff.before).toMatchObject({ id: b, projectId: w.projectId, title: "Login with valid credentials" });
      expect(await one("SELECT diff FROM audit_logs WHERE entity_id = $1 AND action = 'review_board_removed'", [rec.id])).toMatchObject({ diff: { removedTestcaseId: b, keptTestcaseId: a, classification: "exact_duplicate" } });
    });

    it("hides findings about the removed case from the list, and counts stay consistent", async () => {
      const { w, a, rec } = await withPair();
      await svc.remove(w.owner, w.projectId, rec.id, { testcaseId: a, confirm: true });
      const res = await list(w);
      expect(res.items).toEqual([]); // a deleted case makes the pair non-actionable
      // ...but the removal itself is counted, because it is listed in History.
      expect(res.counts).toEqual({ pending: 0, kept: 0, edited: 0, removed: 1, obsolete: 0 });
    });

    it("cannot remove twice (409) and cannot remove after Keep (409)", async () => {
      const first = await withPair();
      await svc.remove(first.w.owner, first.w.projectId, first.rec.id, { testcaseId: first.a, confirm: true });
      await expect(svc.remove(first.w.owner, first.w.projectId, first.rec.id, { testcaseId: first.b, confirm: true })).rejects.toBeInstanceOf(ConflictException); // already resolved
      const kept = await withPair();
      await svc.keep(kept.w.owner, kept.w.projectId, kept.rec.id);
      await expect(svc.remove(kept.w.owner, kept.w.projectId, kept.rec.id, { testcaseId: kept.a, confirm: true })).rejects.toBeInstanceOf(ConflictException);
      expect((await one("SELECT deleted_at FROM testcases WHERE id = $1", [kept.a])).deleted_at).toBeNull();
    });

    it("refuses stale findings: editing EITHER case after the analysis blocks removal with a stale_recommendation 409", async () => {
      for (const side of ["target", "other"] as const) {
        const { w, a, b, rec } = await withPair();
        const edited = side === "target" ? a : b;
        await pool.query("UPDATE testcases SET test_data = 'user=changed' WHERE id = $1", [edited]);
        await expect(svc.remove(w.owner, w.projectId, rec.id, { testcaseId: a, confirm: true })).rejects.toMatchObject({ status: 409, response: { code: "stale_recommendation" } });
        expect((await one("SELECT deleted_at FROM testcases WHERE id = $1", [a])).deleted_at).toBeNull();
        expect(await statusOf(rec.id)).toBe("pending");
        expect((await list(w)).items[0]).toMatchObject({ stale: true, staleReason: "content" }); // and the list says so
      }
    });

    it("treats every compared field as material: title, preconditions, postconditions, test data, steps all make it stale", async () => {
      const edits: Array<[string, unknown]> = [
        ["title", "A different title"],
        ["preconditions", "Different precondition"],
        ["postconditions", "Different postcondition"],
        ["test_data", "Different data"],
        ["steps", JSON.stringify([{ action: "Different", expectedResult: "Different" }])]
      ];
      for (const [column, value] of edits) {
        const { w, a, rec } = await withPair();
        await pool.query(`UPDATE testcases SET ${column} = ${column === "steps" ? "$2::jsonb" : "$2"} WHERE id = $1`, [a, value]);
        await expect(svc.remove(w.owner, w.projectId, rec.id, { testcaseId: a, confirm: true })).rejects.toMatchObject({ status: 409 });
      }
    });

    it("stale-check bypass attempt: editing back to the analysed content makes the finding valid again — by design, judged on content not history", async () => {
      const { w, a, rec } = await withPair();
      await pool.query("UPDATE testcases SET test_data = 'user=changed' WHERE id = $1", [a]);
      await expect(svc.remove(w.owner, w.projectId, rec.id, { testcaseId: a, confirm: true })).rejects.toMatchObject({ status: 409 });
      await pool.query("UPDATE testcases SET test_data = 'user=alice' WHERE id = $1", [a]);
      // The finding describes content that is true again, so it is no longer stale.
      expect((await list(w)).items[0].stale).toBe(false);
      await expect(svc.remove(w.owner, w.projectId, rec.id, { testcaseId: a, confirm: true })).resolves.toMatchObject({ reviewStatus: "removed" });
    });

    it("re-running the analysis re-describes the finding from the NEW content; it never revalidates the old claim", async () => {
      const { w, a, rec } = await withPair();
      const old = await one("SELECT fingerprint_a, fingerprint_b FROM review_recommendations WHERE id = $1", [rec.id]);
      await pool.query("UPDATE testcases SET test_data = 'user=changed' WHERE id = $1", [a]);
      await analyseNow(w);
      const now = await one("SELECT fingerprint_a, fingerprint_b FROM review_recommendations WHERE id = $1", [rec.id]);
      expect([now.fingerprint_a, now.fingerprint_b]).not.toEqual([old.fingerprint_a, old.fingerprint_b]);
      // The refreshed finding is a Similar pair (no longer Exact) that names the real difference, and is fresh.
      const fresh = (await list(w)).items[0];
      expect(fresh).toMatchObject({ id: rec.id, classification: "similar", stale: false });
      expect(fresh.differences.map((d: Any) => d.field)).toEqual(["testData"]);
    });

    it("a concurrent edit that has locked the row makes the removal wait, then fail as stale (no check-then-act race)", async () => {
      const { w, a, rec } = await withPair();
      const editor = await pool.connect();
      try {
        await editor.query("BEGIN");
        await editor.query("UPDATE testcases SET test_data = 'user=racing' WHERE id = $1", [a]); // uncommitted, row locked
        let settled = false;
        const removal = svc.remove(w.owner, w.projectId, rec.id, { testcaseId: a, confirm: true }).finally(() => (settled = true));
        removal.catch(() => undefined);
        await new Promise((r) => setTimeout(r, 600));
        expect(settled).toBe(false); // blocked on the row lock, not racing past it
        await editor.query("COMMIT");
        await expect(removal).rejects.toMatchObject({ status: 409, response: { code: "stale_recommendation" } });
      } finally {
        editor.release();
      }
      expect((await one("SELECT deleted_at FROM testcases WHERE id = $1", [a])).deleted_at).toBeNull();
    });

    it("two reviewers removing at once: exactly one deletion, one winner, one loser with 409/404, one audit trail", async () => {
      const { w, a, b, rec } = await withPair();
      const res = await Promise.allSettled([
        svc.remove(w.owner, w.projectId, rec.id, { testcaseId: a, confirm: true }),
        svc.remove(w.manager, w.projectId, rec.id, { testcaseId: b, confirm: true })
      ]);
      expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await one("SELECT count(*)::int AS n FROM testcases WHERE project_id = $1 AND deleted_at IS NOT NULL", [w.projectId])).n).toBe(1); // never both
      expect((await one("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'testcase_deleted' AND project_id = $1", [w.projectId])).n).toBe(1);
      expect((await one("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'review_board_removed' AND entity_id = $1", [rec.id])).n).toBe(1);
    });

    it("is ATOMIC: if any write in the removal fails, the case stays live and the finding stays pending", async () => {
      const { w, a, rec } = await withPair();
      // Make the LAST statement of the transaction (the review_board_removed audit insert) fail.
      await pool.query("CREATE OR REPLACE FUNCTION rb_test_fail_audit() RETURNS trigger AS $$ BEGIN IF NEW.action = 'review_board_removed' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql");
      await pool.query("CREATE TRIGGER rb_test_fail_audit_trg BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION rb_test_fail_audit()");
      try {
        await expect(svc.remove(w.owner, w.projectId, rec.id, { testcaseId: a, confirm: true })).rejects.toThrow(/injected failure/);
      } finally {
        await pool.query("DROP TRIGGER rb_test_fail_audit_trg ON audit_logs");
        await pool.query("DROP FUNCTION rb_test_fail_audit()");
      }
      expect((await one("SELECT deleted_at, deleted_by FROM testcases WHERE id = $1", [a]))).toEqual({ deleted_at: null, deleted_by: null });
      expect(await statusOf(rec.id)).toBe("pending");
      expect((await one("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = $1 AND action = 'testcase_deleted'", [a])).n).toBe(0);
      // and it works once the fault is gone
      await expect(svc.remove(w.owner, w.projectId, rec.id, { testcaseId: a, confirm: true })).resolves.toMatchObject({ reviewStatus: "removed" });
    });

    it("a group of identical cases can never be deleted in full through its findings: every removal needs BOTH cases alive (server backstop for bulk removal)", async () => {
      const w = await world();
      const ids = [await mkCase(w.projectId), await mkCase(w.projectId), await mkCase(w.projectId)];
      await analyseNow(w);
      const recs = (await list(w)).items;
      expect(recs).toHaveLength(3); // (A,B) (A,C) (B,C)
      const results: string[] = [];
      for (const rec of recs) {
        // Try to remove the first case of EVERY finding, one after another — the "remove everything" combination.
        try {
          await svc.remove(w.owner, w.projectId, rec.id, { testcaseId: rec.testcaseA.id, confirm: true });
          results.push("removed");
        } catch (err) {
          results.push(err instanceof NotFoundException ? "refused-404" : "other");
        }
      }
      expect(results).not.toContain("other");
      const live = (await pool.query("SELECT count(*)::int AS n FROM testcases WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL", [ids])).rows[0].n;
      expect(live).toBeGreaterThanOrEqual(1);
      expect(results.filter((r) => r === "removed").length).toBeLessThanOrEqual(2);
    });

    it("removal is project-scoped: a finding id from another project can never delete this project's cases", async () => {
      const first = await withPair();
      const second = await withPair();
      await expect(svc.remove(first.w.owner, first.w.projectId, second.rec.id, { testcaseId: second.a, confirm: true })).rejects.toBeInstanceOf(NotFoundException);
      expect((await one("SELECT deleted_at FROM testcases WHERE id = $1", [second.a])).deleted_at).toBeNull();
    });
  });

  // ------------------------------------------------------------- freshness (V143)

  describe("review freshness: state fingerprint (V143)", () => {
    const STATE_CHANGES: Array<[string, (w: World, a: string) => Promise<void>]> = [
      ["description", (_w, a) => pool.query("UPDATE testcases SET description = 'A genuinely different description' WHERE id = $1", [a]).then(() => undefined)],
      ["status", (_w, a) => pool.query("UPDATE testcases SET status = 'Deprecated' WHERE id = $1", [a]).then(() => undefined)],
      ["suite", async (w, a) => {
        const s2 = await one("INSERT INTO suites (project_id, name) VALUES ($1, 'Other suite') RETURNING id", [w.projectId]);
        await pool.query("UPDATE testcases SET suite_id = $2 WHERE id = $1", [a, s2.id]);
      }],
      ["suite cleared", (_w, a) => pool.query("UPDATE testcases SET suite_id = NULL WHERE id = $1", [a]).then(() => undefined)],
      ["priority", (_w, a) => pool.query("UPDATE testcases SET priority = 'P0' WHERE id = $1", [a]).then(() => undefined)],
      ["severity", (_w, a) => pool.query("UPDATE testcases SET severity = 'Critical' WHERE id = $1", [a]).then(() => undefined)],
      ["type", (_w, a) => pool.query("UPDATE testcases SET type = 'Regression' WHERE id = $1", [a]).then(() => undefined)],
      ["component", (_w, a) => pool.query("UPDATE testcases SET component = 'Billing' WHERE id = $1", [a]).then(() => undefined)],
      ["owner", (w, a) => pool.query("UPDATE testcases SET owner_id = $2 WHERE id = $1", [a, w.manager]).then(() => undefined)],
      ["jira link", (_w, a) => pool.query("UPDATE testcases SET jira_issue_key = 'TES-99' WHERE id = $1", [a]).then(() => undefined)],
      ["linear link", (_w, a) => pool.query("UPDATE testcases SET linear_issue_key = 'LIN-99' WHERE id = $1", [a]).then(() => undefined)],
      ["notion link", (_w, a) => pool.query("UPDATE testcases SET notion_page_id = 'page-99' WHERE id = $1", [a]).then(() => undefined)]
    ];

    const everyAction = (w: World, id: string, a: string) => [
      () => svc.keep(w.owner, w.projectId, id),
      () => svc.edit(w.owner, w.projectId, id, { testcaseId: a, title: "Edited", confirm: true }),
      () => svc.remove(w.owner, w.projectId, id, { testcaseId: a, confirm: true })
    ];

    for (const [name, change] of STATE_CHANGES) {
      it(`a changed ${name} makes a pending finding stale and keep/edit/remove are all refused (409)`, async () => {
        const { w, a, b, rec } = await withPair();
        await change(w, a);
        const listed = (await list(w)).items[0];
        expect(listed).toMatchObject({ stale: true, staleReason: "state" });
        for (const call of everyAction(w, rec.id, a)) {
          await expect(call()).rejects.toMatchObject({ status: 409, response: { code: "stale_recommendation", staleReason: "state" } });
        }
        // nothing happened
        expect(await statusOf(rec.id)).toBe("pending");
        expect((await one("SELECT title, deleted_at FROM testcases WHERE id = $1", [a]))).toMatchObject({ title: "Login with valid credentials", deleted_at: null });
        expect((await one("SELECT deleted_at FROM testcases WHERE id = $1", [b])).deleted_at).toBeNull();
        expect((await one("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = $1", [rec.id])).n).toBe(0);
      });
    }

    it("the SECOND test case's state matters too", async () => {
      const { w, a, b, rec } = await withPair();
      await pool.query("UPDATE testcases SET status = 'Deprecated' WHERE id = $1", [b]);
      await expect(svc.remove(w.owner, w.projectId, rec.id, { testcaseId: a, confirm: true })).rejects.toMatchObject({ status: 409 });
    });

    it("a content change reports reason 'content' even when state changed as well", async () => {
      const { w, a, rec } = await withPair();
      await pool.query("UPDATE testcases SET test_data = 'user=changed', status = 'Deprecated' WHERE id = $1", [a]);
      expect((await list(w)).items[0]).toMatchObject({ stale: true, staleReason: "content" });
      await expect(svc.keep(w.owner, w.projectId, rec.id)).rejects.toMatchObject({ response: { staleReason: "content" } });
    });

    it("cosmetic description edits and fields outside the set (automation status, attachments, duration) do not make it stale", async () => {
      // Start from a real description (mkCase leaves it NULL, and NULL -> any text is a genuine change).
      const w = await world();
      const a = await mkCase(w.projectId);
      await mkCase(w.projectId);
      await pool.query("UPDATE testcases SET description = 'Verifies sign-in' WHERE project_id = $1", [w.projectId]);
      await analyseNow(w);
      const rec = (await list(w)).items[0];
      await pool.query("UPDATE testcases SET description = '  VERIFIES   sign-in!! ' WHERE id = $1", [a]);
      await pool.query("UPDATE testcases SET automation_status = 'Automated', attachments = 'x.png', estimated_duration = '5m' WHERE id = $1", [a]);
      expect((await list(w)).items[0]).toMatchObject({ stale: false, staleReason: null });
      await expect(svc.remove(w.owner, w.projectId, rec.id, { testcaseId: a, confirm: true })).resolves.toMatchObject({ reviewStatus: "removed" });
    });

    it("state edited back to what the analysis saw makes the finding current again (judged on state, not history)", async () => {
      const { w, a, b } = await withPair();
      const original = (await one("SELECT priority FROM testcases WHERE id = $1", [b])).priority; // b is untouched; a had the same default
      await pool.query("UPDATE testcases SET priority = 'P0' WHERE id = $1", [a]);
      expect((await list(w)).items[0].stale).toBe(true);
      await pool.query("UPDATE testcases SET priority = $2 WHERE id = $1", [a, original]);
      expect((await list(w)).items[0]).toMatchObject({ stale: false, staleReason: null });
    });

    it("re-running the analysis re-describes a stale pending finding on the SAME row and makes it actionable again", async () => {
      const { w, a, rec } = await withPair();
      await pool.query("UPDATE testcases SET status = 'Deprecated' WHERE id = $1", [a]);
      await expect(svc.keep(w.owner, w.projectId, rec.id)).rejects.toMatchObject({ status: 409 });
      await analyseNow(w);
      expect((await one("SELECT count(*)::int AS n FROM review_recommendations WHERE project_id = $1", [w.projectId])).n).toBe(1);
      const after = (await list(w)).items[0];
      expect(after).toMatchObject({ id: rec.id, stale: false, staleReason: null, reviewStatus: "pending" });
      await expect(svc.keep(w.owner, w.projectId, rec.id)).resolves.toMatchObject({ reviewStatus: "kept" });
    });

    it("a state-only change never reopens a decision already made: 'kept' stays kept through the next analysis", async () => {
      const { w, a, rec } = await withPair();
      await svc.keep(w.owner, w.projectId, rec.id);
      await pool.query("UPDATE testcases SET priority = 'P0', status = 'Deprecated' WHERE id = $1", [a]);
      await analyseNow(w);
      expect(await statusOf(rec.id)).toBe("kept");
      // while the refreshed fingerprints keep it consistent for any later pending use
      expect((await one("SELECT state_fingerprint_a IS NOT NULL AS ok FROM review_recommendations WHERE id = $1", [rec.id])).ok).toBe(true);
    });

    it("keep waits for a concurrent state edit that holds the row, then is refused as stale (no check-then-act race)", async () => {
      const { w, a, rec } = await withPair();
      const editor = await pool.connect();
      try {
        await editor.query("BEGIN");
        await editor.query("UPDATE testcases SET status = 'Deprecated' WHERE id = $1", [a]);
        let settled = false;
        const keeping = svc.keep(w.owner, w.projectId, rec.id).finally(() => (settled = true));
        keeping.catch(() => undefined);
        await new Promise((r) => setTimeout(r, 600));
        expect(settled).toBe(false);
        await editor.query("COMMIT");
        await expect(keeping).rejects.toMatchObject({ status: 409, response: { staleReason: "state" } });
      } finally {
        editor.release();
      }
      expect(await statusOf(rec.id)).toBe("pending");
    });

    describe("rows recorded before V143 (state fingerprints NULL) — migration behaviour", () => {
      async function legacyWorld() {
        const w = await world();
        const a = await mkCase(w.projectId, { suite_id: w.suiteId, owner_id: w.owner });
        const b = await mkCase(w.projectId);
        const c = await mkCase(w.projectId, { title: "Zeta flow", preconditions: null, test_data: null, steps: JSON.stringify([{ action: "Zeta", expectedResult: "Zeta ok" }]) });
        const d = await mkCase(w.projectId, { title: "Zeta flow", preconditions: null, test_data: null, steps: JSON.stringify([{ action: "Zeta", expectedResult: "Zeta ok" }]) });
        await analyseNow(w);
        const items = (await list(w)).items;
        expect(items).toHaveLength(2);
        // Simulate rows written by V141-era code: no state fingerprints at all. Give them a mix of decisions.
        const loginRec = items.find((i) => [i.testcaseA.id, i.testcaseB.id].includes(a))!;
        const zetaRec = items.find((i) => [i.testcaseA.id, i.testcaseB.id].includes(c))!;
        await svc.keep(w.owner, w.projectId, zetaRec.id);
        await pool.query("UPDATE review_recommendations SET state_fingerprint_a = NULL, state_fingerprint_b = NULL WHERE project_id = $1", [w.projectId]);
        return { w, a, b, c, d, loginRec, zetaRec };
      }

      it("keeps every row and decision, lists them, and reports pending ones as 'unverified'", async () => {
        const { w, loginRec, zetaRec } = await legacyWorld();
        const res = await list(w, { status: "pending,kept" });
        expect(res.total).toBe(2);
        const byId = Object.fromEntries(res.items.map((i) => [i.id, i]));
        expect(byId[loginRec.id]).toMatchObject({ reviewStatus: "pending", stale: true, staleReason: "unverified" });
        expect(byId[zetaRec.id]).toMatchObject({ reviewStatus: "kept" }); // decision intact
      });

      it("refuses keep/edit/remove on an unverified pending finding (409) and changes nothing", async () => {
        const { w, a, loginRec } = await legacyWorld();
        for (const call of everyAction(w, loginRec.id, a)) {
          await expect(call()).rejects.toMatchObject({ status: 409, response: { code: "stale_recommendation", staleReason: "unverified" } });
        }
        expect(await statusOf(loginRec.id)).toBe("pending");
        expect((await one("SELECT deleted_at FROM testcases WHERE id = $1", [a])).deleted_at).toBeNull();
      });

      it("the next analysis fills the fingerprints in on the SAME rows: no duplicates, decisions preserved, pending becomes actionable", async () => {
        const { w, a, loginRec, zetaRec } = await legacyWorld();
        const before = (await pool.query("SELECT id, review_status FROM review_recommendations WHERE project_id = $1 ORDER BY id", [w.projectId])).rows;
        await analyseNow(w);
        const after = (await pool.query("SELECT id, review_status, state_fingerprint_a IS NOT NULL AS a_ok, state_fingerprint_b IS NOT NULL AS b_ok FROM review_recommendations WHERE project_id = $1 ORDER BY id", [w.projectId])).rows;
        expect(after.map((r) => [r.id, r.review_status])).toEqual(before.map((r) => [r.id, r.review_status]));
        expect(after.every((r) => r.a_ok && r.b_ok)).toBe(true);
        expect((await list(w)).items.find((i) => i.id === loginRec.id)).toMatchObject({ stale: false });
        expect(await statusOf(zetaRec.id)).toBe("kept");
        await expect(svc.remove(w.owner, w.projectId, loginRec.id, { testcaseId: a, confirm: true })).resolves.toMatchObject({ reviewStatus: "removed" });
      });

      it("an 'edited' decision on a V141-era row is preserved too", async () => {
        const w = await world();
        const a = await mkCase(w.projectId);
        await mkCase(w.projectId);
        await analyseNow(w);
        const rec = (await list(w)).items[0];
        await svc.edit(w.owner, w.projectId, rec.id, { testcaseId: a, description: "tweak", confirm: true });
        await pool.query("UPDATE review_recommendations SET state_fingerprint_a = NULL, state_fingerprint_b = NULL WHERE id = $1", [rec.id]);
        expect(await statusOf(rec.id)).toBe("edited");
        expect((await list(w, { status: "edited" })).total).toBe(1);
        await analyseNow(w);
        expect(await statusOf(rec.id)).toBe("edited"); // description is not content: decision survives
      });
    });
  });

  // ------------------------------------------------------------- contract with the frontend

  describe("response shapes the frontend relies on (Tesbo-Frontend/lib/reviewBoard.ts)", () => {
    const sorted = (o: object) => Object.keys(o).sort();

    it("run, list, item, counts, difference and action responses have exactly the documented keys", async () => {
      const { w, a, rec } = await withPair();
      const run = (await svc.getLatestAnalysis(w.owner, w.projectId)).analysis!;
      expect(sorted(run)).toEqual(sorted({ id: 1, status: 1, testcasesAnalyzed: 1, pairsFound: 1, truncated: 1, error: 1, createdAt: 1, startedAt: 1, finishedAt: 1 }));

      const res = await list(w);
      expect(sorted(res)).toEqual(["counts", "items", "total"]);
      expect(sorted(res.counts)).toEqual(["edited", "kept", "obsolete", "pending", "removed"]);
      expect(sorted(rec)).toEqual(
        sorted({ id: 1, classification: 1, similarity: 1, explanation: 1, differences: 1, reviewStatus: 1, stale: 1, staleReason: 1, stepAgreement: 1, edit: 1, reviewedBy: 1, reviewedAt: 1, lastAnalysis: 1, testcaseA: 1, testcaseB: 1 })
      );
      expect(sorted(rec.testcaseA)).toEqual(["externalId", "id", "repositoryName", "title"]);
      expect(sorted(rec.lastAnalysis)).toEqual(["finishedAt", "runId", "status"]);
      expect(rec.stepAgreement).toEqual({ identical: 2, total: 2 }); // an exact duplicate shares every step
      expect(typeof rec.similarity).toBe("number");
      expect(rec.staleReason).toBeNull();

      // a similar pair carries differences with {field, a, b}
      const b2 = await mkCase(w.projectId, { test_data: "user=zed" });
      await analyseNow(w);
      const diffItem = (await list(w)).items.find((i) => i.differences.length > 0)!;
      expect(sorted(diffItem.differences[0])).toEqual(["a", "b", "field"]);
      expect(["title", "preconditions", "steps", "expectedResults", "testData", "postconditions"]).toContain(diffItem.differences[0].field);
      void a; void b2;
    });

    it("keep / edit / remove answer with the documented shapes", async () => {
      const k = await withPair();
      expect(await svc.keep(k.w.owner, k.w.projectId, k.rec.id)).toEqual({ id: k.rec.id, reviewStatus: "kept" });
      const e = await withPair();
      expect(await svc.edit(e.w.owner, e.w.projectId, e.rec.id, { testcaseId: e.a, title: "t2", confirm: true })).toEqual({ id: e.rec.id, reviewStatus: "edited", editedTestcaseId: e.a, classification: expect.stringMatching(/^(exact_duplicate|similar)$/), similarity: expect.any(Number) });
      const r = await withPair();
      expect(await svc.remove(r.w.owner, r.w.projectId, r.rec.id, { testcaseId: r.a, confirm: true })).toEqual({ id: r.rec.id, reviewStatus: "removed", removedTestcaseId: r.a, keptTestcaseId: r.b });
    });
  });

  // ------------------------------------------------------------- history

  describe("History: test cases removed through the Review Board (read-only)", () => {
    const history = (w: World, query: Any = {}, as = w.owner) => svc.listHistory(as, w.projectId, query);

    it("is empty before any removal, and Keep / Edit decisions never appear in it", async () => {
      const k = await withPair();
      await svc.keep(k.w.owner, k.w.projectId, k.rec.id);
      const e = await withPair();
      await svc.edit(e.w.owner, e.w.projectId, e.rec.id, { testcaseId: e.a, title: "Edited title", confirm: true });
      expect(await history(k.w)).toEqual({ items: [], total: 0, counts: expect.objectContaining({ removed: 0 }) });
      expect((await history(e.w)).total).toBe(0);
    });

    it("lists a removal with who removed it, when, the removed and the kept case, the match and the explanation", async () => {
      const { w, a, b, rec } = await withPair();
      await svc.remove(w.manager, w.projectId, rec.id, { testcaseId: b, confirm: true });
      const h = await history(w);
      expect(h.total).toBe(1);
      expect(h.counts.removed).toBe(1);
      expect((await list(w)).counts.removed).toBe(1); // the same number drives the tab count on the main list
      const item = h.items[0];
      expect(item).toMatchObject({ id: rec.id, classification: "exact_duplicate", similarity: 1, removedBy: "U", repositoryName: "Repo One", explanation: rec.explanation });
      expect(new Date(item.removedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(item.removed).toMatchObject({ id: b, stillDeleted: true, title: "Login with valid credentials" });
      expect(item.removed.externalId).toEqual(expect.any(String));
      expect(item.kept).toMatchObject({ id: a, deleted: false });
    });

    it("records the removed case correctly whichever side of the pair it was (a or b)", async () => {
      for (const side of ["a", "b"] as const) {
        const { w, rec } = await withPair();
        const target = side === "a" ? rec.testcaseA.id : rec.testcaseB.id;
        const other = side === "a" ? rec.testcaseB.id : rec.testcaseA.id;
        await svc.remove(w.owner, w.projectId, rec.id, { testcaseId: target, confirm: true });
        const item = (await history(w)).items[0];
        expect(item.removed.id).toBe(target);
        expect(item.kept.id).toBe(other);
      }
    });

    it("is newest first and paginated, with an accurate total", async () => {
      const w = await world();
      for (const t of ["Alpha flow", "Bravo flow", "Charlie flow"]) {
        const steps = JSON.stringify([{ action: `Do ${t} thing`, expectedResult: `${t} works` }]);
        await mkCase(w.projectId, { title: t, steps, preconditions: null, test_data: null });
        await mkCase(w.projectId, { title: t, steps, preconditions: null, test_data: null });
      }
      await analyseNow(w);
      const pending = (await list(w, { status: "pending" })).items;
      expect(pending).toHaveLength(3);
      const removedOrder: string[] = [];
      for (const rec of pending) {
        await svc.remove(w.owner, w.projectId, rec.id, { testcaseId: rec.testcaseA.id, confirm: true });
        removedOrder.push(rec.id);
        await new Promise((r) => setTimeout(r, 15)); // distinct timestamps
      }
      const page1 = await history(w, { limit: "2", offset: "0" });
      const page2 = await history(w, { limit: "2", offset: "2" });
      expect(page1.total).toBe(3);
      expect(page1.counts.removed).toBe(3);
      expect(page1.items.map((i: Any) => i.id)).toEqual([removedOrder[2], removedOrder[1]]); // most recent first
      expect(page2.items.map((i: Any) => i.id)).toEqual([removedOrder[0]]);
      expect((await history(w, { limit: "0" })).items).toHaveLength(3); // junk paging falls back to the default
    });

    it("reports a removed case that was restored elsewhere, and a kept case that was deleted later", async () => {
      const { w, a, b, rec } = await withPair();
      await svc.remove(w.owner, w.projectId, rec.id, { testcaseId: b, confirm: true });
      await pool.query("UPDATE testcases SET deleted_at = NULL, deleted_by = NULL WHERE id = $1", [b]); // restored by something else
      await pool.query("UPDATE testcases SET deleted_at = now() WHERE id = $1", [a]); // the kept one was deleted later
      const item = (await history(w)).items[0];
      expect(item.removed.stillDeleted).toBe(false);
      expect(item.kept.deleted).toBe(true);
    });

    it("is scoped to its own project", async () => {
      const first = await withPair();
      const second = await withPair();
      await svc.remove(first.w.owner, first.w.projectId, first.rec.id, { testcaseId: first.a, confirm: true });
      await svc.remove(second.w.owner, second.w.projectId, second.rec.id, { testcaseId: second.a, confirm: true });
      const h = await history(first.w);
      expect(h.items.map((i: Any) => i.id)).toEqual([first.rec.id]);
    });

    it("has exactly the documented response shape", async () => {
      const { w, rec } = await withPair();
      await svc.remove(w.owner, w.projectId, rec.id, { testcaseId: rec.testcaseA.id, confirm: true });
      const h = await history(w);
      expect(Object.keys(h).sort()).toEqual(["counts", "items", "total"]);
      const item = h.items[0];
      expect(Object.keys(item).sort()).toEqual(["classification", "explanation", "id", "kept", "removed", "removedAt", "removedBy", "repositoryName", "similarity"]);
      expect(Object.keys(item.removed).sort()).toEqual(["externalId", "id", "stillDeleted", "title"]);
      expect(Object.keys(item.kept).sort()).toEqual(["deleted", "externalId", "id", "title"]);
    });
  });

});
