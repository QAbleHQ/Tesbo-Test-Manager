import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { resetToLaunch, setGraceWindow, setProPlan } from "../utils/billing-db";
import { env } from "../utils/env";
import {
  FAKE_RECORDING,
  NYRA_FAKE_SKIP_REASON,
  nyraFakeIsWired,
  startFakeNyraServer,
  type FakeNyraServer,
} from "../utils/fake-nyra-server";
import { exec, literal, scalar } from "../utils/psql";
import {
  anonymousContext,
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * The NYRA agent: /api/projects/:projectId/agents/nyra[/projects].
 *
 * Two halves, because one NYRA_API_KEY is bound to one NYRA workspace and the backend reads
 * NYRA_BASE_URL once at boot:
 *   - "refusals and validation" never reaches NYRA, so it runs on any stack: the Pro gate, roles,
 *     tenancy, and every 400 the form can produce (validated before NYRA is called).
 *   - "against the fake NYRA" creates and lists projects, so it runs only when the stack was booted
 *     with NYRA_BASE_URL pointing at utils/fake-nyra-server.ts. Never at a real NYRA.
 *
 * Own workspace ("nyra"), put on Pro by provisionRbacTenant; the plan tests flip it and restore it.
 */

const ctxB = () => path.join(__dirname, "../.auth/state-b.json");
const REFUSED = [400, 401, 403, 404];

test.describe("NYRA agent", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asManager: APIRequestContext;
  let asQa: APIRequestContext;
  let asGuest: APIRequestContext;
  let asOtherTenant: APIRequestContext;
  let anon: APIRequestContext;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("nyra");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asManager = await loginAs(tenant.manager);
    asQa = await loginAs(tenant.qa);
    asGuest = await loginAs(tenant.guest);
    anon = await anonymousContext();
    asOtherTenant = await request.newContext({ baseURL: env.apiBaseUrl, storageState: ctxB() });
    purge(tenant);
  });

  test.afterAll(async () => {
    if (tenant) {
      purge(tenant);
      setProPlan(tenant.organizationId);
    }
    await Promise.all([asOwner, asManager, asQa, asGuest, asOtherTenant, anon].filter(Boolean).map((c) => c.dispose()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  function purge(t: RbacTenant): void {
    exec(`DELETE FROM nyra_projects WHERE project_id IN (${literal(t.mainProjectId)}, ${literal(t.secondProjectId)});`);
  }

  const base = (projectId?: string) => `/api/projects/${projectId ?? tenant!.mainProjectId}/agents/nyra`;
  const name = (label: string) => `E2E NYRA ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const valid = (label = "Shop") => ({ name: name(label), appUrl: "https://staging.example.com" });
  const create = (api: APIRequestContext, body: unknown, projectId?: string) =>
    api.post(`${base(projectId)}/projects`, { data: body as object, failOnStatusCode: false });

  // ─── Refusals and validation: never reaches NYRA ───────────────────────────

  test.describe("refusals and validation", () => {
    test("card state is readable by every project role and says whether NYRA is configured", async () => {
      for (const api of [asOwner, asManager, asQa]) {
        const res = await api.get(base());
        expect(res.status()).toBe(200);
        expect(typeof (await res.json()).configured).toBe("boolean");
      }
    });

    test("a non-member, an anonymous caller and another workspace are all refused", async () => {
      for (const [label, api] of [
        ["guest", asGuest],
        ["anonymous", anon],
        ["other workspace", asOtherTenant],
      ] as const) {
        const calls = [
          api.get(base(), { failOnStatusCode: false }),
          api.get(`${base()}/projects`, { failOnStatusCode: false }),
          create(api, valid()),
        ];
        for (const res of await Promise.all(calls)) {
          expect(REFUSED, `${label}: ${res.url()}`).toContain(res.status());
        }
      }
      // The other workspace gets "not found", the same answer as a project that does not exist.
      expect((await asOtherTenant.get(`${base()}/projects`, { failOnStatusCode: false })).status()).toBe(404);
    });

    test("a malformed project id is a 404, not a 500", async () => {
      const res = await asOwner.get("/api/projects/not-a-uuid/agents/nyra", { failOnStatusCode: false });
      expect(res.status()).toBe(404);
    });

    test("a QA engineer can view but not create", async () => {
      const res = await create(asQa, valid());
      expect(res.status()).toBe(403);
      expect((await res.json()).error).toContain("owners and managers");
      // Listing is allowed (it is not the owner/manager-only half), so it is never a 403.
      expect((await asQa.get(`${base()}/projects`, { failOnStatusCode: false })).status()).not.toBe(403);
    });

    test("a manager is allowed through to validation", async () => {
      const res = await create(asManager, { ...valid(), appUrl: "ftp://nope" });
      expect(res.status()).toBe(400);
    });

    test.describe("field validation", () => {
      const ok = () => valid("Validation");
      const cases: Array<[string, () => Record<string, unknown>, string]> = [
        ["missing name", () => ({ appUrl: ok().appUrl }), "Project name is required"],
        ["whitespace-only name", () => ({ ...ok(), name: "   " }), "Project name is required"],
        ["non-string name", () => ({ ...ok(), name: 42 }), "Project name is required"],
        ["name over 120 characters", () => ({ ...ok(), name: "x".repeat(121) }), "at most 120"],
        ["missing app URL", () => ({ name: ok().name }), "App URL is required"],
        ["app URL that is not a URL", () => ({ ...ok(), appUrl: "not a url" }), "valid URL"],
        ["app URL with a non-http scheme", () => ({ ...ok(), appUrl: "ftp://example.com" }), "http://"],
        ["javascript: app URL", () => ({ ...ok(), appUrl: "javascript:alert(1)" }), "http://"],
        ["app URL over the length cap", () => ({ ...ok(), appUrl: `https://example.com/${"a".repeat(2000)}` }), "at most 2000"],
        ["username without a password", () => ({ ...ok(), testAccount: { username: "qa@example.com" } }), "Password is required"],
        ["password without a username", () => ({ ...ok(), testAccount: { password: "pw" } }), "Username or email is required"],
        ["login URL alone", () => ({ ...ok(), testAccount: { loginUrl: "https://example.com/login" } }), "Username or email is required"],
        [
          "an OTP login method",
          () => ({ ...ok(), testAccount: { username: "qa@example.com", password: "pw", loginMethod: "otp" } }),
          "Only password login",
        ],
        [
          "an over-long username",
          () => ({ ...ok(), testAccount: { username: "u".repeat(256), password: "pw", loginMethod: "password" } }),
          "at most 255",
        ],
        [
          "a bad login page URL",
          () => ({ ...ok(), testAccount: { loginUrl: "ftp://x", username: "qa@example.com", password: "pw" } }),
          "Login page URL",
        ],
      ];
      for (const [label, body, message] of cases) {
        test(`rejects ${label}`, async () => {
          const res = await create(asOwner, body());
          expect(res.status()).toBe(400);
          expect((await res.json()).error).toContain(message);
        });
      }

      test("a non-object body is a 400", async () => {
        const res = await asOwner.post(`${base()}/projects`, { data: "just text", headers: { "content-type": "application/json" }, failOnStatusCode: false });
        expect(REFUSED).toContain(res.status());
      });
    });

    test("without NYRA configured, a valid create and a list answer 503", async () => {
      const state = await (await asOwner.get(base())).json();
      test.skip(state.configured, "NYRA is configured on this stack, so the not-configured answer cannot be observed.");
      expect((await create(asOwner, valid())).status()).toBe(503);
      expect((await asOwner.get(`${base()}/projects`)).status()).toBe(503);
    });

    test("on the Launch plan NYRA is Pro-only, but the card state is still readable", async () => {
      resetToLaunch(tenant!.organizationId);
      try {
        for (const res of [await asOwner.get(`${base()}/projects`, { failOnStatusCode: false }), await create(asOwner, valid())]) {
          expect(res.status()).toBe(403);
          expect((await res.json()).error).toContain("Pro");
        }
        expect((await asOwner.get(base())).status()).toBe(200);
      } finally {
        setProPlan(tenant!.organizationId);
      }
      expect((await asOwner.get(`${base()}/projects`, { failOnStatusCode: false })).status()).not.toBe(403);
    });

    test("a downgraded workspace inside its grace window still has NYRA, and loses it when the window closes", async () => {
      try {
        setGraceWindow(tenant!.organizationId, 5);
        expect((await asOwner.get(`${base()}/projects`, { failOnStatusCode: false })).status()).not.toBe(403);
        setGraceWindow(tenant!.organizationId, -1);
        expect((await asOwner.get(`${base()}/projects`, { failOnStatusCode: false })).status()).toBe(403);
      } finally {
        setProPlan(tenant!.organizationId);
      }
    });
  });

  // ─── Against the fake NYRA ─────────────────────────────────────────────────

  test.describe("against the fake NYRA", () => {
    let fake: FakeNyraServer | null = null;

    test.beforeAll(async () => {
      // May wait for the other NYRA spec file to release the fake (see startFakeNyraServer).
      test.setTimeout(11 * 60_000);
      if (nyraFakeIsWired()) fake = await startFakeNyraServer();
    });

    test.afterAll(async () => {
      await fake?.close().catch(() => undefined);
    });

    test.beforeEach(() => {
      test.skip(!nyraFakeIsWired(), NYRA_FAKE_SKIP_REASON);
      fake?.reset();
    });

    test("creates a project with a test account, sends it to NYRA once, and never returns the password", async () => {
      const body = {
        ...valid("Full"),
        testAccount: { loginUrl: "https://staging.example.com/login", username: "qa@example.com", loginMethod: "password", password: "S3cret-pw!" },
      };
      const res = await create(asOwner, body);
      expect(res.status(), await res.text()).toBe(201);
      const created = await res.json();
      expect(created).toMatchObject({
        name: body.name,
        appUrl: "https://staging.example.com",
        hasTestAccount: true,
        username: "qa@example.com",
        loginMethod: "password",
      });
      expect(JSON.stringify(created)).not.toContain("S3cret-pw!");

      const sent = fake!.calls.find((c) => c.method === "POST");
      expect(sent!.authorization).toMatch(/^Bearer .{8,}/);
      expect(sent!.body.environment).toMatchObject({
        base_url: "https://staging.example.com",
        test_account: { login_url: "https://staging.example.com/login", username: "qa@example.com", login_method: "password", password: "S3cret-pw!" },
      });

      // Persisted: the link row exists and holds ids only.
      expect(
        scalar(`SELECT count(*) FROM nyra_projects WHERE project_id = ${literal(tenant!.mainProjectId)} AND nyra_project_id = ${literal(created.id)};`),
      ).toBe("1");
      const listed = await (await asOwner.get(`${base()}/projects`)).json();
      expect(listed.list.map((p: any) => p.id)).toContain(created.id);
      expect(JSON.stringify(listed)).not.toContain("S3cret-pw!");
    });

    test("creates a project with no test account and sends no test_account to NYRA", async () => {
      const res = await create(asManager, valid("Plain"));
      expect(res.status()).toBe(201);
      const created = await res.json();
      expect(created).toMatchObject({ hasTestAccount: false, username: null });
      expect(fake!.calls.find((c) => c.method === "POST")!.body.environment.test_account).toBeUndefined();
    });

    test("trims the name and accepts exactly 120 characters", async () => {
      const long = "n".repeat(120);
      const res = await create(asOwner, { name: `  ${long}  `, appUrl: "https://staging.example.com" });
      expect(res.status()).toBe(201);
      expect((await res.json()).name).toBe(long);
    });

    test("lists only the projects this Tesbo project created, in a workspace nobody else can read", async () => {
      const mine = await (await create(asOwner, valid("Mine"))).json();
      // A NYRA project that exists upstream but was never created from this Tesbo project.
      fake!.projects.push({ id: "foreign-1", name: "Someone else's", environments: [] });

      const main = await (await asOwner.get(`${base()}/projects`)).json();
      expect(main.list.map((p: any) => p.id)).toEqual([mine.id]);

      const second = await (await asOwner.get(`${base(tenant!.secondProjectId)}/projects`)).json();
      expect(second.list).toEqual([]);

      expect((await asOtherTenant.get(`${base()}/projects`, { failOnStatusCode: false })).status()).toBe(404);
    });

    test("an empty project lists nothing without calling NYRA", async () => {
      const res = await asOwner.get(`${base(tenant!.secondProjectId)}/projects`);
      expect(await res.json()).toEqual({ list: [] });
      expect(fake!.calls).toHaveLength(0);
    });

    test("a duplicate name is a 409 in the same project, ignoring case, but is fine in another project", async () => {
      const first = valid("Dup");
      expect((await create(asOwner, first)).status()).toBe(201);
      const again = await create(asOwner, { ...first, name: first.name.toUpperCase() });
      expect(again.status()).toBe(409);
      expect(fake!.calls.filter((c) => c.method === "POST")).toHaveLength(1);
      expect((await create(asOwner, first, tenant!.secondProjectId)).status()).toBe(201);
    });

    test("NYRA's validation error becomes a 400 that does not echo the submitted password", async () => {
      const res = await create(asOwner, {
        name: "force-422",
        appUrl: "https://staging.example.com",
        testAccount: { username: "qa@example.com", password: "Echo-me-not-1", loginMethod: "password" },
      });
      expect(res.status()).toBe(400);
      const text = await res.text();
      expect(text).toContain("Fake NYRA says no");
      expect(text).not.toContain("Echo-me-not-1");
      expect(scalar(`SELECT count(*) FROM nyra_projects WHERE project_id = ${literal(tenant!.mainProjectId)};`)).toBe("0");
    });

    test("NYRA rejecting the key is a 502 that does not leak the key, and nothing is linked", async () => {
      const res = await create(asOwner, { name: "force-401", appUrl: "https://staging.example.com" });
      expect(res.status()).toBe(502);
      const text = await res.text();
      expect(text).toContain("NYRA_API_KEY");
      expect(text).not.toMatch(/nyra_sk_|Bearer/);
      expect(scalar(`SELECT count(*) FROM nyra_projects WHERE project_id = ${literal(tenant!.mainProjectId)};`)).toBe("0");
    });

    test("a NYRA server error is a 502", async () => {
      const res = await create(asOwner, { name: "force-500", appUrl: "https://staging.example.com" });
      expect(res.status()).toBe(502);
    });

    test("when NYRA is unreachable the list is a 502, not a hang or an empty list", async () => {
      // Linked projects force the upstream call; with none, the list is empty without one.
      expect((await create(asOwner, valid("Before outage"))).status()).toBe(201);
      await fake!.close();
      fake = null;
      const res = await asOwner.get(`${base()}/projects`, { failOnStatusCode: false });
      expect(res.status()).toBe(502);
      expect((await res.json()).error).toContain("unreachable");
    });
  });

  // ─── Scan routes: refusals and validation (no NYRA needed, but NYRA must be configured) ───

  test.describe("scan routes without reaching NYRA", () => {
    let configured = false;
    let linked: string;

    test.beforeAll(async () => {
      if (!tenant) return;
      configured = (await (await asOwner.get(base())).json()).configured === true;
    });

    test.beforeEach(async () => {
      test.skip(!configured, "needs NYRA_API_KEY and NYRA_BASE_URL set on the stack so the routes get past the configured check.");
      // A link row alone is enough: every request below is refused before NYRA is called.
      linked = randomUUID();
      exec(`DELETE FROM nyra_projects WHERE project_id IN (${literal(tenant!.mainProjectId)}, ${literal(tenant!.secondProjectId)});`);
      exec(`INSERT INTO nyra_projects (project_id, nyra_project_id) VALUES (${literal(tenant!.mainProjectId)}, ${literal(linked)});`);
    });

    const at = (nyraId: string, rest = "", projectId?: string) => `${base(projectId)}/projects/${nyraId}${rest}`;
    const RUN = randomUUID();

    test("a NYRA project this Tesbo project did not create is a 404 on every route", async () => {
      const stranger = randomUUID();
      const routes: Array<[string, string]> = [
        ["GET", ""],
        ["GET", "/runs"],
        ["POST", "/runs"],
        ["GET", `/runs/${RUN}`],
        ["POST", `/runs/${RUN}/stop`],
        ["GET", `/runs/${RUN}/items`],
        ["GET", `/runs/${RUN}/recordings`],
        ["GET", `/runs/${RUN}/live.jpg`],
        ["GET", `/runs/${RUN}/files/screens/screen-001.jpg`],
        ["GET", `/runs/${RUN}/export/test-cases.csv`],
        ["GET", `/runs/${RUN}/events`],
        ["PATCH", `/environments/${randomUUID()}`],
      ];
      for (const [method, rest] of routes) {
        const res = await asOwner.fetch(at(stranger, rest), { method, data: method === "GET" ? undefined : {}, failOnStatusCode: false });
        expect(res.status(), `${method} ${rest}`).toBe(404);
      }
    });

    test("a NYRA project linked to one Tesbo project cannot be opened through another", async () => {
      // `linked` belongs to the main project; the second project (same owner, same workspace) must not see it.
      for (const rest of ["", "/runs", `/runs/${RUN}/items`]) {
        const res = await asOwner.get(at(linked, rest, tenant!.secondProjectId), { failOnStatusCode: false });
        expect(res.status(), rest).toBe(404);
      }
    });

    test("malformed ids are 404, not 500", async () => {
      for (const rest of ["", "/runs", "/runs/not-a-uuid", "/runs/not-a-uuid/items", "/runs/not-a-uuid/events"]) {
        const res = await asOwner.get(at("not-a-uuid", rest), { failOnStatusCode: false });
        expect(res.status(), `bad project id ${rest}`).toBe(404);
      }
      for (const rest of ["/runs/not-a-uuid", "/runs/not-a-uuid/items", "/runs/%20/recordings"]) {
        const res = await asOwner.get(at(linked, rest), { failOnStatusCode: false });
        expect(res.status(), `bad run id ${rest}`).toBe(404);
      }
    });

    test("a non-member, an anonymous caller and another workspace are refused", async () => {
      for (const [label, api] of [
        ["guest", asGuest],
        ["anonymous", anon],
        ["other workspace", asOtherTenant],
      ] as const) {
        for (const rest of ["", "/runs", `/runs/${RUN}/items`, `/runs/${RUN}/export/knowledge.md`]) {
          const res = await api.get(at(linked, rest), { failOnStatusCode: false });
          expect(REFUSED, `${label} ${rest}`).toContain(res.status());
        }
      }
    });

    test("on the Launch plan the scan routes are Pro-only", async () => {
      resetToLaunch(tenant!.organizationId);
      try {
        for (const rest of ["", "/runs", `/runs/${RUN}/items`]) {
          const res = await asOwner.get(at(linked, rest), { failOnStatusCode: false });
          expect(res.status(), rest).toBe(403);
          expect((await res.json()).error).toContain("Pro");
        }
      } finally {
        setProPlan(tenant!.organizationId);
      }
    });

    test.describe("start-scan validation", () => {
      const env = randomUUID();
      const cases: Array<[string, Record<string, unknown>, string]> = [
        ["no environment", {}, "Choose an environment"],
        ["an environment id that is not a uuid", { environmentId: "staging" }, "Choose an environment"],
        ["zero pages", { environmentId: env, budget: { maxPages: 0 } }, "Max pages"],
        ["too many pages", { environmentId: env, budget: { maxPages: 501 } }, "Max pages"],
        ["fractional pages", { environmentId: env, budget: { maxPages: 1.5 } }, "Max pages"],
        ["pages as text", { environmentId: env, budget: { maxPages: "10" } }, "Max pages"],
        ["too many minutes", { environmentId: env, budget: { maxMinutes: 121 } }, "Max minutes"],
        ["zero minutes", { environmentId: env, budget: { maxMinutes: 0 } }, "Max minutes"],
        ["too deep", { environmentId: env, budget: { maxDepth: 21 } }, "Max depth"],
        ["negative depth", { environmentId: env, budget: { maxDepth: -1 } }, "Max depth"],
      ];
      for (const [label, body, message] of cases) {
        test(`rejects ${label}`, async () => {
          const res = await asOwner.post(at(linked, "/runs"), { data: body, failOnStatusCode: false });
          expect(res.status()).toBe(400);
          expect((await res.json()).error).toContain(message);
        });
      }
    });

    test("files and exports refuse names and kinds that are not NYRA's", async () => {
      for (const rest of [
        `/runs/${RUN}/files/other/x.jpg`,
        `/runs/${RUN}/files/screens/..%2Fsecret`,
        `/runs/${RUN}/files/screens/${"a".repeat(129)}`,
        `/runs/${RUN}/files/screens/has space.jpg`,
        `/runs/${RUN}/export/secrets.txt`,
      ]) {
        const res = await asOwner.get(at(linked, rest), { failOnStatusCode: false });
        expect(res.status(), rest).toBe(404);
      }
    });

    test.describe("environment settings validation", () => {
      const patch = (api: APIRequestContext, data: unknown) => api.patch(at(linked, `/environments/${randomUUID()}`), { data: data as object, failOnStatusCode: false });

      test("a QA engineer cannot change settings", async () => {
        const res = await patch(asQa, { mode: "sandbox" });
        expect(res.status()).toBe(403);
        expect((await res.json()).error).toContain("owners and managers");
      });

      const cases: Array<[string, Record<string, unknown>, string]> = [
        ["nothing to update", {}, "Nothing to update"],
        ["a blank name", { name: "  " }, "Environment name is required"],
        ["a 61-character name", { name: "n".repeat(61) }, "at most 60"],
        ["an unknown mode", { mode: "yolo" }, "Mode must be"],
        ["a non-http app URL", { baseUrl: "ftp://x" }, "http://"],
        ["a bare suffix as an allowed domain", { allowedDomains: ["com"] }, "full hostname"],
        ["allowed domains that is not a list", { allowedDomains: "a.example.com" }, "list"],
        ["more than 50 allowed domains", { allowedDomains: Array.from({ length: 51 }, (_, i) => `d${i}.example.com`) }, "at most 50"],
        ["a test account with no username", { testAccount: { password: "pw" } }, "Username or email is required"],
        ["an OTP login method", { testAccount: { username: "qa@example.com", loginMethod: "otp" } }, "Only password login"],
      ];
      for (const [label, body, message] of cases) {
        test(`a manager's edit with ${label} is a 400`, async () => {
          const res = await patch(asManager, body);
          expect(res.status()).toBe(400);
          expect((await res.json()).error).toContain(message);
        });
      }
    });
  });

  // ─── Scans, results, files, exports, live stream and settings, against the fake NYRA ───

  test.describe("scans against the fake NYRA", () => {
    let fake: FakeNyraServer | null = null;
    let nyraId = "";
    let envId = "";

    test.beforeAll(async () => {
      // May wait for the other NYRA spec file to release the fake (see startFakeNyraServer).
      test.setTimeout(11 * 60_000);
      if (nyraFakeIsWired()) fake = await startFakeNyraServer();
    });

    test.afterAll(async () => {
      await fake?.close().catch(() => undefined);
    });

    test.beforeEach(async () => {
      test.skip(!nyraFakeIsWired(), NYRA_FAKE_SKIP_REASON);
      // The outage test closes the fake; bring it back for the tests after it.
      if (!fake) fake = await startFakeNyraServer();
      fake.reset();
      purge(tenant!);
      const created = await (await create(asOwner, { ...valid("Scans"), testAccount: { username: "qa@example.com", password: "S3cret-pw!", loginMethod: "password" } })).json();
      nyraId = created.id;
      envId = fake!.projects[0].environments[0].id;
    });

    const at = (rest = "", id?: string) => `${base()}/projects/${id ?? nyraId}${rest}`;
    const start = (body: Record<string, unknown> = {}, api: APIRequestContext = asOwner) =>
      api.post(at("/runs"), { data: { environmentId: envId, ...body }, failOnStatusCode: false });
    const begin = async (body: Record<string, unknown> = {}) => {
      const res = await start(body);
      expect(res.status(), await res.text()).toBe(201);
      return res.json();
    };

    test("the project detail lists its environments and never a password", async () => {
      const res = await asOwner.get(at());
      expect(res.status()).toBe(200);
      const detail = await res.json();
      expect(detail.environments).toHaveLength(1);
      expect(detail.environments[0]).toMatchObject({ id: envId, mode: "observe", username: "qa@example.com", hasPassword: true, loginMethod: "password" });
      expect(JSON.stringify(detail)).not.toContain("S3cret-pw!");
    });

    test("starts a scan with NYRA's defaults, then with a custom budget sent in NYRA's own field names", async () => {
      const first = await begin();
      expect(first).toMatchObject({ status: "running", environmentId: envId, budget: { maxPages: 25, maxMinutes: 10, maxDepth: 4 } });
      expect(fake!.calls.find((c) => c.method === "POST" && c.path.endsWith("/runs"))!.body).toEqual({ environment_id: envId });

      fake!.finishRun(first.id);
      const second = await begin({ budget: { maxPages: 3, maxMinutes: 2, maxDepth: 1 } });
      expect(second.budget).toEqual({ maxPages: 3, maxMinutes: 2, maxDepth: 1 });
      expect(fake!.calls.filter((c) => c.method === "POST" && c.path.endsWith("/runs")).pop()!.body.budget).toEqual({ max_pages: 3, max_minutes: 2, max_depth: 1 });
    });

    test("accepts the budget limits themselves", async () => {
      const run = await begin({ budget: { maxPages: 500, maxMinutes: 120, maxDepth: 20 } });
      expect(run.budget).toEqual({ maxPages: 500, maxMinutes: 120, maxDepth: 20 });
    });

    test("a second scan on the same environment is a 409 and starts nothing", async () => {
      await begin();
      const again = await start();
      expect(again.status()).toBe(409);
      expect((await again.json()).error).toContain("already running");
      expect(fake!.runs).toHaveLength(1);
    });

    test("an environment NYRA does not know is a 404", async () => {
      const res = await start({ environmentId: randomUUID() });
      expect(res.status()).toBe(404);
    });

    test("lists scans newest first, and reads one", async () => {
      const a = await begin();
      fake!.finishRun(a.id);
      const b = await begin();
      const list = (await (await asOwner.get(at("/runs"))).json()).list;
      expect(list.map((r: any) => r.id)).toEqual([b.id, a.id]);
      const one = await (await asOwner.get(at(`/runs/${a.id}`))).json();
      expect(one).toMatchObject({ id: a.id, status: "completed", summary: { pagesVisited: 1, recordings: 1 } });
      expect(one.finishedAt).toBeTruthy();
    });

    test("a QA engineer can start and stop a scan, as in NYRA", async () => {
      const res = await start({}, asQa);
      expect(res.status()).toBe(201);
      const run = await res.json();
      const stop = await asQa.post(at(`/runs/${run.id}/stop`), { failOnStatusCode: false });
      expect(stop.status()).toBe(202);
      expect(await stop.json()).toEqual({ status: "stopping" });
    });

    test("stopping a finished scan reports its real status", async () => {
      const run = await begin();
      fake!.finishRun(run.id, "partial");
      const res = await asOwner.post(at(`/runs/${run.id}/stop`));
      expect(res.status()).toBe(202);
      expect(await res.json()).toEqual({ status: "partial" });
    });

    test("results are empty while the scan runs and complete once it ends, in Tesbo's field names", async () => {
      const run = await begin();
      expect((await (await asOwner.get(at(`/runs/${run.id}/items`))).json()).list).toEqual([]);
      fake!.finishRun(run.id);
      const { list } = await (await asOwner.get(at(`/runs/${run.id}/items`))).json();
      expect(list.map((i: any) => i.kind).sort()).toEqual(["business_rule", "feature", "screen", "test_case", "workflow"]);
      expect(list[0]).toHaveProperty("reviewStatus", "waiting");
      expect(list[0]).not.toHaveProperty("review_status");
    });

    test("an unknown run is a 404", async () => {
      expect((await asOwner.get(at(`/runs/${randomUUID()}`), { failOnStatusCode: false })).status()).toBe(404);
    });

    test("the live frame is 204 until NYRA has one, then a JPEG that is never cached", async () => {
      const run = await begin();
      expect((await asOwner.get(at(`/runs/${run.id}/live.jpg`))).status()).toBe(204);
      fake!.finishRun(run.id);
      const frame = await asOwner.get(at(`/runs/${run.id}/live.jpg`));
      expect(frame.status()).toBe(200);
      expect(frame.headers()["content-type"]).toBe("image/jpeg");
      expect(frame.headers()["cache-control"]).toContain("no-store");
    });

    test("recordings are listed by name and size only, and served with Range support", async () => {
      const run = await begin();
      expect((await (await asOwner.get(at(`/runs/${run.id}/recordings`))).json()).list).toEqual([]);
      fake!.finishRun(run.id);
      const { list } = await (await asOwner.get(at(`/runs/${run.id}/recordings`))).json();
      expect(list).toEqual([{ name: "session-1.webm", sizeBytes: FAKE_RECORDING.length }]);

      const url = at(`/runs/${run.id}/files/recordings/session-1.webm`);
      const full = await asOwner.get(url);
      expect(full.status()).toBe(200);
      expect(full.headers()["content-type"]).toBe("video/webm");
      expect(full.headers()["accept-ranges"]).toBe("bytes");
      expect((await full.body()).equals(FAKE_RECORDING)).toBe(true);

      const part = await asOwner.get(url, { headers: { Range: "bytes=100-199" } });
      expect(part.status()).toBe(206);
      expect(part.headers()["content-range"]).toBe(`bytes 100-199/${FAKE_RECORDING.length}`);
      expect((await part.body()).equals(FAKE_RECORDING.subarray(100, 200))).toBe(true);

      const past = await asOwner.get(url, { headers: { Range: `bytes=${FAKE_RECORDING.length + 10}-` }, failOnStatusCode: false });
      expect(past.status()).toBe(416);
    });

    test("files carry nosniff and a sandbox policy, and a type Tesbo did not choose becomes a download", async () => {
      const run = await begin();
      fake!.finishRun(run.id);
      const shot = await asOwner.get(at(`/runs/${run.id}/files/screens/screen-001.jpg`));
      expect(shot.status()).toBe(200);
      expect(shot.headers()["content-type"]).toBe("image/jpeg");
      expect(shot.headers()["x-content-type-options"]).toBe("nosniff");
      expect(shot.headers()["content-security-policy"]).toBe("sandbox");

      // NYRA's file said text/html; a browser must never be told that about scanned content.
      const evil = await asOwner.get(at(`/runs/${run.id}/files/recordings/evil.webm`));
      expect(evil.headers()["content-type"]).toBe("application/octet-stream");
      expect(evil.headers()["content-disposition"]).toContain("attachment");
    });

    test("the CSV export neutralises formulas; the knowledge and rules exports pass through; empty rules are a 204", async () => {
      const run = await begin();
      expect((await asOwner.get(at(`/runs/${run.id}/export/business-rules.md`))).status()).toBe(204);
      fake!.finishRun(run.id);

      const csv = await asOwner.get(at(`/runs/${run.id}/export/test-cases.csv`));
      expect(csv.status()).toBe(200);
      expect(csv.headers()["content-type"]).toContain("text/csv");
      expect(csv.headers()["content-disposition"]).toContain(`nyra-${run.id.slice(0, 8)}-test-cases.csv`);
      const text = await csv.text();
      expect(text).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
      expect(text).not.toMatch(/"=HYPERLINK/);

      expect(await (await asOwner.get(at(`/runs/${run.id}/export/knowledge.md`))).text()).toContain("# Fake: knowledge file");
      expect((await asOwner.get(at(`/runs/${run.id}/export/business-rules.md`))).status()).toBe(200);
    });

    test("NYRA being unreachable on a scan route is a 502 with a plain message", async () => {
      const run = await begin();
      await fake!.close();
      fake = null;
      const res = await asOwner.get(at(`/runs/${run.id}`), { failOnStatusCode: false });
      expect(res.status()).toBe(502);
      expect((await res.json()).error).toContain("unreachable");
    });

    test.describe("live events", () => {
      /** The session cookie a browser's EventSource would send. */
      async function cookieHeader(api: APIRequestContext): Promise<string> {
        return (await api.storageState()).cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      }

      /** Reads the stream until `until` matches the text so far, or the timeout passes. */
      async function readStream(runId: string, until: RegExp, headers: Record<string, string> = {}, afterOpen?: () => void) {
        const controller = new AbortController();
        const res = await fetch(`${env.apiBaseUrl}${at(`/runs/${runId}/events`)}`, {
          headers: { cookie: await cookieHeader(asOwner), accept: "text/event-stream", ...headers },
          signal: controller.signal,
        });
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let text = "";
        const timer = setTimeout(() => controller.abort(), 15_000);
        let fired = false;
        try {
          while (!until.test(text)) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
            if (!fired && /event: item/.test(text)) {
              fired = true;
              afterOpen?.();
            }
          }
        } catch {
          // aborted by the timer: the assertions below report what was and was not received
        } finally {
          clearTimeout(timer);
          controller.abort();
        }
        return { status: res.status, contentType: res.headers.get("content-type"), text };
      }

      test("passes NYRA's events through unchanged, including ones sent after it opened", async () => {
        const run = await begin();
        const got = await readStream(run.id, /Later line/, {}, () => fake!.emit(run.id, "log", { level: "info", message: "Later line" }));
        expect(got.status).toBe(200);
        expect(got.contentType).toContain("text/event-stream");
        for (const event of ["log", "status", "digest", "item"]) expect(got.text, event).toContain(`event: ${event}`);
        expect(got.text).toContain("Later line");
        expect(got.text).toContain('"kind":"screen"');
      });

      test("forwards a real Last-Event-ID and drops a malformed one", async () => {
        const run = await begin();
        await readStream(run.id, /event: item/, { "last-event-id": "1761052800123-0" });
        await readStream(run.id, /event: item/, { "last-event-id": "not-a-stream-id" });
        const sent = fake!.calls.filter((c) => c.path.endsWith("/events")).map((c) => c.headers["last-event-id"]);
        expect(sent).toEqual(["1761052800123-0", undefined]);
      });

      test("an unlinked project or an unknown run gets a 404, not an open stream", async () => {
        const run = await begin();
        for (const url of [at(`/runs/${run.id}/events`, randomUUID()), at(`/runs/${randomUUID()}/events`)]) {
          const res = await asOwner.get(url, { failOnStatusCode: false });
          expect(res.status(), url).toBe(404);
        }
      });
    });

    test.describe("environment settings", () => {
      const patch = (data: unknown, api: APIRequestContext = asOwner) => api.patch(at(`/environments/${envId}`), { data: data as object, failOnStatusCode: false });

      test("saves mode, URL and allowed domains, and returns the refreshed project", async () => {
        const res = await patch({ mode: "sandbox", baseUrl: "https://new.example.com", allowedDomains: ["Accounts.Example.com"] });
        expect(res.status(), await res.text()).toBe(200);
        expect((await res.json()).environments[0]).toMatchObject({ mode: "sandbox", baseUrl: "https://new.example.com", allowedDomains: ["accounts.example.com"] });
        expect(fake!.calls.filter((c) => c.method === "PATCH").pop()!.body).toEqual({ base_url: "https://new.example.com", mode: "sandbox", allowed_domains: ["accounts.example.com"] });
      });

      test("a blank password keeps the saved one, and a typed one replaces it", async () => {
        const keep = await patch({ testAccount: { username: "other@example.com", password: "" } });
        expect(keep.status(), await keep.text()).toBe(200);
        const sent = fake!.calls.filter((c) => c.method === "PATCH").pop()!.body.test_account;
        expect(sent).toEqual({ login_url: null, username: "other@example.com", login_method: "password" });
        expect((await keep.json()).environments[0]).toMatchObject({ username: "other@example.com", hasPassword: true });

        await patch({ testAccount: { username: "other@example.com", password: "New-pw-1!" } });
        expect(fake!.calls.filter((c) => c.method === "PATCH").pop()!.body.test_account.password).toBe("New-pw-1!");
      });

      test("adding a test account to an environment that has none needs a password", async () => {
        const bare = await (await create(asOwner, valid("No account"))).json();
        const bareEnv = fake!.projects.find((p) => p.id === bare.id).environments[0].id;
        const res = await asOwner.patch(at(`/environments/${bareEnv}`, bare.id), { data: { testAccount: { username: "qa@example.com", password: "" } }, failOnStatusCode: false });
        expect(res.status()).toBe(400);
        expect((await res.json()).error).toContain("Password is required");
        expect(fake!.calls.some((c) => c.method === "PATCH")).toBe(false);
      });

      test("an environment that is not the project's is a 404", async () => {
        const res = await asOwner.patch(at(`/environments/${randomUUID()}`), { data: { mode: "sandbox" }, failOnStatusCode: false });
        expect(res.status()).toBe(404);
      });

      test("NYRA's refusal is a 400 that does not echo the password", async () => {
        const res = await patch({ name: "force-422", testAccount: { username: "qa@example.com", password: "Echo-env-pw-1" } });
        expect(res.status()).toBe(400);
        expect(await res.text()).not.toContain("Echo-env-pw-1");
      });

      test("a manager can save settings", async () => {
        expect((await patch({ mode: "sandbox" }, asManager)).status()).toBe(200);
      });
    });
  });
});
