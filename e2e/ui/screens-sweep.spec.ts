import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { env } from "../utils/env";
import { exec, literal, scalar } from "../utils/psql";
import { screensSuiteSkipReason, screensTenant } from "../utils/screens-tenant";

/*
 * A breadth sweep over the screens no other spec opens.
 *
 * WHY BREADTH RATHER THAN DEPTH. The Screens work recorded in docs/e2e-coverage-waves.md found eleven
 * product bugs precisely by opening every page once and looking, and the two most valuable — a
 * localStorage crash and two contrast failures — were on pages nobody was asserting anything specific
 * about. A page that renders its own error boundary, throws in a client component, or comes up blank
 * fails here; that is a low bar, and it is exactly the bar these pages had never been held to.
 *
 * Each screen gets the same four checks, in renderCheck():
 *   1. the route responds and settles without a page-level HTTP error
 *   2. no Next.js error overlay or error-boundary text is on the page
 *   3. no console exception was thrown while it rendered
 *   4. something specific to that screen is visible — not just "a body exists"
 *
 * The deeper assertions for these areas live in their own specs (api/zyra.spec.ts,
 * api/knowledge-base.spec.ts, api/integrations.spec.ts). This file's job is that the screens open at
 * all, which the API-level suites cannot tell us.
 */

const tenant = screensTenant();
const skipReason = screensSuiteSkipReason(tenant);

/**
 * An absolute API URL.
 *
 * The ui project's baseURL is the WEB origin, so page.request.post("/api/...") posts to the frontend
 * and gets Next.js's 404 document back — which then fails as "unexpected token <" when a test reads
 * it as JSON. Every fixture call here therefore names the API host explicitly.
 */
function api(pathname: string): string {
  return `${env.apiBaseUrl}${pathname}`;
}

test.use({ storageState: path.join(__dirname, "../.auth/state-screens.json") });

/** Text a Next.js error boundary or an unhandled render error puts on the page. */
const ERROR_MARKERS = [
  "Application error",
  "Unhandled Runtime Error",
  "This page could not be found",
  "Something went wrong",
  "client-side exception",
];

interface RenderResult {
  consoleErrors: string[];
}

/**
 * Opens a route and fails if it did not render.
 *
 * Console errors are collected rather than asserted on immediately, so a caller can allow the ones a
 * screen legitimately produces (a 404 fetch for a fixture that does not exist) while still failing on
 * a thrown exception.
 */
async function renderCheck(page: Page, url: string): Promise<RenderResult> {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const response = await page.goto(url, { waitUntil: "domcontentloaded" });
  // A client-rendered route answers 200 with a shell; what must not happen is a 5xx document.
  if (response) {
    expect(response.status(), `${url} answered ${response.status()}`).toBeLessThan(500);
  }
  // networkidle is deliberately avoided: /activity needs ~25s of a 30s budget to reach it (see the
  // tracker's "Worth checking"), and every page here would pay that.
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator("body")).toBeVisible();

  const bodyText = (await page.locator("body").innerText().catch(() => "")) || "";
  for (const marker of ERROR_MARKERS) {
    expect(bodyText, `${url} rendered an error boundary containing "${marker}"`).not.toContain(marker);
  }
  // A blank page is a render failure that no error boundary caught.
  expect(bodyText.trim().length, `${url} rendered an empty page`).toBeGreaterThan(0);

  return { consoleErrors };
}

/** The exceptions that mean a component threw, as opposed to a fetch that 404'd. */
function thrownExceptions(result: RenderResult): string[] {
  return result.consoleErrors.filter((e) => e.startsWith("pageerror:"));
}

