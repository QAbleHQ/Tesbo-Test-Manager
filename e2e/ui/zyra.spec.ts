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
    // Fixtures for the "Create Zyra task" modal tests below: an allocated (fake) AI key, so
    // state.agent.active is true and the modal's Create task button is enabled; Knowledge Base
    // documents used to exercise the Acceptance Criteria split; and a Jira connection + ticket
    // used to prove the ticket picker stays gone even when Jira genuinely is connected.
    exec(
      `DELETE FROM knowledge_document_versions WHERE document_id IN (SELECT id FROM knowledge_documents WHERE project_id IN (${projects}));`,
    );
    exec(`DELETE FROM knowledge_documents WHERE project_id IN (${projects});`);
    exec(`DELETE FROM project_ai_key_allocations WHERE project_id IN (${projects});`);
    exec(`DELETE FROM workspace_ai_keys WHERE organization_id = ${literal(t.organizationId)};`);
    exec(`DELETE FROM jira_tickets WHERE project_id IN (${projects});`);
    exec(
      `DELETE FROM integration_connections WHERE organization_id = ${literal(t.organizationId)} AND provider = 'jira';`,
    );
  }

  function stamp(label: string): string {
    return `E2E ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  }

  // ─── Fixtures for the "Create Zyra task" modal (Jira picker removal, Acceptance Criteria) ──

  /**
   * The board's Create task button is disabled whenever state.agent.active is false (see ZYU-05),
   * which is this tenant's default so no test here accidentally drives a real model. Allocating a
   * fake key flips that flag without ever being submitted against a real provider — every modal
   * test below only reads/writes form fields and never clicks the final "Create task" submit.
   */
  async function allocateFakeAiKey(): Promise<void> {
    const keyRes = await api.post("/api/workspace/ai-keys", {
      data: { name: `E2E key ${Date.now()}${Math.floor(Math.random() * 1000)}`, provider: "openai", apiKey: "sk-e2e-not-a-real-key" },
      failOnStatusCode: false,
    });
    expect(keyRes.status(), `creating an AI key — ${await keyRes.text()}`).toBe(201);
    const key = await keyRes.json();
    const allocRes = await api.post("/api/workspace/ai-keys/allocations", {
      data: { projectId: tenant!.mainProjectId, workspaceAiKeyId: key.id },
      failOnStatusCode: false,
    });
    expect(allocRes.status(), `allocating the key — ${await allocRes.text()}`).toBe(201);
  }

  function rootFolderId(): string {
    const t = tenant!;
    const existing = scalar(
      `SELECT id FROM knowledge_folders WHERE project_id = ${literal(t.mainProjectId)} AND is_root = true;`,
    );
    if (existing) return existing;
    // Same backfill api/knowledge-base.spec.ts relies on: is_root rows are only ever written by
    // project creation, so a fixture project missing one (KB-A-00's defect) gets one here instead.
    exec(
      "INSERT INTO knowledge_folders (organization_id, project_id, parent_folder_id, name, is_root) " +
        `VALUES (${literal(t.organizationId)}, ${literal(t.mainProjectId)}, NULL, 'Knowledge base', true);`,
    );
    return scalar(
      `SELECT id FROM knowledge_folders WHERE project_id = ${literal(t.mainProjectId)} AND is_root = true;`,
    );
  }

  /** Creates a Knowledge Base document via the real API, the same content the picker will read. */
  async function createKnowledgeDoc(body: Record<string, unknown>): Promise<{ id: string; title: string }> {
    const res = await api.post(`/api/projects/${tenant!.mainProjectId}/knowledge-base/documents`, {
      data: { folderId: rootFolderId(), documentType: "general", ...body },
      failOnStatusCode: false,
    });
    expect(res.status(), `creating knowledge doc ${JSON.stringify(body)} — ${await res.text()}`).toBe(201);
    return res.json();
  }

  /** Seeds a real Jira connection + ticket, so "the picker is gone" is proven with Jira actually connected. */
  function seedFakeJiraConnection(): void {
    const t = tenant!;
    exec(
      `INSERT INTO integration_connections (organization_id, provider, external_id, site_url, access_token, refresh_token, token_expires_at) ` +
        `VALUES (${literal(t.organizationId)}, 'jira', 'e2e-zyra-ui', 'https://e2e-zyra-ui.invalid', 'e2e', '', now() + interval '365 days') ` +
        `ON CONFLICT (organization_id, provider) DO NOTHING;`,
    );
    const connectionId = scalar(
      `SELECT id FROM integration_connections WHERE organization_id = ${literal(t.organizationId)} AND provider = 'jira';`,
    );
    exec(
      `INSERT INTO jira_tickets (project_id, jira_connection_id, jira_issue_id, jira_issue_key, summary, issue_type, status) ` +
        `VALUES (${literal(t.mainProjectId)}, ${literal(connectionId)}, 'ZYE-1', 'ZYE-1', 'Seeded Jira ticket', 'Story', 'Open') ` +
        `ON CONFLICT DO NOTHING;`,
    );
  }

  /** Opens the board and the "Create Zyra task" modal, returning its locator. */
  async function openCreateModal(browser: Browser): Promise<{ page: Page; dialog: Locator }> {
    const page = await open(browser, "/agents/tasks");
    await page.getByRole("button", { name: "Create task" }).click();
    return { page, dialog: modal(page, "Create Zyra task") };
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

  interface ChatEntry {
    opType: "create" | "update" | "archive";
    draft?: { title: string; description?: string; preconditions?: string; stepsJson?: string; priority?: string; suiteId?: string | null };
    testcaseId?: string;
    externalId?: string;
    fields?: Record<string, unknown>;
  }

  /**
   * A chat-staged review batch: a chat session, a chat_session_id-linked ai_generation_requests
   * row (the wrapped {opType, draft|fields} shape — NOT seedTask()'s flat AiGeneratedDraft), and
   * the assistant chat message that references it via review_request_id, the way a real reply
   * would once applyZyraChatOperations stages it. Seeded directly for the same reason seedTask()
   * is: reaching this state through the live chat route needs a model this suite never calls.
   */
  function seedChatReviewBatch(options: { status?: string; entries?: ChatEntry[] } = {}): {
    taskId: string;
    sessionId: string;
  } {
    const t = tenant!;
    exec(
      "INSERT INTO zyra_chat_sessions (project_id, user_id, title) VALUES " +
        `(${literal(t.mainProjectId)}, ${literal(t.owner.userId)}, 'E2E chat review');`,
    );
    const sessionId = scalar(
      `SELECT id FROM zyra_chat_sessions WHERE project_id = ${literal(t.mainProjectId)} ORDER BY created_at DESC LIMIT 1;`,
    );
    const entries: ChatEntry[] = options.entries ?? [
      {
        opType: "create",
        draft: {
          suiteId: null,
          title: "Sign in with a valid password",
          description: "The dashboard opens",
          preconditions: "The account exists",
          stepsJson: JSON.stringify([{ stepNumber: 1, action: "Submit the form", expectedResult: "The dashboard opens" }]),
          priority: "P1",
        },
      },
      { opType: "create", draft: { suiteId: null, title: "Sign in with a wrong password", description: "", preconditions: "", stepsJson: "[]", priority: "P2" } },
    ];
    exec(
      "INSERT INTO ai_generation_requests (project_id, requested_by, provider, model, user_story, requested_count, " +
        "generated_count, generated_payload, agent_name, task_status, chat_session_id) VALUES (" +
        `${literal(t.mainProjectId)}, ${literal(t.owner.userId)}, 'zyra_chat', 'gpt-4o-mini', 'Zyra chat proposal', ` +
        `${entries.length}, ${entries.length}, ${literal(JSON.stringify(entries))}::jsonb, ${literal(ZYRA_AGENT_NAME)}, ` +
        `${literal(options.status ?? "in_review")}, ${literal(sessionId)});`,
    );
    const taskId = scalar(
      `SELECT id FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)} ORDER BY created_at DESC LIMIT 1;`,
    );

    const rows = entries.map((entry, index) => ({
      title: entry.draft?.title ?? String(entry.fields?.title ?? "Untitled"),
      priority: entry.draft?.priority ?? String(entry.fields?.priority ?? "P2"),
      status: "Draft",
      type: "Functional",
      preconditions: entry.draft?.preconditions ?? "",
      expectedSummary: entry.draft?.description ?? "",
      stepsJson: entry.draft?.stepsJson ?? "[]",
      action: entry.opType === "create" ? "proposed-create" : entry.opType === "archive" ? "proposed-archive" : "proposed-update",
      reason: "",
      draftIndex: index,
      reviewRequestId: taskId,
    }));
    exec(
      "INSERT INTO zyra_chat_messages (session_id, project_id, user_id, role, content, status, testcases, activity, review_request_id) VALUES " +
        `(${literal(sessionId)}, ${literal(t.mainProjectId)}, ${literal(t.owner.userId)}, 'assistant', ` +
        `'I have drafted these test cases for your review.', 'completed', ${literal(JSON.stringify(rows))}::jsonb, '[]'::jsonb, ${literal(taskId)});`,
    );
    exec(`UPDATE zyra_chat_sessions SET updated_at = now() WHERE id = ${literal(sessionId)};`);
    return { taskId, sessionId };
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

  test("ZYU-40 the Agents card shows nothing until used, then an absolute last-used date, and the chat sidebar's own timestamps are untouched", async ({
    browser,
  }) => {
    /*
     * Regression test. The Agents picker card used to read "Used Nd ago" and go stale whenever the
     * activity was through chat rather than the task board (see api/zyra.spec.ts ZYR-A-43/44 for the
     * backend half). The card now shows nothing at all in that footer slot until Zyra has actually
     * been used — no "Not used yet" placeholder either — and once used reads "Last used on
     * DD/MM/YYYY"; this pins both states and that it never regresses back to a relative "…ago"
     * string.
     *
     * The Zyra chat screen's own "Conversations" sidebar renders each session's timestamp with its
     * own long-standing `formatTime` (e.g. "Aug 24, 08:08 PM") and was explicitly asked NOT to change
     * — pinned here too, on the same seeded session, so a future edit to the card's date logic can't
     * silently leak into the sidebar.
     */
    // Same selector convention as ZYU-02: the whole card is one <button>, and its accessible name is
    // the concatenation of everything visible inside it — heading, role text, description, chips,
    // and the "Last used on …" footer this test cares about.
    const agentCard = (page: Page) => page.getByRole("button", { name: /Zyra the Test Generator/ });
    const lastUsedText = (page: Page) => agentCard(page).getByText(/^(Last used on|Not used|Used) /);

    // Nothing used yet — the footer slot must render no last-used text of any kind.
    const cleanPage = await open(browser, "/agents");
    await expect(agentCard(cleanPage)).toBeVisible();
    await expect(lastUsedText(cleanPage)).toHaveCount(0);

    // Auto-creates one empty session to type into — must NOT make the card show a last-used date,
    // the same boundary ZYU-26/27 pin for the sidebar's own "0 sessions" / hasMessages reporting.
    await open(browser, "/agents/zyra");
    await cleanPage.reload();
    await expect(lastUsedText(cleanPage)).toHaveCount(0);

    // Give that session an actual message, the same way ZYU-26 does — direct insert, since no AI
    // provider is configured for this tenant (file header) to drive a real send.
    const sessionId = scalar(
      `SELECT id FROM zyra_chat_sessions WHERE project_id = ${literal(tenant!.mainProjectId)} ORDER BY created_at DESC LIMIT 1;`,
    );
    expect(sessionId, "opening the chat did not auto-create a session").toBeTruthy();
    exec(
      `INSERT INTO zyra_chat_messages (session_id, project_id, user_id, role, content, status) VALUES ` +
        `(${literal(sessionId)}, ${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'user', 'Write me some test cases', 'sent');`,
    );
    exec(`UPDATE zyra_chat_sessions SET updated_at = now() WHERE id = ${literal(sessionId)};`);

    await cleanPage.reload();
    const usedLabel = agentCard(cleanPage).getByText(/^Last used on \d{2}\/\d{2}\/\d{4}$/);
    await expect(usedLabel).toBeVisible();
    await expect(agentCard(cleanPage).getByText(/ago$/)).toHaveCount(0);

    // The date is DD/MM/YYYY and within a day of "now" either side of a UTC/local boundary — not
    // asserted against an exact string, since the browser's and the DB's timezone need not match.
    const labelText = (await usedLabel.textContent())!;
    const [, dd, mm, yyyy] = labelText.match(/(\d{2})\/(\d{2})\/(\d{4})/)!;
    const shown = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
    const today = new Date();
    const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const dayDiff = Math.abs(shown.getTime() - todayMidnight.getTime()) / 86_400_000;
    expect(dayDiff, `"${labelText}" is not close to today's date`).toBeLessThanOrEqual(1);

    // The chat screen's own "Conversations" sidebar timestamp is untouched by this fix — still its
    // pre-existing locale format, not DD/MM/YYYY.
    const chatPage = await open(browser, "/agents/zyra");
    const sidebarRow = chatPage.locator("aside button").first();
    await expect(sidebarRow).toBeVisible();
    const sidebarTimestamp = (await sidebarRow.locator("span").nth(1).textContent()) ?? "";
    expect(sidebarTimestamp, "the chat sidebar's own timestamp regressed to DD/MM/YYYY").not.toMatch(
      /^\d{2}\/\d{2}\/\d{4}$/,
    );
    expect(sidebarTimestamp.trim().length, "the sidebar row lost its timestamp entirely").toBeGreaterThan(0);
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

  // ─── The "Create Zyra task" modal: no Jira picker, a dedicated Acceptance Criteria field ───
  //
  // Regression coverage for a reported bug (a Jira ticket's Acceptance Criteria landed mixed into
  // Context) and a follow-up ask (drop the Jira ticket picker from this modal entirely — Jira and
  // Linear tickets already mirror into the Knowledge Base as documents via
  // IntegrationSyncDocumentBuilder, so nothing is lost by only offering Knowledge Base here).
  //
  // page.tsx's splitAcceptanceCriteria/resolveDocumentText run entirely client-side against
  // knowledgeItems already loaded by listKnowledgeDocuments — no AI call is involved, so these
  // tests never need to submit the form, only read back the Story/Context/Acceptance Criteria
  // textareas after picking a document from the "Knowledge Base docs and notes" select.

  test("ZYU-50 the modal has no Jira ticket picker, and none appears even when Jira is genuinely connected", async ({ browser }) => {
    await allocateFakeAiKey();
    seedFakeJiraConnection();

    const { page, dialog } = await openCreateModal(browser);
    await expect(dialog).toBeVisible();

    // The primary fields are still there...
    await expect(dialog.getByPlaceholder("As a user, I want...")).toBeVisible();
    await expect(dialog.getByPlaceholder("Business rules, edge cases, acceptance notes...")).toBeVisible();
    await expect(dialog.getByPlaceholder("Given ..., when ..., then ...")).toBeVisible();

    // ...but no Jira selection surface of any kind, despite a real jira_tickets row existing for
    // this project and a connected integration_connections row for this org.
    await expect(dialog.getByText("Jira tickets", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("Select ticket...", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("ZYE-1", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText(/^Linear/)).toHaveCount(0);
  });

  test("ZYU-51 selecting a Knowledge Base document maps its Acceptance Criteria section to a dedicated field, not Context", async ({
    browser,
  }) => {
    await allocateFakeAiKey();
    const title = stamp("Login KB doc");
    await createKnowledgeDoc({
      title,
      contentText:
        "## Description\n\nUsers should be able to log in with email and password.\n\n" +
        "Acceptance Criteria:\nShows an error on a wrong password\nRedirects to the dashboard on success",
    });

    const { dialog } = await openCreateModal(browser);
    await dialog.getByRole("combobox").selectOption({ label: `${title} - general` });

    const story = dialog.getByPlaceholder("As a user, I want...");
    const context = dialog.getByPlaceholder("Business rules, edge cases, acceptance notes...");
    const acceptanceCriteria = dialog.getByPlaceholder("Given ..., when ..., then ...");

    await expect(story).toHaveValue(new RegExp(title));
    await expect(context).toHaveValue(/Users should be able to log in/);
    await expect(context).not.toHaveValue(/wrong password/);
    await expect(acceptanceCriteria).toHaveValue(/Shows an error on a wrong password/);
    await expect(acceptanceCriteria).toHaveValue(/Redirects to the dashboard on success/);
  });

  test("ZYU-52 a Knowledge Base document with no Acceptance Criteria section leaves the field empty and puts everything in Context", async ({
    browser,
  }) => {
    await allocateFakeAiKey();
    const title = stamp("Plain KB doc");
    await createKnowledgeDoc({ title, contentText: "Just a plain note with no special sections at all." });

    const { dialog } = await openCreateModal(browser);
    await dialog.getByRole("combobox").selectOption({ label: `${title} - general` });

    await expect(dialog.getByPlaceholder("Business rules, edge cases, acceptance notes...")).toHaveValue(
      /Just a plain note/,
    );
    await expect(dialog.getByPlaceholder("Given ..., when ..., then ...")).toHaveValue("");
  });

  test("ZYU-53 an Acceptance Criteria heading stops at the next heading, not swallowing later sections", async ({
    browser,
  }) => {
    await allocateFakeAiKey();
    const title = stamp("Headed KB doc");
    await createKnowledgeDoc({
      title,
      contentText:
        "## Description\n\nDo the thing well.\n\n## Acceptance Criteria\n\nCase one applies\nCase two applies\n\n" +
        "## Comments\n\nNothing noteworthy yet.",
    });

    const { dialog } = await openCreateModal(browser);
    await dialog.getByRole("combobox").selectOption({ label: `${title} - general` });

    const context = dialog.getByPlaceholder("Business rules, edge cases, acceptance notes...");
    const acceptanceCriteria = dialog.getByPlaceholder("Given ..., when ..., then ...");

    await expect(acceptanceCriteria).toHaveValue(/Case one applies/);
    await expect(acceptanceCriteria).toHaveValue(/Case two applies/);
    await expect(acceptanceCriteria).not.toHaveValue(/Nothing noteworthy yet/);
    await expect(context).toHaveValue(/Do the thing well/);
    await expect(context).toHaveValue(/Nothing noteworthy yet/);
    await expect(context).not.toHaveValue(/Case one applies/);
  });

  test("ZYU-54 a document with content only in contentHtml (no contentText) still populates Context and Acceptance Criteria", async ({
    browser,
  }) => {
    // Regression guard for a silent-failure edge case: contentText is the plain-text render kept
    // in sync by the editor, but it can be unset (a document written straight through the API, or
    // an older row) while contentHtml still holds the real content. Selecting such a document must
    // not quietly leave Context empty.
    await allocateFakeAiKey();
    const title = stamp("HTML-only KB doc");
    await createKnowledgeDoc({
      title,
      contentHtml: "<p>Do the thing well.</p><p>Acceptance Criteria:</p><ul><li>Case one</li><li>Case two</li></ul>",
    });

    const { dialog } = await openCreateModal(browser);
    await dialog.getByRole("combobox").selectOption({ label: `${title} - general` });

    const context = dialog.getByPlaceholder("Business rules, edge cases, acceptance notes...");
    const acceptanceCriteria = dialog.getByPlaceholder("Given ..., when ..., then ...");

    await expect(context).toHaveValue(/Do the thing well/);
    await expect(context).not.toHaveValue(/Case one/);
    await expect(acceptanceCriteria).toHaveValue(/Case one/);
    await expect(acceptanceCriteria).toHaveValue(/Case two/);
    // And no raw HTML leaked into either field.
    await expect(context).not.toHaveValue(/<p>|<li>/);
    await expect(acceptanceCriteria).not.toHaveValue(/<p>|<li>/);
  });

  test("ZYU-55 a document with no content at all does not crash the modal and still contributes its title to Story", async ({
    browser,
  }) => {
    await allocateFakeAiKey();
    const title = stamp("Empty KB doc");
    await createKnowledgeDoc({ title });

    const { page, dialog } = await openCreateModal(browser);
    await dialog.getByRole("combobox").selectOption({ label: `${title} - general` });

    await expect(dialog.getByPlaceholder("As a user, I want...")).toHaveValue(new RegExp(title));
    await expect(dialog.getByPlaceholder("Business rules, edge cases, acceptance notes...")).toHaveValue("");
    await expect(dialog.getByPlaceholder("Given ..., when ..., then ...")).toHaveValue("");
    // The modal, and the page under it, are still fully responsive.
    await expect(dialog.getByRole("button", { name: "Create task" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Zyra", exact: false })).toBeVisible();
  });

  test("ZYU-56 removing a selected document's chip and reselecting it does not duplicate its content", async ({ browser }) => {
    await allocateFakeAiKey();
    const title = stamp("Reselect KB doc");
    await createKnowledgeDoc({ title, contentText: "Some unique reselection content." });

    const { dialog } = await openCreateModal(browser);
    const select = dialog.getByRole("combobox");
    await select.selectOption({ label: `${title} - general` });

    const chip = dialog.getByRole("button", { name: new RegExp(`^${title}`) });
    await expect(chip).toBeVisible();
    await chip.click(); // removes it from the selected-items chips, but not from the text fields

    await select.selectOption({ label: `${title} - general` });

    const context = dialog.getByPlaceholder("Business rules, edge cases, acceptance notes...");
    const value = await context.inputValue();
    const occurrences = value.split("Some unique reselection content.").length - 1;
    expect(occurrences, `content was duplicated in Context:\n${value}`).toBe(1);
  });

  test("ZYU-57 selecting two Knowledge Base documents combines both into Context, and only the one with a section into Acceptance Criteria", async ({
    browser,
  }) => {
    await allocateFakeAiKey();
    const titleA = stamp("Multi KB doc A");
    const titleB = stamp("Multi KB doc B");
    await createKnowledgeDoc({
      title: titleA,
      contentText: "Doc A body text.\n\nAcceptance Criteria:\nOnly doc A has this bullet",
    });
    await createKnowledgeDoc({ title: titleB, contentText: "Doc B body text with no special section." });

    const { dialog } = await openCreateModal(browser);
    const select = dialog.getByRole("combobox");
    await select.selectOption({ label: `${titleA} - general` });
    await select.selectOption({ label: `${titleB} - general` });

    const context = dialog.getByPlaceholder("Business rules, edge cases, acceptance notes...");
    const acceptanceCriteria = dialog.getByPlaceholder("Given ..., when ..., then ...");

    await expect(context).toHaveValue(/Doc A body text/);
    await expect(context).toHaveValue(/Doc B body text/);
    await expect(context).not.toHaveValue(/Only doc A has this bullet/);
    await expect(acceptanceCriteria).toHaveValue(/Only doc A has this bullet/);
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

  // ─── The quick-view panel's description block (fix for "Task Details popup is not
  // scrollable when the user story description is long") ─────────────────────
  //
  // Before the fix, task.context rendered unbounded and unscrollable inside the panel's shrink-0
  // header, so a long description (a common shape once a Knowledge Base doc is pulled in — see
  // page.tsx's context concatenation) pushed the stats row, tabs, generated drafts, and the
  // footer's "View full task"/"Close task" controls below the panel's fixed h-screen height, with
  // no way to scroll down to them. The description now lives in its own height-capped,
  // internally-scrollable block (the `no-scrollbar` div) below a slim, always-visible top bar.

  test("ZYU-58 a long description does not push the footer's 'View full task' link out of the panel", async ({
    browser,
  }) => {
    const userStory = stamp("Long context story");
    const longContext = "Flight booking scope detail. ".repeat(400);
    seedTask({ userStory, context: longContext });

    const page = await open(browser, "/agents/tasks");
    await page.getByRole("tab", { name: "Kanban board" }).click();
    await page.locator("button", { has: page.getByText(userStory) }).click();

    const panel = page.locator(".slide-in-right");
    const footerLink = panel.getByRole("link", { name: "View full task" });
    await expect(footerLink).toBeVisible();
    // The tabs are reachable too, not just the footer — the whole rest of the panel below the
    // description must still render, not just its very last control.
    await expect(panel.getByRole("button", { name: /^Test cases/ })).toBeVisible();

    const panelBox = (await panel.boundingBox())!;
    const footerBox = (await footerLink.boundingBox())!;
    expect(
      footerBox.y + footerBox.height,
      "the footer link must stay within the panel's own bounds, not be clipped below it",
    ).toBeLessThanOrEqual(panelBox.y + panelBox.height + 1);
  });

  test("ZYU-59 a long description scrolls internally within its own capped region, with no visible scrollbar", async ({
    browser,
  }) => {
    const userStory = stamp("Scrollable description story");
    const longContext = "Booking flow detail line. ".repeat(300);
    seedTask({ userStory, context: longContext });

    const page = await open(browser, "/agents/tasks");
    await page.getByRole("tab", { name: "Kanban board" }).click();
    await page.locator("button", { has: page.getByText(userStory) }).click();

    const panel = page.locator(".slide-in-right");
    const descriptionBlock = panel.locator("div.no-scrollbar");
    await expect(descriptionBlock).toBeVisible();

    const overflow = await descriptionBlock.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(overflow.scrollHeight, "the block must actually overflow so there is something to scroll").toBeGreaterThan(
      overflow.clientHeight,
    );

    // Scrolling this block moves its own scrollTop, independent of the rest of the panel.
    await descriptionBlock.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const scrolledTop = await descriptionBlock.evaluate((el) => el.scrollTop);
    expect(scrolledTop, "the description block itself must be the thing that scrolls").toBeGreaterThan(0);

    // No visible scrollbar track claiming layout width, despite being scrollable.
    const scrollbarWidth = await descriptionBlock.evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth);
    expect(scrollbarWidth, "the scrollbar must be visually hidden").toBe(0);
  });

  test("ZYU-60 a short description does not scroll and shows no scrollbar", async ({ browser }) => {
    const userStory = stamp("Short story");
    seedTask({ userStory, context: "Just a short one-line context." });

    const page = await open(browser, "/agents/tasks");
    await page.getByRole("tab", { name: "Kanban board" }).click();
    await page.locator("button", { has: page.getByText(userStory) }).click();

    const panel = page.locator(".slide-in-right");
    const descriptionBlock = panel.locator("div.no-scrollbar");
    const overflow = await descriptionBlock.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(
      overflow.scrollHeight,
      "a short description must not be clipped as though it needed to scroll",
    ).toBeLessThanOrEqual(overflow.clientHeight);

    await expect(panel.getByRole("link", { name: "View full task" })).toBeVisible();
  });

  test("ZYU-61 a long unbroken token in the description wraps instead of overflowing the panel horizontally", async ({
    browser,
  }) => {
    const longToken = `https://example.com/${"a".repeat(200)}`;
    const userStory = stamp("Long token in context story");
    seedTask({ userStory, context: `See ${longToken} for details.` });

    const page = await open(browser, "/agents/tasks");
    await page.getByRole("tab", { name: "Kanban board" }).click();
    await page.locator("button", { has: page.getByText(userStory) }).click();

    const panel = page.locator(".slide-in-right");
    const descriptionBlock = panel.locator("div.no-scrollbar");
    await expect(descriptionBlock.getByText(longToken, { exact: false })).toBeVisible();

    const overflow = await descriptionBlock.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    expect(
      overflow.scrollWidth,
      "a long token must wrap, not push the description block into horizontal overflow",
    ).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });

  test("ZYU-62 the description preserves line breaks between combined Knowledge Base sections", async ({
    browser,
  }) => {
    const userStory = stamp("Multiline context story");
    const context = "Section one detail.\n\nSection two detail.\n\nSection three detail.";
    seedTask({ userStory, context });

    const page = await open(browser, "/agents/tasks");
    await page.getByRole("tab", { name: "Kanban board" }).click();
    await page.locator("button", { has: page.getByText(userStory) }).click();

    const panel = page.locator(".slide-in-right");
    const contextParagraph = panel.locator("div.no-scrollbar p").last();
    await expect(contextParagraph).toHaveCSS("white-space", "pre-wrap");
    expect(await contextParagraph.textContent()).toBe(context);
  });

  test("ZYU-63 a failed task with a long failure detail still keeps 'Close task' reachable in the footer", async ({
    browser,
  }) => {
    const userStory = stamp("Long failure story");
    const taskId = seedTask({ userStory, status: "failed" });
    seedFailureActivity(taskId, "Provider timeout while generating drafts. ".repeat(200));

    const page = await open(browser, "/agents/tasks");
    await page.getByRole("tab", { name: "Kanban board" }).click();
    await page.locator("button", { has: page.getByText(userStory) }).click();

    const panel = page.locator(".slide-in-right");
    const closeButton = panel.getByRole("button", { name: "Close task" });
    await expect(closeButton).toBeVisible();

    const panelBox = (await panel.boundingBox())!;
    const closeBox = (await closeButton.boundingBox())!;
    expect(
      closeBox.y + closeBox.height,
      "'Close task' must stay within the panel's own bounds even with a very long failure detail",
    ).toBeLessThanOrEqual(panelBox.y + panelBox.height + 1);
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

  // ─── Sources tab: Knowledge Base Markdown rendering (KAN-6 report) ─────────
  //
  // legacy.service.ts labels the source object `{ type: "knowledge_base", ... }` — only that type
  // goes through renderMarkdown (lib/markdown.ts, shared with the Zyra chat page); every other
  // source type keeps rendering as literal whitespace-pre-wrap text, which is what ZYU-30/31/32
  // above depend on. Real generation can't be driven end to end in this suite (see file header —
  // no AI provider is configured), so these seed a `knowledge_base` source directly, the same way
  // the context/story sources above are seeded, and assert on what the panel/page render from it.

  test("ZYU-34 the quick-view panel's Sources tab renders Knowledge Base Markdown as formatted HTML, not raw symbols", async ({
    browser,
  }) => {
    const userStory = stamp("KB markdown story");
    const detail =
      "# Search Forum Posts\n\nAs a user, I want to **carefully** review existing posts.\n\nAcceptance Criteria:\n- Search bar is available\n- Results are sortable";
    seedTask({ userStory, sources: [{ type: "knowledge_base", title: "KAN-6: Search Forum Posts", detail }] });

    const page = await open(browser, "/agents/tasks");
    await page.getByRole("tab", { name: "Kanban board" }).click();
    await page.locator("button", { has: page.getByText(userStory) }).click();

    const panel = page.locator(".slide-in-right");
    await panel.getByRole("button", { name: /^Sources/ }).click();

    await expect(panel.getByRole("heading", { name: "Search Forum Posts", level: 1 })).toBeVisible();
    await expect(panel.locator("strong", { hasText: "carefully" })).toBeVisible();
    await expect(panel.locator("li", { hasText: "Search bar is available" })).toBeVisible();
    await expect(panel.locator("li", { hasText: "Results are sortable" })).toBeVisible();

    await expect(
      panel.getByText("# Search Forum Posts", { exact: true }),
      "the raw markdown symbol must not be shown as literal text",
    ).toHaveCount(0);
    await expect(panel.getByText("**carefully**", { exact: false })).toHaveCount(0);
  });

  test("ZYU-35 the task detail page's Sources tab renders Knowledge Base Markdown as formatted HTML, not raw symbols", async ({
    browser,
  }) => {
    const detail = "## Description\n\nUse `filters` to narrow **results**.\n- item a\n- item b";
    const taskId = seedTask({ sources: [{ type: "knowledge_base", title: "KB doc", detail }] });

    const page = await open(browser, `/agents/tasks/${taskId}`);
    await page.getByRole("button", { name: "Sources (1)" }).click();

    await expect(page.getByRole("heading", { name: "Description", level: 2 })).toBeVisible();
    await expect(page.locator("strong", { hasText: "results" })).toBeVisible();
    await expect(page.locator(".inline-code", { hasText: "filters" })).toBeVisible();
    await expect(page.locator("li", { hasText: "item a" })).toBeVisible();
    await expect(page.locator("li", { hasText: "item b" })).toBeVisible();

    await expect(page.getByText("## Description", { exact: true })).toHaveCount(0);
  });

  test("ZYU-36 a Knowledge Base source displays its complete content, not cut off at the old 320-character limit", async ({
    browser,
  }) => {
    // Regression test for the reported truncation ("...so t"): source.detail used to be hard-cut
    // at 320 characters with no word-boundary awareness. legacy.service.ts now applies a much
    // larger, word-safe cap (truncateAtWordBoundary) upstream of this point, so content within
    // that cap must render in full here — this proves the panel itself performs no additional
    // client-side clipping of what it's given.
    const tail = "the final sentence must remain fully visible and unclipped";
    const filler = "Paragraph text describing the feature in detail. ".repeat(10); // > 320 chars
    const userStory = stamp("KB long content story");
    seedTask({ userStory, sources: [{ type: "knowledge_base", title: "KB doc", detail: `${filler}${tail}` }] });

    const page = await open(browser, "/agents/tasks");
    await page.getByRole("tab", { name: "Kanban board" }).click();
    await page.locator("button", { has: page.getByText(userStory) }).click();

    const panel = page.locator(".slide-in-right");
    await panel.getByRole("button", { name: /^Sources/ }).click();
    await expect(panel.getByText(tail, { exact: false })).toBeVisible();
  });

  test("ZYU-37 Knowledge Base content with a long unbroken token wraps inside the panel instead of overflowing it", async ({
    browser,
  }) => {
    // whitespace-pre-wrap alone does not break an unspaced token (a URL, an id) — only
    // overflow-wrap does. Regression guard for the fixed max-w-[520px] quick-view panel.
    const longToken = `https://example.com/${"a".repeat(120)}`;
    const userStory = stamp("KB long token story");
    seedTask({ userStory, sources: [{ type: "knowledge_base", title: "KB doc", detail: `See ${longToken} for details.` }] });

    const page = await open(browser, "/agents/tasks");
    await page.getByRole("tab", { name: "Kanban board" }).click();
    await page.locator("button", { has: page.getByText(userStory) }).click();

    const panel = page.locator(".slide-in-right");
    await panel.getByRole("button", { name: /^Sources/ }).click();
    await expect(panel.getByText(longToken, { exact: false })).toBeVisible();

    const scrollArea = panel.locator(".overflow-y-auto");
    const { scrollWidth, clientWidth } = await scrollArea.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(scrollWidth, "a long token must wrap, not push the content area into horizontal overflow").toBeLessThanOrEqual(
      clientWidth + 1,
    );
  });

  test("ZYU-38 Knowledge Base content containing HTML-like text is escaped, not rendered as markup", async ({ browser }) => {
    const marker = `xss-marker-${Date.now()}`;
    const userStory = stamp("KB injection story");
    seedTask({
      userStory,
      sources: [{ type: "knowledge_base", title: "KB doc", detail: `<img src=x onerror="window.__zyraXss='${marker}'">` }],
    });

    const page = await open(browser, "/agents/tasks");
    await page.getByRole("tab", { name: "Kanban board" }).click();
    await page.locator("button", { has: page.getByText(userStory) }).click();

    const panel = page.locator(".slide-in-right");
    await panel.getByRole("button", { name: /^Sources/ }).click();

    await expect(panel.locator("img")).toHaveCount(0);
    const injected = await page.evaluate(() => (window as unknown as Record<string, unknown>).__zyraXss);
    expect(injected, "the markdown renderer escapes HTML before parsing, so this must never execute").toBeUndefined();
    await expect(panel.getByText("<img", { exact: false })).toBeVisible();
  });

  test("ZYU-39 a non-Knowledge-Base source's Markdown-looking text is not parsed as Markdown", async ({ browser }) => {
    // Locks the type gate in TaskQuickViewPanel/the task detail page: only `knowledge_base`
    // sources go through renderMarkdown. Every other type (context, story, jira, linear,
    // existing_testcase) must keep rendering as literal pre-wrap text — ZYU-30/31/32 depend on
    // that for `context`, and this pins it against the Markdown-looking text a real Jira
    // description or user story can plausibly contain (e.g. a literal "- " bullet in prose).
    const raw = "# Not a heading\n**not bold** and a - bullet look-alike";
    const taskId = seedTask({ sources: [{ type: "context", title: "User Story Context", detail: raw }] });

    const page = await open(browser, `/agents/tasks/${taskId}`);
    await page.getByRole("button", { name: "Sources (1)" }).click();

    await expect(page.getByRole("heading", { name: "Not a heading" })).toHaveCount(0);
    const title = page.getByRole("heading", { name: "User Story Context", level: 3 });
    const sourceCard = page.locator("div.rounded-lg", { has: title });
    const detail = sourceCard.locator("p");
    expect(await detail.textContent()).toBe(raw);
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

  // ─── Review step for Zyra-chat-generated test cases ────────────────────────
  // Chat no longer writes create/update/archive operations straight to `testcases` — they're
  // staged (applyZyraChatOperations) and shown in a review panel on the assistant's own message,
  // the same select/edit/discard/save actions the task board already has. The live chat route
  // can't drive staging itself (file header — no AI provider configured), so every scenario below
  // seeds the staged batch and its referencing chat message directly, same rule seedTask() and
  // seedChatReviewBatch() already establish.

  test("ZYU-64 a chat message with a review batch renders every proposal, all selected by default", async ({ browser }) => {
    seedChatReviewBatch();
    const page = await open(browser, "/agents/zyra");

    await expect(page.getByText("Sign in with a valid password")).toBeVisible();
    await expect(page.getByText("Sign in with a wrong password")).toBeVisible();
    await expect(page.getByText(/2 of 2 selected/)).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Select proposed test case 1" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Select proposed test case 2" })).toBeChecked();
    await expect(page.getByRole("button", { name: /Save 2 to repository/ })).toBeEnabled();

    // Unselecting one drops the save button's count and disables nothing else.
    await page.getByRole("checkbox", { name: "Select proposed test case 1" }).uncheck();
    await expect(page.getByText(/1 of 2 selected/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Save 1 to repository/ })).toBeEnabled();
  });

  test("ZYU-65 discarding a proposed row removes it from the panel and the stored batch", async ({ browser }) => {
    const { taskId } = seedChatReviewBatch();
    const page = await open(browser, "/agents/zyra");

    await expect(page.getByText("Sign in with a valid password")).toBeVisible();
    await page
      .getByRole("listitem")
      .filter({ hasText: "Sign in with a valid password" })
      .getByRole("button", { name: "Discard" })
      .click();

    await expect(page.getByText("Sign in with a valid password")).toHaveCount(0);
    await expect(page.getByText("Sign in with a wrong password")).toBeVisible();
    await expect
      .poll(() => draftTitles(taskId), { message: "the discard must persist, not just disappear client-side" })
      .toEqual(["Sign in with a wrong password"]);
  });

  test("ZYU-66 editing a proposed row updates what's displayed and what's stored", async ({ browser }) => {
    const { taskId } = seedChatReviewBatch();
    const page = await open(browser, "/agents/zyra");

    const row = page.getByRole("listitem").filter({ hasText: "Sign in with a wrong password" });
    await row.getByRole("button", { name: "Edit" }).click();
    const titleInput = row.getByRole("textbox").first();
    await titleInput.fill("Sign in with a wrong password — edited");
    await row.getByRole("button", { name: "Save edit" }).click();

    await expect(page.getByText("Sign in with a wrong password — edited")).toBeVisible();
    await expect
      .poll(() => draftTitles(taskId), { message: "the edit must persist, not just render client-side" })
      .toContain("Sign in with a wrong password — edited");
  });

  test("ZYU-67 saving selected proposals creates real test cases in their own suite", async ({ browser }) => {
    const suiteName = stamp("Chat review suite");
    const createdSuite = await api.post(`/api/projects/${tenant!.mainProjectId}/suites`, {
      data: { name: suiteName },
      failOnStatusCode: false,
    });
    expect(createdSuite.status()).toBe(201);
    const realSuiteId = (await createdSuite.json()).id;

    const draftTitle = stamp("Chat-saved case");
    const { taskId } = seedChatReviewBatch({
      entries: [{ opType: "create", draft: { suiteId: realSuiteId, title: draftTitle, description: "", preconditions: "", stepsJson: "[]", priority: "P2" } }],
    });
    const page = await open(browser, "/agents/zyra");

    await expect(page.getByText(draftTitle)).toBeVisible();
    await page.getByRole("button", { name: /Save 1 to repository/ }).click();

    await expect(page.getByText(/saved to the repository/)).toBeVisible();
    await expect
      .poll(
        () =>
          Number(
            scalar(
              `SELECT COUNT(*) FROM testcases t WHERE t.project_id = ${literal(tenant!.mainProjectId)} AND t.suite_id = ${literal(realSuiteId)} AND t.title = ${literal(draftTitle)};`,
            ),
          ),
        { message: "the saved proposal must land in its own suite as a real test case" },
      )
      .toBe(1);
    expect(scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe("done");
  });

  test("ZYU-68 a review batch already resolved elsewhere shows a read-only note instead of live controls", async ({ browser }) => {
    seedChatReviewBatch({ status: "done" });
    const page = await open(browser, "/agents/zyra");

    await expect(page.getByText(/This batch was already saved or closed/)).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /Select proposed test case/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Save \d+ to repository/ })).toHaveCount(0);
  });

  test("ZYU-69 saving only part of a batch leaves the rest visible and actionable, not resolved", async ({ browser }) => {
    const { taskId } = seedChatReviewBatch();
    const page = await open(browser, "/agents/zyra");

    await page.getByRole("checkbox", { name: "Select proposed test case 2" }).uncheck();
    await page.getByRole("button", { name: /Save 1 to repository/ }).click();

    await expect(page.getByText(/saved to the repository/)).toBeVisible();
    // The unselected draft is still on screen, still checked, still actionable — the batch did not
    // resolve just because one of its two drafts was saved.
    await expect(page.getByText("Sign in with a wrong password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Discard" })).toBeVisible();
    await expect
      .poll(() => scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`))
      .toBe("in_review");
  });
});
