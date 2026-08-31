import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { exec, literal, scalar } from "../utils/psql";
import {
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  writeStorageState,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * The Agents screens: the agent picker, Zyra's chat, Zyra's settings, the task board, and the task
 * detail review table.
 *
 * NO AI PROVIDER IS CALLED, and that is the same deliberate boundary api/zyra.spec.ts draws. The
 * fixture workspace has no AI key allocated, so every route that would reach a model stops at the
 * allocation check. That is not a reduced version of the feature — it is the state a new workspace
 * is actually in, and the state these screens spend most of their life rendering: "AI provider not
 * connected", a disabled "Create task", a settings page that says "Needs key".
 *
 * What that leaves untested is generation itself, which needs utils/fake-ai-server.ts (Wave 0 item 3,
 * still missing). Everything downstream of generation is reachable anyway, because a completed task
 * is just a row: seedTask() writes one into ai_generation_requests with its drafts, activity and
 * sources, and the whole review flow — select, save into a suite, delete, close — runs against it.
 * That is where the real risk lives: those actions write test cases into the project and delete
 * generated work, and none of it is covered anywhere else.
 *
 * Two things about the seed that cost time to discover:
 *
 *   - `agent_name` must be exactly "Zyra the Test Generator" (ZYRA_AGENT_NAME in legacy.service.ts).
 *     The tasks list filters `agent_name = ANY(...)`, so a row with any other value is invisible on
 *     the board while still being reachable by id — which looks like a UI bug and isn't.
 *   - a task's `drafts` are `generated_payload` verbatim (formatAiTask), so the seed controls the
 *     review table exactly.
 *
 * Runs against its own disposable workspace ("zyra-ui"). Locator conventions match
 * ui/knowledge-base.spec.ts: Modal is role="presentation" with an h2 title, and FieldLabel has no
 * htmlFor, so fields are reached through the modal by role and placeholder rather than getByLabel.
 */

/** legacy.service.ts ZYRA_AGENT_NAME. The tasks list is filtered on it. */
const ZYRA_AGENT_NAME = "Zyra the Test Generator";

test.describe("zyra / agents (UI)", () => {
  let tenant: RbacTenant | null = null;
  let api: APIRequestContext;
  const states = new Map<string, string>();
  const contexts: BrowserContext[] = [];

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("zyra-ui");
    if (!tenant) return;
    api = await loginAs(tenant.owner);
    states.set("owner", await writeStorageState(tenant.owner, "zyra-ui-owner"));
    states.set("qa", await writeStorageState(tenant.qa, "zyra-ui-qa"));
    states.set("guest", await writeStorageState(tenant.guest, "zyra-ui-guest"));
    purgeZyra(tenant);
  });

  test.afterAll(async () => {
    if (tenant) purgeZyra(tenant);
    if (api) await api.dispose();
    await Promise.all(contexts.map((ctx) => ctx.close()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  test.afterEach(() => {
    if (tenant) purgeZyra(tenant);
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function purgeZyra(t: RbacTenant): void {
    const projects = `${literal(t.mainProjectId)}, ${literal(t.secondProjectId)}`;
    exec(`DELETE FROM ai_generation_requests WHERE project_id IN (${projects});`);
    exec(
      `DELETE FROM zyra_chat_messages WHERE session_id IN (SELECT id FROM zyra_chat_sessions WHERE project_id IN (${projects}));`,
    );
    exec(`DELETE FROM zyra_chat_sessions WHERE project_id IN (${projects});`);
    // Saved drafts land in real test cases and suites, so the review tests have to clear those too
    // or the next run's counts drift.
    exec(`DELETE FROM testcases WHERE project_id IN (${projects});`);
    exec(`DELETE FROM suites WHERE project_id IN (${projects});`);
    // Zyra's settings live on the PROJECT, not in a table of their own, so a capability switched
    // off by one test stays off for the next one and for the next run against the same volume.
    // Dropping the key restores the built-in defaults (every capability on, the default range).
    exec(`UPDATE projects SET settings = COALESCE(settings, '{}'::jsonb) - 'zyraAgent' WHERE id IN (${projects});`);
  }

  function stamp(label: string): string {
    return `E2E ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  }

  interface SeedOptions {
    userStory?: string;
    status?: string;
    drafts?: Array<Record<string, unknown>>;
    projectId?: string;
    context?: string;
    sources?: Array<{ type: string; title: string; detail: string }>;
  }

  /** Writes a completed Zyra task straight into the table, drafts and all. Returns its id. */
  function seedTask(options: SeedOptions = {}): string {
    const t = tenant!;
    const projectId = options.projectId ?? t.mainProjectId;
    const userStory = options.userStory ?? stamp("Story");
    const drafts = options.drafts ?? [
      {
        title: "Sign in with a valid password",
        priority: "P1",
        preconditions: "The account exists",
        steps: [{ action: "Submit the form", expectedResult: "The dashboard opens" }],
      },
      { title: "Sign in with a wrong password", priority: "P2", preconditions: "", steps: [] },
    ];
    const activity = JSON.stringify([{ type: "picked_up", title: "Picked up task", detail: userStory }]);
    const sources = JSON.stringify(
      options.sources ?? [{ type: "knowledge_document", title: "Auth notes", detail: "Seeded source" }],
    );

    exec(
      `INSERT INTO ai_generation_requests
        (project_id, requested_by, provider, model, user_story, requested_count,
         include_happy_flow, include_negative_flow, include_multi_tab, include_cross_browser, include_boundary,
         generated_count, generated_payload, saved_count, save_events, agent_name, task_status,
         feedback, context, jira_issue_keys, token_input, token_output, token_total, source_summary, activity_log)
       VALUES (${literal(projectId)}, ${literal(t.owner.userId)}, 'openai', 'gpt-4o-mini',
         ${literal(userStory)}, ${drafts.length},
         true, true, false, false, false,
         ${drafts.length}, ${literal(JSON.stringify(drafts))}::jsonb, 0, '[]'::jsonb,
         ${literal(ZYRA_AGENT_NAME)}, ${literal(options.status ?? "in_review")},
         '', ${literal(options.context ?? "")}, '[]'::jsonb, 10, 20, 30, ${literal(sources)}::jsonb, ${literal(activity)}::jsonb);`,
    );
    return scalar(
      `SELECT id FROM ai_generation_requests WHERE project_id = ${literal(projectId)} AND user_story = ${literal(userStory)};`,
    );
  }

  function draftTitles(taskId: string): string[] {
    const raw = scalar(
      `SELECT COALESCE(jsonb_agg(d->>'title'), '[]'::jsonb)::text FROM ai_generation_requests r, jsonb_array_elements(r.generated_payload) d WHERE r.id = ${literal(taskId)};`,
    );
    return JSON.parse(raw || "[]");
  }

  async function open(browser: Browser, path: string, as: "owner" | "qa" | "guest" = "owner"): Promise<Page> {
    const ctx = await browser.newContext({ storageState: states.get(as) });
    contexts.push(ctx);
    const page = await ctx.newPage();
    await page.goto(`/projects/${tenant!.mainProjectId}${path}`);
    return page;
  }

  function modal(page: Page, title: string): Locator {
    return page
      .locator('div[role="presentation"]')
      .filter({ has: page.getByRole("heading", { name: title, level: 2 }) })
      .last();
  }

  function kanbanColumn(page: Page, label: string): Locator {
    return page.locator("section").filter({ has: page.getByRole("heading", { name: label, level: 2 }) });
  }

  /** Appends a "Generation failed" activity entry the way processZyraTask's catch block writes one. */
  function seedFailureActivity(taskId: string, detail: string): void {
    exec(
      "UPDATE ai_generation_requests SET activity_log = activity_log || " +
        `${literal(
          JSON.stringify([{ actor: "agent", stage: "failed", title: "Generation failed", detail, createdAt: new Date().toISOString() }]),
        )}::jsonb WHERE id = ${literal(taskId)};`,
    );
  }

  /** Appends a "Review feedback submitted" entry the way zyraFeedback writes one, `kind` and all. */
  function seedFeedbackActivity(taskId: string, detail: string): void {
    exec(
      "UPDATE ai_generation_requests SET activity_log = activity_log || " +
        `${literal(
          JSON.stringify([
            { actor: "user", stage: "todo", kind: "feedback", title: "Review feedback submitted", detail, createdAt: new Date().toISOString() },
          ]),
        )}::jsonb WHERE id = ${literal(taskId)};`,
    );
  }

  // ─── The agent picker ──────────────────────────────────────────────────────

  test("ZYU-01 the agent picker offers Zyra and marks the two planned agents unavailable", { tag: '@tesbo.testId("TES-TC-1086")' }, async ({
    browser,
  }) => {
    const page = await open(browser, "/agents");

    await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Zyra the Test Generator" })).toBeVisible();

    // The two placeholders are deliberately not links — a card that looks clickable and does
    // nothing is worse than one that says it isn't ready.
    for (const planned of ["Run Analyst", "Bug Triage"]) {
      await expect(page.getByRole("heading", { name: planned })).toBeVisible();
    }
    await expect(page.getByText("Not yet available")).toHaveCount(2);
  });

  test("ZYU-02 the Zyra card opens a detail modal that routes to the workspace and the board", { tag: '@tesbo.testId("TES-TC-1087")' }, async ({
    browser,
  }) => {
    const page = await open(browser, "/agents");

    // The card does not navigate — it opens a modal offering the two places Zyra lives. Clicking
    // it and expecting a route change was this spec's first wrong guess.
    await page.getByRole("button", { name: /Zyra the Test Generator/ }).click();

    const board = page.getByRole("link", { name: /Task board/ });
    await expect(board).toHaveAttribute("href", new RegExp(`/projects/${tenant!.mainProjectId}/agents/tasks$`));

    await page.getByRole("link", { name: /Agent workspace/ }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${tenant!.mainProjectId}/agents/zyra$`));
    await expect(page.getByRole("heading", { name: "Zyra", level: 1 })).toBeVisible();
  });

  // ─── The unconfigured-provider state, which is most workspaces ─────────────

  test("ZYU-03 the chat says the provider is not connected and points at where to fix it", { tag: '@tesbo.testId("TES-TC-1088")' }, async ({
    browser,
  }) => {
    const page = await open(browser, "/agents/zyra");

    // Not an error, not a crash, not a silent empty box: a named state with a way out.
    await expect(page.getByRole("heading", { name: "AI provider not connected" })).toBeVisible();
    await expect(page.getByText("No AI key connected")).toBeVisible();
    await expect(page.getByRole("link", { name: "Set up AI key" })).toHaveAttribute(
      "href",
      /\/settings\?tab=ai/,
    );
  });

  test("ZYU-04 settings reports the missing key and links to the workspace providers page", { tag: '@tesbo.testId("TES-TC-1089")' }, async ({
    browser,
  }) => {
    const page = await open(browser, "/agents/zyra/settings");

    await expect(page.getByRole("heading", { name: "Zyra settings", level: 1 })).toBeVisible();
    await expect(page.getByText("No AI key connected")).toBeVisible();
    await expect(page.getByText("Needs key")).toBeVisible();
    await expect(page.getByRole("link", { name: /workspace AI providers/ })).toHaveAttribute(
      "href",
      /\/settings\?tab=ai/,
    );
  });

  test("ZYU-05 the board's Create task is disabled without a provider", { tag: '@tesbo.testId("TES-TC-1090")' }, async ({ browser }) => {
    const page = await open(browser, "/agents/tasks");

    // The gate is on the control, not only in the API: a workspace with no key cannot start a task
    // it has no way to finish.
    await expect(page.getByRole("button", { name: "Create task" })).toBeDisabled();
  });

  // ─── Settings that are ours, not the model's ───────────────────────────────

  test("ZYU-06 a capability toggle persists across a reload", { tag: '@tesbo.testId("TES-TC-1091")' }, async ({ browser }) => {
    const page = await open(browser, "/agents/zyra/settings");

    const knowledgeBase = page.getByRole("switch").nth(1);
    await expect(knowledgeBase).toBeChecked();
    await knowledgeBase.click();
    await expect(knowledgeBase).not.toBeChecked();

    await page.getByRole("button", { name: "Save settings" }).click();
    await page.reload();

    await expect(
      page.getByRole("switch").nth(1),
      "a capability the user turned off stays off",
    ).not.toBeChecked();
  });

  test("ZYU-07 the test-cases-per-task choice persists across a reload", { tag: '@tesbo.testId("TES-TC-1092")' }, async ({ browser }) => {
    const page = await open(browser, "/agents/zyra/settings");

    await page.getByRole("button", { name: /10–30 Broad/ }).click();
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.reload();

    // Two assertions because a wrong highlight and a wrong setting look identical on screen.
    //
    // The state: these four options used to convey the choice with border and background colour
    // only, so nothing non-visual could tell which was picked. aria-pressed now carries it, and
    // that is what makes the selection perceivable as well as assertable.
    await expect(page.getByRole("button", { name: /10–30 Broad/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: /1–10 Focused/ })).toHaveAttribute("aria-pressed", "false");

    // And the stored value the next generation would actually use. The agent-state endpoint nests
    // it under `settings`; there is no bare GET .../settings that returns it flat.
    const state = await (await api.get(`/api/projects/${tenant!.mainProjectId}/agents/zyra`)).json();
    expect(state.settings.testcaseRange, "the choice is persisted, not just rendered").toBe("10-30");
  });

  test("ZYU-08 reset to defaults puts every capability back on", { tag: '@tesbo.testId("TES-TC-1093")' }, async ({ browser }) => {
    const page = await open(browser, "/agents/zyra/settings");

    const first = page.getByRole("switch").first();
    await first.click();
    await expect(first).not.toBeChecked();
    await page.getByRole("button", { name: "Save settings" }).click();

    await page.getByRole("button", { name: "Reset to defaults" }).click();

    for (const index of [0, 1, 2, 3]) {
      await expect(page.getByRole("switch").nth(index), `capability ${index} is back on`).toBeChecked();
    }
  });

  // ─── The task board ────────────────────────────────────────────────────────

  test("ZYU-09 a project with no tasks says so rather than rendering an empty table", { tag: '@tesbo.testId("TES-TC-1094")' }, async ({
    browser,
  }) => {
    const page = await open(browser, "/agents/tasks");
    await expect(page.getByText("No tasks in queue")).toBeVisible();
  });

  test("ZYU-10 a task appears on the board with its status, draft count and token total", { tag: '@tesbo.testId("TES-TC-1095")' }, async ({
    browser,
  }) => {
    const userStory = stamp("Board story");
    seedTask({ userStory });

    const page = await open(browser, "/agents/tasks");

    const card = page.getByRole("button", { name: new RegExp(userStory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    await expect(card).toBeVisible();
    // Status labels render Title Case ("In Review"), never the raw lowercase enum value ("in_review").
    await expect(card).toContainText("In Review");
    await expect(card).not.toContainText("in review");
    await expect(card, "the board summarises how much was generated").toContainText("2 testcases");
  });

  test("ZYU-11 the board switches to the Kanban view and keeps the task", { tag: '@tesbo.testId("TES-TC-1096")' }, async ({ browser }) => {
    const userStory = stamp("Kanban story");
    seedTask({ userStory });

    const page = await open(browser, "/agents/tasks");
    await page.getByRole("tab", { name: "Kanban board" }).click();

    await expect(page.getByRole("tab", { name: "Kanban board" })).toHaveAttribute("aria-selected", "true");
    const card = page.getByText(userStory);
    await expect(card).toBeVisible();

    // The kanban card's own status chip is Title Case too, not the raw "in_review" token.
    const cardContainer = page.locator("button", { has: card });
    await expect(cardContainer).toContainText("In Review");
  });

  test("ZYU-24 the kanban card and its quick-view panel both show the task's description", async ({
    browser,
  }) => {
    const userStory = stamp("Described story");
    const context = "Business rule: only verified accounts may reset their password.";
    seedTask({ userStory, context });

    const page = await open(browser, "/agents/tasks");
    await page.getByRole("tab", { name: "Kanban board" }).click();

    const cardContainer = page.locator("button", { has: page.getByText(userStory) });
    await expect(cardContainer, "the kanban card surfaces the same description as the list view").toContainText(context);

    await cardContainer.click();
    const panel = page.locator(".slide-in-right");
    await expect(panel.getByText(userStory)).toBeVisible();
    await expect(panel, "the quick-view panel opened from the card shows the full description too").toContainText(context);
  });

  test("ZYU-25 a task with no description renders neither view with an empty description line", async ({
    browser,
  }) => {
    const userStory = stamp("Bare story");
    seedTask({ userStory });

    const page = await open(browser, "/agents/tasks");
    await page.getByRole("tab", { name: "Kanban board" }).click();

    const cardContainer = page.locator("button", { has: page.getByText(userStory) });
    await expect(cardContainer).toBeVisible();
    // The description <p> only renders when task.context is truthy — confirm the empty string
    // doesn't leave a blank paragraph behind, by checking the card's text is exactly what the
    // non-description fields produce (status, story, generated/token summary — no extra line).
    await expect(cardContainer.locator("p")).toHaveCount(1);

    await cardContainer.click();
    const panel = page.locator(".slide-in-right");
    await expect(panel.getByText(userStory)).toBeVisible();
    await expect(panel.locator("h2 + p")).toHaveCount(0);
  });

  test("ZYU-18 a failed task shows a distinct error state on the task window, not a silent 'Pending'", async ({
    browser,
  }) => {
    /*
     * Regression test for the Kanban bug: a generation failure used to revert task_status to
     * 'todo', so the task window rendered it exactly like a task that was never picked up — the
     * user had to open the Activity tab to discover anything failed at all. The real generation
     * call can't be exercised here (see the file header), so the failure is arranged the way the
     * fixed backend leaves it: task_status = 'failed' plus a matching activity_log entry.
     */
    const userStory = stamp("Failed story");
    const taskId = seedTask({ userStory, status: "failed" });
    seedFailureActivity(taskId, "E2E simulated provider timeout");

    const page = await open(browser, "/agents/tasks");

    const card = page.getByRole("button", { name: new RegExp(userStory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    await expect(card).toBeVisible();
    await expect(card).toContainText("failed");
    await expect(card, "must not read back as the pre-generation 'todo' status").not.toContainText("todo");
    await expect(card, "the failure reason must be visible without opening the Activity tab").toContainText(
      "E2E simulated provider timeout",
    );
  });

  test("ZYU-19 a failed task lands in its own Kanban column, not silently in Pending", async ({ browser }) => {
    const userStory = stamp("Failed kanban story");
    const taskId = seedTask({ userStory, status: "failed" });
    seedFailureActivity(taskId, "E2E simulated provider timeout");

    const page = await open(browser, "/agents/tasks");
    await page.getByRole("tab", { name: "Kanban board" }).click();

    await expect(kanbanColumn(page, "Failed").getByText(userStory)).toBeVisible();
    // Before the fix a failed task normalized to 'todo' and landed here instead.
    await expect(kanbanColumn(page, "Pending").getByText(userStory)).toHaveCount(0);
  });

  // ─── The review table, which is where the writes happen ────────────────────

  test("ZYU-12 the task detail lists every generated draft with its priority", { tag: '@tesbo.testId("TES-TC-1097")' }, async ({ browser }) => {
    const taskId = seedTask();
    const page = await open(browser, `/agents/tasks/${taskId}`);

    await expect(page.getByRole("heading", { name: "Zyra task", level: 1 })).toBeVisible();
    // Same Title Case status label as the board and kanban card, not the raw "in_review" token.
    await expect(page.getByText("In Review", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Generated Testcases (2)" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Sign in with a valid password" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "P1" })).toBeVisible();

    // The other two tabs carry the counts the seed put there.
    await expect(page.getByRole("button", { name: "Activities (1)" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sources (1)" })).toBeVisible();
  });

  test("ZYU-13 selection drives the bulk actions", { tag: '@tesbo.testId("TES-TC-1098")' }, async ({ browser }) => {
    const taskId = seedTask();
    const page = await open(browser, `/agents/tasks/${taskId}`);

    // Nothing selected: every bulk action is refused up front rather than erroring on click.
    await expect(page.getByRole("button", { name: "Delete selected" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Clear selection" })).toBeDisabled();

    await page.getByRole("button", { name: "Select all" }).click();
    await expect(page.getByText("2 of 2 testcases selected")).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete selected" })).toBeEnabled();

    await page.getByRole("button", { name: "Clear selection" }).click();
    await expect(page.getByText("0 of 2 testcases selected")).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete selected" })).toBeDisabled();
  });

  test("ZYU-14 saving a draft into a new suite creates a real test case", { tag: '@tesbo.testId("TES-TC-1099")' }, async ({ browser }) => {
    const taskId = seedTask();
    const suiteName = stamp("Suite");
    const page = await open(browser, `/agents/tasks/${taskId}`);

    await page.getByRole("row", { name: /Sign in with a valid password/ }).getByRole("button", { name: "Save" }).click();

    const dialog = modal(page, "Save generated testcases");
    await dialog.getByRole("combobox").first().selectOption("new");
    await dialog.getByRole("textbox").last().fill(suiteName);
    await dialog.getByRole("button", { name: "Save" }).click();

    // The point of the whole screen: a generated draft becomes a real, queryable test case in a
    // real suite. A toast would not prove that.
    await expect
      .poll(
        () =>
          Number(
            scalar(
              `SELECT COUNT(*) FROM testcases t JOIN suites s ON s.id = t.suite_id WHERE t.project_id = ${literal(tenant!.mainProjectId)} AND s.name = ${literal(suiteName)} AND t.title = 'Sign in with a valid password';`,
            ),
          ),
        { message: "the saved draft lands in the named suite as a test case" },
      )
      .toBe(1);
  });

  test("ZYU-15 deleting a draft removes it from the task and leaves the rest", { tag: '@tesbo.testId("TES-TC-1100")' }, async ({ browser }) => {
    const taskId = seedTask();
    const page = await open(browser, `/agents/tasks/${taskId}`);

    page.on("dialog", (dialog) => void dialog.accept());
    await page
      .getByRole("row", { name: /Sign in with a valid password/ })
      .getByRole("button", { name: "Delete" })
      .click();

    await expect
      .poll(() => draftTitles(taskId), { message: "only the deleted draft goes" })
      .toEqual(["Sign in with a wrong password"]);
  });

  test("ZYU-16 a task whose drafts are all gone says so", { tag: '@tesbo.testId("TES-TC-1101")' }, async ({ browser }) => {
    const taskId = seedTask({ drafts: [] });
    const page = await open(browser, `/agents/tasks/${taskId}`);

    await expect(page.getByText("No generated testcases remain for this task.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Generated Testcases (0)" })).toBeVisible();

    // The bulk toolbar stays on screen with nothing to act on. Asserting it is *inert* rather than
    // absent: "Select all" renders either way, but selecting nothing must not arm the destructive
    // buttons. (That the toolbar shows at all on an empty task is cosmetic, and left alone.)
    await expect(page.getByRole("button", { name: "Delete selected" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save selected" }).last()).toBeDisabled();
  });

  test("ZYU-17 closing a task records the new status", { tag: '@tesbo.testId("TES-TC-1102")' }, async ({ browser }) => {
    const taskId = seedTask();
    const page = await open(browser, `/agents/tasks/${taskId}`);

    page.on("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Close task" }).click();

    await expect
      .poll(() => scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`), {
        message: "closing the task is persisted, not just visual",
      })
      .not.toBe("in_review");

    // The chip updates in place to the Title Case label, not the raw "done"/"accepted" token.
    await expect(page.getByText("Done", { exact: true })).toBeVisible();

    // Regression: the button used to stay mounted-but-disabled once done, so a closed task
    // still showed an actionable-looking "Close task" button. It must be gone, not greyed out.
    await expect(page.getByRole("button", { name: "Close task" })).toHaveCount(0);
  });

  test("ZYU-26 a task that is already done never shows a Close task button, on either surface", async ({ browser }) => {
    // Covers the initial-render path, not just the transition covered by ZYU-17: a task can
    // load already-done (e.g. "accepted" from a Jira sync), and the button must never mount.
    const userStory = stamp("Already done story");
    const taskId = seedTask({ userStory, status: "done" });

    const fullPage = await open(browser, `/agents/tasks/${taskId}`);
    await expect(fullPage.getByText("Done", { exact: true })).toBeVisible();
    await expect(fullPage.getByRole("button", { name: "Close task" })).toHaveCount(0);

    const boardPage = await open(browser, "/agents/tasks");
    await boardPage.getByRole("tab", { name: "Kanban board" }).click();
    const cardContainer = boardPage.locator("button", { has: boardPage.getByText(userStory) });
    await cardContainer.click();
    const panel = boardPage.locator(".slide-in-right");
    await expect(panel.getByText(userStory)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Close task" })).toHaveCount(0);
  });

  test("ZYU-27 a task synced back as 'accepted' is treated as done for the Close task button too", async ({ browser }) => {
    // normalizeTaskStatus() maps the Jira-sync status "accepted" to "done" for the chip and the
    // disabled state alike — confirm the button-hiding fix keys off that same normalization,
    // not a literal `=== "done"` check that a raw "accepted" row would slip past.
    const taskId = seedTask({ status: "accepted" });

    const page = await open(browser, `/agents/tasks/${taskId}`);
    await expect(page.getByText("Done", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close task" })).toHaveCount(0);
  });

  // ─── Authorization ─────────────────────────────────────────────────────────

  test("ZYU-20 a workspace member with no project access cannot use the task board", { tag: '@tesbo.testId("TES-TC-1103")' }, async ({
    browser,
  }) => {
    seedTask();
    const page = await open(browser, "/agents/tasks", "guest");
    await page.waitForLoadState("domcontentloaded");

    // No board, and above all no task rows — a Zyra task carries whatever the team told the agent
    // about their product.
    await expect(page.getByRole("tab", { name: "Kanban board" })).toHaveCount(0);
  });

  test("ZYU-21 another project's task is not reachable through this project's URL", { tag: '@tesbo.testId("TES-TC-1104")' }, async ({
    browser,
  }) => {
    const foreignTask = seedTask({ projectId: tenant!.secondProjectId });

    const page = await open(browser, `/agents/tasks/${foreignTask}`);
    await page.waitForLoadState("domcontentloaded");

    // The id is real, the project in the URL is not the one that owns it.
    const res = await api.get(
      `/api/projects/${tenant!.mainProjectId}/agents/zyra/tasks/${foreignTask}`,
      { failOnStatusCode: false },
    );
    expect([403, 404], "a task is scoped to its project").toContain(res.status());
    await expect(page.getByRole("button", { name: "Close task" })).toHaveCount(0);
  });

  test("ZYU-22 a malformed task id does not throw in the page", { tag: '@tesbo.testId("TES-TC-1105")' }, async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: states.get("owner") });
    contexts.push(ctx);
    const page = await ctx.newPage();

    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(`/projects/${tenant!.mainProjectId}/agents/tasks/not-a-uuid`);
    await page.waitForLoadState("domcontentloaded");

    expect(errors, "a URL typo must not throw an uncaught error in the page").toEqual([]);
    await expect(page.locator("body")).not.toContainText("Application error");
  });

  test("ZYU-23 a qa_engineer can open Zyra and review a task", { tag: '@tesbo.testId("TES-TC-1106")' }, async ({ browser }) => {
    const taskId = seedTask();
    const page = await open(browser, `/agents/tasks/${taskId}`, "qa");

    // A project member of any role reviews generated work — the API allows it, so the screen must
    // not hide it. The role that cannot is the one with no project access (ZYU-20).
    await expect(page.getByRole("heading", { name: "Zyra task", level: 1 })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Sign in with a valid password" })).toBeVisible();
  });

  // ─── Chat session history (sidebar) ─────────────────────────────────────────

  test("ZYU-26 the sidebar hides an empty auto-created session until it has a message", async ({ browser }) => {
    /*
     * Regression test for "Duplicate Empty 'Zyra Chat' Sessions are Displayed in the Chat
     * Sidebar": opening the chat with no prior sessions auto-creates one to type into (existing
     * behaviour, unchanged), but nothing was ever asked yet — it must not render as a
     * conversation. No AI provider is configured for this tenant (see file header), so the send
     * button stays disabled; the follow-up message is seeded directly, the same way the rest of
     * this file works around that boundary.
     */
    const page = await open(browser, "/agents/zyra");
    await expect(page.getByRole("heading", { name: "Zyra", level: 1 })).toBeVisible();

    await expect(page.getByText("No conversations yet")).toBeVisible();
    await expect(page.getByText("0 sessions")).toBeVisible();

    const sessionId = scalar(
      `SELECT id FROM zyra_chat_sessions WHERE project_id = ${literal(tenant!.mainProjectId)} ORDER BY created_at DESC LIMIT 1;`,
    );
    expect(sessionId, "the page still auto-creates a session to type into").toBeTruthy();

    exec(
      `INSERT INTO zyra_chat_messages (session_id, project_id, user_id, role, content, status) VALUES ` +
        `(${literal(sessionId)}, ${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'user', 'Write me some test cases', 'sent');`,
    );
    await page.reload();

    await expect(page.getByText("1 session", { exact: true })).toBeVisible();
    await expect(page.getByText("No conversations yet")).toHaveCount(0);
  });

  test("ZYU-27 reopening the chat with an unused session reuses it instead of creating another", async ({
    browser,
  }) => {
    // The steady-state guard the auto-create bug depended on staying intact: loadData opens the
    // existing empty session instead of creating a new one whenever the list isn't empty. If this
    // regressed, every ordinary revisit — not just a race — would grow the sidebar's dead weight.
    const page = await open(browser, "/agents/zyra");
    await expect(page.getByText("No conversations yet")).toBeVisible();

    const countAfterFirstVisit = Number(
      scalar(`SELECT COUNT(*) FROM zyra_chat_sessions WHERE project_id = ${literal(tenant!.mainProjectId)};`),
    );
    expect(countAfterFirstVisit, "exactly one session is auto-created").toBe(1);

    await page.reload();
    await page.reload();

    const countAfterReloads = Number(
      scalar(`SELECT COUNT(*) FROM zyra_chat_sessions WHERE project_id = ${literal(tenant!.mainProjectId)};`),
    );
    expect(countAfterReloads, "reopening a still-empty session must reuse it, not create another").toBe(1);
  });

  // ─── Real-time status updates ───────────────────────────────────────────────

  test("ZYU-24 the task board reflects Zyra finishing a task without a page reload", async ({ browser }) => {
    /*
     * Regression test for "task status is not updated in real time". Before this fix, the board
     * fetched task state once on mount and never again — a status change made by the server-side
     * generation job (or by another tab) only appeared after the user manually reloaded. The board
     * now polls while any task is todo/in_progress. Simulate the job finishing by writing the
     * status directly (the real job isn't exercisable here — no AI provider is called, per the
     * file header) and assert the change lands without ever calling page.reload().
     */
    const taskId = seedTask({ status: "in_progress" });
    const page = await open(browser, "/agents/tasks");
    await expect(page.getByText("in progress", { exact: true })).toBeVisible();

    exec(`UPDATE ai_generation_requests SET task_status = 'in_review' WHERE id = ${literal(taskId)};`);

    await expect(page.getByText("in review", { exact: true })).toBeVisible({ timeout: 9000 });
    await expect(page.getByText("in progress", { exact: true })).toHaveCount(0);
  });

  test("ZYU-25 the task detail page reflects Zyra finishing a task without a page reload", async ({ browser }) => {
    const taskId = seedTask({ status: "todo" });
    const page = await open(browser, `/agents/tasks/${taskId}`);
    await expect(page.getByText("todo", { exact: true })).toBeVisible();

    exec(`UPDATE ai_generation_requests SET task_status = 'failed' WHERE id = ${literal(taskId)};`);
    seedFailureActivity(taskId, "E2E simulated provider timeout while this page was open");

    await expect(page.getByText("failed", { exact: true })).toBeVisible({ timeout: 9000 });
    await expect(page.getByText("E2E simulated provider timeout while this page was open")).toBeVisible();
  });

  // ─── The quick-view panel's Feedback tab (fix for "Feedback and Activity sections
  // display similar content") ─────────────────────────────────────────────────

  test("ZYU-28 the quick-view panel's Feedback tab says so when a task has no feedback, even though Activity has entries", async ({
    browser,
  }) => {
    /*
     * Regression test: the Feedback tab used to render the whole activity_log verbatim, so it was
     * never actually empty — it just duplicated whatever Activity showed. seedTask()'s default
     * activity_log entry is status/process narration ("Picked up task"), not reviewer feedback, so
     * a correct Feedback tab must show its own empty state here while Activity still lists it.
     */
    const userStory = stamp("No feedback story");
    seedTask({ userStory });

    const page = await open(browser, "/agents/tasks");
    await page.getByRole("tab", { name: "Kanban board" }).click();
    await page.locator("button", { has: page.getByText(userStory) }).click();

    const panel = page.locator(".slide-in-right");
    await panel.getByRole("button", { name: /^Feedback/ }).click();
    await expect(panel.getByText("No feedback yet.")).toBeVisible();
    await expect(panel.getByText("Picked up task"), "the empty state must not be the whole activity log in disguise").toHaveCount(0);

    await panel.getByRole("button", { name: /^Activity/ }).click();
    await expect(panel.getByText("Picked up task"), "Activity keeps the full history unfiltered").toBeVisible();
  });

  test("ZYU-29 the quick-view panel's Feedback tab shows only the reviewer's submitted feedback, not status activity", async ({
    browser,
  }) => {
    const userStory = stamp("Feedback story");
    const taskId = seedTask({ userStory });
    seedFeedbackActivity(taskId, "Cover the locked-account case too");

    const page = await open(browser, "/agents/tasks");
    await page.getByRole("tab", { name: "Kanban board" }).click();
    await page.locator("button", { has: page.getByText(userStory) }).click();

    const panel = page.locator(".slide-in-right");
    // The tab count is the filtered count, not the raw activity_log length (2 entries seeded).
    await expect(panel.getByRole("button", { name: "Feedback (1)" })).toBeVisible();
    await panel.getByRole("button", { name: /^Feedback/ }).click();
    await expect(panel.getByText("Cover the locked-account case too")).toBeVisible();
    await expect(panel.getByText("Picked up task"), "a status entry must not leak into Feedback").toHaveCount(0);

    await expect(panel.getByRole("button", { name: "Activity (2)" })).toBeVisible();
    await panel.getByRole("button", { name: /^Activity/ }).click();
    await expect(panel.getByText("Cover the locked-account case too"), "Activity still carries the full history, feedback included").toBeVisible();
    await expect(panel.getByText("Picked up task")).toBeVisible();
  });

  // ─── Sources tab: label and formatting ─────────────────────────────────────

  test("ZYU-30 the quick-view panel's Sources tab labels context 'User Story Context' and preserves its line breaks", async ({
    browser,
  }) => {
    /*
     * Regression test for [Agents-Tasks] "User context" in the Task Details view: the source label
     * had to read "User Story Context", not "User context", and the detail text — pulled from a
     * multi-paragraph Jira description — had to keep its line breaks rather than rendering as one
     * flattened paragraph. The real generation flow that builds this source can't be driven end to
     * end here (see the file header — no AI provider is configured for this suite), so the source is
     * seeded the way aiGenerate leaves it and this asserts the panel renders it correctly.
     */
    const userStory = stamp("Context story");
    const context = "Line one of the story\nLine two of the story\nLine three";
    seedTask({ userStory, sources: [{ type: "context", title: "User Story Context", detail: context }] });

    const page = await open(browser, "/agents/tasks");
    await page.getByRole("tab", { name: "Kanban board" }).click();
    await page.locator("button", { has: page.getByText(userStory) }).click();

    const panel = page.locator(".slide-in-right");
    await panel.getByRole("button", { name: /^Sources/ }).click();

    const title = panel.getByRole("heading", { name: "User Story Context", level: 3 });
    await expect(title).toBeVisible();
    await expect(panel.getByText("User context", { exact: true }), "the old label must not still be rendered").toHaveCount(0);

    const sourceCard = panel.locator("div.rounded-lg", { has: title });
    const detail = sourceCard.locator("p");
    await expect(detail, "the detail paragraph must preserve line breaks visually, not collapse them").toHaveCSS("white-space", "pre-wrap");
    expect(await detail.textContent()).toBe(context);
  });

  test("ZYU-31 the task detail page's Sources tab labels context 'User Story Context' and preserves its line breaks", async ({
    browser,
  }) => {
    const context = "Line one of the story\nLine two of the story\nLine three";
    const taskId = seedTask({ sources: [{ type: "context", title: "User Story Context", detail: context }] });

    const page = await open(browser, `/agents/tasks/${taskId}`);
    await page.getByRole("button", { name: "Sources (1)" }).click();

    const title = page.getByRole("heading", { name: "User Story Context", level: 3 });
    await expect(title).toBeVisible();
    await expect(page.getByText("User context", { exact: true }), "the old label must not still be rendered").toHaveCount(0);

    const sourceCard = page.locator("div.rounded-lg", { has: title });
    const detail = sourceCard.locator("p");
    await expect(detail).toHaveCSS("white-space", "pre-wrap");
    expect(await detail.textContent()).toBe(context);
  });

  test("ZYU-32 a source with no line breaks in its detail still renders correctly", async ({ browser }) => {
    // Guard against a regression the other way: whitespace-pre-wrap must not visually alter
    // single-line detail text (extra wrapping, stray whitespace) — only multi-line text is affected.
    const single = "A single line of context with no breaks at all";
    const taskId = seedTask({ sources: [{ type: "context", title: "User Story Context", detail: single }] });

    const page = await open(browser, `/agents/tasks/${taskId}`);
    await page.getByRole("button", { name: "Sources (1)" }).click();

    const title = page.getByRole("heading", { name: "User Story Context", level: 3 });
    const sourceCard = page.locator("div.rounded-lg", { has: title });
    const detail = sourceCard.locator("p");
    await expect(detail).toBeVisible();
    expect(await detail.textContent()).toBe(single);
  });

  // ─── Transient network failures (fix for "Failed to fetch" on Zyra staging) ─

  test("ZYU-33 a transport-level failure on save is retried once instead of surfacing to the user", async ({ browser }) => {
    /*
     * Regression test for intermittent "Failed to fetch — browser blocked or could not reach the
     * API" reports on Zyra staging. RCA: browsers refuse to silently retry a POST/PATCH written
     * into a keep-alive connection the server already closed while idle (nginx's default
     * keepalive_timeout, 75s, is shorter than the gaps a real chat session leaves between
     * requests) — fetch() throws a transport TypeError instead, which used to reach the user
     * verbatim. A page refresh "fixed" it only because it opened a fresh connection. lib/api.ts's
     * fetchWithNetworkErrorMessage now retries exactly once on that error class before surfacing
     * anything, since the failed write never reached the server in the first place.
     *
     * Settings save (PATCH .../agents/zyra/settings) stands in for the chat POST here because it
     * needs no AI key (see file header) and already has an observable persisted side effect
     * (ZYU-06/07). route.abort("failed") reproduces the exact browser-level failure — Chromium
     * surfaces it to fetch() as `TypeError: Failed to fetch`, the same string production code
     * matches on.
     */
    const page = await open(browser, "/agents/zyra/settings");
    const settingsPath = `/api/projects/${tenant!.mainProjectId}/agents/zyra/settings`;

    let patchAttempts = 0;
    // Matched by pathname predicate, not a glob: the frontend posts to the backend's own origin
    // while the page is served from the frontend's, and a relative glob is resolved against
    // baseURL — see NAV-B-07 in navigation.spec.ts for the same gotcha.
    await page.route(
      (url) => url.pathname === settingsPath,
      async (route) => {
        if (route.request().method() !== "PATCH") {
          await route.continue();
          return;
        }
        patchAttempts++;
        if (patchAttempts === 1) {
          await route.abort("failed");
        } else {
          await route.continue();
        }
      },
    );

    const knowledgeBase = page.getByRole("switch").nth(1);
    await knowledgeBase.click();
    await page.getByRole("button", { name: "Save settings" }).click();

    await expect(page.getByText("All changes saved.")).toBeVisible();
    await expect(page.getByText(/Failed to fetch|browser blocked or could not reach the API/)).toHaveCount(0);
    expect(patchAttempts, "the first attempt fails and the client retries exactly once").toBe(2);

    await page.reload();
    await expect(
      page.getByRole("switch").nth(1),
      "the retried request actually persisted the change, not just the UI's optimism",
    ).not.toBeChecked();
  });

  test("ZYU-34 a failure that survives the retry still reaches the user", async ({ browser }) => {
    // The other half of ZYU-33: a genuinely dead backend (both attempts fail) must not be silently
    // swallowed — the user still needs to see it, just after one automatic retry rather than zero.
    const page = await open(browser, "/agents/zyra/settings");
    const settingsPath = `/api/projects/${tenant!.mainProjectId}/agents/zyra/settings`;

    let patchAttempts = 0;
    await page.route(
      (url) => url.pathname === settingsPath,
      async (route) => {
        if (route.request().method() !== "PATCH") {
          await route.continue();
          return;
        }
        patchAttempts++;
        await route.abort("failed");
      },
    );

    const knowledgeBase = page.getByRole("switch").nth(1);
    await knowledgeBase.click();
    await page.getByRole("button", { name: "Save settings" }).click();

    await expect(page.getByText(/browser blocked or could not reach the API/)).toBeVisible();
    expect(patchAttempts, "still only one retry, not an unbounded loop").toBe(2);
  });
});
