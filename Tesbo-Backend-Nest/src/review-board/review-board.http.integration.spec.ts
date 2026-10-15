/*
 * Review Board over REAL HTTP and a REAL BullMQ queue: the actual controller, DTO shapes, status codes, the global
 * exception filter, and the actual worker (ReviewBoardProcessor) consuming jobs from Redis.
 *
 * Opt-in, with two hard guards so it can never touch the app's own infrastructure:
 *   REVIEW_BOARD_TEST_DATABASE_URL — loopback host, database name starting "rb_test" (same rule as the other suite)
 *   REVIEW_BOARD_TEST_REDIS_URL    — loopback host AND port 56379 exactly (the shared stack's Redis is on 6389)
 * Skipped entirely when either is unset. Authentication is replaced by a test middleware that reads the user id from
 * an x-test-user header; everything behind it (membership, effective Pro plan, role, SQL) is the real code.
 */
import type { INestApplication } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import { SuitesCacheService } from "../cache/suites-cache.service";
import { TestcasesListCacheService } from "../cache/testcases-list-cache.service";
import { HttpExceptionFilter } from "../common/http-exception.filter";
import { DatabaseService } from "../database/database.service";
import { LegacyService } from "../legacy/legacy.service";
import { PlanLimitsService } from "../plan-limits/plan-limits.service";
import { ProjectLookupService } from "../request-cache/project-lookup.service";
import { RequestCacheService } from "../request-cache/request-cache.service";
import { REVIEW_BOARD_QUEUE } from "./review-board.constants";
import { ReviewBoardController } from "./review-board.controller";
import { ReviewBoardProcessor } from "./review-board.processor";
import { ReviewBoardService } from "./review-board.service";

const DB_URL = process.env.REVIEW_BOARD_TEST_DATABASE_URL;
const REDIS_URL = process.env.REVIEW_BOARD_TEST_REDIS_URL;
const suite = DB_URL && REDIS_URL ? describe : describe.skip;

type Any = any;

