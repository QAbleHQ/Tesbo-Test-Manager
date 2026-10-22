import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { resetToLaunch, setGraceWindow, setProPlan } from "../utils/billing-db";
import { env } from "../utils/env";
import {
  FAKE_ITEMS,
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
    const projects = `${literal(t.mainProjectId)}, ${literal(t.secondProjectId)}`;
    // The Knowledge Base documents approvals wrote, then the review state and links.
    exec(`DELETE FROM knowledge_documents WHERE id IN (SELECT document_id FROM nyra_kb_documents WHERE project_id IN (${projects}));`);
    exec(`DELETE FROM nyra_item_reviews WHERE project_id IN (${projects});`);
    exec(`DELETE FROM nyra_run_approvals WHERE project_id IN (${projects});`);
    exec(`DELETE FROM nyra_kb_documents WHERE project_id IN (${projects});`);
    exec(`DELETE FROM nyra_projects WHERE project_id IN (${projects});`);
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
      purge(tenant!);
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
        ["PUT", `/runs/${RUN}/items/review`],
        ["POST", `/runs/${RUN}/items/review-bulk`],
        ["GET", `/runs/${RUN}/document-preview`],
        ["POST", `/runs/${RUN}/approve`],
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
      expect(list.map((i: any) => i.kind).sort()).toEqual(["business_rule", "feature", "form", "screen", "tech", "test_case", "workflow"]);
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

  // ─── Review and approval: validation that needs no NYRA scan ───────────────

  test.describe("review and approval validation", () => {
    let configured = false;
    let linked = "";
    const RUN = randomUUID();

    test.beforeAll(async () => {
      if (!tenant) return;
      configured = (await (await asOwner.get(base())).json()).configured === true;
    });
    test.beforeEach(() => {
      test.skip(!configured, "needs NYRA_API_KEY and NYRA_BASE_URL set on the stack so the routes get past the configured check.");
      linked = randomUUID();
      purge(tenant!);
      exec(`INSERT INTO nyra_projects (project_id, nyra_project_id) VALUES (${literal(tenant!.mainProjectId)}, ${literal(linked)});`);
    });

    const put = (data: unknown, run: string = RUN, api: APIRequestContext = asOwner) =>
      api.put(`${base()}/projects/${linked}/runs/${run}/items/review`, { data: data as object, failOnStatusCode: false });
    const bulk = (data: unknown, api: APIRequestContext = asOwner) =>
      api.post(`${base()}/projects/${linked}/runs/${RUN}/items/review-bulk`, { data: data as object, failOnStatusCode: false });

    const single: Array<[string, Record<string, unknown>, string]> = [
      ["an unknown kind", { kind: "page", key: "k", status: "correct" }, "Unknown kind"],
      ["no kind", { key: "k", status: "correct" }, "Unknown kind"],
      ["no key", { kind: "screen", status: "correct" }, "key is required"],
      ["an empty key", { kind: "screen", key: "", status: "correct" }, "key is required"],
      ["a key over 500 characters", { kind: "screen", key: "k".repeat(501), status: "correct" }, "key is required"],
      ["an unknown status", { kind: "screen", key: "k", status: "approved" }, "Status must be"],
      ["no status", { kind: "screen", key: "k" }, "Status must be"],
    ];
    for (const [label, body, message] of single) {
      test(`a single decision with ${label} is a 400`, async () => {
        const res = await put(body);
        expect(res.status()).toBe(400);
        expect((await res.json()).error).toContain(message);
      });
    }

    const many: Array<[string, Record<string, unknown>, string]> = [
      ["edited as the status", { status: "edited", items: [{ kind: "screen", key: "k" }] }, "Status must be"],
      ["no findings", { status: "correct", items: [] }, "at least one"],
      ["findings that are not a list", { status: "correct", items: "all" }, "at least one"],
      ["more than 500 findings", { status: "correct", items: Array.from({ length: 501 }, (_, i) => ({ kind: "screen", key: `k${i}` })) }, "at most 500"],
      ["a finding with no key", { status: "correct", items: [{ kind: "screen" }] }, "kind and a key"],
      ["a finding of an unknown kind", { status: "correct", items: [{ kind: "page", key: "k" }] }, "kind and a key"],
    ];
    for (const [label, body, message] of many) {
      test(`a bulk decision with ${label} is a 400`, async () => {
        const res = await bulk(body);
        expect(res.status()).toBe(400);
        expect((await res.json()).error).toContain(message);
      });
    }

    test("a malformed run id is a 404 for review, bulk review and approval", async () => {
      expect((await put({ kind: "screen", key: "k", status: "correct" }, "not-a-uuid")).status()).toBe(404);
      expect((await asOwner.post(`${base()}/projects/${linked}/runs/not-a-uuid/items/review-bulk`, { data: { status: "correct", items: [{ kind: "screen", key: "k" }] }, failOnStatusCode: false })).status()).toBe(404);
      expect((await asOwner.post(`${base()}/projects/${linked}/runs/not-a-uuid/approve`, { failOnStatusCode: false })).status()).toBe(404);
      expect((await asOwner.get(`${base()}/projects/${linked}/runs/not-a-uuid/document-preview`, { failOnStatusCode: false })).status()).toBe(404);
    });

    test("a QA engineer cannot approve into the Knowledge Base", async () => {
      const res = await asQa.post(`${base()}/projects/${linked}/runs/${RUN}/approve`, { failOnStatusCode: false });
      expect(res.status()).toBe(403);
      expect((await res.json()).error).toContain("owners and managers");
    });

    test("on the Launch plan review and approval are Pro-only", async () => {
      resetToLaunch(tenant!.organizationId);
      try {
        for (const res of [
          await put({ kind: "screen", key: "k", status: "correct" }),
          await bulk({ status: "correct", items: [{ kind: "screen", key: "k" }] }),
          await asOwner.post(`${base()}/projects/${linked}/runs/${RUN}/approve`, { failOnStatusCode: false }),
          await asOwner.get(`${base()}/projects/${linked}/runs/${RUN}/document-preview`, { failOnStatusCode: false }),
        ]) {
          expect(res.status()).toBe(403);
          expect((await res.json()).error).toContain("Pro");
        }
      } finally {
        setProPlan(tenant!.organizationId);
      }
    });
  });

  // ─── Review and approval against the fake NYRA ─────────────────────────────

  test.describe("review and approval against the fake NYRA", () => {
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
      if (tenant) purge(tenant);
    });
    test.beforeEach(async () => {
      test.skip(!nyraFakeIsWired(), NYRA_FAKE_SKIP_REASON);
      fake!.reset();
      purge(tenant!);
      const created = await (await create(asOwner, valid("Review"))).json();
      nyraId = created.id;
      envId = fake!.projects[0].environments[0].id;
    });

    const at = (rest = "") => `${base()}/projects/${nyraId}${rest}`;
    const SCREEN = { kind: "screen", key: "/login" };
    // A workflow has editable text and steps, so the edit rules are exercised on it.
    const FLOW = { kind: "workflow", key: "login-flow" };
    const FLOW_TITLE = FAKE_ITEMS[2].title;

    /** A scan that has already ended, with NYRA's five findings saved. */
    async function finishedRun(): Promise<string> {
      const run = await (await asOwner.post(at("/runs"), { data: { environmentId: envId } })).json();
      fake!.finishRun(run.id);
      return run.id;
    }
    const decide = (runId: string, body: Record<string, unknown>, api: APIRequestContext = asOwner) =>
      api.put(at(`/runs/${runId}/items/review`), { data: body, failOnStatusCode: false });
    const items = async (runId: string) => (await (await asOwner.get(at(`/runs/${runId}/items`))).json()) as { list: any[]; approval: any; embeddings: { available: boolean; provider: string | null } };
    const statusOf = async (runId: string, kind: string, key: string) => (await items(runId)).list.find((i) => i.kind === kind && i.key === key).reviewStatus;
    const approve = (runId: string, api: APIRequestContext = asOwner, data?: Record<string, unknown>) =>
      api.post(at(`/runs/${runId}/approve`), { data, failOnStatusCode: false });
    const preview = async (runId: string) => (await asOwner.get(at(`/runs/${runId}/document-preview`))).json();
    const docText = (id: string) => scalar(`SELECT content_text FROM knowledge_documents WHERE id = ${literal(id)};`);

    test("every finding starts waiting, and findings cannot be reviewed while the scan runs", async () => {
      const run = await (await asOwner.post(at("/runs"), { data: { environmentId: envId } })).json();
      const early = await decide(run.id, { ...SCREEN, status: "correct" });
      expect(early.status()).toBe(409);
      expect((await early.json()).error).toContain("once the scan has finished");

      fake!.finishRun(run.id);
      const { list, approval } = await items(run.id);
      expect(list).toHaveLength(7);
      expect(list.every((i) => i.reviewStatus === "waiting")).toBe(true);
      expect(approval).toBeNull();
    });

    test("Correct and Reject are saved, show in the findings, and Undo returns a finding to waiting", async () => {
      const runId = await finishedRun();
      const ok = await decide(runId, { ...SCREEN, status: "correct" });
      expect(ok.status(), await ok.text()).toBe(200);
      expect(await ok.json()).toMatchObject({ kind: "screen", key: "/login", reviewStatus: "correct", title: "Sign in" });
      expect(await statusOf(runId, "screen", "/login")).toBe("correct");

      await decide(runId, { kind: "feature", key: "sign-in", status: "rejected" });
      expect(await statusOf(runId, "feature", "sign-in")).toBe("rejected");

      await decide(runId, { ...SCREEN, status: "waiting" });
      expect(await statusOf(runId, "screen", "/login")).toBe("waiting");
      expect(scalar(`SELECT count(*) FROM nyra_item_reviews WHERE project_id = ${literal(tenant!.mainProjectId)} AND kind = 'screen';`)).toBe("0");
    });

    test("a decision changes nothing in NYRA", async () => {
      const runId = await finishedRun();
      fake!.calls.length = 0;
      await decide(runId, { ...SCREEN, status: "correct" });
      await decide(runId, { ...FLOW, status: "edited", title: "Login works" });
      expect(fake!.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    });

    test("an edit keeps NYRA's original beside the new text, and only editable fields change", async () => {
      const runId = await finishedRun();
      const res = await decide(runId, {
        ...FLOW,
        status: "edited",
        title: "Login works",
        data: { goal: "The dashboard opens", steps: ["Open /login", "", "Submit the form"], status: "verified", screens: ["/hijacked"] },
      });
      expect(res.status(), await res.text()).toBe(200);
      const edited = await res.json();
      expect(edited).toMatchObject({ reviewStatus: "edited", title: "Login works" });
      expect(edited.data).toMatchObject({ goal: "The dashboard opens", steps: ["Open /login", "Submit the form"], status: "inferred", screens: ["/login"] });
      expect(edited.original).toMatchObject({ title: FLOW_TITLE, data: { goal: "Get in", status: "inferred" } });

      const again = (await items(runId)).list.find((i) => i.key === "login-flow");
      expect(again).toMatchObject({ reviewStatus: "edited", title: "Login works" });
      // Undo goes back to what NYRA found.
      await decide(runId, { ...FLOW, status: "waiting" });
      const undone = (await items(runId)).list.find((i) => i.key === "login-flow");
      expect(undone).toMatchObject({ reviewStatus: "waiting", title: FLOW_TITLE, original: null });
    });

    test("an edit that changes nothing, a bad value, or an unknown finding is refused", async () => {
      const runId = await finishedRun();
      const same = await decide(runId, { ...FLOW, status: "edited" });
      expect(same.status()).toBe(400);
      expect((await same.json()).error).toContain("Nothing was changed");
      expect((await decide(runId, { ...FLOW, status: "edited", data: { goal: 5 } })).status()).toBe(400);
      expect((await decide(runId, { ...FLOW, status: "edited", title: "   " })).status()).toBe(400);
      expect((await decide(runId, { ...FLOW, status: "edited", data: { steps: "one" } })).status()).toBe(400);
      expect((await decide(runId, { ...FLOW, status: "edited", title: "t".repeat(301) })).status()).toBe(400);
      expect((await decide(runId, { kind: "screen", key: "/nope", status: "correct" })).status()).toBe(404);
      expect(scalar(`SELECT count(*) FROM nyra_item_reviews WHERE project_id = ${literal(tenant!.mainProjectId)};`)).toBe("0");
    });

    test("a decision on a finding can be changed, and the last one wins", async () => {
      const runId = await finishedRun();
      await decide(runId, { ...SCREEN, status: "rejected" });
      await decide(runId, { ...SCREEN, status: "correct" });
      expect(await statusOf(runId, "screen", "/login")).toBe("correct");
      expect(scalar(`SELECT count(*) FROM nyra_item_reviews WHERE project_id = ${literal(tenant!.mainProjectId)} AND kind = 'screen';`)).toBe("1");
    });

    test("a QA engineer can review, as in NYRA", async () => {
      const runId = await finishedRun();
      expect((await decide(runId, { ...SCREEN, status: "correct" }, asQa)).status()).toBe(200);
      expect(await statusOf(runId, "screen", "/login")).toBe("correct");
    });

    test("bulk review marks the findings it knows, skips the ones it does not, and can undo", async () => {
      const runId = await finishedRun();
      const url = at(`/runs/${runId}/items/review-bulk`);
      const all = FAKE_ITEMS.filter((i) => i.kind !== "test_case").map((i) => ({ kind: i.kind, key: i.key }));
      const res = await asOwner.post(url, { data: { status: "correct", items: [...all, { kind: "screen", key: "/gone" }] } });
      expect(await res.json()).toEqual({ updated: 6, skipped: 1 });
      const reviewed = async () => (await items(runId)).list.filter((i) => i.kind !== "test_case");
      expect((await reviewed()).every((i) => i.reviewStatus === "correct")).toBe(true);
      // The test case is not part of the product document, so nothing was decided about it.
      expect(await statusOf(runId, "test_case", "valid-login")).toBe("waiting");

      await asOwner.post(url, { data: { status: "rejected", items: [all[0]] } });
      expect(await statusOf(runId, "screen", "/login")).toBe("rejected");
      await asOwner.post(url, { data: { status: "waiting", items: all } });
      expect((await reviewed()).every((i) => i.reviewStatus === "waiting")).toBe(true);
    });

    test("test cases, API calls and issues are not reviewed: they stay in the report", async () => {
      const runId = await finishedRun();
      for (const [kind, key, label] of [
        ["test_case", "valid-login", "Test cases"],
        ["api_call", "GET /x", "API calls"],
        ["issue", "console:1", "Issues"],
      ]) {
        const one = await decide(runId, { kind, key, status: "correct" });
        expect(one.status(), kind).toBe(400);
        expect((await one.json()).error).toContain(`${label} are not reviewed`);
      }
      // One of them hidden among reviewable findings refuses the whole request, rather than half of it.
      const many = await asOwner.post(at(`/runs/${runId}/items/review-bulk`), {
        data: { status: "correct", items: [{ kind: "screen", key: "/login" }, { kind: "test_case", key: "valid-login" }] },
        failOnStatusCode: false,
      });
      expect(many.status()).toBe(400);
      expect(await statusOf(runId, "screen", "/login")).toBe("waiting");
      expect(scalar(`SELECT count(*) FROM nyra_item_reviews WHERE project_id = ${literal(tenant!.mainProjectId)};`)).toBe("0");
      // They are still in the findings, for the report.
      expect((await items(runId)).list.map((i) => i.kind)).toEqual(expect.arrayContaining(["test_case"]));
    });

    test("approving with nothing marked Correct is refused, and so is approving while the scan runs", async () => {
      const runId = await finishedRun();
      const none = await approve(runId);
      expect(none.status()).toBe(400);
      expect((await none.json()).error).toContain("Mark at least one screen, feature, workflow or business rule Correct");

      const running = await (await asOwner.post(at("/runs"), { data: { environmentId: envId } })).json();
      const early = await approve(running.id);
      expect(early.status()).toBe(409);
      expect(scalar(`SELECT count(*) FROM nyra_kb_documents WHERE project_id = ${literal(tenant!.mainProjectId)};`)).toBe("0");
    });

    test("forms and the tech profile alone do not make a document", async () => {
      const runId = await finishedRun();
      await asOwner.post(at(`/runs/${runId}/items/review-bulk`), {
        data: { status: "correct", items: [{ kind: "form", key: "login-form" }, { kind: "tech", key: "tech" }] },
      });
      const res = await approve(runId);
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toContain("Mark at least one screen, feature, workflow or business rule Correct");
      expect((await preview(runId)).approvable).toBe(0);
      expect(scalar(`SELECT count(*) FROM nyra_kb_documents WHERE project_id = ${literal(tenant!.mainProjectId)};`)).toBe("0");
    });

    test("approving writes ONE product document, with edits in, rejections out and the appendix last", async () => {
      const runId = await finishedRun();
      const everything = FAKE_ITEMS.filter((i) => i.kind !== "test_case").map((i) => ({ kind: i.kind, key: i.key }));
      await asOwner.post(at(`/runs/${runId}/items/review-bulk`), { data: { status: "correct", items: everything } });
      await decide(runId, { ...FLOW, status: "edited", title: "Login works <b>fine</b>", data: { steps: ["Open /login", "Submit"] } });
      await decide(runId, { kind: "feature", key: "sign-in", status: "rejected" });
      const before = await preview(runId);

      const res = await approve(runId);
      expect(res.status(), await res.text()).toBe(200);
      const done = await res.json();
      // Five of the six reviewed findings: the feature was rejected.
      expect(done.itemCount).toBe(5);
      expect(done.documents).toHaveLength(1);
      const doc = done.documents[0];
      expect(doc).toMatchObject({ kind: "product", count: 5, label: "Product knowledge" });
      expect(doc.title).toMatch(/^NYRA · E2E NYRA Review .* · Product knowledge$/);

      const text = docText(doc.documentId);
      const pos = (s: string) => text.indexOf(s);
      expect(text).toContain("### Login works <b>fine</b>");
      expect(text).toContain("1. Open /login\n2. Submit");
      expect(text).toContain("Purpose: Sign in to the shop");
      expect(text).toContain('"Email" is required');
      expect(text).toContain("Fields: Email (required), password");
      // The rejected feature and the test case, which is not part of this document, are not in it.
      expect(text).not.toContain("Account sign in");
      expect(text).not.toContain("## Features");
      expect(text).not.toContain("HYPERLINK");
      // Journeys, screens and rules come before the appendix.
      expect(pos("## Journeys")).toBeLessThan(pos("## Screens"));
      expect(pos("## Screens")).toBeLessThan(pos("## Business rules"));
      expect(pos("## Business rules")).toBeLessThan(pos("## Appendix: forms"));
      expect(pos("## Appendix: forms")).toBeLessThan(pos("## Appendix: technical profile"));

      // The preview is what was stored: every block it showed is in the document, in the same order.
      const headings = before.sections.flatMap((s: any) => s.groups.flatMap((g: any) => g.blocks.map((b: any) => b.heading)));
      expect(headings.length).toBe(5);
      let from = 0;
      for (const h of headings) {
        const found = text.indexOf(h, from);
        expect(found, h).toBeGreaterThanOrEqual(from);
        from = found;
      }

      // Stored as text, and HTML-escaped for the editor, so a finding can never inject markup into the Knowledge Base.
      const html = scalar(`SELECT content_html FROM knowledge_documents WHERE id = ${literal(doc.documentId)};`);
      expect(html).toContain("&lt;b&gt;fine&lt;/b&gt;");
      expect(html).not.toContain("<b>fine");

      // An ordinary Knowledge Base document of this project, published, in a NYRA folder, and the only one.
      expect(
        scalar(
          `SELECT count(*) FROM knowledge_documents d JOIN knowledge_folders f ON f.id = d.folder_id
           WHERE d.id = ${literal(doc.documentId)} AND d.project_id = ${literal(tenant!.mainProjectId)}
             AND f.name = 'NYRA' AND d.status = 'published' AND d.is_deleted = false;`,
        ),
      ).toBe("1");
      expect(scalar(`SELECT count(*) FROM nyra_kb_documents WHERE project_id = ${literal(tenant!.mainProjectId)};`)).toBe("1");
      expect(scalar(`SELECT count(*) FROM knowledge_documents WHERE project_id = ${literal(tenant!.mainProjectId)} AND title LIKE 'NYRA ·%';`)).toBe("1");
      expect(scalar(`SELECT content_hash IS NOT NULL FROM nyra_kb_documents WHERE project_id = ${literal(tenant!.mainProjectId)};`)).toBe("t");

      const after = await items(runId);
      expect(after.approval).toMatchObject({ itemCount: 5 });
      expect(after.approval.documents).toEqual([{ kind: "product", documentId: doc.documentId, title: doc.title }]);
    });

    test("approving twice updates the same document instead of duplicating it", async () => {
      const runId = await finishedRun();
      await decide(runId, { ...SCREEN, status: "correct" });
      const first = await (await approve(runId)).json();
      const second = await (await approve(runId)).json();
      expect(second.documents.map((d: any) => d.documentId)).toEqual(first.documents.map((d: any) => d.documentId));
      expect(scalar(`SELECT count(*) FROM nyra_kb_documents WHERE project_id = ${literal(tenant!.mainProjectId)};`)).toBe("1");
      expect(scalar(`SELECT count(*) FROM nyra_run_approvals WHERE project_id = ${literal(tenant!.mainProjectId)};`)).toBe("1");
    });

    test("two approvals at once make one document", async () => {
      const runId = await finishedRun();
      await decide(runId, { ...SCREEN, status: "correct" });
      const [a, b] = await Promise.all([approve(runId), approve(runId)]);
      expect([a.status(), b.status()]).toEqual([200, 200]);
      expect(scalar(`SELECT count(*) FROM nyra_kb_documents WHERE project_id = ${literal(tenant!.mainProjectId)};`)).toBe("1");
      expect(scalar(`SELECT count(*) FROM knowledge_documents WHERE project_id = ${literal(tenant!.mainProjectId)} AND title LIKE 'NYRA · E2E NYRA Review%';`)).toBe("1");
    });

    test("an earlier scan's approval carries into a later scan's document", async () => {
      const first = await finishedRun();
      await decide(first, { ...SCREEN, status: "correct" });
      const doc = (await (await approve(first)).json()).documents[0];

      const second = await finishedRun();
      expect(await statusOf(second, "screen", "/login")).toBe("waiting");
      await decide(second, { ...FLOW, status: "correct" });
      const done = await (await approve(second)).json();
      expect(done.documents[0].documentId).toBe(doc.documentId);
      expect(done.itemCount).toBe(2);
      const text = docText(doc.documentId);
      expect(text).toContain("Purpose: Sign in to the shop");
      expect(text).toContain("## Journeys");
    });

    test("a later scan's decision wins: rejecting a finding approved before removes it from the document", async () => {
      const first = await finishedRun();
      await decide(first, { ...SCREEN, status: "correct" });
      const doc = (await (await approve(first)).json()).documents[0];
      expect(docText(doc.documentId)).toContain("### Sign in");

      const second = await finishedRun();
      await decide(second, { ...SCREEN, status: "rejected" });
      await decide(second, { ...FLOW, status: "correct" });
      const done = await (await approve(second)).json();
      expect(done.documents[0].documentId).toBe(doc.documentId);
      const text = docText(doc.documentId);
      expect(text).not.toContain("## Screens");
      expect(text).toContain("### Login flow");

      // Undoing the rejection in that scan brings the earlier approval back, since it is the latest decision left.
      await decide(second, { ...SCREEN, status: "waiting" });
      await approve(second);
      expect(docText(doc.documentId)).toContain("## Screens");
    });

    test("rejecting everything that was approved leaves nothing to approve, and the document stays as it was", async () => {
      const runId = await finishedRun();
      await decide(runId, { ...SCREEN, status: "correct" });
      const doc = (await (await approve(runId)).json()).documents[0];
      await decide(runId, { ...SCREEN, status: "rejected" });
      expect((await preview(runId)).approvable).toBe(0);
      const res = await approve(runId);
      expect(res.status()).toBe(400);
      expect(docText(doc.documentId)).toContain("Purpose: Sign in to the shop");
    });

    test("a document deleted from the Knowledge Base is put back by the next approval", async () => {
      const runId = await finishedRun();
      await decide(runId, { ...SCREEN, status: "correct" });
      const first = (await (await approve(runId)).json()).documents[0];
      exec(`UPDATE knowledge_documents SET is_deleted = true, deleted_at = now() WHERE id = ${literal(first.documentId)};`);
      // Deleted is not "edited": nothing to warn about, and the preview no longer points at it.
      const gone = await preview(runId);
      expect(gone).toMatchObject({ documentId: null, editedInKb: false });

      const second = (await (await approve(runId)).json()).documents[0];
      expect(second.documentId).not.toBe(first.documentId);
      expect(scalar(`SELECT document_id FROM nyra_kb_documents WHERE project_id = ${literal(tenant!.mainProjectId)} AND kind = 'product';`)).toBe(second.documentId);
    });

    test("a document a person edited in the Knowledge Base is not overwritten until the caller says so", async () => {
      const runId = await finishedRun();
      await decide(runId, { ...SCREEN, status: "correct" });
      const doc = (await (await approve(runId)).json()).documents[0];
      expect((await preview(runId)).editedInKb).toBe(false);

      exec(`UPDATE knowledge_documents SET content_text = content_text || E'\\nHand-written note.' WHERE id = ${literal(doc.documentId)};`);
      expect(await preview(runId)).toMatchObject({ editedInKb: true, documentId: doc.documentId });

      const refused = await approve(runId);
      expect(refused.status()).toBe(409);
      expect(await refused.json()).toMatchObject({ code: "kb_document_edited" });
      expect(docText(doc.documentId)).toContain("Hand-written note.");

      // Anything but an explicit true is not consent.
      for (const replaceEdits of ["true", 1, "yes"]) {
        expect((await approve(runId, asOwner, { replaceEdits })).status(), String(replaceEdits)).toBe(409);
      }
      expect(docText(doc.documentId)).toContain("Hand-written note.");

      const replaced = await approve(runId, asOwner, { replaceEdits: true });
      expect(replaced.status(), await replaced.text()).toBe(200);
      expect(docText(doc.documentId)).not.toContain("Hand-written note.");
      expect((await preview(runId)).editedInKb).toBe(false);
      // And it is an ordinary approval again afterwards.
      expect((await approve(runId)).status()).toBe(200);
    });

    test("a document left over from the one-per-kind approach is left alone", async () => {
      const runId = await finishedRun();
      await decide(runId, { ...SCREEN, status: "correct" });
      const doc = (await (await approve(runId)).json()).documents[0];
      const folder = scalar(`SELECT folder_id FROM knowledge_documents WHERE id = ${literal(doc.documentId)};`);
      const legacy = scalar(
        `INSERT INTO knowledge_documents (organization_id, project_id, folder_id, title, content_text, status)
         VALUES (${literal(tenant!.organizationId)}, ${literal(tenant!.mainProjectId)}, ${literal(folder)}, 'NYRA · old · Screens', 'old text', 'published') RETURNING id;`,
      );
      exec(`INSERT INTO nyra_kb_documents (project_id, nyra_project_id, kind, document_id) VALUES (${literal(tenant!.mainProjectId)}, ${literal(nyraId)}, 'screen', ${literal(legacy)});`);

      const again = await (await approve(runId)).json();
      expect(again.documents.map((d: any) => d.documentId)).toEqual([doc.documentId]);
      expect((await items(runId)).approval.documents.map((d: any) => d.documentId)).toEqual([doc.documentId]);
      expect(docText(legacy)).toBe("old text");
      expect(scalar(`SELECT is_deleted FROM knowledge_documents WHERE id = ${literal(legacy)};`)).toBe("f");
    });

    test.describe("the document preview", () => {
      test("starts empty, grows with Correct and edits, and shrinks with Reject and Undo", async () => {
        const runId = await finishedRun();
        expect(await preview(runId)).toMatchObject({ approvable: 0, sections: [], documentId: null, editedInKb: false, clipped: false });

        await decide(runId, { ...SCREEN, status: "correct" });
        const one = await preview(runId);
        expect(one).toMatchObject({ approvable: 1, counts: { screen: 1, feature: 0 } });
        expect(one.sections.map((s: any) => s.heading)).toEqual(["Screens"]);

        await decide(runId, { ...FLOW, status: "edited", title: "Sign in flow", data: { goal: "Get in fast" } });
        const two = await preview(runId);
        expect(two.sections.map((s: any) => s.heading)).toEqual(["Journeys", "Screens"]);
        expect(two.sections[0].groups[0].blocks[0]).toMatchObject({ heading: "Sign in flow", facts: [["Goal", "Get in fast"], ["Screens", "/login"]] });

        await decide(runId, { ...SCREEN, status: "rejected" });
        await decide(runId, { ...FLOW, status: "waiting" });
        expect(await preview(runId)).toMatchObject({ approvable: 0, sections: [] });
      });

      test("groups features by module and rules by category, with the appendix after the story", async () => {
        const runId = await finishedRun();
        await asOwner.post(at(`/runs/${runId}/items/review-bulk`), {
          data: { status: "correct", items: FAKE_ITEMS.filter((i) => i.kind !== "test_case").map((i) => ({ kind: i.kind, key: i.key })) },
        });
        const p = await preview(runId);
        expect(p.sections.map((s: any) => s.heading)).toEqual(["Features", "Journeys", "Screens", "Business rules", "Appendix: forms", "Appendix: technical profile"]);
        expect(p.sections[0].groups.map((g: any) => g.heading)).toEqual(["Account"]);
        expect(p.sections[3].groups.map((g: any) => g.heading)).toEqual(["Validation"]);
        expect(p.title).toMatch(/· Product knowledge$/);
        expect(p.intro.join(" ")).toContain("https://staging.example.com");
      });

      test("is refused while the scan runs, for a malformed run id, and for another Tesbo project", async () => {
        const running = await (await asOwner.post(at("/runs"), { data: { environmentId: envId } })).json();
        expect((await asOwner.get(at(`/runs/${running.id}/document-preview`), { failOnStatusCode: false })).status()).toBe(409);
        expect((await asOwner.get(at("/runs/not-a-uuid/document-preview"), { failOnStatusCode: false })).status()).toBe(404);
        fake!.finishRun(running.id);
        const cross = await asOwner.get(`${base(tenant!.secondProjectId)}/projects/${nyraId}/runs/${running.id}/document-preview`, { failOnStatusCode: false });
        expect(cross.status()).toBe(404);
      });

      test("is readable by a QA engineer, who reviews", async () => {
        const runId = await finishedRun();
        expect((await asQa.get(at(`/runs/${runId}/document-preview`), { failOnStatusCode: false })).status()).toBe(200);
      });

      test("never carries a password or a key", async () => {
        const runId = await finishedRun();
        await decide(runId, { ...SCREEN, status: "correct" });
        const text = await (await asOwner.get(at(`/runs/${runId}/document-preview`))).text();
        expect(text).not.toContain("S3cret");
        expect(text).not.toContain("qa@example.com");
      });
    });

    test("another Tesbo project keeps its own review state and documents", async () => {
      const runId = await finishedRun();
      await decide(runId, { ...SCREEN, status: "correct" });
      await approve(runId);
      const res = await asOwner.get(`${base(tenant!.secondProjectId)}/projects/${nyraId}/runs/${runId}/items`, { failOnStatusCode: false });
      expect(res.status()).toBe(404);
      expect(scalar(`SELECT count(*) FROM nyra_kb_documents WHERE project_id = ${literal(tenant!.secondProjectId)};`)).toBe("0");
    });

    // Vectors use the project's AI key when it can embed (OpenAI, Google, Mistral), else another such
    // key in the workspace. Anthropic cannot embed. The page is told which, and never sees a key.
    test.describe("whether approved findings will get vectors", () => {
      const keyName = () => `E2E NYRA embeddings ${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const addKey = (provider: string, active = true): string => {
        const name = keyName();
        exec(
          `INSERT INTO workspace_ai_keys (organization_id, name, provider, api_key, is_active)
           VALUES (${literal(tenant!.organizationId)}, ${literal(name)}, ${literal(provider)}, 'e2e-not-a-real-key', ${active});`,
        );
        return scalar(`SELECT id FROM workspace_ai_keys WHERE organization_id = ${literal(tenant!.organizationId)} AND name = ${literal(name)};`);
      };
      const clearKeys = () => {
        exec(`DELETE FROM project_ai_key_allocations WHERE project_id IN (${literal(tenant!.mainProjectId)}, ${literal(tenant!.secondProjectId)});`);
        exec(`DELETE FROM workspace_ai_keys WHERE organization_id = ${literal(tenant!.organizationId)} AND name LIKE 'E2E NYRA embeddings%';`);
      };
      test.beforeEach(clearKeys);
      test.afterAll(() => tenant && clearKeys());

      const embeddingsOf = async (runId: string) => (await items(runId)).embeddings;

      test("without an AI key that can embed, the findings page and the approval both say so", async () => {
        const runId = await finishedRun();
        expect(await embeddingsOf(runId)).toEqual({ available: false, provider: null });
        await decide(runId, { ...SCREEN, status: "correct" });
        const done = await (await approve(runId)).json();
        expect(done.embeddings).toEqual({ available: false, provider: null });
        // The documents are still written; only the vectors wait for a key.
        expect(done.documents).toHaveLength(1);
      });

      test("an Anthropic key alone cannot make vectors", async () => {
        addKey("anthropic");
        expect(await embeddingsOf(await finishedRun())).toEqual({ available: false, provider: null });
      });

      test("an OpenAI, Google or Mistral key in the workspace is used, whatever the project's chat key is", async () => {
        const anthropic = addKey("anthropic");
        exec(`INSERT INTO project_ai_key_allocations (project_id, workspace_ai_key_id) VALUES (${literal(tenant!.mainProjectId)}, ${literal(anthropic)});`);
        for (const provider of ["openai", "google", "mistral"]) {
          const id = addKey(provider);
          expect(await embeddingsOf(await finishedRun()), provider).toEqual({ available: true, provider });
          exec(`DELETE FROM workspace_ai_keys WHERE id = ${literal(id)};`);
          fake!.runs.length = 0;
        }
      });

      test("a project whose own key can embed uses that key", async () => {
        const openai = addKey("openai");
        exec(`INSERT INTO project_ai_key_allocations (project_id, workspace_ai_key_id) VALUES (${literal(tenant!.mainProjectId)}, ${literal(openai)});`);
        const runId = await finishedRun();
        await decide(runId, { ...SCREEN, status: "correct" });
        expect((await (await approve(runId)).json()).embeddings).toEqual({ available: true, provider: "openai" });
      });

      test("an inactive key does not count", async () => {
        addKey("openai", false);
        expect(await embeddingsOf(await finishedRun())).toEqual({ available: false, provider: null });
      });

      test("neither the key nor its name is ever in the response", async () => {
        const name = keyName();
        exec(
          `INSERT INTO workspace_ai_keys (organization_id, name, provider, api_key, is_active)
           VALUES (${literal(tenant!.organizationId)}, ${literal(name)}, 'openai', 'sk-e2e-secret-value', true);`,
        );
        const runId = await finishedRun();
        const text = await (await asOwner.get(at(`/runs/${runId}/items`))).text();
        expect(text).not.toContain("sk-e2e-secret-value");
        expect(text).not.toContain(name);
      });
    });
  });
});