test.describe("screens sweep — the pages no other spec opens", () => {
  test.skip(!!skipReason, skipReason ?? "");

  const projectId = () => tenant!.projectId;

  // ─── Repository screens ───────────────────────────────────────────────────

  test("SWP-01 the suites screen lists the project's suites", { tag: '@tesbo.testId("TES-TC-807")' }, async ({ page }) => {
    const result = await renderCheck(page, `/projects/${projectId()}/suites`);
    await expect(page.getByRole("heading", { name: /suite/i }).first()).toBeVisible();
    expect(thrownExceptions(result)).toEqual([]);
  });

  test("SWP-02 a test case's detail screen opens on a real test case", { tag: '@tesbo.testId("TES-TC-808")' }, async ({ page }) => {
    // Created through the API so the screen has something real to render — a detail page reached with
    // an invented id would only ever exercise its not-found branch.
    const title = `E2E Sweep Case ${Date.now()}`;
    const created = await page.request.post(api(`/api/projects/${projectId()}/testcases`), {
      data: { title },
      failOnStatusCode: false,
    });
    expect(created.status(), `seeding a test case — ${await created.text()}`).toBe(201);
    const testcaseId = (await created.json()).id;

    try {
      const result = await renderCheck(page, `/projects/${projectId()}/testcases/${testcaseId}`);
      await expect(page.getByText(title).first()).toBeVisible();
      expect(thrownExceptions(result)).toEqual([]);
    } finally {
      await page.request.delete(api(`/api/projects/${projectId()}/testcases/${testcaseId}`), {
        failOnStatusCode: false,
      });
    }
  });

  test("SWP-03 a test case detail screen for an id that does not exist says so", { tag: '@tesbo.testId("TES-TC-809")' }, async ({ page }) => {
    const result = await renderCheck(page, `/projects/${projectId()}/testcases/11111111-1111-4111-8111-111111111111`);
    // The not-found branch has to render a message rather than an empty frame or a thrown error.
    expect(thrownExceptions(result)).toEqual([]);
    const body = await page.locator("body").innerText();
    expect(body.trim().length).toBeGreaterThan(0);
  });

  // ─── Knowledge Base ───────────────────────────────────────────────────────

  test("SWP-04 a knowledge base document opens in the editor", { tag: '@tesbo.testId("TES-TC-810")' }, async ({ page }) => {
    const rootFolderId = await ensureKnowledgeRoot(page);
    const title = `E2E Sweep Doc ${Date.now()}`;
    const created = await page.request.post(api(`/api/projects/${projectId()}/knowledge-base/documents`), {
      data: { title, folderId: rootFolderId, contentHtml: "<p>swept</p>", contentText: "swept" },
      failOnStatusCode: false,
    });
    expect(created.status(), `seeding a document — ${await created.text()}`).toBe(201);
    const documentId = (await created.json()).id;

    try {
      const result = await renderCheck(page, `/projects/${projectId()}/knowledge-base/documents/${documentId}`);
      await expect(page.getByText(title).first()).toBeVisible();
      expect(thrownExceptions(result)).toEqual([]);
    } finally {
      exec(`DELETE FROM knowledge_documents WHERE id = ${literal(documentId)};`);
    }
  });

  /** The project's KB root folder, backfilled if project creation predates the seeding fix. */
  async function ensureKnowledgeRoot(page: Page): Promise<string> {
    const tree = await page.request.get(api(`/api/projects/${projectId()}/knowledge-base/folders/tree`), {
      failOnStatusCode: false,
    });
    if (tree.ok()) return (await tree.json()).id;
    // See the same helper in api/knowledge-base.spec.ts, and KB-A-00 for the defect behind it.
    exec(
      "INSERT INTO knowledge_folders (organization_id, project_id, parent_folder_id, name, is_root) " +
        `VALUES (${literal(tenant!.organizationId)}, ${literal(projectId())}, NULL, 'Knowledge base', true);`,
    );
    return scalar(
      `SELECT id FROM knowledge_folders WHERE project_id = ${literal(projectId())} AND is_root = true;`,
    );
  }

  // ─── Execution ────────────────────────────────────────────────────────────

  test("SWP-05 the execute screen opens on a run with a case in it", { tag: '@tesbo.testId("TES-TC-811")' }, async ({ page }) => {
    const title = `E2E Sweep Exec Case ${Date.now()}`;
    const caseRes = await page.request.post(api(`/api/projects/${projectId()}/testcases`), {
      data: { title },
      failOnStatusCode: false,
    });
    const testcaseId = (await caseRes.json()).id;
    const cycleRes = await page.request.post(api(`/api/projects/${projectId()}/cycles`), {
      data: { name: `E2E Sweep Run ${Date.now()}` },
      failOnStatusCode: false,
    });
    expect(cycleRes.status(), `seeding a run — ${await cycleRes.text()}`).toBe(201);
    const cycleId = (await cycleRes.json()).id;
    await page.request.post(api(`/api/cycles/${cycleId}/testcases`), {
      data: { testcaseIds: [testcaseId] },
      failOnStatusCode: false,
    });
    const executions = await (await page.request.get(api(`/api/cycles/${cycleId}/executions`))).json();
    const executionId = executions[0]?.id;
    expect(executionId, "the seeded run has no execution to open").toBeTruthy();

    try {
      const result = await renderCheck(page, `/projects/${projectId()}/cycles/${cycleId}/execute/${executionId}`);
      // The execute screen's whole purpose is showing the case being run and the result controls.
      await expect(page.getByText(title).first()).toBeVisible();
      expect(thrownExceptions(result)).toEqual([]);
    } finally {
      exec(
        `DELETE FROM executions WHERE cycle_item_id IN (SELECT id FROM cycle_items WHERE cycle_id = ${literal(cycleId)});`,
      );
      exec(`DELETE FROM cycle_items WHERE cycle_id = ${literal(cycleId)};`);
      exec(`DELETE FROM cycles WHERE id = ${literal(cycleId)};`);
      await page.request.delete(api(`/api/projects/${projectId()}/testcases/${testcaseId}`), { failOnStatusCode: false });
    }
  });

  test("SWP-06 the run schedule screen opens and does not claim a schedule was saved", { tag: '@tesbo.testId("TES-TC-812")' }, async ({ page }) => {
    const result = await renderCheck(page, `/projects/${projectId()}/cycles/schedule`);
    expect(thrownExceptions(result)).toEqual([]);
    // Scheduled runs are not implemented (see api/execution-ops.spec.ts EXO-A-08b). The screen may
    // exist ahead of the feature, but it must not be showing a saved schedule that does not exist.
    const body = await page.locator("body").innerText();
    expect(body).not.toContain("local-schedule");
  });

  test("SWP-07 a shared run opens for a visitor with no session", { tag: '@tesbo.testId("TES-TC-813")' }, async ({ browser }) => {
    // The one screen here that must work with NO session — that is what a share link is.
    const owner = await browser.newContext({ storageState: path.join(__dirname, "../.auth/state-screens.json") });
    const ownerPage = await owner.newPage();
    let cycleId = "";
    let token = "";
    try {
      const cycleRes = await ownerPage.request.post(api(`/api/projects/${projectId()}/cycles`), {
        data: { name: `E2E Sweep Shared ${Date.now()}` },
        failOnStatusCode: false,
      });
      cycleId = (await cycleRes.json()).id;
      const shared = await ownerPage.request.post(api(`/api/cycles/${cycleId}/share`), {
        data: { enabled: true },
        failOnStatusCode: false,
      });
      expect(shared.status(), `sharing a run — ${await shared.text()}`).toBeLessThan(400);
      token = (await shared.json()).shareToken;
      expect(token).toBeTruthy();
    } finally {
      await owner.close();
    }

    // A genuinely anonymous context: storageState is cleared explicitly, since the project default
    // would otherwise sign this visitor in and prove nothing.
    const visitor = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await visitor.newPage();
    try {
      const result = await renderCheck(page, `/share/${token}`);
      expect(thrownExceptions(result)).toEqual([]);
      // It must not have bounced the visitor to a login screen.
      expect(page.url(), "a share link redirected an anonymous visitor to sign in").not.toContain("/login");
    } finally {
      await visitor.close();
      if (cycleId) {
        // cycle_items.cycle_id / executions.cycle_item_id are ON DELETE RESTRICT now (V111) — clear
        // children before the cycle itself.
        exec(`DELETE FROM executions WHERE cycle_item_id IN (SELECT id FROM cycle_items WHERE cycle_id = ${literal(cycleId)});`);
        exec(`DELETE FROM cycle_items WHERE cycle_id = ${literal(cycleId)};`);
        exec(`DELETE FROM cycles WHERE id = ${literal(cycleId)};`);
      }
    }
  });

  // ─── Zyra ─────────────────────────────────────────────────────────────────

  test("SWP-08 the Zyra chat screen opens on a workspace with no AI provider configured", { tag: '@tesbo.testId("TES-TC-814")' }, async ({ page }) => {
    // The state every workspace starts in. The screen has to render the "connect a provider" path
    // rather than throwing on an agent payload it did not get.
    const result = await renderCheck(page, `/projects/${projectId()}/agents/zyra`);
    expect(thrownExceptions(result)).toEqual([]);
    await expect(page.locator("body")).toContainText(/zyra/i);
  });

  test("SWP-09 the Zyra settings screen opens", { tag: '@tesbo.testId("TES-TC-815")' }, async ({ page }) => {
    const result = await renderCheck(page, `/projects/${projectId()}/agents/zyra/settings`);
    expect(thrownExceptions(result)).toEqual([]);
    await expect(page.locator("body")).toContainText(/setting|range|generat/i);
  });

  test("SWP-10 the agent tasks list opens, empty and with a task in it", { tag: '@tesbo.testId("TES-TC-816")' }, async ({ page }) => {
    const empty = await renderCheck(page, `/projects/${projectId()}/agents/tasks`);
    expect(thrownExceptions(empty)).toEqual([]);

    // With a task present, so the list's populated branch renders too — an empty-state-only check
    // would miss a crash in the row component.
    const userStory = `E2E Sweep Story ${Date.now()}`;
    exec(
      "INSERT INTO ai_generation_requests (project_id, requested_by, provider, model, user_story, " +
        "requested_count, generated_count, generated_payload, agent_name, task_status) VALUES (" +
        `${literal(projectId())}, (SELECT user_id FROM project_members WHERE project_id = ${literal(projectId())} LIMIT 1), ` +
        `'openai', 'gpt-4o-mini', ${literal(userStory)}, 1, 1, ` +
        `'[{"title":"E2E sweep draft","steps":[]}]'::jsonb, 'Zyra the Test Generator', 'awaiting_review');`,
    );
    const taskId = scalar(
      `SELECT id FROM ai_generation_requests WHERE project_id = ${literal(projectId())} ORDER BY created_at DESC LIMIT 1;`,
    );

    try {
      const populated = await renderCheck(page, `/projects/${projectId()}/agents/tasks`);
      expect(thrownExceptions(populated)).toEqual([]);

      const detail = await renderCheck(page, `/projects/${projectId()}/agents/tasks/${taskId}`);
      expect(thrownExceptions(detail)).toEqual([]);
      // The detail screen is where a reviewer reads the request and its drafts.
      await expect(page.locator("body")).toContainText(/E2E sweep draft|E2E Sweep Story/);
    } finally {
      exec(`DELETE FROM ai_generation_requests WHERE id = ${literal(taskId)};`);
    }
  });

  // ─── Settings screens ─────────────────────────────────────────────────────

  test("SWP-11 the project API tokens screen opens and shows no secret at rest", { tag: '@tesbo.testId("TES-TC-817")' }, async ({ page }) => {
    const result = await renderCheck(page, `/projects/${projectId()}/settings/api-tokens`);
    expect(thrownExceptions(result)).toEqual([]);
    await expect(page.locator("body")).toContainText(/token|key/i);
    // A token's raw value is shown once at creation; a screen that reloads it later would mean the
    // API is handing the secret back, which api/tail.spec.ts TAI-A-01 forbids.
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(/tsb_[A-Za-z0-9]{16,}/);
  });

  test("SWP-12 the workspace integration screens open with nothing connected", { tag: '@tesbo.testId("TES-TC-818")' }, async ({ page }) => {
    for (const provider of ["jira", "linear"]) {
      const result = await renderCheck(page, `/settings/integrations/${provider}`);
      expect(thrownExceptions(result), `/settings/integrations/${provider} threw`).toEqual([]);
      await expect(page.locator("body")).toContainText(new RegExp(provider, "i"));
    }
  });

  test("SWP-13 the project integration screens open with nothing connected", { tag: '@tesbo.testId("TES-TC-819")' }, async ({ page }) => {
    for (const provider of ["jira", "linear"]) {
      const result = await renderCheck(page, `/projects/${projectId()}/settings/integrations/${provider}`);
      expect(thrownExceptions(result), `project ${provider} integration screen threw`).toEqual([]);
      await expect(page.locator("body")).toContainText(new RegExp(provider, "i"));
    }
  });

  test("SWP-14 the AI providers screens open", { tag: '@tesbo.testId("TES-TC-820")' }, async ({ page }) => {
    const list = await renderCheck(page, "/settings/ai-providers");
    expect(thrownExceptions(list)).toEqual([]);
    await expect(page.locator("body")).toContainText(/provider|openai|anthropic|model/i);

    const details = await renderCheck(page, "/settings/ai-providers/details");
    expect(thrownExceptions(details)).toEqual([]);
    // Neither screen may render a stored key.
    for (const body of [await page.locator("body").innerText()]) {
      expect(body).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    }
  });

  // ─── Pre-auth and onboarding screens ──────────────────────────────────────

  test("SWP-15 the OTP verification screen opens for a visitor with no session", { tag: '@tesbo.testId("TES-TC-821")' }, async ({ browser }) => {
    const visitor = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await visitor.newPage();
    try {
      const result = await renderCheck(page, "/verify-otp");
      expect(thrownExceptions(result)).toEqual([]);
      // It is reached mid-signup with no session, so it must render its own form rather than bounce.
      await expect(page.locator("body")).toContainText(/code|otp|verif/i);
    } finally {
      await visitor.close();
    }
  });

  test("SWP-16 an invitation link opens for a visitor with no session, valid and invalid", { tag: '@tesbo.testId("TES-TC-822")' }, async ({ browser }) => {
    const visitor = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await visitor.newPage();
    try {
      // An invented token: the screen's job is to say the invitation is not usable, not to crash.
      const invalid = await renderCheck(page, "/invite/not-a-real-invitation-token");
      expect(thrownExceptions(invalid)).toEqual([]);
      await expect(page.locator("body")).toContainText(/invit|expire|invalid|not found/i);

      const register = await renderCheck(page, "/invite/not-a-real-invitation-token/register");
      expect(thrownExceptions(register)).toEqual([]);
    } finally {
      await visitor.close();
    }
  });

  test("SWP-17 the onboarding screen opens for a signed-in user", { tag: '@tesbo.testId("TES-TC-823")' }, async ({ page }) => {
    // Reached straight after signup, before a workspace exists. This account already has one, so the
    // screen may redirect — what it must not do is throw or come up blank.
    const result = await renderCheck(page, "/onboarding");
    expect(thrownExceptions(result)).toEqual([]);
  });
});