suite("review board over HTTP + real BullMQ worker", () => {
  jest.setTimeout(90_000);

  let pool: Pool;
  let app: INestApplication;
  let base: string;
  let seq = 0;

  beforeAll(async () => {
    const d = new URL(DB_URL as string);
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(d.hostname) || !d.pathname.replace(/^\//, "").startsWith("rb_test")) {
      throw new Error("Refusing to run: the database must be loopback and named rb_test*.");
    }
    const r = new URL(REDIS_URL as string);
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(r.hostname) || r.port !== "56379") {
      throw new Error("Refusing to run: Redis must be the disposable loopback instance on port 56379.");
    }

    pool = new Pool({ connectionString: DB_URL, max: 12 });
    const db = new DatabaseService(pool);
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

    const moduleRef = await Test.createTestingModule({
      imports: [BullModule.forRoot({ connection: { url: REDIS_URL } }), BullModule.registerQueue({ name: REVIEW_BOARD_QUEUE })],
      controllers: [ReviewBoardController],
      providers: [
        ReviewBoardService,
        ReviewBoardProcessor,
        { provide: DatabaseService, useValue: db },
        { provide: PlanLimitsService, useValue: planLimits },
        { provide: LegacyService, useValue: legacy },
        { provide: SuitesCacheService, useValue: invalidating },
        { provide: TestcasesListCacheService, useValue: invalidating }
      ]
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter());
    app.use((req: Any, _res: Any, next: () => void) => {
      req.userId = req.headers["x-test-user"] || null;
      next();
    });
    await app.init();
    await app.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${(app.getHttpServer().address() as Any).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // ------------------------------------------------------------------ helpers

  const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

  async function call(method: string, path: string, user: string | null, body?: unknown): Promise<{ status: number; json: Any }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  async function mkUser(orgId: string, projectId: string | null, role: string | null): Promise<string> {
    seq += 1;
    const u = await one("INSERT INTO users (email, name, active_organization_id) VALUES ($1, 'U', $2) RETURNING id", [`rb-http-${Date.now()}-${seq}@example.test`, orgId]);
    await pool.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, u.id]);
    if (projectId && role) await pool.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)", [projectId, u.id, role]);
    return u.id;
  }

  const STEPS = JSON.stringify([
    { action: "Open the login page", expectedResult: "Form is shown" },
    { action: "Submit valid credentials", expectedResult: "Dashboard opens" }
  ]);

  async function mkCase(projectId: string, over: Record<string, unknown> = {}): Promise<string> {
    seq += 1;
    const r = await one(
      `INSERT INTO testcases (project_id, external_id, title, preconditions, test_data, steps) VALUES ($1, $2, $3, 'User exists', $4, $5::jsonb) RETURNING id`,
      [projectId, `H-${seq}-${Math.floor(Math.random() * 1e6)}`, over.title ?? "Login with valid credentials", over.test_data ?? "user=alice", over.steps ?? STEPS]
    );
    return r.id;
  }

  async function world(plan: "pro" | "launch" = "pro") {
    seq += 1;
    const org = await one("INSERT INTO organizations (name, slug, plan) VALUES ('RB HTTP', $1, $2) RETURNING id", [`rb-http-org-${Date.now()}-${seq}`, plan]);
    const project = await one("INSERT INTO projects (organization_id, name, key) VALUES ($1, 'Http Repo', $2) RETURNING id", [org.id, `H${seq}`.slice(0, 10)]);
    return {
      projectId: project.id as string,
      owner: await mkUser(org.id, project.id, "owner"),
      qa: await mkUser(org.id, project.id, "qa_engineer"),
      outsider: await mkUser(org.id, null, null)
    };
  }

  const url = (w: { projectId: string }, tail: string) => `/api/projects/${w.projectId}/review-board${tail}`;

  async function runAndWait(w: Awaited<ReturnType<typeof world>>) {
    const started = await call("POST", url(w, "/analysis"), w.owner);
    expect(started.status).toBe(202);
    const deadline = Date.now() + 30_000;
    let latest = started.json.analysis;
    while (Date.now() < deadline && (latest.status === "queued" || latest.status === "running")) {
      await new Promise((r) => setTimeout(r, 250));
      latest = (await call("GET", url(w, "/analysis"), w.owner)).json.analysis;
    }
    return latest;
  }

  // ------------------------------------------------------------------ tests

  it("rejects an unauthenticated request exactly like every other project endpoint: 400 { error: 'Authentication required' }", async () => {
    // The real AuthMiddleware only sets req.userId (null when there is no session) and never rejects; the rejection
    // comes from LegacyService.requireUser, which answers 400. That is existing, app-wide behaviour this feature inherits.
    const w = await world();
    const res = await call("GET", url(w, "/analysis"), null);
    expect(res).toEqual({ status: 400, json: { error: "Authentication required" } });
  });

  it("answers 403 { error } to a QA engineer and to a Launch workspace, 404 to a non-member and to unknown routes", async () => {
    const w = await world();
    const launch = await world("launch");
    const qa = await call("GET", url(w, "/analysis"), w.qa);
    expect(qa.status).toBe(403);
    expect(qa.json.error).toMatch(/owners and managers/);
    const pro = await call("POST", url(launch, "/analysis"), launch.owner);
    expect(pro.status).toBe(403);
    expect(pro.json.error).toMatch(/Pro plan/);
    expect((await call("GET", url(w, "/analysis"), w.outsider)).status).toBe(404);
    expect((await call("GET", url(w, "/nope"), w.owner)).status).toBe(404);
  });

  it("a fresh project has no analysis (200 with analysis: null) and an empty list", async () => {
    const w = await world();
    expect(await call("GET", url(w, "/analysis"), w.owner)).toEqual({ status: 200, json: { analysis: null } });
    const list = await call("GET", url(w, "/recommendations"), w.owner);
    expect(list.status).toBe(200);
    expect(list.json).toEqual({ items: [], total: 0, counts: { pending: 0, kept: 0, edited: 0, removed: 0, obsolete: 0 } });
  });

  it("POST /analysis answers 202, the REAL worker consumes the job from Redis and completes the run, results are readable", async () => {
    const w = await world();
    await mkCase(w.projectId);
    await mkCase(w.projectId);
    const run = await runAndWait(w);
    expect(run).toMatchObject({ status: "completed", testcasesAnalyzed: 2, pairsFound: 1, truncated: false, error: null });
    const list = await call("GET", url(w, "/recommendations"), w.owner);
    expect(list.status).toBe(200);
    expect(list.json.total).toBe(1);
    expect(list.json.items[0]).toMatchObject({ classification: "exact_duplicate", reviewStatus: "pending", stale: false, staleReason: null });
  });

  it("two simultaneous POST /analysis: exactly one 202 and one 409 carrying the active run", async () => {
    const w = await world();
    await mkCase(w.projectId);
    const [x, y] = await Promise.all([call("POST", url(w, "/analysis"), w.owner), call("POST", url(w, "/analysis"), w.owner)]);
    expect([x.status, y.status].sort()).toEqual([202, 409]);
    const loser = x.status === 409 ? x : y;
    expect(loser.json.error).toMatch(/already running/);
    expect(loser.json.analysis).toMatchObject({ id: expect.any(String) });
    // let the winner finish so the project is left idle
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const s = (await call("GET", url(w, "/analysis"), w.owner)).json.analysis.status;
      if (s === "completed" || s === "failed") break;
      await new Promise((r) => setTimeout(r, 250));
    }
  });

  it("keep / edit / remove: documented status codes, bodies and error shapes over HTTP", async () => {
    const w = await world();
    const a = await mkCase(w.projectId);
    await mkCase(w.projectId);
    await runAndWait(w);
    const rec = (await call("GET", url(w, "/recommendations"), w.owner)).json.items[0];

    // validation: 400 without confirm, 400 for a case outside the pair
    expect((await call("POST", url(w, `/recommendations/${rec.id}/remove`), w.owner, { testcaseId: a })).status).toBe(400);
    expect((await call("POST", url(w, `/recommendations/${rec.id}/edit`), w.owner, { testcaseId: "00000000-0000-4000-8000-000000000000", title: "x", confirm: true })).status).toBe(400);
    // edit
    const edited = await call("POST", url(w, `/recommendations/${rec.id}/edit`), w.owner, { testcaseId: a, title: "Edited over HTTP", confirm: true });
    expect(edited).toEqual({
      status: 200,
      json: { id: rec.id, reviewStatus: "edited", editedTestcaseId: a, classification: expect.stringMatching(/^(exact_duplicate|similar)$/), similarity: expect.any(Number) }
    });
    expect((await one("SELECT title FROM testcases WHERE id = $1", [a])).title).toBe("Edited over HTTP");
    // already reviewed -> 409 { error }
    const again = await call("POST", url(w, `/recommendations/${rec.id}/keep`), w.owner);
    expect(again.status).toBe(409);
    expect(again.json.error).toMatch(/already reviewed/);
    // unknown / malformed ids -> 404
    expect((await call("POST", url(w, "/recommendations/00000000-0000-4000-8000-0000000000ff/keep"), w.owner)).status).toBe(404);
    expect((await call("POST", url(w, "/recommendations/not-a-uuid/keep"), w.owner)).status).toBe(404);
  });

  it("keep (200) and remove (200) over HTTP; stale findings come back as 409 { error, code, staleReason }", async () => {
    const w = await world();
    const k1 = await mkCase(w.projectId);
    await mkCase(w.projectId);
    await runAndWait(w);
    const first = (await call("GET", url(w, "/recommendations"), w.owner)).json.items[0];
    expect(await call("POST", url(w, `/recommendations/${first.id}/keep`), w.owner)).toEqual({ status: 200, json: { id: first.id, reviewStatus: "kept" } });

    const w2 = await world();
    const a = await mkCase(w2.projectId);
    const b = await mkCase(w2.projectId);
    await runAndWait(w2);
    const rec = (await call("GET", url(w2, "/recommendations"), w2.owner)).json.items[0];
    await pool.query("UPDATE testcases SET status = 'Deprecated' WHERE id = $1", [a]); // review-state change after the analysis
    const stale = await call("POST", url(w2, `/recommendations/${rec.id}/remove`), w2.owner, { testcaseId: a, confirm: true });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: "stale_recommendation", staleReason: "state" });
    expect(typeof stale.json.error).toBe("string");
    expect((await call("GET", url(w2, "/recommendations"), w2.owner)).json.items[0]).toMatchObject({ stale: true, staleReason: "state" });

    // after re-analysis it is current again and removal goes through (200) — soft delete only
    await runAndWait(w2);
    const ok = await call("POST", url(w2, `/recommendations/${rec.id}/remove`), w2.owner, { testcaseId: b, confirm: true });
    expect(ok).toEqual({ status: 200, json: { id: rec.id, reviewStatus: "removed", removedTestcaseId: b, keptTestcaseId: a } });
    expect((await one("SELECT deleted_at IS NOT NULL AS gone FROM testcases WHERE id = $1", [b])).gone).toBe(true);
    void k1;
  });

  it("list query parameters work over HTTP: paging, status filter, and 400 for an unknown status", async () => {
    const w = await world();
    for (const t of ["Alpha flow", "Bravo flow"]) {
      const steps = JSON.stringify([{ action: `Do ${t}`, expectedResult: `${t} ok` }]);
      await mkCase(w.projectId, { title: t, steps, test_data: null });
      await mkCase(w.projectId, { title: t, steps, test_data: null });
    }
    await runAndWait(w);
    const page1 = await call("GET", url(w, "/recommendations?status=pending&limit=1&offset=0"), w.owner);
    const page2 = await call("GET", url(w, "/recommendations?status=pending&limit=1&offset=1"), w.owner);
    expect([page1.json.items.length, page2.json.items.length, page1.json.total]).toEqual([1, 1, 2]);
    expect(page1.json.items[0].id).not.toBe(page2.json.items[0].id);
    const bad = await call("GET", url(w, "/recommendations?status=bogus"), w.owner);
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/status must be one or more of/);
  });
});
