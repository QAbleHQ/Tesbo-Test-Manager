import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { exec, literal, scalar } from "../utils/psql";
import {
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  writeStorageState,
  type RbacTenant,
} from "../utils/rbac-tenant";
import { startFakeAiServer, type FakeAiServer } from "../utils/fake-ai-server";

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
    exec(`DELETE FROM jira_project_mappings WHERE project_id IN (${projects});`);
    // The task-detail Feedback pickers (ZYU-113..116) seed a Linear connection, mapping and tickets too.
    exec(`DELETE FROM linear_tickets WHERE project_id IN (${projects});`);
    exec(`DELETE FROM linear_project_mappings WHERE project_id IN (${projects});`);
    exec(
      `DELETE FROM integration_connections WHERE organization_id = ${literal(t.organizationId)} AND provider IN ('jira', 'linear');`,
    );
  }

  function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    /** The ticket a Jira- or Linear-linked task carries — both default to none, as before. */
    jiraIssueKeys?: string[];
    linearIssueKeys?: string[];
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
         feedback, context, jira_issue_keys, linear_issue_keys, token_input, token_output, token_total, source_summary, activity_log)
       VALUES (${literal(projectId)}, ${literal(t.owner.userId)}, 'openai', 'gpt-4o-mini',
         ${literal(userStory)}, ${drafts.length},
         true, true, false, false, false,
         ${drafts.length}, ${literal(JSON.stringify(drafts))}::jsonb, 0, '[]'::jsonb,
         ${literal(ZYRA_AGENT_NAME)}, ${literal(options.status ?? "in_review")},
         '', ${literal(options.context ?? "")},
         ${literal(JSON.stringify(options.jiraIssueKeys ?? []))}::jsonb, ${literal(JSON.stringify(options.linearIssueKeys ?? []))}::jsonb,
         10, 20, 30, ${literal(sources)}::jsonb, ${literal(activity)}::jsonb);`,
    );
    return scalar(
      `SELECT id FROM ai_generation_requests WHERE project_id = ${literal(projectId)} AND user_story = ${literal(userStory)};`,
    );
  }

  interface ChatEntry {
    opType: "create" | "update" | "archive";
    draft?: { title: string; description?: string; preconditions?: string; stepsJson?: string; testData?: string; priority?: string; suiteId?: string | null; severity?: string; component?: string };
    testcaseId?: string;
    externalId?: string;
    fields?: Record<string, unknown>;
    /** Mirrors ZyraChatTestcaseRow.sourceRefs — what ZyraCitationsList/ZyraContextDrawer read. */
    sourceRefs?: Array<{ type: string; id: string; title: string }>;
  }

  /**
   * A chat-staged review batch: a chat session, a chat_session_id-linked ai_generation_requests
   * row (the wrapped {opType, draft|fields} shape — NOT seedTask()'s flat AiGeneratedDraft), and
   * the assistant chat message that references it via review_request_id, the way a real reply
   * would once applyZyraChatOperations stages it. Seeded directly for the same reason seedTask()
   * is: reaching this state through the live chat route needs a model this suite never calls.
   */
  //
  // `sessionId` appends another batch to an existing session (an exhaustive plan posts one message
  // per batch into the same conversation). `linkMessage: false` writes the message without
  // review_request_id — the shape every background plan batch was stored in before
  // postZyraPlanMessage persisted it, while each row still carried its own reviewRequestId.
  function seedChatReviewBatch(
    options: {
      status?: string;
      entries?: ChatEntry[];
      sessionId?: string;
      linkMessage?: boolean;
      content?: string;
      /** Snapshot rows without `testData`, the shape a message staged before chatDraftRow carried it has. */
      legacySnapshot?: boolean;
    } = {},
  ): {
    taskId: string;
    sessionId: string;
  } {
    const t = tenant!;
    let sessionId = options.sessionId;
    if (!sessionId) {
      exec(
        "INSERT INTO zyra_chat_sessions (project_id, user_id, title) VALUES " +
          `(${literal(t.mainProjectId)}, ${literal(t.owner.userId)}, 'E2E chat review');`,
      );
      sessionId = scalar(
        `SELECT id FROM zyra_chat_sessions WHERE project_id = ${literal(t.mainProjectId)} ORDER BY created_at DESC LIMIT 1;`,
      );
    }
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
      ...(options.legacySnapshot ? {} : { testData: entry.draft?.testData ?? String(entry.fields?.testData ?? "") }),
      // Mirrors chatDraftRow's own severity/component handling (legacy.service.ts) — this row is
      // seeded directly rather than produced by the live endpoint, so it must match that shape.
      severity: entry.draft?.severity ?? entry.fields?.severity ?? null,
      component: entry.draft?.component ?? entry.fields?.component ?? null,
      action: entry.opType === "create" ? "proposed-create" : entry.opType === "archive" ? "proposed-archive" : "proposed-update",
      reason: "",
      draftIndex: index,
      reviewRequestId: taskId,
      sourceRefs: entry.sourceRefs ?? [],
    }));
    exec(
      "INSERT INTO zyra_chat_messages (session_id, project_id, user_id, role, content, status, testcases, activity, review_request_id) VALUES " +
        `(${literal(sessionId)}, ${literal(t.mainProjectId)}, ${literal(t.owner.userId)}, 'assistant', ` +
        `${literal(options.content ?? "I have drafted these test cases for your review.")}, 'completed', ${literal(JSON.stringify(rows))}::jsonb, '[]'::jsonb, ` +
        `${options.linkMessage === false ? "NULL" : literal(taskId)});`,
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

  test("ZYU-07b the test-cases-per-task options render in the new order with no Minimum tier", { tag: '@tesbo.testId("TES-TC-1092")' }, async ({ browser }) => {
    const page = await open(browser, "/agents/zyra/settings");

    // aria-pressed is unique to the four range cards (Toggle switches use role="switch", every
    // other on-page button has no aria-pressed at all), so this locator is exactly the range row
    // in DOM order — which is also render order, so this doubles as the ordering assertion.
    const rangeButtons = page.locator("button[aria-pressed]");
    await expect(rangeButtons).toHaveCount(4);
    await expect(rangeButtons.nth(0)).toContainText("1–10");
    await expect(rangeButtons.nth(1)).toContainText("10–30");
    await expect(rangeButtons.nth(2)).toContainText("30–50");
    await expect(rangeButtons.nth(3)).toContainText("All");

    // "Removed entirely" means the card, the label and the value are all gone, not just hidden.
    await expect(page.getByRole("button", { name: /Minimum/ })).toHaveCount(0);
    await expect(page.getByText("1–3", { exact: true })).toHaveCount(0);
  });

  test("ZYU-07c a project that has never saved this setting defaults to 30–50 Extensive", { tag: '@tesbo.testId("TES-TC-1092")' }, async ({ browser }) => {
    // purgeZyra() strips the zyraAgent settings key after every test in this file (see the
    // afterEach above), so this project genuinely has no saved testcaseRange at this point.
    const page = await open(browser, "/agents/zyra/settings");

    await expect(page.getByRole("button", { name: /30–50 Extensive/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: /1–10 Focused/ })).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: /10–30 Broad/ })).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: /All Exhaustive/ })).toHaveAttribute("aria-pressed", "false");

    const state = await (await api.get(`/api/projects/${tenant!.mainProjectId}/agents/zyra`)).json();
    expect(state.settings.testcaseRange, "a project that never saved this setting defaults to 30-50").toBe("30-50");
  });

  test("ZYU-07d selecting 30-50 persists across a reload, and Reset to defaults returns to 30-50", { tag: '@tesbo.testId("TES-TC-1092")' }, async ({ browser }) => {
    const page = await open(browser, "/agents/zyra/settings");

    // Move off the default first, so the save below is a real, observable change.
    await page.getByRole("button", { name: /10–30 Broad/ }).click();
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: /10–30 Broad/ })).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: /30–50 Extensive/ }).click();
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: /30–50 Extensive/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: /10–30 Broad/ })).toHaveAttribute("aria-pressed", "false");

    const state = await (await api.get(`/api/projects/${tenant!.mainProjectId}/agents/zyra`)).json();
    expect(state.settings.testcaseRange, "the choice is persisted, not just rendered").toBe("30-50");

    // Reset to defaults is a local (unsaved) selection change — pick a different card first so the
    // click is a real, observable move back to the default rather than a no-op.
    await page.getByRole("button", { name: /10–30 Broad/ }).click();
    await expect(page.getByRole("button", { name: /10–30 Broad/ })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Reset to defaults" }).click();
    await expect(page.getByRole("button", { name: /30–50 Extensive/ })).toHaveAttribute("aria-pressed", "true");
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

    // The description is rendered as Markdown now (ZYU-107), so blank-line-separated sections come
    // out as separate paragraphs rather than one pre-wrap <p> holding the raw string — the
    // behaviour this test protects (sections are not run together) is unchanged.
    const panel = page.locator(".slide-in-right");
    const paragraphs = panel.locator("div.no-scrollbar .zyra-prose p");
    await expect(paragraphs).toHaveText(["Section one detail.", "Section two detail.", "Section three detail."]);
  });

  // ─── Markdown in the description (fix for "Zyra task displays Markdown formatting in ticket
  // descriptions") ────────────────────────────────────────────────────────────
  //
  // Jira/Linear tickets arrive through the Knowledge Base as flattened Markdown (see
  // IntegrationSyncDocumentBuilder), and that text becomes task.context. Before the fix all three
  // surfaces printed it verbatim, so "### LIN-05 …" and "**Module:** Claim" showed their syntax.
  // The quick-view panel now renders it with lib/markdown.ts; the list row and Kanban card, being
  // two-line clamped previews where headings and lists cannot lay out, show it as plain text.

  /** The shape of the Linear ticket in the bug report's screenshot. */
  const TICKET_MARKDOWN = [
    "### LIN-05: Submit an Expense Claim",
    "",
    "**Module:** Claim",
    "**Priority:** Medium",
    "",
    "**User Story:**",
    "As an employee, I want to submit an expense claim with supporting documents so that I can request reimbursement.",
    "",
    "- Receipt is mandatory",
    "- Amount must be _positive_",
    "",
    "See [the claim policy](https://example.com/claims) for limits.",
  ].join("\n");

  /** Markdown syntax that must never survive into a rendered or preview surface. */
  const MARKDOWN_SYNTAX = /###|\*\*|\]\(|(^|\s)- /;

  test("ZYU-107 the quick-view panel renders a ticket's Markdown description instead of showing its syntax", async ({
    browser,
  }) => {
    const userStory = stamp("Markdown panel story");
    seedTask({ userStory, context: TICKET_MARKDOWN });

    const page = await open(browser, "/agents/tasks");
    await page.getByRole("button", { name: new RegExp(escapeRegExp(userStory)) }).click();

    const panel = page.locator(".slide-in-right");
    const description = panel.locator("div.no-scrollbar .zyra-prose");
    await expect(description.locator("h3")).toHaveText("LIN-05: Submit an Expense Claim");
    await expect(description.locator("strong")).toHaveText(["Module:", "Priority:", "User Story:"]);
    await expect(description.locator("li")).toHaveText(["Receipt is mandatory", "Amount must be positive"]);
    await expect(description.locator("em")).toHaveText("positive");
    const link = description.getByRole("link", { name: "the claim policy" });
    await expect(link).toHaveAttribute("href", "https://example.com/claims");
    // Opens outside the app, and without handing the target a window.opener back into it.
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);

    const text = (await description.innerText()) ?? "";
    expect(text, "no Markdown syntax is left visible in the rendered description").not.toMatch(MARKDOWN_SYNTAX);
    expect(text).toContain("As an employee, I want to submit an expense claim");
  });

  test("ZYU-108 the task window row previews a Markdown description as plain text", async ({ browser }) => {
    const userStory = stamp("Markdown row story");
    seedTask({ userStory, context: TICKET_MARKDOWN });

    const page = await open(browser, "/agents/tasks");
    const row = page.getByRole("button", { name: new RegExp(escapeRegExp(userStory)) });
    // Wait for the row itself first: the list can still be on its loading skeleton when the page
    // opens, and a count of the row's <p> would otherwise spend its whole timeout on that skeleton.
    await expect(row).toBeVisible();
    const preview = row.locator("p");
    await expect(preview).toHaveCount(1);
    const text = (await preview.textContent()) ?? "";
    expect(text, "the row preview carries no Markdown syntax").not.toMatch(MARKDOWN_SYNTAX);
    expect(text).toContain("LIN-05: Submit an Expense Claim Module: Claim Priority: Medium");
    // A link keeps its visible text and drops the URL syntax.
    expect(text).toContain("See the claim policy for limits.");
    expect(text).not.toContain("https://example.com/claims");
  });

  test("ZYU-109 the kanban card previews a Markdown description as plain text", async ({ browser }) => {
    const userStory = stamp("Markdown card story");
    seedTask({ userStory, context: TICKET_MARKDOWN });

    const page = await open(browser, "/agents/tasks");
    await page.getByRole("tab", { name: "Kanban board" }).click();
    const card = page.locator("button", { has: page.getByText(userStory) });
    // The card's second <p> is its "N testcases generated" summary line; the description is first.
    await expect(card.locator("p")).toHaveCount(2);
    const text = (await card.locator("p").first().textContent()) ?? "";
    expect(text, "the card preview carries no Markdown syntax").not.toMatch(MARKDOWN_SYNTAX);
    expect(text).toContain("LIN-05: Submit an Expense Claim Module: Claim");
  });

  test("ZYU-110 raw HTML in a description is shown as text, never rendered as markup", async ({ browser }) => {
    const userStory = stamp("HTML in context story");
    // Ticket bodies are third-party content. The quote-breaking link is the payload lib/markdown.ts's
    // own comment calls out; the javascript: link must stay inert text since only http(s) is linked.
    const context = [
      `<img src=x onerror="window.__zyraMdXss=1"> <b>not bold</b>`,
      `[x](https://a" onmouseover="window.__zyraMdXss=2" x=")`,
      `[click](javascript:window.__zyraMdXss=3)`,
    ].join("\n");
    seedTask({ userStory, context });

    const page = await open(browser, "/agents/tasks");
    const row = page.getByRole("button", { name: new RegExp(escapeRegExp(userStory)) });
    await expect(row.locator("img, b")).toHaveCount(0);
    await row.click();

    const description = page.locator(".slide-in-right div.no-scrollbar .zyra-prose");
    await expect(description).toContainText("<b>not bold</b>");
    await expect(description.locator("img, b")).toHaveCount(0);
    await expect(description.locator('a[href^="javascript"], [onmouseover], [onerror]')).toHaveCount(0);
    await description.hover();
    expect(await page.evaluate(() => (window as unknown as { __zyraMdXss?: number }).__zyraMdXss)).toBeUndefined();
  });

  test("ZYU-111 a plain description with snake_case identifiers and no Markdown is shown unchanged", async ({
    browser,
  }) => {
    const userStory = stamp("Plain context story");
    // Intraword underscores are not emphasis (CommonMark agrees) — without that rule, turning on
    // Markdown rendering would mangle every plain description that names a field.
    const context = "Validate user_id and order_id before saving the claim_total.";
    seedTask({ userStory, context });

    const page = await open(browser, "/agents/tasks");
    const row = page.getByRole("button", { name: new RegExp(escapeRegExp(userStory)) });
    // See ZYU-108: wait out the list's loading skeleton before asserting on the row's contents.
    await expect(row).toBeVisible();
    await expect(row.locator("p")).toHaveText(context);
    await row.click();

    const description = page.locator(".slide-in-right div.no-scrollbar .zyra-prose");
    await expect(description).toHaveText(context);
    await expect(description.locator("em, strong")).toHaveCount(0);
  });

  test("ZYU-112 a whitespace-only description renders no description line on the row, card or panel", async ({
    browser,
  }) => {
    const userStory = stamp("Whitespace context story");
    seedTask({ userStory, context: "   \n\n   " });

    const page = await open(browser, "/agents/tasks");
    const row = page.getByRole("button", { name: new RegExp(escapeRegExp(userStory)) });
    await expect(row).toBeVisible();
    await expect(row.locator("p")).toHaveCount(0);

    await page.getByRole("tab", { name: "Kanban board" }).click();
    const card = page.locator("button", { has: page.getByText(userStory) });
    // Only the card's own summary line, as in ZYU-25 — no blank description paragraph.
    await expect(card.locator("p")).toHaveCount(1);

    await card.click();
    const panel = page.locator(".slide-in-right");
    await expect(panel.getByText(userStory)).toBeVisible();
    await expect(panel.locator("div.no-scrollbar .zyra-prose")).toHaveCount(0);
    await expect(panel.locator("h2 + p")).toHaveCount(0);
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

  // ─── The full task page's description (fix for "[Task] Jira/Linear – Task Description Missing in
  // Full Task Details") ──────────────────────────────────────────────────────
  //
  // A Jira/Linear task's ticket description is captured into task.context when the task is created
  // from Requirements. The quick-view popup rendered it; "View full task" ([taskId]/page.tsx) never
  // did, so the full page showed no description at all — only a 320-character excerpt under Sources.

  for (const provider of ["Jira", "Linear"] as const) {
    const keys = (key: string) => (provider === "Jira" ? { jiraIssueKeys: [key] } : { linearIssueKeys: [key] });

    test(`ZYU-122 the full task page renders a ${provider} ticket's description as formatted Markdown`, async ({ browser }) => {
      const key = provider === "Jira" ? "ZYD-1" : "LIN-D1";
      const taskId = seedTask({ userStory: stamp(`${provider} description story`), context: TICKET_MARKDOWN, ...keys(key) });
      const page = await open(browser, `/agents/tasks/${taskId}`);

      const description = page.getByTestId("task-description");
      await expect(description).toBeVisible();
      await expect(description.locator("h3")).toHaveText("LIN-05: Submit an Expense Claim");
      await expect(description.locator("strong")).toHaveText(["Module:", "Priority:", "User Story:"]);
      await expect(description.locator("li")).toHaveText(["Receipt is mandatory", "Amount must be positive"]);
      const link = description.getByRole("link", { name: "the claim policy" });
      await expect(link).toHaveAttribute("href", "https://example.com/claims");
      await expect(link).toHaveAttribute("rel", /noopener/);
      const text = (await description.innerText()).replace(/\s+/g, " ");
      expect(text, "no Markdown syntax is left visible on the full page").not.toMatch(MARKDOWN_SYNTAX);
      expect(text).toContain("As an employee, I want to submit an expense claim");
      // The ticket key the task is linked to still shows alongside it.
      await expect(page.getByText(key, { exact: true })).toBeVisible();
    });

    test(`ZYU-123 a ${provider} task with no description says so on the full task page`, async ({ browser }) => {
      const taskId = seedTask({ userStory: stamp(`${provider} empty description story`), context: "", ...keys(provider === "Jira" ? "ZYD-2" : "LIN-D2") });
      const page = await open(browser, `/agents/tasks/${taskId}`);

      await expect(page.getByTestId("task-description")).toContainText("No description available");
      // The rest of the page is unaffected by the empty state.
      await expect(page.getByRole("button", { name: "Generated Testcases (2)" })).toBeVisible();
    });
  }

  test("ZYU-124 raw HTML in a task description is shown as text on the full task page, never rendered", async ({ browser }) => {
    const context = [
      `<img src=x onerror="window.__zyraTaskXss=1"> <b>not bold</b>`,
      `[click me](javascript:window.__zyraTaskXss=1)`,
    ].join("\n");
    const taskId = seedTask({ userStory: stamp("XSS description story"), context, linearIssueKeys: ["LIN-D3"] });
    const page = await open(browser, `/agents/tasks/${taskId}`);

    const description = page.getByTestId("task-description");
    await expect(description).toContainText("<b>not bold</b>");
    await expect(description.locator("img, b")).toHaveCount(0);
    await expect(description.locator('a[href^="javascript"], [onerror]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __zyraTaskXss?: number }).__zyraTaskXss)).toBeUndefined();
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

  /*
   * ZYU-77/78/79: technique badges (TechniqueBadges, shared by TaskQuickViewPanel and this same
   * [taskId] page — see ZYRA_IMPLEMENTATION_LOG.md's "surface techniques to human reviewers"
   * entry). generated_payload is rendered verbatim (formatAiTask), so seeding a draft's
   * `techniques` field directly controls what a reviewer actually sees here — no live model call
   * needed, same boundary every other test in this file draws.
   */
  test("ZYU-77 a single technique renders as one badge", async ({ browser }) => {
    const taskId = seedTask({
      drafts: [{ title: "Reject usernames over 64 characters", priority: "P2", preconditions: "", steps: [], techniques: ["boundary_value_analysis"] }],
    });
    const page = await open(browser, `/agents/tasks/${taskId}`);

    await expect(page.getByText("Boundary Value Analysis", { exact: true })).toBeVisible();
  });

  test("ZYU-78 multiple techniques on one case each render their own badge", async ({ browser }) => {
    const taskId = seedTask({
      drafts: [{
        title: "Archive a case whose linked ticket just closed",
        priority: "P2",
        preconditions: "",
        steps: [],
        techniques: ["state_testing", "error_guessing", "security_perspective"],
      }],
    });
    const page = await open(browser, `/agents/tasks/${taskId}`);

    await expect(page.getByText("State Testing", { exact: true })).toBeVisible();
    await expect(page.getByText("Error Guessing", { exact: true })).toBeVisible();
    await expect(page.getByText("Security Perspective", { exact: true })).toBeVisible();
  });

  test("ZYU-79 the general fallback and a missing techniques field both render no badge at all, not a meaningless 'General' pill", async ({ browser }) => {
    const taskId = seedTask({
      drafts: [
        { title: "Case tagged only general", priority: "P2", preconditions: "", steps: [], techniques: ["general"] },
        { title: "Case with no techniques field", priority: "P2", preconditions: "", steps: [] }, // older-shaped draft
      ],
    });
    const page = await open(browser, `/agents/tasks/${taskId}`);

    await expect(page.getByRole("cell", { name: "Case tagged only general" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Case with no techniques field" })).toBeVisible();
    // Every real technique label, checked absent rather than just "no visible badge row" — proves
    // this isn't merely mis-styled but genuinely renders nothing for either case.
    for (const label of ["Equivalence Partitioning", "Boundary Value Analysis", "Decision Table", "State Testing", "Use Case Testing", "Pairwise Testing", "Error Guessing", "Security Perspective", "General", "general"]) {
      await expect(page.getByText(label, { exact: true })).toHaveCount(0);
    }
  });

  // ─── Ticket comments panel (auto-comment outcome + Retry) ─────────────────

  /**
   * One integration_ticket_comments row for a task, as a save would have left it — seeded directly,
   * since producing a real 'failed' or 'posted' outcome needs a live Jira (see api/zyra.spec.ts's
   * "ticket auto-comment" block, which drives the real save path). The comment lists one real test
   * case, so a Retry has something to rebuild.
   */
  async function seedTicketComment(taskId: string, fields: { status: string; reason?: string | null; issueKey?: string }): Promise<string> {
    const created = await api.post(`/api/projects/${tenant!.mainProjectId}/testcases`, {
      data: { title: stamp("Commented case") },
      failOnStatusCode: false,
    });
    expect(created.status()).toBe(201);
    const testcase = await created.json();
    const issueKey = fields.issueKey ?? "KAN-4";
    const text = `**Generated by Tesbo Test Manager**\n\n**Added (1)**\n- [${testcase.externalId}](http://localhost/projects/${tenant!.mainProjectId}/testcases/${testcase.id}) — ${testcase.title}`;
    exec(
      "INSERT INTO integration_ticket_comments (project_id, generation_request_id, save_event_id, provider, issue_key, testcase_ids, status, comment_text, reason) VALUES (" +
        `${literal(tenant!.mainProjectId)}, ${literal(taskId)}, gen_random_uuid(), 'jira', ${literal(issueKey)}, ` +
        `${literal(JSON.stringify([testcase.id]))}::jsonb, ${literal(fields.status)}, ${literal(text)}, ` +
        `${fields.reason ? literal(fields.reason) : "NULL"});`,
    );
    return scalar(`SELECT id FROM integration_ticket_comments WHERE generation_request_id = ${literal(taskId)} AND issue_key = ${literal(issueKey)};`);
  }

  test("ZYU-TC-01 a task with no ticket comments shows no Ticket comments panel", async ({ browser }) => {
    const taskId = seedTask();
    const page = await open(browser, `/agents/tasks/${taskId}`);
    await expect(page.getByRole("button", { name: "Generated Testcases (2)" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ticket comments" })).toHaveCount(0);
  });

  test("ZYU-TC-02 each outcome is labelled, and only a failed comment offers Retry", async ({ browser }) => {
    const taskId = seedTask({ status: "done" });
    await seedTicketComment(taskId, { status: "posted", issueKey: "KAN-1" });
    await seedTicketComment(taskId, { status: "skipped_disabled", issueKey: "KAN-2" });
    await seedTicketComment(taskId, { status: "failed", issueKey: "KAN-3", reason: "Jira refused the comment (403) — no permission." });

    const page = await open(browser, `/agents/tasks/${taskId}`);
    await expect(page.getByRole("heading", { name: "Ticket comments" })).toBeVisible();
    const row = (key: string) => page.getByRole("listitem").filter({ hasText: `Jira ${key}` });
    await expect(row("KAN-1").getByText("Posted", { exact: true })).toBeVisible();
    await expect(row("KAN-2").getByText("Not posted — auto-comment off")).toBeVisible();
    await expect(row("KAN-3").getByText("Failed", { exact: true })).toBeVisible();
    await expect(row("KAN-3").getByText("Jira refused the comment (403) — no permission.")).toBeVisible();

    await expect(page.getByRole("button", { name: "Retry comment" })).toHaveCount(1);
    await expect(row("KAN-3").getByRole("button", { name: "Retry comment" })).toBeVisible();
  });

  test("ZYU-TC-03 Retry re-sends the comment and shows the new outcome (Jira not connected: fails with that reason)", async ({ browser }) => {
    const taskId = seedTask({ status: "done" });
    const commentId = await seedTicketComment(taskId, { status: "failed", reason: "An older failure" });

    const page = await open(browser, `/agents/tasks/${taskId}`);
    await page.getByRole("button", { name: "Retry comment" }).click();

    // This tenant has no Jira connection, so the re-send fails before any outbound call. The page
    // reports it, and the row now carries the new reason instead of the old one.
    await expect(page.getByText(/Comment still couldn't be posted on Jira KAN-4: Jira is not connected\./)).toBeVisible();
    const row = page.getByRole("listitem").filter({ hasText: "Jira KAN-4" });
    await expect(row.getByText("Jira is not connected.", { exact: true })).toBeVisible();
    await expect(row.getByText("An older failure")).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Retry comment" })).toBeEnabled();

    // Persisted, not just displayed.
    expect(scalar(`SELECT status || '|' || reason FROM integration_ticket_comments WHERE id = ${literal(commentId)};`)).toBe(
      "failed|Jira is not connected.",
    );
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
    // With everything selected, the toggle becomes the one "unselect all" control — the standalone
    // "Clear selection" button (only meaningful for a partial selection) is hidden rather than
    // duplicating it.
    await expect(page.getByRole("button", { name: "Clear selection" })).toHaveCount(0);

    await page.getByRole("button", { name: "Unselect all" }).click();
    await expect(page.getByText("0 of 2 testcases selected")).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete selected" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Clear selection" })).toBeDisabled();
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

  /*
   * "[Zyra] Severity and Component Are Missing in Generated Test Cases" — drives the actual Save
   * button (not the API directly, see api/zyra.spec.ts ZYR-A-71..74 for that half) to prove the
   * browser's own save action forwards a draft's severity/component through to the real row, the
   * same way ZYU-14 proves it for suite placement.
   */
  test("ZYU-80 saving a draft with severity and component persists both onto the real test case", async ({ browser }) => {
    const taskId = seedTask({
      drafts: [{ title: "Sign in with a valid password", priority: "P1", severity: "High", component: "Auth", preconditions: "", steps: [] }],
    });
    const suiteName = stamp("Suite");
    const page = await open(browser, `/agents/tasks/${taskId}`);

    // The actual display bug this ticket was about: severity/component must be visible on the
    // review table BEFORE saving, not just present in the row that eventually gets persisted —
    // this is what a reviewer is deciding whether to approve.
    const draftRow = page.getByRole("row", { name: /Sign in with a valid password/ });
    await expect(draftRow.getByText("High")).toBeVisible();
    await expect(draftRow.getByText("Auth")).toBeVisible();

    await draftRow.getByRole("button", { name: "Save" }).click();

    const dialog = modal(page, "Save generated testcases");
    await dialog.getByRole("combobox").first().selectOption("new");
    await dialog.getByRole("textbox").last().fill(suiteName);
    await dialog.getByRole("button", { name: "Save" }).click();

    await expect
      .poll(
        () => scalar(`SELECT severity FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND title = 'Sign in with a valid password';`),
        { message: "the draft's severity must reach the saved row, not just the review table" },
      )
      .toBe("High");
    expect(scalar(`SELECT component FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND title = 'Sign in with a valid password';`)).toBe("Auth");
  });

  /*
   * "Save Test Cases popup — suite target" — the modal used to open on "Existing suite" with that
   * dropdown's empty value labelled "No suite", so an untouched modal was already submittable and
   * silently saved unassigned test cases. "No suite" was an option of the wrong dropdown, and Save
   * had no rule for the existing-suite path at all. The target is now an explicit choice (No suite /
   * Existing suite / Create new suite) behind a "Select suite" placeholder, and Save is enabled only
   * when the chosen path is complete. ZYU-128..132 pin each path plus the payload it sends.
   */
  const SUITE_TARGET_OPTIONS = ["Select suite", "No suite", "Existing suite", "Create new suite"];

  function isSaveRequest(taskId: string) {
    // Pathname predicate rather than a glob: the API is on a different origin from the page.
    return (req: { url(): string; method(): string }) =>
      req.method() === "POST" && new URL(req.url()).pathname === `/api/projects/${tenant!.mainProjectId}/agents/zyra/tasks/${taskId}/save`;
  }

  async function seedSuite(name: string): Promise<string> {
    const res = await api.post(`/api/projects/${tenant!.mainProjectId}/suites`, { data: { name } });
    expect(res.status(), await res.text()).toBeLessThan(300);
    return String((await res.json()).id);
  }

  async function openSaveFor(page: Page, title: string | RegExp): Promise<Locator> {
    await page.getByRole("row", { name: title }).getByRole("button", { name: "Save" }).click();
    return modal(page, "Save generated testcases");
  }

  test("ZYU-128 the Save modal opens on 'Select suite' with Save disabled and no suite fields", async ({ browser }) => {
    const taskId = seedTask();
    const page = await open(browser, `/agents/tasks/${taskId}`);
    const dialog = await openSaveFor(page, /Sign in with a valid password/);

    const target = dialog.getByRole("combobox");
    // Exactly one select: the target. The existing-suite picker and name field are not rendered yet.
    await expect(target).toHaveCount(1);
    await expect(target).toHaveValue("");
    await expect(target.locator("option:checked")).toHaveText("Select suite");
    expect((await target.locator("option").allTextContents()).map((s) => s.trim())).toEqual(SUITE_TARGET_OPTIONS);
    await expect(dialog.getByRole("textbox")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  test("ZYU-129 'No suite' hides every suite field and saves the draft unassigned", async ({ browser }) => {
    const title = stamp("No suite draft");
    const taskId = seedTask({ drafts: [{ title, priority: "P1", preconditions: "", steps: [] }] });
    const page = await open(browser, `/agents/tasks/${taskId}`);
    const dialog = await openSaveFor(page, new RegExp(escapeRegExp(title)));

    await dialog.getByRole("combobox").selectOption("none");
    await expect(dialog.getByRole("combobox")).toHaveCount(1);
    await expect(dialog.getByRole("textbox")).toHaveCount(0);
    const save = dialog.getByRole("button", { name: "Save" });
    await expect(save).toBeEnabled();

    const request = page.waitForRequest(isSaveRequest(taskId));
    await save.click();
    expect((await request).postDataJSON().suiteId).toBeUndefined();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("1 testcase saved.")).toBeVisible();
    await expect
      .poll(() => scalar(`SELECT COALESCE(suite_id::text, 'NULL') FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND title = ${literal(title)};`))
      .toBe("NULL");
  });

  test("ZYU-130 'Existing suite' blocks Save until a suite is picked, then saves into that suite", async ({ browser }) => {
    const title = stamp("Existing suite draft");
    const suiteName = stamp("Target suite");
    const suiteId = await seedSuite(suiteName);
    const taskId = seedTask({ drafts: [{ title, priority: "P1", preconditions: "", steps: [] }] });
    const page = await open(browser, `/agents/tasks/${taskId}`);
    const dialog = await openSaveFor(page, new RegExp(escapeRegExp(title)));
    const save = dialog.getByRole("button", { name: "Save" });

    await dialog.getByRole("combobox").first().selectOption("existing");
    const picker = dialog.getByRole("combobox").nth(1);
    await expect(picker).toBeVisible();
    await expect(picker).toHaveValue("");
    // "No suite" is a target of its own now, not a value hiding inside this list.
    const pickerOptions = (await picker.locator("option").allTextContents()).map((s) => s.trim());
    expect(pickerOptions).not.toContain("No suite");
    expect(pickerOptions).toContain(suiteName);
    await expect(save).toBeDisabled();

    await picker.selectOption({ label: suiteName });
    await expect(save).toBeEnabled();

    const request = page.waitForRequest(isSaveRequest(taskId));
    await save.click();
    expect((await request).postDataJSON().suiteId).toBe(suiteId);
    await expect
      .poll(() => scalar(`SELECT suite_id::text FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND title = ${literal(title)};`))
      .toBe(suiteId);
  });

  test("ZYU-131 'Create new suite' keeps Save disabled for a blank name and caps the name at 255", async ({ browser }) => {
    const taskId = seedTask();
    const page = await open(browser, `/agents/tasks/${taskId}`);
    const dialog = await openSaveFor(page, /Sign in with a valid password/);
    const save = dialog.getByRole("button", { name: "Save" });

    await dialog.getByRole("combobox").selectOption("new");
    const name = dialog.getByRole("textbox");
    await expect(name).toBeVisible();
    await expect(save).toBeDisabled();

    await name.fill("   ");
    await expect(save).toBeDisabled();
    await expect(dialog.getByText("Suite name is required")).toBeVisible();

    // suites.name is VARCHAR(255); the field stops there instead of letting the API reject it.
    await name.fill("x".repeat(300));
    await expect(name).toHaveValue("x".repeat(255));
    await expect(save).toBeEnabled();

    await name.fill(stamp("Suite"));
    await expect(dialog.getByText("Suite name is required")).toHaveCount(0);
    await expect(save).toBeEnabled();
    // No click: ZYU-14 already proves the create-and-save path end to end.
  });

  test("ZYU-132 switching target drops the stale suite, and reopening the modal starts clean", async ({ browser }) => {
    const title = stamp("Switch target draft");
    const suiteName = stamp("Stale suite");
    await seedSuite(suiteName);
    const taskId = seedTask({ drafts: [{ title, priority: "P1", preconditions: "", steps: [] }] });
    const page = await open(browser, `/agents/tasks/${taskId}`);
    let dialog = await openSaveFor(page, new RegExp(escapeRegExp(title)));
    const target = dialog.getByRole("combobox").first();

    await target.selectOption("existing");
    await dialog.getByRole("combobox").nth(1).selectOption({ label: suiteName });
    await target.selectOption("new");
    await dialog.getByRole("textbox").fill(stamp("Abandoned"));

    // Cancel and reopen: nothing from the abandoned attempt survives.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    dialog = await openSaveFor(page, new RegExp(escapeRegExp(title)));
    await expect(dialog.getByRole("combobox")).toHaveCount(1);
    await expect(dialog.getByRole("combobox")).toHaveValue("");
    await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();

    await dialog.getByRole("combobox").selectOption("existing");
    await expect(dialog.getByRole("combobox").nth(1)).toHaveValue("");
    await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();

    // Pick a suite, then change your mind: the suite must not ride along with a "No suite" save.
    await dialog.getByRole("combobox").nth(1).selectOption({ label: suiteName });
    await dialog.getByRole("combobox").first().selectOption("none");
    await expect(dialog.getByRole("combobox")).toHaveCount(1);

    const request = page.waitForRequest(isSaveRequest(taskId));
    await dialog.getByRole("button", { name: "Save" }).click();
    expect((await request).postDataJSON().suiteId).toBeUndefined();
    await expect
      .poll(() => scalar(`SELECT COALESCE(suite_id::text, 'NULL') FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND title = ${literal(title)};`))
      .toBe("NULL");
    // And no suite was created by the abandoned "Create new suite" attempt.
    expect(Number(scalar(`SELECT COUNT(*) FROM suites WHERE project_id = ${literal(tenant!.mainProjectId)} AND name LIKE 'E2E Abandoned %';`))).toBe(0);
  });

  /*
   * "[Zyra] Save Test Cases error message is hidden behind the modal" — a failed save used to write
   * to the page-level error banner, which sits under the modal's portaled backdrop. The text was in
   * the DOM, so a page-wide toBeVisible() would have passed; the assertion is therefore scoped to
   * the dialog, and a trial click proves nothing is layered over it.
   */
  test("ZYU-117 a failed save shows its error inside the open Save modal, and a retry still saves", async ({ browser }) => {
    const title = stamp("Save failure draft");
    const taskId = seedTask({ drafts: [{ title, priority: "P1", preconditions: "", steps: [] }] });
    const page = await open(browser, `/agents/tasks/${taskId}`);
    const failure = "Suite is locked for this plan — upgrade to save more testcases.";

    // First attempt is held until released, then refused; later attempts reach the real API.
    // Pathname predicate rather than a glob: the API is on a different origin from the page.
    let attempts = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => url.pathname === `/api/projects/${tenant!.mainProjectId}/agents/zyra/tasks/${taskId}/save`,
      async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        attempts++;
        if (attempts > 1) return route.continue();
        await held;
        await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: failure }) });
      },
    );

    await page.getByRole("row", { name: new RegExp(title) }).getByRole("button", { name: "Save" }).click();
    const dialog = modal(page, "Save generated testcases");
    // The modal opens on "Select suite" and can't submit until a target is chosen (ZYU-128).
    await dialog.getByRole("combobox").selectOption("none");
    await dialog.getByRole("button", { name: "Save" }).click();

    // In flight: the button reports it, and Escape can't dismiss the modal out from under the result.
    await expect(dialog.getByRole("button", { name: "Saving..." })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    release();

    const alert = dialog.getByRole("alert");
    await expect(alert).toHaveText(failure);
    // Actionability includes "receives pointer events" — this fails if the backdrop covers the text.
    await alert.click({ trial: true });
    await expect(dialog.getByRole("button", { name: "Save" })).toBeEnabled();

    // Closing and reopening starts clean rather than replaying the stale failure.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("row", { name: new RegExp(title) }).getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByRole("alert")).toHaveCount(0);

    // Retry goes through the unchanged success path: modal closes, page confirms, the row exists.
    // Reopening resets the target too (ZYU-132), so it's chosen again.
    await dialog.getByRole("combobox").selectOption("none");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("1 testcase saved.")).toBeVisible();
    await expect
      .poll(() => Number(scalar(`SELECT COUNT(*) FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND title = ${literal(title)};`)))
      .toBe(1);
    expect(attempts).toBe(2);
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

  // ─── The full task view's Feedback tab (fix for "Feedback tab is missing from Full
  // Task view / feedback section shown at the bottom of Generated Testcases") ────────

  test("ZYU-70 the full task view has its own Feedback tab, and the send-feedback form is no longer bolted onto Generated Testcases", async ({
    browser,
  }) => {
    /*
     * Regression test: the send-feedback form used to render unconditionally at the bottom of the
     * "testcases" tab content, and there was no way to see past feedback at all in the full view —
     * only in the quick-view popup. The full view must now offer "Feedback" as its own tab, exactly
     * like the popup does, with the form (and, new here, the feedback history) living only there.
     */
    const taskId = seedTask();
    const page = await open(browser, `/agents/tasks/${taskId}`);

    // Default tab is Generated Testcases — the form must not leak into it any more.
    await expect(page.getByRole("heading", { name: "Zyra task", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Send feedback" })).toHaveCount(0);
    await expect(page.getByPlaceholder("Ask Zyra to improve coverage, add edge cases, remove duplicates, or focus on a missed rule.")).toHaveCount(0);

    // The tab exists, is distinct from "Generated Testcases", and carries its own count badge.
    const feedbackTab = page.getByRole("button", { name: "Feedback (0)" });
    await expect(feedbackTab).toBeVisible();
    await feedbackTab.click();

    await expect(page.getByRole("heading", { name: "Send feedback" })).toBeVisible();
    await expect(page.getByPlaceholder("Ask Zyra to improve coverage, add edge cases, remove duplicates, or focus on a missed rule.")).toBeVisible();
    // No feedback has been submitted yet — the history must say so, not render empty and silent.
    await expect(page.getByText("No feedback yet.")).toBeVisible();

    // Leaving the tab unmounts its content — the form is not merely hidden behind the testcases tab.
    await page.getByRole("button", { name: "Generated Testcases (2)" }).click();
    await expect(page.getByRole("heading", { name: "Send feedback" })).toHaveCount(0);
  });

  test("ZYU-71 the full task view's Feedback tab shows only the reviewer's submitted feedback, not status activity, and the count matches the popup's", async ({
    browser,
  }) => {
    const userStory = stamp("Full view feedback story");
    const taskId = seedTask({ userStory });
    seedFeedbackActivity(taskId, "Cover the locked-account case too");

    const page = await open(browser, `/agents/tasks/${taskId}`);

    // The tab count is the filtered count (isFeedbackActivity), not the raw activity_log length
    // (2 entries seeded: the default "Picked up task" plus the seeded feedback entry).
    await expect(page.getByRole("button", { name: "Feedback (1)" })).toBeVisible();
    await page.getByRole("button", { name: "Feedback (1)" }).click();
    await expect(page.getByText("Cover the locked-account case too")).toBeVisible();
    await expect(page.getByText("Picked up task"), "a status entry must not leak into Feedback").toHaveCount(0);

    // Activities keeps the full, unfiltered history — same contract as the quick-view popup (ZYU-29).
    await expect(page.getByRole("button", { name: "Activities (2)" })).toBeVisible();
    await page.getByRole("button", { name: "Activities (2)" }).click();
    await expect(page.getByText("Cover the locked-account case too"), "Activities still carries the full history, feedback included").toBeVisible();
    await expect(page.getByText("Picked up task")).toBeVisible();
  });

  test("ZYU-72 the full task view's Feedback tab still gates sending on task status once relocated", async ({ browser }) => {
    // Proves the move didn't drop the existing status guard (see api/zyra.spec.ts ZYR-A-34): a task
    // that hasn't finished generating, and one that's already closed, both refuse a real submission
    // and say why, rather than silently accepting a click that the server would answer with a 409.
    const pendingTask = seedTask({ userStory: stamp("Pending feedback story"), status: "todo" });
    const pendingPage = await open(browser, `/agents/tasks/${pendingTask}`);
    await pendingPage.getByRole("button", { name: "Feedback (0)" }).click();
    await expect(pendingPage.getByText("Feedback opens up once Zyra finishes generating drafts for this task.")).toBeVisible();
    await expect(pendingPage.getByRole("button", { name: "Send feedback" })).toBeDisabled();

    const doneTask = seedTask({ userStory: stamp("Done feedback story"), status: "done" });
    const donePage = await open(browser, `/agents/tasks/${doneTask}`);
    await donePage.getByRole("button", { name: "Feedback (0)" }).click();
    await expect(donePage.getByText("Feedback isn't available once a task is closed.")).toBeVisible();
    await expect(donePage.getByRole("button", { name: "Send feedback" })).toBeDisabled();
  });

  // ─── Feedback tab: attaching Jira and Linear tickets (fix for "Feedback form does not show a
  // Linear ticket dropdown") ──────────────────────────────────────────────────────────────────

  /*
   * The form used to load and offer Jira tickets only; Linear tickets could not be attached at all,
   * though POST .../feedback has always accepted linearIssueKeys (api/zyra.spec.ts ZYR-A-93).
   *
   * Both ticket lists are scoped to the project's currently ENABLED mapping (mapped_remote_id —
   * see api/integrations.spec.ts currentOrAutoLinearMapping), so a ticket row alone never reaches
   * the picker: each seed below writes connection + enabled mapping + tickets carrying its id.
   */
  function seedFeedbackTickets(provider: "jira" | "linear", tickets: Array<{ key: string; summary: string }>): void {
    const t = tenant!;
    const org = literal(t.organizationId);
    const project = literal(t.mainProjectId);
    exec(
      `INSERT INTO integration_connections (organization_id, provider, external_id, site_url, access_token, refresh_token, token_expires_at) ` +
        `VALUES (${org}, ${literal(provider)}, 'e2e-zyra-ui-feedback', 'https://e2e-zyra-ui-feedback.invalid', 'e2e', '', now() + interval '365 days') ` +
        `ON CONFLICT (organization_id, provider) DO NOTHING;`,
    );
    const connectionId = literal(
      scalar(`SELECT id FROM integration_connections WHERE organization_id = ${org} AND provider = ${literal(provider)};`),
    );
    const remoteId = literal(`${provider}-feedback-${t.mainProjectId}`);
    if (provider === "jira") {
      exec(
        "INSERT INTO jira_project_mappings (project_id, jira_connection_id, jira_project_id, jira_project_key, jira_project_name, enabled) " +
          `VALUES (${project}, ${connectionId}, ${remoteId}, 'ZFB', 'E2E feedback mapping', true) ON CONFLICT DO NOTHING;`,
      );
    } else {
      exec(
        "INSERT INTO linear_project_mappings (project_id, integration_connection_id, linear_team_id, linear_team_key, linear_team_name, entity_type, enabled) " +
          `VALUES (${project}, ${connectionId}, ${remoteId}, 'ZFB', 'E2E feedback mapping', 'team', true) ON CONFLICT DO NOTHING;`,
      );
    }
    for (const ticket of tickets) {
      exec(
        provider === "jira"
          ? "INSERT INTO jira_tickets (project_id, jira_connection_id, jira_issue_id, jira_issue_key, summary, issue_type, status, mapped_remote_id) " +
              `VALUES (${project}, ${connectionId}, ${literal(ticket.key)}, ${literal(ticket.key)}, ${literal(ticket.summary)}, 'Story', 'Open', ${remoteId});`
          : "INSERT INTO linear_tickets (project_id, integration_connection_id, linear_issue_id, linear_issue_key, summary, issue_type, status, mapped_remote_id) " +
              `VALUES (${project}, ${connectionId}, ${literal(ticket.key)}, ${literal(ticket.key)}, ${literal(ticket.summary)}, 'Story', 'Todo', ${remoteId});`,
      );
    }
  }

  /** The picker's native <select>. FieldLabel has no htmlFor, so it is reached through its Field
   *  (div.space-y-2); `.last()` is the innermost such div, as outer containers also match. */
  function ticketPicker(page: Page, label: "Attach Jira tickets" | "Attach Linear tickets"): Locator {
    return page
      .locator("div.space-y-2")
      .filter({ has: page.locator("label", { hasText: new RegExp(`^${label}$`) }) })
      .last()
      .locator("select");
  }

  async function openFeedbackTab(browser: Browser, taskId: string): Promise<Page> {
    const page = await open(browser, `/agents/tasks/${taskId}`);
    await page.getByRole("button", { name: /^Feedback \(/ }).click();
    await expect(page.getByRole("heading", { name: "Send feedback" })).toBeVisible();
    return page;
  }

  /** A fake-provider key (utils/fake-ai-server.ts), so the regeneration Send feedback kicks off
   *  completes for real. A custom gateway provider name keeps embeddings off (see api/zyra.spec.ts
   *  ZYR-A-91's allocateFakeAiKey comment). */
  async function allocateFakeProviderKey(ai: FakeAiServer): Promise<void> {
    const keyRes = await api.post("/api/workspace/ai-keys", {
      data: { name: `E2E ui feedback fake ai ${Date.now()}${Math.floor(Math.random() * 1000)}`, provider: "e2e-fake-gateway", apiKey: "sk-e2e-fake", baseUrl: ai.baseUrl, defaultModel: "gpt-4o-mini" },
      failOnStatusCode: false,
    });
    expect(keyRes.status(), `creating the fake-provider AI key — ${await keyRes.text()}`).toBe(201);
    const allocRes = await api.post("/api/workspace/ai-keys/allocations", {
      data: { projectId: tenant!.mainProjectId, workspaceAiKeyId: (await keyRes.json()).id },
      failOnStatusCode: false,
    });
    expect(allocRes.status(), `allocating the fake-provider key — ${await allocRes.text()}`).toBe(201);
  }

  async function waitForTaskSettled(taskId: string): Promise<string> {
    for (let i = 0; i < 80; i++) {
      const status = scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`);
      if (status !== "todo" && status !== "in_progress") return status;
      await new Promise((r) => setTimeout(r, 250));
    }
    return scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`);
  }

  function isFeedbackRequest(url: string, method: string): boolean {
    return method === "POST" && /\/agents\/zyra\/tasks\/[^/]+\/feedback$/.test(new URL(url).pathname);
  }

  test("ZYU-113 with Linear connected, the Feedback tab offers a Linear ticket picker, and the picked ticket reaches Zyra and the task", async ({
    browser,
  }) => {
    // The regression test for the report: before the fix there is no "Attach Linear tickets" field
    // at all, so this fails at the first picker assertion.
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const linearKey = `ZLN-${suffix}`;
    const linearSummary = `Linear refund window rule ${suffix}`;
    seedFeedbackTickets("linear", [{ key: linearKey, summary: linearSummary }, { key: `ZLN-${suffix}-B`, summary: "Another Linear ticket" }]);
    const ai = await startFakeAiServer();
    try {
      await allocateFakeProviderKey(ai);
      const taskId = seedTask();
      const page = await openFeedbackTab(browser, taskId);

      const picker = ticketPicker(page, "Attach Linear tickets");
      await expect(picker).toBeVisible();
      await expect(picker.locator("option", { hasText: `${linearKey} - ${linearSummary}` })).toHaveCount(1);
      // Linear is the only provider connected — no empty Jira field alongside it.
      await expect(page.getByText("Attach Jira tickets", { exact: true })).toHaveCount(0);

      await picker.selectOption(linearKey);
      const chip = page.getByRole("button", { name: `${linearKey} x` });
      await expect(chip).toBeVisible();
      // The select resets to its placeholder after each pick; picking the same key again must not add a second chip.
      await expect(picker).toHaveValue("");
      await picker.selectOption(linearKey);
      await expect(chip).toHaveCount(1);

      ai.queueReply({
        drafts: [{
          title: "Refund refused after the refund window",
          preconditions: "",
          stepsJson: JSON.stringify([{ stepNumber: 1, action: "Request a late refund", expectedResult: "It is refused" }]),
          testData: "",
          expectedSummary: "It is refused.",
          priority: "P1",
          tags: ["zyra"],
          sourceRefs: [],
        }],
      });
      await page.getByPlaceholder("Ask Zyra to improve coverage, add edge cases, remove duplicates, or focus on a missed rule.").fill("Cover the Linear refund rule");
      const sent = page.waitForRequest((req) => isFeedbackRequest(req.url(), req.method()));
      await page.getByRole("button", { name: "Send feedback" }).click();
      expect((await sent).postDataJSON()).toMatchObject({ linearIssueKeys: [linearKey], jiraIssueKeys: [] });
      await expect(page.getByText(/Feedback sent\./)).toBeVisible();
      // Sending clears the selection.
      await expect(page.getByRole("button", { name: `${linearKey} x` })).toHaveCount(0);

      expect(await waitForTaskSettled(taskId), "regeneration must complete, not fail").toBe("in_review");
      expect(JSON.parse(scalar(`SELECT linear_issue_keys::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`))).toEqual([linearKey]);
      expect(JSON.stringify(ai.requests[0]?.messages ?? []), "the Linear ticket's summary must reach the model").toContain(linearSummary);

      // The task header now shows the attached Linear key, as it always did for Jira keys.
      await page.reload();
      await expect(page.getByRole("heading", { name: "Zyra task", level: 1 })).toBeVisible();
      await expect(page.locator("span", { hasText: new RegExp(`^${linearKey}$`) })).toBeVisible();
    } finally {
      await ai.close();
    }
  });

  test("ZYU-114 with Jira and Linear both connected, each picker lists only its own tickets and sends them in its own list", async ({ browser }) => {
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const jiraKey = `ZJI-${suffix}`;
    const linearKey = `ZLN-${suffix}`;
    const linearKey2 = `ZLN-${suffix}-B`;
    seedFeedbackTickets("jira", [{ key: jiraKey, summary: "Seeded Jira feedback ticket" }]);
    seedFeedbackTickets("linear", [{ key: linearKey, summary: "Seeded Linear feedback ticket" }, { key: linearKey2, summary: "Second Linear ticket" }]);
    const ai = await startFakeAiServer();
    try {
      await allocateFakeProviderKey(ai);
      const taskId = seedTask();
      const page = await openFeedbackTab(browser, taskId);

      const jiraPicker = ticketPicker(page, "Attach Jira tickets");
      const linearPicker = ticketPicker(page, "Attach Linear tickets");
      await expect(jiraPicker).toBeVisible();
      await expect(linearPicker).toBeVisible();
      await expect(jiraPicker.locator("option", { hasText: linearKey })).toHaveCount(0);
      await expect(linearPicker.locator("option", { hasText: jiraKey })).toHaveCount(0);

      await jiraPicker.selectOption(jiraKey);
      await linearPicker.selectOption(linearKey);
      await linearPicker.selectOption(linearKey2);
      // Clicking a chip removes just that key.
      await page.getByRole("button", { name: `${linearKey2} x` }).click();
      await expect(page.getByRole("button", { name: `${linearKey2} x` })).toHaveCount(0);
      await expect(page.getByRole("button", { name: `${linearKey} x` })).toBeVisible();
      await expect(page.getByRole("button", { name: `${jiraKey} x` })).toBeVisible();

      await page.getByPlaceholder("Ask Zyra to improve coverage, add edge cases, remove duplicates, or focus on a missed rule.").fill("Use both tickets");
      const sent = page.waitForRequest((req) => isFeedbackRequest(req.url(), req.method()));
      await page.getByRole("button", { name: "Send feedback" }).click();
      expect((await sent).postDataJSON()).toMatchObject({ jiraIssueKeys: [jiraKey], linearIssueKeys: [linearKey] });
      await expect(page.getByText(/Feedback sent\./)).toBeVisible();

      expect(await waitForTaskSettled(taskId)).toBe("in_review");
      expect(JSON.parse(scalar(`SELECT jira_issue_keys::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`))).toEqual([jiraKey]);
      expect(JSON.parse(scalar(`SELECT linear_issue_keys::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`))).toEqual([linearKey]);
    } finally {
      await ai.close();
    }
  });

  test("ZYU-115 no ticket picker is shown for a provider that is not connected or has no tickets in the mapped scope", async ({ browser }) => {
    const taskId = seedTask();

    // Nothing connected: neither picker, and the rest of the form still works.
    let page = await openFeedbackTab(browser, taskId);
    await expect(page.getByRole("button", { name: "Send feedback" })).toBeVisible();
    await expect(page.getByText("Attach Jira tickets", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Attach Linear tickets", { exact: true })).toHaveCount(0);

    // Linear connected and mapped, but with no tickets synced: still no empty picker.
    seedFeedbackTickets("linear", []);
    page = await openFeedbackTab(browser, taskId);
    await expect(page.getByRole("button", { name: "Send feedback" })).toBeVisible();
    await expect(page.getByText("Attach Linear tickets", { exact: true })).toHaveCount(0);

    // Jira only: the Jira picker is unaffected by the Linear addition.
    seedFeedbackTickets("jira", [{ key: `ZJI-${Date.now()}`, summary: "Jira only" }]);
    page = await openFeedbackTab(browser, taskId);
    await expect(ticketPicker(page, "Attach Jira tickets")).toBeVisible();
    await expect(page.getByText("Attach Linear tickets", { exact: true })).toHaveCount(0);
  });

  test("ZYU-116 a failing Linear status call hides only the Linear picker; the task and the Jira picker still load", async ({ browser }) => {
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const jiraKey = `ZJI-${suffix}`;
    seedFeedbackTickets("jira", [{ key: jiraKey, summary: "Jira survives" }]);
    seedFeedbackTickets("linear", [{ key: `ZLN-${suffix}`, summary: "Hidden by the failure" }]);
    const taskId = seedTask();

    const ctx = await browser.newContext({ storageState: states.get("owner") });
    contexts.push(ctx);
    const page = await ctx.newPage();
    // The API is cross-origin from the page, so match on path rather than a full URL.
    await page.route(/\/linear\/status(\?|$)/, (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));
    await page.goto(`/projects/${tenant!.mainProjectId}/agents/tasks/${taskId}`);
    await page.getByRole("button", { name: /^Feedback \(/ }).click();

    await expect(page.getByRole("heading", { name: "Send feedback" })).toBeVisible();
    await expect(ticketPicker(page, "Attach Jira tickets").locator("option", { hasText: jiraKey })).toHaveCount(1);
    await expect(page.getByText("Attach Linear tickets", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Failed to load task.")).toHaveCount(0);
  });

  // ─── Sources tab: label and formatting ─────────────────────────────────────

  test("ZYU-30 the quick-view panel's Sources tab labels context 'User Story Context' and keeps each line on its own row", async ({
    browser,
  }) => {
    /*
     * Regression test for [Agents-Tasks] "User context" in the Task Details view: the source label
     * had to read "User Story Context", not "User context", and the detail text — pulled from a
     * multi-paragraph Jira description — had to keep its line breaks rather than rendering as one
     * flattened paragraph. The real generation flow that builds this source can't be driven end to
     * end here (see the file header — no AI provider is configured for this suite), so the source is
     * seeded the way aiGenerate leaves it and this asserts the panel renders it correctly.
     *
     * Context now goes through renderMarkdown (see ZYU-125), which turns each non-blank line into
     * its own paragraph — so "line breaks kept" is asserted as three rows, not as pre-wrap text.
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
    await expect(
      sourceCard.locator(".zyra-prose p"),
      "each line of the context must stay on its own row, not collapse into one paragraph",
    ).toHaveText(["Line one of the story", "Line two of the story", "Line three"]);
  });

  test("ZYU-31 the task detail page's Sources tab labels context 'User Story Context' and keeps each line on its own row", async ({
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
    await expect(sourceCard.locator(".zyra-prose p")).toHaveText(["Line one of the story", "Line two of the story", "Line three"]);
  });

  test("ZYU-32 a source with no line breaks in its detail still renders correctly", async ({ browser }) => {
    // Guard against a regression the other way: rendering context as Markdown must not alter
    // single-line plain text (extra wrapping, stray whitespace) — it stays one paragraph, verbatim.
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
  // legacy.service.ts labels the source object `{ type: "knowledge_base", ... }`. It goes through
  // renderMarkdown (lib/markdown.ts, shared with the Zyra chat page), as do `context`, `jira` and
  // `linear` since ZYU-125 — the gate is isMarkdownSource(). `story` keeps rendering as literal
  // whitespace-pre-wrap text (ZYU-39). Real generation can't be driven end to end in this suite (see file header —
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

  test("ZYU-39 a story source's Markdown-looking text is not parsed as Markdown", async ({ browser }) => {
    // Locks the other side of isMarkdownSource(): `story` is the user's own one-line story, shown
    // plain in the task heading and on Kanban cards, so the Sources tab must not reinterpret a
    // literal "# " or "**" in it either. (This test used to pin the same for `context`; ZYU-125
    // deliberately reversed that, because a Jira/Linear description arrives as Markdown.)
    const raw = "# Not a heading\n**not bold** and a - bullet look-alike";
    const taskId = seedTask({ sources: [{ type: "story", title: "User story", detail: raw }] });

    const page = await open(browser, `/agents/tasks/${taskId}`);
    await page.getByRole("button", { name: "Sources (1)" }).click();

    await expect(page.getByRole("heading", { name: "Not a heading" })).toHaveCount(0);
    const title = page.getByRole("heading", { name: "User story", level: 3 });
    const sourceCard = page.locator("div.rounded-lg", { has: title });
    const detail = sourceCard.locator("p");
    expect(await detail.textContent()).toBe(raw);
  });

  // ─── Sources tab: Linear/Jira ticket Markdown in context (reported screenshot) ─
  //
  // A task created from a Linear ticket stores the ticket's Markdown description as `context`, and
  // aiGenerate copies its first 320 characters into a "User Story Context" source. Only
  // `knowledge_base` sources were rendered, so the card showed "- **Status:** Backlog" verbatim.
  // The fixture is the reported ticket's context, cut at 320 the way legacy.service.ts cuts it.
  const LINEAR_CONTEXT = [
    "QAB-241: LIN-01: Create a System User",
    "# QAB-241: LIN-01: Create a System User",
    "",
    "- **Status:** Backlog",
    "- **Type:** Issue",
    "- **Priority:** No priority",
    "- **Assignee:** Namrata Gosai",
    "- **Reporter:** Namrata Gosai",
    "- **Created:** 2026-09-22",
    "- **Updated:** 2026-09-24",
    "- **Link:** https://linear.app/qable/issue/QAB-241/lin-01-create-a-system-user",
  ]
    .join("\n")
    .slice(0, 320);

  async function expectLinearContextRendered(scope: Page | Locator) {
    const title = scope.getByRole("heading", { name: "User Story Context", level: 3 });
    const sourceCard = scope.locator("div.rounded-lg", { has: title });
    await expect(sourceCard.getByRole("heading", { name: "QAB-241: LIN-01: Create a System User", level: 1 })).toBeVisible();
    await expect(sourceCard.locator("li")).toHaveCount(8);
    await expect(sourceCard.locator("li").first()).toHaveText("Status: Backlog");
    await expect(sourceCard.locator("li strong", { hasText: "Assignee:" })).toBeVisible();
    await expect(sourceCard.getByText("**", { exact: false }), "no raw bold markers may be shown").toHaveCount(0);
    await expect(sourceCard.getByText("# QAB-241", { exact: false }), "no raw heading marker may be shown").toHaveCount(0);
  }

  test("ZYU-125 the task detail page renders a Linear ticket's context source as formatted Markdown", async ({ browser }) => {
    const taskId = seedTask({ sources: [{ type: "context", title: "User Story Context", detail: LINEAR_CONTEXT }] });

    const page = await open(browser, `/agents/tasks/${taskId}`);
    await page.getByRole("button", { name: "Sources (1)" }).click();
    await expectLinearContextRendered(page);
  });

  test("ZYU-126 the quick-view panel renders a Linear ticket's context source as formatted Markdown", async ({ browser }) => {
    const userStory = stamp("Linear context story");
    seedTask({ userStory, sources: [{ type: "context", title: "User Story Context", detail: LINEAR_CONTEXT }] });

    const page = await open(browser, "/agents/tasks");
    await page.getByRole("tab", { name: "Kanban board" }).click();
    await page.locator("button", { has: page.getByText(userStory) }).click();

    const panel = page.locator(".slide-in-right");
    await panel.getByRole("button", { name: /^Sources/ }).click();
    await expectLinearContextRendered(panel);
  });

  test("ZYU-127 jira and linear sources render Markdown too, a link cut mid-syntax stays plain text, and HTML stays escaped", async ({
    browser,
  }) => {
    const marker = `xss-marker-${Date.now()}`;
    const taskId = seedTask({
      sources: [
        { type: "jira", title: "KAN-9", detail: "Checkout **must** retry\n- once\n- twice" },
        // The 320-character slice can end inside a link; the unclosed syntax must render as plain
        // text rather than swallow or break the card.
        { type: "linear", title: "QAB-9", detail: "- **Status:** Backlog\n- **Link:** [ticket](https://linear.app/qab" },
        { type: "context", title: "User Story Context", detail: `<img src=x onerror="window.__zyraXss='${marker}'">` },
      ],
    });

    const page = await open(browser, `/agents/tasks/${taskId}`);
    await page.getByRole("button", { name: "Sources (3)" }).click();

    const card = (name: string) => page.locator("div.rounded-lg", { has: page.getByRole("heading", { name, level: 3 }) });
    await expect(card("KAN-9").locator("strong", { hasText: "must" })).toBeVisible();
    await expect(card("KAN-9").locator("li")).toHaveText(["once", "twice"]);

    await expect(card("QAB-9").locator("li")).toHaveCount(2);
    await expect(card("QAB-9").locator("li").first()).toHaveText("Status: Backlog");
    await expect(card("QAB-9").locator("a"), "a cut-off link must not become an anchor").toHaveCount(0);
    await expect(card("QAB-9").locator("li").nth(1)).toContainText("[ticket](https://linear.app/qab");

    const contextCard = card("User Story Context");
    await expect(contextCard.locator("img")).toHaveCount(0);
    await expect(contextCard.getByText("<img", { exact: false })).toBeVisible();
    const injected = await page.evaluate(() => (window as unknown as Record<string, unknown>).__zyraXss);
    expect(injected, "context now goes through renderMarkdown, which escapes HTML first").toBeUndefined();
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

  // ─── Continue / resume (the misleading "Resuming…" hang fix) ───────────────
  // Same "arrange through Postgres" rule as seedChatReviewBatch below — actually reaching a
  // timed-out or in-flight resume through the live route needs a provider call that genuinely
  // stalls, which this suite deliberately never drives (file header).
  function seedResumeMessage(status: "timed_out" | "resuming", options: { resumeAttempt?: number } = {}): { sessionId: string; messageId: string } {
    const t = tenant!;
    exec(`INSERT INTO zyra_chat_sessions (project_id, user_id, title) VALUES (${literal(t.mainProjectId)}, ${literal(t.owner.userId)}, 'E2E resume session');`);
    const sessionId = scalar(`SELECT id FROM zyra_chat_sessions WHERE project_id = ${literal(t.mainProjectId)} ORDER BY created_at DESC LIMIT 1;`);
    const checkpoint = JSON.stringify({
      stage: "generate", userMessageId: "", message: "Write me some test cases",
      routedSuite: null, routedCount: { requestedCount: 10, exhaustive: false },
    });
    exec(
      "INSERT INTO zyra_chat_messages (session_id, project_id, user_id, role, content, status, resume_checkpoint, resume_attempt) VALUES " +
        `(${literal(sessionId)}, ${literal(t.mainProjectId)}, ${literal(t.owner.userId)}, 'assistant', ` +
        `'⏱️ I did not hear back from the AI provider in time.', ${literal(status)}, ${literal(checkpoint)}::jsonb, ${options.resumeAttempt ?? 0});`,
    );
    const messageId = scalar(`SELECT id FROM zyra_chat_messages WHERE session_id = ${literal(sessionId)} ORDER BY created_at DESC LIMIT 1;`);
    return { sessionId, messageId };
  }

  test("ZYU-90 a message already 'resuming' on page load shows a working indicator immediately, with elapsed time ticking", async ({ browser }) => {
    // Loading the page with status already 'resuming' is exactly what a reload mid-Continue looks
    // like (no client-side turnId survives a reload) — this is that gap the fix closes: previously
    // nothing rendered at all for this status.
    seedResumeMessage("resuming");
    const page = await open(browser, "/agents/zyra");

    // Case-insensitive: the redesigned backlog uses a lowercase, log-style "zyra is working on
    // this" line rather than sentence-cased prose.
    await expect(page.getByText(/zyra is working on this/i)).toBeVisible();
    // The old static, disabled "Resuming…" button no longer exists in any form.
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
    await expect(page.getByText(/Resuming…/)).toHaveCount(0);

    const elapsedText = page.getByText(/\d+s elapsed/);
    await expect(elapsedText).toBeVisible();
    const first = Number((await elapsedText.textContent())?.match(/(\d+)s elapsed/)?.[1] ?? "0");
    await page.waitForTimeout(2500);
    const second = Number((await elapsedText.textContent())?.match(/(\d+)s elapsed/)?.[1] ?? "0");
    expect(second, "the elapsed counter must actually advance — a frozen number is the exact misleading UX this fix replaces").toBeGreaterThan(first);
  });

  test("ZYU-91 after repeated timeouts, Continue is replaced by a narrowed-batch suggestion with an escape hatch back to full size", async ({ browser }) => {
    seedResumeMessage("timed_out", { resumeAttempt: 2 });
    const page = await open(browser, "/agents/zyra");

    await expect(page.getByText(/timed out 3 times in a row/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with a smaller batch (5 cases)" })).toBeVisible();
    // The identical-size Continue is gone once the cap is hit — offering it again would just repeat
    // the same multi-minute wait for the same result.
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
    // Never a hard dead end: the user can still choose to retry at the original size.
    await expect(page.getByText("Try the original size again anyway")).toBeVisible();
  });

  test("ZYU-92 below the cap, the plain Continue button still renders exactly as before", async ({ browser }) => {
    seedResumeMessage("timed_out", { resumeAttempt: 1 });
    const page = await open(browser, "/agents/zyra");

    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with a smaller batch (5 cases)" })).toHaveCount(0);
    await expect(page.getByText(/timed out .* times in a row/)).toHaveCount(0);
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

  /*
   * "[Zyra] Severity and Component Are Missing in Generated Test Cases" — the edit form
   * (ZyraDraftEditor) never exposed these two fields at all, even though the backend's
   * sanitizeZyraUpdateFields allowlist already accepted them. Mirrors ZYU-66's edit/persist
   * pattern exactly, for the two fields that were actually missing.
   */
  test("ZYU-82 editing a proposed row's severity and component updates what's displayed and what's stored", async ({ browser }) => {
    const { taskId } = seedChatReviewBatch();
    const page = await open(browser, "/agents/zyra");

    const row = page.getByRole("listitem").filter({ hasText: "Sign in with a wrong password" });
    await row.getByRole("button", { name: "Edit" }).click();
    // Field order in ZyraDraftEditor: Title (textbox 0), Priority (combobox 0), Severity
    // (combobox 1), Component (textbox 1), Preconditions/Description/Test Data/Steps after that.
    // The seeded draft has no severity, so the placeholder option must read "Select", not "No severity".
    await expect(row.getByRole("combobox").nth(1).locator("option:checked")).toHaveText("Select");
    await row.getByRole("combobox").nth(1).selectOption("Medium");
    await row.getByRole("textbox").nth(1).fill("Search");
    await row.getByRole("button", { name: "Save edit" }).click();

    await expect(row.getByText("Medium")).toBeVisible();
    await expect(row.getByText("Search")).toBeVisible();

    const readDraft = (field: "severity" | "component") =>
      scalar(
        `SELECT d->'draft'->>'${field}' FROM ai_generation_requests r, jsonb_array_elements(r.generated_payload) d ` +
          `WHERE r.id = ${literal(taskId)} AND d->'draft'->>'title' = 'Sign in with a wrong password';`,
      );
    await expect
      .poll(() => readDraft("severity"), { message: "the severity edit must persist, not just render client-side" })
      .toBe("Medium");
    expect(readDraft("component")).toBe("Search");
  });

  /*
   * "[Zyra] Edit Test Case View Is Missing Fields Available After Saving" — the draft editor showed
   * the description under an "Expected result" label (below the fold) and had no Test Data field
   * at all, while zyraSave wrote both onto the real test case.
   *
   * FieldLabel renders a <label> with no htmlFor, so getByLabel can't resolve these textareas —
   * each is the label's next sibling inside its Field wrapper.
   */
  function editorTextarea(row: Locator, label: string): Locator {
    return row.locator("label", { hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::textarea[1]");
  }

  function readDraftField(taskId: string, title: string, field: string): string {
    return scalar(
      `SELECT COALESCE(d->'draft'->>'${field}', '<absent>') FROM ai_generation_requests r, jsonb_array_elements(r.generated_payload) d ` +
        `WHERE r.id = ${literal(taskId)} AND d->'draft'->>'title' = ${literal(title)};`,
    );
  }

  test("ZYU-133 the draft editor shows a proposal's Description and Test Data, and a Test Data edit persists", async ({ browser }) => {
    const title = stamp("Chat test data case");
    const { taskId } = seedChatReviewBatch({
      entries: [
        { opType: "create", draft: { suiteId: null, title, description: "The post appears in the feed", preconditions: "", stepsJson: "[]", testData: "post: Hello Buzz", priority: "P1" } },
      ],
    });
    const page = await open(browser, "/agents/zyra");

    const row = page.getByRole("listitem").filter({ hasText: title });
    await row.getByRole("button", { name: "Edit" }).click();
    await expect(editorTextarea(row, "Description")).toHaveValue("The post appears in the feed");
    await expect(editorTextarea(row, "Test Data")).toHaveValue("post: Hello Buzz");
    // The description used to sit under this label; it must not survive as a second, misleading name.
    await expect(row.locator("label", { hasText: /^Expected result$/ })).toHaveCount(0);

    await editorTextarea(row, "Test Data").fill("post: Edited Buzz");
    await row.getByRole("button", { name: "Save edit" }).click();
    await expect(row.getByRole("button", { name: "Save edit" })).toHaveCount(0);

    await expect
      .poll(() => readDraftField(taskId, title, "testData"), { message: "the test data edit must persist, not just render client-side" })
      .toBe("post: Edited Buzz");
    expect(readDraftField(taskId, title, "description"), "editing test data must leave the description alone").toBe("The post appears in the feed");

    // Reopening shows the edited value (the panel's local row was updated, not only the server).
    await row.getByRole("button", { name: "Edit" }).click();
    await expect(editorTextarea(row, "Test Data")).toHaveValue("post: Edited Buzz");
  });

  test("ZYU-134 editing another field of a proposal staged before test data was on the row does not wipe its test data", async ({ browser }) => {
    const title = stamp("Legacy snapshot case");
    const { taskId } = seedChatReviewBatch({
      legacySnapshot: true,
      entries: [{ opType: "create", draft: { suiteId: null, title, description: "", preconditions: "", stepsJson: "[]", testData: "keep: me", priority: "P2" } }],
    });
    const page = await open(browser, "/agents/zyra");

    const row = page.getByRole("listitem").filter({ hasText: title });
    await row.getByRole("button", { name: "Edit" }).click();
    // The message snapshot predates the field, so the editor genuinely has no value to show here.
    await expect(editorTextarea(row, "Test Data")).toHaveValue("");
    await editorTextarea(row, "Preconditions").fill("Signed in as an employee");
    await row.getByRole("button", { name: "Save edit" }).click();

    await expect
      .poll(() => readDraftField(taskId, title, "preconditions"), { message: "the preconditions edit must persist" })
      .toBe("Signed in as an employee");
    expect(readDraftField(taskId, title, "testData"), "an untouched blank Test Data field must not overwrite the stored value").toBe("keep: me");
  });

  test("ZYU-135 saving a proposal with a description and test data persists both onto the real test case", async ({ browser }) => {
    const title = stamp("Chat-saved test data case");
    const { taskId } = seedChatReviewBatch({
      entries: [
        { opType: "create", draft: { suiteId: null, title, description: "Order confirmation is shown", preconditions: "", stepsJson: "[]", testData: "qty: 3", priority: "P2" } },
      ],
    });
    const page = await open(browser, "/agents/zyra");

    await expect(page.getByText(title)).toBeVisible();
    await page.getByRole("button", { name: /Save 1 to repository/ }).click();
    await expect(page.getByText(/saved to the repository/)).toBeVisible();

    const savedField = (column: "description" | "test_data") =>
      scalar(`SELECT ${column} FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND title = ${literal(title)};`);
    await expect.poll(() => savedField("test_data"), { message: "the proposal's test data must reach the saved row" }).toBe("qty: 3");
    expect(savedField("description")).toBe("Order confirmation is shown");
    expect(scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe("done");
  });

  test("ZYU-136 a failed draft edit keeps the editor open, shows the error, and stores nothing", async ({ browser }) => {
    const title = stamp("Failed edit case");
    const { taskId } = seedChatReviewBatch({
      entries: [{ opType: "create", draft: { suiteId: null, title, description: "", preconditions: "", stepsJson: "[]", testData: "before", priority: "P2" } }],
    });
    const page = await open(browser, "/agents/zyra");
    await page.route("**/agents/zyra/tasks/*/drafts/*", (route) =>
      route.request().method() === "PATCH" ? route.fulfill({ status: 500, json: { error: "Simulated edit failure" } }) : route.continue(),
    );

    const row = page.getByRole("listitem").filter({ hasText: title });
    await row.getByRole("button", { name: "Edit" }).click();
    await editorTextarea(row, "Test Data").fill("after");
    await row.getByRole("button", { name: "Save edit" }).click();

    await expect(page.getByText(/Simulated edit failure|Failed to save the edit/)).toBeVisible();
    await expect(row.getByRole("button", { name: "Save edit" }), "the editor must stay open so the edit isn't lost").toBeVisible();
    await expect(editorTextarea(row, "Test Data")).toHaveValue("after");
    expect(readDraftField(taskId, title, "testData")).toBe("before");
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

  test("ZYU-81 saving a chat-staged proposal with severity and component persists both onto the real test case", async ({ browser }) => {
    const draftTitle = stamp("Chat-saved severity case");
    const { taskId } = seedChatReviewBatch({
      entries: [{ opType: "create", draft: { suiteId: null, title: draftTitle, description: "", preconditions: "", stepsJson: "[]", priority: "P2", severity: "Critical", component: "Billing" } }],
    });
    const page = await open(browser, "/agents/zyra");

    // Same display bug, chat surface: severity/component must be visible in the review card
    // BEFORE saving (this is chatDraftRow's own output — the exact place the fields were dropped).
    const draftRow = page.getByRole("listitem").filter({ hasText: draftTitle });
    await expect(draftRow.getByText("Critical")).toBeVisible();
    await expect(draftRow.getByText("Billing")).toBeVisible();

    await page.getByRole("button", { name: /Save 1 to repository/ }).click();
    await expect(page.getByText(/saved to the repository/)).toBeVisible();

    await expect
      .poll(
        () => scalar(`SELECT severity FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND title = ${literal(draftTitle)};`),
        { message: "a chat-staged proposal's severity must reach the saved row" },
      )
      .toBe("Critical");
    expect(scalar(`SELECT component FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND title = ${literal(draftTitle)};`)).toBe("Billing");
    expect(scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe("done");
  });

  test("ZYU-68 a review batch already resolved elsewhere shows a read-only note instead of live controls", async ({ browser }) => {
    seedChatReviewBatch({ status: "done" });
    const page = await open(browser, "/agents/zyra");

    await expect(page.getByText(/This batch was already saved or closed/)).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /Select proposed test case/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Save \d+ to repository/ })).toHaveCount(0);
  });

  /*
   * "All – Exhaustive" plans post one assistant message per batch into the same conversation. Every
   * batch after the first was stored without review_request_id (postZyraPlanMessage never wrote it),
   * and the panel only rendered off that column — so the header said "5 test cases drafted for
   * review" with nothing under it. The rows themselves still carried their batch's reviewRequestId;
   * these pin that every batch renders, earlier ones survive later ones, and each panel acts on its
   * own batch. api/zyra-chat-consistency.spec.ts ZCC-B-17 pins the stored link for new batches.
   */
  function planBatch(label: string, count: number): ChatEntry[] {
    return Array.from({ length: count }, (_, i) => ({
      opType: "create" as const,
      draft: { suiteId: null, title: `${label} case ${i + 1}`, description: "", preconditions: "", stepsJson: "[]", priority: "P2" },
    }));
  }

  test("ZYU-125 every batch of an exhaustive plan renders its drafts, including batches stored without the message-level review link", async ({ browser }) => {
    const b1 = stamp("Plan batch one");
    const b2 = stamp("Plan batch two");
    const b3 = stamp("Plan batch three");
    const first = seedChatReviewBatch({ entries: planBatch(b1, 2), content: "I identified 6 distinct scenarios to cover. Here are the first 2." });
    const second = seedChatReviewBatch({ sessionId: first.sessionId, entries: planBatch(b2, 2), linkMessage: false, content: "Here are 2 more test case(s) — 4/6 scenarios covered so far." });
    const third = seedChatReviewBatch({ sessionId: first.sessionId, entries: planBatch(b3, 2), linkMessage: false, content: "Here are the final 2 test case(s) — all 6 scenarios are now covered." });
    const page = await open(browser, "/agents/zyra");

    for (const label of [b1, b2, b3]) {
      await expect(page.getByText(`${label} case 1`), `${label} must be reviewable in the chat`).toBeVisible();
      await expect(page.getByText(`${label} case 2`)).toBeVisible();
    }
    await expect(page.getByText(/2 of 2 selected — pending review/), "one review panel per batch").toHaveCount(3);

    // The fallback panel must address ITS batch, not the first one: a discard in batch three
    // changes batch three's stored drafts and leaves the other two untouched.
    await page.getByRole("listitem").filter({ hasText: `${b3} case 1` }).getByRole("button", { name: "Discard" }).click();
    await expect(page.getByText(`${b3} case 1`)).toHaveCount(0);
    await expect.poll(() => draftTitles(third.taskId)).toEqual([`${b3} case 2`]);
    expect(draftTitles(second.taskId)).toEqual([`${b2} case 1`, `${b2} case 2`]);
    expect(draftTitles(first.taskId)).toEqual([`${b1} case 1`, `${b1} case 2`]);
  });

  test("ZYU-126 a batch landing while the plan runs is appended below the earlier one, which keeps its review state", async ({ browser }) => {
    const b1 = stamp("Running plan batch one");
    const b2 = stamp("Running plan batch two");
    const first = seedChatReviewBatch({ entries: planBatch(b1, 2), content: "I identified 4 distinct scenarios to cover. Here are the first 2." });
    // A plan row the page polls on — nothing executes it (the batch loop is only ever launched by a
    // send, a resume, or a backend restart), so this test controls exactly when the next batch lands.
    const plan = { planId: `e2e-plan-${Date.now()}`, status: "running", remainingScenarios: ["S3", "S4"], batchSize: 2, doneCount: 2, totalCount: 4, originalMessage: "Generate all possible cases" };
    exec(`UPDATE zyra_chat_sessions SET active_plan = ${literal(JSON.stringify(plan))}::jsonb WHERE id = ${literal(first.sessionId)};`);
    try {
      const page = await open(browser, "/agents/zyra");
      await expect(page.getByText(/Generating remaining scenarios — 2\/4 covered \(50%\)/)).toBeVisible();
      await expect(page.getByText(`${b1} case 1`)).toBeVisible();
      // In-progress review work on the earlier batch, which the next poll must not reset.
      await page.getByRole("checkbox", { name: "Select proposed test case 1" }).first().uncheck();
      await expect(page.getByText(/1 of 2 selected — pending review/)).toBeVisible();

      // The background loop's next batch, stored the way postZyraPlanMessage now stores it.
      seedChatReviewBatch({ sessionId: first.sessionId, entries: planBatch(b2, 2), content: "Here are the final 2 test case(s) — all 4 scenarios are now covered." });
      exec(`UPDATE zyra_chat_sessions SET active_plan = NULL WHERE id = ${literal(first.sessionId)};`);

      await expect(page.getByText(`${b2} case 1`), "the new batch must appear without a reload").toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(`${b2} case 2`)).toBeVisible();
      await expect(page.getByText(`${b1} case 1`), "the earlier batch must not be replaced").toBeVisible();
      await expect(page.getByText(/1 of 2 selected — pending review/), "the earlier batch's selection survives the refresh").toBeVisible();
      await expect(page.getByText(/2 of 2 selected — pending review/)).toHaveCount(1);
      await expect(page.getByText(/Generating remaining scenarios/)).toHaveCount(0);
      // Each title rendered once — a refresh replaces the transcript, it never duplicates a batch.
      await expect(page.getByText(`${b1} case 1`)).toHaveCount(1);
      await expect(page.getByText(`${b2} case 1`)).toHaveCount(1);
    } finally {
      exec(`UPDATE zyra_chat_sessions SET active_plan = NULL WHERE id = ${literal(first.sessionId)};`);
    }
  });

  test("ZYU-127 an unlinked message whose rows name two different batches gets no guessed review panel", async ({ browser }) => {
    const label = stamp("Ambiguous batch");
    const { sessionId, taskId } = seedChatReviewBatch({ entries: planBatch(label, 2) });
    const otherTask = seedChatReviewBatch({ sessionId, entries: planBatch(stamp("Other batch"), 1) }).taskId;
    // Rewrite the first message as unlinked, with its second row pointing at the other batch.
    const rows = JSON.parse(
      scalar(`SELECT testcases::text FROM zyra_chat_messages WHERE review_request_id = ${literal(taskId)};`) || "[]",
    ) as Array<Record<string, unknown>>;
    rows[1].reviewRequestId = otherTask;
    exec(
      `UPDATE zyra_chat_messages SET review_request_id = NULL, testcases = ${literal(JSON.stringify(rows))}::jsonb ` +
        `WHERE review_request_id = ${literal(taskId)};`,
    );
    const page = await open(browser, "/agents/zyra");

    await expect(page.getByText(/Other batch case 1/)).toBeVisible();
    await expect(page.getByText(/1 of 1 selected — pending review/)).toBeVisible();
    // Only the other, properly linked batch gets a panel — no actions are offered against a guess.
    await expect(page.getByText(/of 2 selected — pending review/)).toHaveCount(0);
    await expect(page.getByText(`${label} case 1`)).toHaveCount(0);
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

  /*
   * Regression test for the Test Case Repository not reflecting a Zyra save until a manual reload.
   * The Test Cases page seeds its first render from an in-memory, per-tab cache (pageDataCache,
   * keyed `testcases:${projectId}`) rather than always fetching live first — see its own doc
   * comment. The chat review panel used to save into the repository without ever touching that
   * cache, so a tab that had Test Cases open earlier in the session, then saved via Zyra, then
   * navigated back, rendered the pre-save snapshot (old suite list, old counts) until the page's
   * own background revalidation fetch happened to finish.
   *
   * The fix is NOT to drop the cache entry on save (that was tried and reverted — it traded "shows
   * stale data instantly" for "shows a blocking spinner until a live fetch finishes", which is its
   * own regression: a real, noticeably slower Test Cases open right after every Zyra save).
   * ZyraChatReviewPanel.tsx instead refetches suites/summary in the BACKGROUND the moment the save
   * succeeds (refreshTestCasesPageCache) and writes the result into the same cache entry, so the
   * correct data is already sitting there by the time the user actually clicks over.
   *
   * To prove both halves of that without racing the real backend's timing: first wait for the
   * background refresh's own network call to complete (so the cache is provably updated before
   * navigating), THEN artificially delay the Test Cases page's own mount-time fetch of the same
   * endpoint. If the fix works, the very first paint after navigating already shows the new suite
   * and count — sourced from the cache, not from that (still in-flight, delayed) fetch — and no
   * loading spinner ever appears. Before this fix, that first paint would have shown the stale
   * suite-less snapshot; with the earlier (reverted) invalidate-only approach, it would have shown
   * a spinner instead. Either wrong prior behavior is distinguishable from the two assertions below.
   */
  test("ZYU-80 navigating from a Zyra save back to Test Cases shows the new suite and counts immediately, with no loading spinner", async ({
    browser,
  }) => {
    // Prime the Test Cases page's cache with a pre-save snapshot — no suites, no test cases yet —
    // the same way a real user would already have this page open earlier in the session.
    const page = await open(browser, "/testcases");
    await expect(page.getByText("Zyra generated test cases")).toHaveCount(0);
    await expect(page.getByText(/0 test cases across 0 suites/)).toBeVisible();

    // Leaving suiteId null means the backend files this under its default "Zyra generated test
    // cases" suite (LegacyService.ZYRA_DRAFT_SUITE_NAME) — a suite that does not exist yet, so its
    // very appearance after saving is itself proof the repository picked up the new data.
    const draftTitle = stamp("Fresh from Zyra");
    seedChatReviewBatch({
      entries: [{ opType: "create", draft: { suiteId: null, title: draftTitle, description: "", preconditions: "", stepsJson: "[]", priority: "P2" } }],
    });

    // Client-side navigation only, via the same sidebar/modal links a real user clicks (ZYU-02) —
    // a page.goto() would do a full document load and reset pageDataCache's module state for free,
    // which would prove nothing about the bug.
    await page.getByRole("link", { name: "Agents", exact: true }).click();
    await page.getByRole("button", { name: /Zyra the Test Generator/ }).click();
    await page.getByRole("link", { name: /Agent workspace/ }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${tenant!.mainProjectId}/agents/zyra$`));

    const suitesPath = `/api/projects/${tenant!.mainProjectId}/suites`;
    await expect(page.getByText(draftTitle)).toBeVisible();
    // Set up the wait before clicking — the background refresh's request can land before the next
    // line would otherwise get a chance to start listening for it.
    const backgroundRefresh = page.waitForResponse(
      (res) => new URL(res.url()).pathname === suitesPath && res.request().method() === "GET",
    );
    await page.getByRole("button", { name: /Save 1 to repository/ }).click();
    await expect(page.getByText(/saved to the repository/)).toBeVisible();
    await expect
      .poll(
        () =>
          Number(
            scalar(
              `SELECT COUNT(*) FROM testcases t JOIN suites s ON s.id = t.suite_id ` +
                `WHERE t.project_id = ${literal(tenant!.mainProjectId)} AND s.name = 'Zyra generated test cases' AND t.title = ${literal(draftTitle)};`,
            ),
          ),
        { message: "the saved proposal must land in the default Zyra suite as a real test case" },
      )
      .toBe(1);
    // Confirms the background cache refresh's own suites fetch has completed — the cache is
    // provably holding fresh data now, before we ever navigate back to Test Cases.
    await backgroundRefresh;

    // Only now delay the Test Cases page's OWN mount-time fetch of the same endpoint — everything
    // above, including the background refresh just awaited, must stay fast and unaffected.
    await page.route(
      (url) => url.pathname === suitesPath,
      async (route) => {
        if (route.request().method() !== "GET") {
          await route.continue();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await route.continue();
      },
    );

    await page.getByRole("link", { name: "Test cases" }).click();

    // The very first paint after navigating back already has the background-refreshed cache to
    // seed from: no loading state at all, and the new suite/count are correct immediately — sourced
    // from that cache, not from the mount's own fetch, which is still artificially stuck mid-flight.
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.getByText("Zyra generated test cases")).toBeVisible();
    await expect(page.getByText(/1 test case across 1 suite/)).toBeVisible();
  });

  /**
   * Representative coverage for the same fix generalized beyond Test Cases: dashboard, reports
   * (overview + execFilters), requirements, agents/tasks, agents/zyra/settings, and the workspace
   * projects list all cache a test-case-derived count/summary the same way testcases/page.tsx did,
   * and are now refreshed by the same lib/zyraCacheSync.ts helper ZYU-80 already exercises end to
   * end. Every one of those pages goes through the identical generic patchPageCacheIfCached() —
   * the only per-page risk is a wrong cache key or field name, which type-checking alone would not
   * catch (a string literal typo still compiles). This pins that the dashboard's wiring — cache key
   * `dashboard:${projectId}`, field `summary.testCases.total`, endpoint `GET .../dashboard` — is
   * actually correct, the same way ZYU-80 pins it for testcases/page.tsx, rather than trusting the
   * other five pages' wiring by code review alone.
   */
  test("ZYU-81 saving via Zyra also refreshes the dashboard's Test cases stat, not just the Test Cases page", async ({
    browser,
  }) => {
    // Same locator convention as ui/project-dashboard.spec.ts's own statCard/statValue helpers:
    // filtered on containing a <p> as well as the label, since the sidebar's own "Test cases" nav
    // link is also an /projects/... link carrying the same words but has no <p> inside it.
    const testCasesCard = (p: Page) =>
      p.locator('a[href*="/projects/"]').filter({ has: p.locator("p") }).filter({ hasText: "Test cases" }).first();
    const cardValue = (card: Locator) => card.evaluate((el) => el.querySelector("p")?.textContent?.trim() ?? "");

    const page = await open(browser, "/dashboard");
    await expect(testCasesCard(page)).toBeVisible();
    expect(await cardValue(testCasesCard(page))).toBe("0");

    const draftTitle = stamp("Fresh from Zyra for dashboard");
    seedChatReviewBatch({
      entries: [{ opType: "create", draft: { suiteId: null, title: draftTitle, description: "", preconditions: "", stepsJson: "[]", priority: "P2" } }],
    });

    await page.getByRole("link", { name: "Agents", exact: true }).click();
    await page.getByRole("button", { name: /Zyra the Test Generator/ }).click();
    await page.getByRole("link", { name: /Agent workspace/ }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${tenant!.mainProjectId}/agents/zyra$`));

    const dashboardPath = `/api/projects/${tenant!.mainProjectId}/dashboard`;
    await expect(page.getByText(draftTitle)).toBeVisible();
    const backgroundRefresh = page.waitForResponse(
      (res) => new URL(res.url()).pathname === dashboardPath && res.request().method() === "GET",
    );
    await page.getByRole("button", { name: /Save 1 to repository/ }).click();
    await expect(page.getByText(/saved to the repository/)).toBeVisible();
    // Confirms the background cache refresh's own dashboard-summary fetch has completed — the
    // cache is provably holding the fresh count now, before navigating back to the dashboard.
    await backgroundRefresh;

    // Only now delay the dashboard page's OWN mount-time fetch of the same endpoint.
    await page.route(
      (url) => url.pathname === dashboardPath,
      async (route) => {
        if (route.request().method() !== "GET") {
          await route.continue();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await route.continue();
      },
    );

    // "Project home" is the sidebar link that reaches the dashboard — it's a client-side redirect
    // (app/(app)/projects/[id]/page.tsx does router.replace to .../dashboard), still client-side
    // navigation throughout, so pageDataCache's module state survives the hop.
    await page.getByRole("link", { name: "Project home" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${tenant!.mainProjectId}/dashboard$`));

    // Correct immediately, sourced from the background-refreshed cache — not from the mount's own
    // fetch, which is still artificially stuck mid-flight.
    expect(await cardValue(testCasesCard(page))).toBe("1");
  });

  /*
   * Frontend defense-in-depth for the reported bug ("8 flight booking test cases drafted and staged
   * for your review" with no table, no review panel) — added alongside the backend fix
   * (buildZyraChatDecision's router salvage-retry) so a FUTURE regression in that guard still can't
   * look like silent success in the UI. The backend fix means this exact shape (actionType
   * create/update/archive with zero testcases and no reviewRequestId) should no longer be reachable
   * through the live chat route at all — which is exactly why it has to be seeded directly rather
   * than driven through a real turn, the same rule seedChatReviewBatch()'s own header states.
   */
  test("ZYU-73 a mutation-routed reply with no testcases and no review batch shows the missing-data notice", async ({ browser }) => {
    exec(
      "INSERT INTO zyra_chat_sessions (project_id, user_id, title) VALUES " +
        `(${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'E2E missing structured data');`,
    );
    const sessionId = scalar(
      `SELECT id FROM zyra_chat_sessions WHERE project_id = ${literal(tenant!.mainProjectId)} ORDER BY created_at DESC LIMIT 1;`,
    );
    exec(
      "INSERT INTO zyra_chat_messages (session_id, project_id, user_id, role, content, status, action_type, testcases, activity) VALUES " +
        `(${literal(sessionId)}, ${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'assistant', ` +
        "'Here are 8 flight booking test cases drafted and staged for your review.', 'completed', 'create', '[]'::jsonb, '[]'::jsonb);",
    );
    exec(`UPDATE zyra_chat_sessions SET updated_at = now() WHERE id = ${literal(sessionId)};`);

    const page = await open(browser, "/agents/zyra");

    await expect(page.getByText("Here are 8 flight booking test cases drafted and staged for your review.")).toBeVisible();
    await expect(page.getByText(/didn.t return structured data for this reply/)).toBeVisible();
    // Neither the read-only table nor the review panel has anything to show for this message.
    await expect(page.getByRole("checkbox", { name: /Select proposed test case/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "View test cases" })).toHaveCount(0);
  });

  test("ZYU-74 an ordinary answer with no testcases shows no missing-data notice", async ({ browser }) => {
    exec(
      "INSERT INTO zyra_chat_sessions (project_id, user_id, title) VALUES " +
        `(${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'E2E ordinary answer');`,
    );
    const sessionId = scalar(
      `SELECT id FROM zyra_chat_sessions WHERE project_id = ${literal(tenant!.mainProjectId)} ORDER BY created_at DESC LIMIT 1;`,
    );
    exec(
      "INSERT INTO zyra_chat_messages (session_id, project_id, user_id, role, content, status, action_type, testcases, activity) VALUES " +
        `(${literal(sessionId)}, ${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'assistant', ` +
        "'There are 12 login test cases already covering this flow.', 'completed', 'answer', '[]'::jsonb, '[]'::jsonb);",
    );
    exec(`UPDATE zyra_chat_sessions SET updated_at = now() WHERE id = ${literal(sessionId)};`);

    const page = await open(browser, "/agents/zyra");

    await expect(page.getByText("There are 12 login test cases already covering this flow.")).toBeVisible();
    await expect(page.getByText(/didn.t return structured data for this reply/)).toHaveCount(0);
  });

  /*
   * Regression for a gap found by review, before this shipped: the missingStructuredData allow-list
   * only checked create/update/archive — "mixed" (reachable whenever the router's intent is
   * create/update/archive and the model itself reports actionType "mixed",
   * normalizeZyraChatDecision trusting that value as-is) hit the identical phantom-success shape
   * with no notice at all.
   */
  test("ZYU-75 a 'mixed' reply with no testcases and no review batch also shows the missing-data notice", async ({ browser }) => {
    exec(
      "INSERT INTO zyra_chat_sessions (project_id, user_id, title) VALUES " +
        `(${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'E2E mixed missing structured data');`,
    );
    const sessionId = scalar(
      `SELECT id FROM zyra_chat_sessions WHERE project_id = ${literal(tenant!.mainProjectId)} ORDER BY created_at DESC LIMIT 1;`,
    );
    exec(
      "INSERT INTO zyra_chat_messages (session_id, project_id, user_id, role, content, status, action_type, testcases, activity) VALUES " +
        `(${literal(sessionId)}, ${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'assistant', ` +
        "'Created 2 test cases and archived 1 outdated one.', 'completed', 'mixed', '[]'::jsonb, '[]'::jsonb);",
    );
    exec(`UPDATE zyra_chat_sessions SET updated_at = now() WHERE id = ${literal(sessionId)};`);

    const page = await open(browser, "/agents/zyra");

    await expect(page.getByText("Created 2 test cases and archived 1 outdated one.")).toBeVisible();
    await expect(page.getByText(/didn.t return structured data for this reply/)).toBeVisible();
  });

  // "suite" stays deliberately excluded — create_suite/move_to_suite write immediately, so a
  // suite-only turn legitimately has no testcases row to show, and must not show the notice.
  test("ZYU-76 a 'suite' reply with no testcases does not show the missing-data notice", async ({ browser }) => {
    exec(
      "INSERT INTO zyra_chat_sessions (project_id, user_id, title) VALUES " +
        `(${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'E2E suite no notice');`,
    );
    const sessionId = scalar(
      `SELECT id FROM zyra_chat_sessions WHERE project_id = ${literal(tenant!.mainProjectId)} ORDER BY created_at DESC LIMIT 1;`,
    );
    exec(
      "INSERT INTO zyra_chat_messages (session_id, project_id, user_id, role, content, status, action_type, testcases, activity) VALUES " +
        `(${literal(sessionId)}, ${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'assistant', ` +
        "'Created the Smoke Tests suite.', 'completed', 'suite', '[]'::jsonb, '[]'::jsonb);",
    );
    exec(`UPDATE zyra_chat_sessions SET updated_at = now() WHERE id = ${literal(sessionId)};`);

    const page = await open(browser, "/agents/zyra");

    await expect(page.getByText("Created the Smoke Tests suite.")).toBeVisible();
    await expect(page.getByText(/didn.t return structured data for this reply/)).toHaveCount(0);
  });

  // ─── Citation drawer (ZyraContextDrawer): Markdown rendering ───────────────
  //
  // Bug report: "Zyra Context shows raw Markdown formatting for Jira and Knowledge Base content".
  // A citation opened from ZyraCitationsList's "Context used (N)" list ("Context used" as seen in
  // the review panel above) is always a knowledge_document lookup — Jira/Linear tickets sync into
  // knowledge_documents as mirror rows (integration-sync.processor.ts), so there is only one
  // component in this path, KnowledgeDocumentDetail inside ZyraContextDrawer.tsx, and it is what
  // both the "JIRA" and "KNOWLEDGE BASE" chips in the bug screenshots open. Before the fix it
  // rendered `contentText` as a raw `<p className="whitespace-pre-wrap">` string; it now runs the
  // same `renderMarkdown` (lib/markdown.ts) already used for Zyra chat and the Sources tab
  // (ZYU-34..39 above cover that renderer's use there). The seeded content below mirrors exactly
  // what IntegrationSyncDocumentBuilder.buildMirror emits for a real Jira ticket (heading, a
  // `- **Label:** value` meta list, an `_italic_` placeholder, and a markdown link) — so this proves
  // both a native Knowledge Base document and a Jira-mirrored one render correctly, since they are
  // the same row shape and the same component.

  test("ZYU-77 the citation drawer renders a cited document's Markdown as formatted HTML, not raw symbols", async ({
    browser,
  }) => {
    const title = stamp("Citation markdown doc");
    const doc = await createKnowledgeDoc({
      title,
      contentText:
        `# ${title}\n\n- **Status:** Open\n- **Priority:** High\n\n` +
        "## Description\n\n_No description provided in the source ticket._\n\n" +
        "## Comments\n\n_No comments on the source ticket._\n\n" +
        "See [Open in Jira](https://example.atlassian.net/browse/KAN-9) for the source ticket.",
    });

    seedChatReviewBatch({
      entries: [
        {
          opType: "create",
          draft: { suiteId: null, title: "E2E citation drafted case", description: "", preconditions: "", stepsJson: "[]", priority: "P2" },
          sourceRefs: [{ type: "knowledge_document", id: doc.id, title }],
        },
      ],
    });

    const page = await open(browser, "/agents/zyra");
    const titleRe = new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

    await expect(page.getByText("E2E citation drafted case")).toBeVisible();
    await page.getByRole("button", { name: "Context used (1)" }).click();
    await page.getByRole("button", { name: titleRe }).click();

    const drawer = page.locator('div[role="presentation"]').last();
    await expect(drawer.getByRole("heading", { name: title, level: 1 })).toBeVisible();
    await expect(drawer.getByRole("heading", { name: "Description", level: 2 })).toBeVisible();
    await expect(drawer.getByRole("heading", { name: "Comments", level: 2 })).toBeVisible();
    await expect(drawer.locator("li", { hasText: "High" })).toBeVisible();
    await expect(drawer.locator("strong", { hasText: "Status:" })).toBeVisible();
    await expect(drawer.locator("em", { hasText: "No comments on the source ticket." })).toBeVisible();
    // Plain text with no markdown syntax renders unchanged.
    await expect(drawer.getByText("for the source ticket.", { exact: false })).toBeVisible();

    const link = drawer.getByRole("link", { name: "Open in Jira" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "https://example.atlassian.net/browse/KAN-9");
    await expect(link).toHaveAttribute("target", "_blank");

    // The raw markdown symbols must not appear anywhere as literal text.
    await expect(drawer.getByText(`# ${title}`, { exact: true })).toHaveCount(0);
    await expect(drawer.getByText("**Status:**", { exact: false })).toHaveCount(0);
    await expect(drawer.getByText("_No comments on the source ticket._", { exact: true })).toHaveCount(0);
    await expect(drawer.getByText("[Open in Jira](https://example.atlassian.net/browse/KAN-9)", { exact: false })).toHaveCount(0);
  });

  test("ZYU-78 the citation drawer escapes HTML-like content in a cited document instead of rendering or executing it", async ({
    browser,
  }) => {
    // Same safety guarantee ZYU-38 pins for the Sources tab's use of renderMarkdown — proven here
    // too because the drawer is a second, independent dangerouslySetInnerHTML call site.
    const marker = `xss-marker-${Date.now()}`;
    const title = stamp("Citation injection doc");
    const doc = await createKnowledgeDoc({
      title,
      contentText: `<img src=x onerror="window.__zyraDrawerXss='${marker}'">`,
    });

    seedChatReviewBatch({
      entries: [
        {
          opType: "create",
          draft: { suiteId: null, title: "E2E injection drafted case", description: "", preconditions: "", stepsJson: "[]", priority: "P2" },
          sourceRefs: [{ type: "knowledge_document", id: doc.id, title }],
        },
      ],
    });

    const page = await open(browser, "/agents/zyra");
    const titleRe = new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

    await expect(page.getByText("E2E injection drafted case")).toBeVisible();
    await page.getByRole("button", { name: "Context used (1)" }).click();
    await page.getByRole("button", { name: titleRe }).click();

    const drawer = page.locator('div[role="presentation"]').last();
    await expect(drawer.locator("img")).toHaveCount(0);
    const injected = await page.evaluate(() => (window as unknown as Record<string, unknown>).__zyraDrawerXss);
    expect(injected, "the markdown renderer escapes HTML before parsing, so this must never execute").toBeUndefined();
    await expect(drawer.getByText("<img", { exact: false })).toBeVisible();
  });

  test("ZYU-79 the citation drawer never lets a link's own URL text break out of its href attribute", async ({ browser }) => {
    /*
     * Regression: renderMarkdown's escaping (lib/markdown.ts) escaped `&`/`<`/`>` but not `"`, and
     * its own link markup interpolates the captured URL straight into a double-quoted href
     * attribute — so a cited document whose text contains a markdown link with a `"` inside the
     * URL (e.g. copy-pasted from a browser address bar mid-incident) could close that attribute
     * early and leave a bare, injected attribute (onmouseover=...) sitting on the rendered <a>
     * element. No space before the link's closing `)`, so the regex still matches and produces a
     * real <a href> either way — proving the fix has to be the escaping, not a malformed link.
     * Checked at the DOM level (via the browser's own HTML parser), not just string-matching the
     * markup, since that parser's quote-handling quirks are exactly what this vulnerability turns on.
     */
    const title = stamp("Citation link injection doc");
    const doc = await createKnowledgeDoc({
      title,
      contentText: 'See [details](https://example.com"onmouseover=alert(1)) for the source ticket.',
    });

    seedChatReviewBatch({
      entries: [
        {
          opType: "create",
          draft: { suiteId: null, title: "E2E link injection drafted case", description: "", preconditions: "", stepsJson: "[]", priority: "P2" },
          sourceRefs: [{ type: "knowledge_document", id: doc.id, title }],
        },
      ],
    });

    const page = await open(browser, "/agents/zyra");
    const titleRe = new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

    await expect(page.getByText("E2E link injection drafted case")).toBeVisible();
    await page.getByRole("button", { name: "Context used (1)" }).click();
    await page.getByRole("button", { name: titleRe }).click();

    const drawer = page.locator('div[role="presentation"]').last();
    const link = drawer.getByRole("link", { name: "details" });
    await expect(link).toBeVisible();

    const attrs = await link.evaluate((el) => ({
      href: el.getAttribute("href"),
      onmouseover: el.getAttribute("onmouseover"),
      attributeCount: el.attributes.length,
    }));
    // Pre-fix, the browser's own HTML parser closed href="..." at the raw `"` and attached this as
    // a second, genuine attribute on the element instead of leaving it inert inside href's value.
    expect(attrs.onmouseover, "no attribute must be injected via a broken-out href").toBeNull();
    // The whole malicious fragment lands inside href instead (decoded back through the &quot;
    // entity the fix produces) — inert data, never parsed as markup.
    expect(attrs.href).toContain('example.com"onmouseover=alert(1');
    // Exactly the three attributes renderMarkdown's own link markup sets: href, target, rel.
    expect(attrs.attributeCount).toBe(3);
  });

  // ─── Settings → AI Providers: the "Add workspace AI key" form ──────────────
  //
  // "Workspace AI key provider resets to default after deployment": nothing server-side rewrites a
  // stored provider, but the add form opened pre-set to OpenAI / gpt-4o on every page load. After a
  // deploy reloads the page, that read as the saved provider having reset — and since the form has
  // no edit mode, a remove-and-re-add that missed the field really did save openai. These pin that
  // the form starts unselected and that the saved provider survives a reload untouched.

  async function openAiProviders(browser: Browser): Promise<Page> {
    const ctx = await browser.newContext({ storageState: states.get("owner") });
    contexts.push(ctx);
    const page = await ctx.newPage();
    // The model list is fetched from the provider itself once a key is typed. Answer it locally so
    // these tests never send a (fake) key to a real provider.
    await page.route("**/api/workspace/ai-keys/models", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ models: [{ id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" }], source: "fallback", reason: "" }),
      }),
    );
    await page.goto("/settings?tab=ai");
    await expect(page.getByRole("heading", { name: "Workspace AI keys" })).toBeVisible();
    return page;
  }

  /** The add form. FieldLabel has no htmlFor, so its selects are told apart by an option they own. */
  function addKeyForm(page: Page) {
    const form = page.locator("form").filter({ has: page.getByRole("button", { name: /Add workspace AI key|Adding key/ }) });
    return {
      form,
      name: form.getByPlaceholder("Primary OpenAI key"),
      provider: form.locator("select").filter({ has: page.locator("option", { hasText: "Select a provider" }) }),
      apiKey: form.locator('input[type="password"]'),
      model: form.locator("select").filter({ has: page.locator("option", { hasText: "Enter a model name manually..." }) }),
      submit: form.getByRole("button", { name: /Add workspace AI key|Adding key/ }),
    };
  }

  /**
   * The saved-keys table row for `name`. Matched on an exact Name cell, not row text: the project
   * allocation table below lists every key as a "<name> (<provider>)" option, so a text filter hits
   * those rows too.
   */
  function keyRow(page: Page, name: string): Locator {
    return page.getByRole("row").filter({ has: page.getByRole("cell", { name, exact: true }) });
  }

  function storedProvider(name: string): string {
    return scalar(
      `SELECT provider FROM workspace_ai_keys WHERE organization_id = ${literal(tenant!.organizationId)} AND name = ${literal(name)};`,
    );
  }

  test("ZYU-104 with an Anthropic key saved, the add form opens unselected — not on OpenAI — and cannot submit a default", async ({ browser }) => {
    const name = stamp("anthropic key");
    const created = await api.post("/api/workspace/ai-keys", {
      data: { name, provider: "anthropic", apiKey: "sk-ant-e2e-not-a-real-key", defaultModel: "claude-sonnet-4-6" },
      failOnStatusCode: false,
    });
    expect(created.status(), `creating the key — ${await created.text()}`).toBe(201);

    const page = await openAiProviders(browser);
    const f = addKeyForm(page);

    // The saved key is shown as saved…
    await expect(keyRow(page, name)).toContainText("ANTHROPIC");
    // …and the add form does not claim a provider of its own.
    await expect(f.provider).toHaveValue("");
    await expect(f.provider.locator("option:checked")).toHaveText("Select a provider");

    // Name and key filled but no provider picked: there is no default left to fall back on.
    await f.name.fill(stamp("no provider"));
    await f.apiKey.fill("sk-e2e-not-a-real-key");
    await expect(f.submit).toBeDisabled();

    expect(storedProvider(name), "opening the page must not change the stored provider").toBe("anthropic");
  });

  test("ZYU-105 a key added as Anthropic through the form is stored as Anthropic and still shows so after a reload", async ({ browser }) => {
    const page = await openAiProviders(browser);
    const f = addKeyForm(page);
    const name = stamp("form key");

    await f.name.fill(name);
    await f.provider.selectOption("anthropic");
    await f.apiKey.fill("sk-ant-e2e-not-a-real-key");
    await f.model.selectOption("claude-sonnet-4-6");
    await f.submit.click();
    await expect(page.getByText("Workspace AI key added.")).toBeVisible();

    // Persisted state, via the API the screen itself reads.
    const list = await api.get("/api/workspace/ai-keys", { failOnStatusCode: false });
    expect(list.status()).toBe(200);
    const saved = ((await list.json()).keys as Array<{ name: string; provider: string; defaultModel: string | null }>).find((k) => k.name === name);
    expect(saved, "the key the form added").toBeTruthy();
    expect(saved!.provider).toBe("anthropic");
    expect(saved!.defaultModel).toBe("claude-sonnet-4-6");

    // A reload (what a deploy does to an open tab) shows the saved provider and an unselected form.
    await page.reload();
    await expect(keyRow(page, name)).toContainText("ANTHROPIC");
    await expect(addKeyForm(page).provider).toHaveValue("");
    expect(storedProvider(name)).toBe("anthropic");
  });

  test("ZYU-106 re-adding a saved key's name through the form is refused and leaves its provider as saved", async ({ browser }) => {
    const name = stamp("dup key");
    const created = await api.post("/api/workspace/ai-keys", {
      data: { name, provider: "anthropic", apiKey: "sk-ant-e2e-original-key", defaultModel: "claude-sonnet-4-6" },
      failOnStatusCode: false,
    });
    expect(created.status(), `creating the key — ${await created.text()}`).toBe(201);

    const page = await openAiProviders(browser);
    const f = addKeyForm(page);
    await f.name.fill(name);
    await f.provider.selectOption("openai");
    await f.apiKey.fill("sk-e2e-should-not-apply");
    await f.submit.click();

    await expect(page.getByText(/already exists/)).toBeVisible();
    await expect(keyRow(page, name)).toContainText("ANTHROPIC");
    expect(storedProvider(name), "the refused re-add must not overwrite the saved provider").toBe("anthropic");
  });
});

/*
 * Sending a real chat message through the page, against the fake provider (utils/fake-ai-server.ts).
 *
 * Regression coverage for "Failed to fetch (api-app-stage.tesbo.io)" with Knowledge Base access OFF.
 * The page used to hold one POST open for the whole turn; a generation turn runs for minutes, and
 * Cloudflare drops an origin request at 100 s with a CORS-less 524, so the browser reported a
 * network failure while the backend went on to save the reply. The page now starts the turn with
 * `background: true` (the POST returns as soon as the message is recorded) and polls the session
 * until its user message leaves `processing`. A 100-second cutoff is not reproducible here, so these
 * tests pin the property that removes it: the POST returns while the model is still answering.
 */
test.describe("zyra / chat send (UI, fake provider)", () => {
  let tenant: RbacTenant | null = null;
  let api: APIRequestContext;
  let ai: FakeAiServer;
  let ownerState = "";
  const contexts: BrowserContext[] = [];
  const composer = (page: Page) => page.getByPlaceholder("Ask Zyra to generate, update, or review test cases...");

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("zyra-ui-chat");
    if (!tenant) return;
    api = await loginAs(tenant.owner);
    ownerState = await writeStorageState(tenant.owner, "zyra-ui-chat-owner");
    ai = await startFakeAiServer();
  });

  test.afterAll(async () => {
    if (tenant) purge();
    await Promise.all(contexts.map((ctx) => ctx.close()));
    await api?.dispose();
    await ai?.close();
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
    if (tenant) purge();
    ai?.reset();
  });

  test.afterEach(() => {
    if (tenant) purge();
  });

  function purge(): void {
    const project = literal(tenant!.mainProjectId);
    exec(`DELETE FROM zyra_chat_messages WHERE project_id = ${project};`);
    exec(`DELETE FROM ai_generation_requests WHERE project_id = ${project};`);
    exec(`DELETE FROM zyra_chat_sessions WHERE project_id = ${project};`);
    exec(`DELETE FROM knowledge_documents WHERE project_id = ${project};`);
    exec(`DELETE FROM project_ai_key_allocations WHERE project_id = ${project};`);
    exec(`DELETE FROM workspace_ai_keys WHERE organization_id = ${literal(tenant!.organizationId)};`);
    exec(`UPDATE projects SET settings = COALESCE(settings, '{}'::jsonb) - 'zyraAgent' WHERE id = ${project};`);
  }

  async function allocateFakeAiKey(): Promise<void> {
    const keyRes = await api.post("/api/workspace/ai-keys", {
      data: { name: `E2E ui chat fake ai ${Date.now()}${Math.floor(Math.random() * 1000)}`, provider: "openai", apiKey: "sk-e2e-fake", baseUrl: ai.baseUrl, defaultModel: "gpt-4o-mini" },
      failOnStatusCode: false,
    });
    expect(keyRes.status(), `creating the fake-provider AI key — ${await keyRes.text()}`).toBe(201);
    const allocRes = await api.post("/api/workspace/ai-keys/allocations", {
      data: { projectId: tenant!.mainProjectId, workspaceAiKeyId: (await keyRes.json()).id },
      failOnStatusCode: false,
    });
    expect(allocRes.status(), `allocating the fake-provider key — ${await allocRes.text()}`).toBe(201);
  }

  async function setKnowledgeBaseAccess(enabled: boolean): Promise<void> {
    const res = await api.patch(`/api/projects/${tenant!.mainProjectId}/agents/zyra/settings`, {
      data: { capabilities: { knowledgeBase: enabled } },
      failOnStatusCode: false,
    });
    expect(res.status(), `saving the KB capability — ${await res.text()}`).toBeLessThan(300);
  }

  async function seedKbDoc(marker: string): Promise<void> {
    let folderId = scalar(`SELECT id FROM knowledge_folders WHERE project_id = ${literal(tenant!.mainProjectId)} AND is_root = true;`);
    if (!folderId) {
      exec(
        "INSERT INTO knowledge_folders (organization_id, project_id, parent_folder_id, name, is_root) " +
          `VALUES (${literal(tenant!.organizationId)}, ${literal(tenant!.mainProjectId)}, NULL, 'Knowledge base', true);`,
      );
      folderId = scalar(`SELECT id FROM knowledge_folders WHERE project_id = ${literal(tenant!.mainProjectId)} AND is_root = true;`);
    }
    const res = await api.post(`/api/projects/${tenant!.mainProjectId}/knowledge-base/documents`, {
      data: { folderId, documentType: "general", title: `${marker} seat policy`, contentText: `${marker}: a booking allows at most 10 seats.` },
      failOnStatusCode: false,
    });
    expect(res.status(), `seeding the KB doc — ${await res.text()}`).toBe(201);
  }

  // `locale` sets the browser language. Zyra must ignore it — its language comes from what is typed.
  async function openChat(browser: Browser, locale?: string): Promise<Page> {
    const ctx = await browser.newContext({ storageState: ownerState, ...(locale ? { locale } : {}) });
    contexts.push(ctx);
    const page = await ctx.newPage();
    await page.goto(`/projects/${tenant!.mainProjectId}/agents/zyra`);
    await expect(composer(page)).toBeEnabled();
    return page;
  }

  function isSendRequest(url: string, method: string): boolean {
    return method === "POST" && /\/agents\/zyra\/chat\/sessions\/[^/]+\/messages$/.test(new URL(url).pathname);
  }

  function queueAnswer(reply: string): void {
    ai.queueReply({ reply, reasoningSummary: "Answered directly.", action: "answer", actionType: "answer", operations: [], testcases: [] });
  }

  test("ZYU-100 with Knowledge Base access off, a message gets its reply — the send returns while Zyra is still answering", async ({ browser }) => {
    await allocateFakeAiKey();
    const marker = `Zorblax${Date.now() % 100000}`;
    await seedKbDoc(marker);
    await setKnowledgeBaseAccess(false);
    const page = await openChat(browser);
    const reply = `No knowledge-base access here, so I cannot confirm the ${marker} seat limit.`;
    // The model answers only after 6 s; the send must not wait for it.
    ai.delayNextReplyMs(6_000);
    queueAnswer(reply);

    const sendResponse = page.waitForResponse((res) => isSendRequest(res.url(), res.request().method()));
    await composer(page).fill(`How many seats can a ${marker} booking hold?`);
    await composer(page).press("Enter");
    const response = await sendResponse;
    expect(response.status()).toBe(201);
    expect(response.request().postDataJSON()).toMatchObject({ background: true });
    // The POST came back while the model was still holding its answer — the reply can't be here yet.
    expect(ai.requests.length, "the router call should still be in flight").toBeLessThanOrEqual(1);
    await expect(page.getByText(reply)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Thinking..." })).toBeVisible();

    await expect(page.getByText(reply)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Thinking..." })).toHaveCount(0);
    await expect(page.getByText(/Failed to fetch|could not reach the API|couldn't finish answering/)).toHaveCount(0);
    expect(JSON.stringify(ai.requests[0].messages), "the KB document reached the model with access off").not.toContain(`${marker}: a booking allows`);

    // Persisted, not just rendered: the turn is in the session with its user message settled.
    const sessionId = scalar(`SELECT session_id FROM zyra_chat_messages WHERE project_id = ${literal(tenant!.mainProjectId)} AND role = 'user' LIMIT 1;`);
    const session = await (await api.get(`/api/projects/${tenant!.mainProjectId}/agents/zyra/chat/sessions/${sessionId}`)).json();
    expect(session.messages.map((m: { role: string; status: string }) => [m.role, m.status])).toEqual([["user", "sent"], ["assistant", "completed"]]);
  });

  test("ZYU-101 with Knowledge Base access on, the reply still arrives and the model is shown the knowledge base", async ({ browser }) => {
    await allocateFakeAiKey();
    const marker = `Zorblax${Date.now() % 100000}`;
    await seedKbDoc(marker);
    const page = await openChat(browser);
    queueAnswer("A booking allows at most 10 seats.");

    await composer(page).fill(`How many seats can a ${marker} booking hold?`);
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("A booking allows at most 10 seats.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Failed to fetch|could not reach the API/)).toHaveCount(0);
    expect(JSON.stringify(ai.requests[0].messages)).toContain(`${marker}: a booking allows at most 10 seats.`);
  });

  test("ZYU-102 reloading mid-turn keeps waiting for the same turn and shows its reply, without sending it twice", async ({ browser }) => {
    await allocateFakeAiKey();
    const page = await openChat(browser);
    ai.delayNextReplyMs(6_000);
    queueAnswer("Answer that outlived a reload.");

    const sendResponse = page.waitForResponse((res) => isSendRequest(res.url(), res.request().method()));
    await composer(page).fill("How many test cases exist?");
    await composer(page).press("Enter");
    await sendResponse;
    await page.reload();

    // After the reload nothing local knows about the turn — only the server's `processing` status.
    // The message text also names the session (sidebar entry + chat header), so target the bubble.
    await expect(page.locator("div.whitespace-pre-wrap", { hasText: "How many test cases exist?" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Thinking..." })).toBeVisible();
    await expect(page.getByText("Answer that outlived a reload.")).toBeVisible({ timeout: 30_000 });
    await expect(composer(page)).toBeEnabled();
    expect(
      Number(scalar(`SELECT COUNT(*) FROM zyra_chat_messages WHERE project_id = ${literal(tenant!.mainProjectId)} AND role = 'user';`)),
      "the message was sent again after the reload",
    ).toBe(1);
  });

  test("ZYU-103 a send the server refuses shows the server's reason and drops the unsent message", async ({ browser }) => {
    await allocateFakeAiKey();
    const page = await openChat(browser);
    // A 409 is what the server answers while another turn in the session is still running.
    await page.route(
      (url) => /\/agents\/zyra\/chat\/sessions\/[^/]+\/messages$/.test(url.pathname),
      async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "Zyra is still working on your previous message in this session — wait for it to finish before sending another." }),
        });
      },
    );

    await composer(page).fill("A message that will be refused");
    await composer(page).press("Enter");

    await expect(page.getByText(/Zyra is still working on your previous message/)).toBeVisible();
    await expect(page.getByText("A message that will be refused")).toHaveCount(0);
    await expect(composer(page)).toBeEnabled();
    expect(ai.requests.length, "a refused send must never reach the model").toBe(0);
  });

  // ─── Request trace ────────────────────────────────────────────────────────
  // The trace is persisted on the request's own message (see zyra-turn-trace.ts), so the states a
  // live send can't reach on demand — a failed request, one whose process died, one running in
  // another tab — are arranged by writing that trace directly, in the exact shape the backend writes.

  function traceJson(outcome: string, steps: Array<{ stage: string; status: string; meta?: Record<string, unknown> }>): string {
    const at = new Date(Date.now() - 30_000).toISOString();
    return JSON.stringify({
      version: 1,
      outcome,
      startedAt: at,
      endedAt: outcome === "running" ? null : new Date().toISOString(),
      steps: steps.map((s) => ({ ...s, attempt: 1, startedAt: at, endedAt: s.status === "active" ? null : new Date().toISOString() })),
    });
  }

  function seedRequest(status: string, trace: string, opts: { claimed?: boolean } = {}): string {
    const t = tenant!;
    exec(`INSERT INTO zyra_chat_sessions (project_id, user_id, title) VALUES (${literal(t.mainProjectId)}, ${literal(t.owner.userId)}, 'E2E trace session');`);
    const sessionId = scalar(`SELECT id FROM zyra_chat_sessions WHERE project_id = ${literal(t.mainProjectId)} ORDER BY created_at DESC LIMIT 1;`);
    exec(
      "INSERT INTO zyra_chat_messages (session_id, project_id, user_id, role, content, status, trace) VALUES " +
        `(${literal(sessionId)}, ${literal(t.mainProjectId)}, ${literal(t.owner.userId)}, 'user', 'Seeded question', ${literal(status)}, ${literal(trace)}::jsonb);`,
    );
    if (opts.claimed) exec(`UPDATE zyra_chat_sessions SET processing_since = now() WHERE id = ${literal(sessionId)};`);
    return sessionId;
  }

  async function gotoChat(browser: Browser): Promise<Page> {
    const ctx = await browser.newContext({ storageState: ownerState });
    contexts.push(ctx);
    const page = await ctx.newPage();
    await page.goto(`/projects/${tenant!.mainProjectId}/agents/zyra`);
    return page;
  }

  test("ZYU-118 a send shows its live trace while it runs, then the finished trace under the reply — still there after a reload", async ({ browser }) => {
    await allocateFakeAiKey();
    // Held long enough to observe the decision step while it is running.
    ai.delayNextReplyMs(4_000);
    queueAnswer("There are no test cases yet.");
    const page = await openChat(browser);
    await composer(page).fill("How many test cases exist?");
    await composer(page).press("Enter");

    const running = page.locator('[data-zyra-trace="running"]');
    await expect(running.locator('[data-zyra-step="routing"][data-zyra-step-status="active"]')).toBeVisible({ timeout: 20_000 });
    await expect(running.getByText(/zyra · step \d+ · /)).toBeVisible();
    // No invented total: the old header claimed "turn 7/8" before knowing what the turn would need.
    await expect(running.getByText(/turn \d+\/\d+/)).toHaveCount(0);

    await expect(page.getByText("There are no test cases yet.")).toBeVisible({ timeout: 30_000 });
    const finished = page.locator('[data-zyra-trace="completed"]');
    await expect(finished).toBeVisible();
    await expect(finished.locator("summary")).toContainText("[DONE]");
    await finished.locator("summary").click();
    await expect(finished.locator('[data-zyra-step="context:knowledge"]')).toBeVisible();
    await expect(finished.locator('[data-zyra-step="routing"]')).toContainText("answer");
    // An answer never generates, so the trace must not claim it did.
    await expect(finished.locator('[data-zyra-step="generating"]')).toHaveCount(0);

    await page.reload();
    await expect(page.locator('[data-zyra-trace="completed"]')).toBeVisible();
  });

  test("ZYU-119 a request that failed before any reply shows its trace under the request, with the step that failed", async ({ browser }) => {
    seedRequest("failed", traceJson("failed", [
      { stage: "received", status: "ok" },
      { stage: "routing", status: "failed", meta: { status: "failed", reason: "This turn did not complete." } },
    ]));
    const page = await gotoChat(browser);
    const failed = page.locator('[data-zyra-trace="failed"]');
    await expect(failed.locator("summary")).toContainText("[FAILED]");
    await failed.locator("summary").click();
    const routing = failed.locator('[data-zyra-step="routing"]');
    await expect(routing).toContainText("[FAIL]");
    await expect(routing).toContainText("This turn did not complete.");
    await expect(composer(page)).toBeEnabled();
  });

  test("ZYU-120 a request left processing by a turn that died reads as interrupted, and the conversation is not locked", async ({ browser }) => {
    seedRequest("processing", traceJson("running", [
      { stage: "received", status: "ok" },
      { stage: "routing", status: "active", meta: { totalContextItems: 2 } },
    ]));
    const page = await gotoChat(browser);
    // Before the fix this row kept the composer disabled and the page polling, forever.
    await expect(composer(page)).toBeEnabled();
    const failed = page.locator('[data-zyra-trace="failed"]');
    await failed.locator("summary").click();
    await expect(failed.locator('[data-zyra-step="routing"]')).toContainText("interrupted");
  });

  test("ZYU-121 a request still running elsewhere (another tab, or before a reload) shows its steps so far from the persisted trace", async ({ browser }) => {
    seedRequest("processing", traceJson("running", [
      { stage: "received", status: "ok" },
      { stage: "context:jira", status: "empty", meta: { items: [], count: 0 } },
      { stage: "routing", status: "active", meta: { totalContextItems: 0 } },
    ]), { claimed: true });
    const page = await gotoChat(browser);
    const running = page.locator('[data-zyra-trace="running"]');
    await expect(running.getByText(/zyra · step 3 · /)).toBeVisible();
    await expect(running.locator('[data-zyra-step="routing"]')).toContainText("[RUN]");
    await expect(running.locator('[data-zyra-step="context:jira"]')).toContainText("none found");
    await expect(composer(page)).toBeDisabled();
  });

  /* ───────── Zyra's language follows what the user types (lib/zyra-i18n.ts, V132) ───────── */

  const RU_PLACEHOLDER = "Попросите Zyra создать, обновить или проверить тест-кейсы...";

  test("ZYU-L-01 after a Russian message the chat screen's own labels switch to Russian, and the reply is shown", async ({ browser }) => {
    await allocateFakeAiKey();
    // An English browser: the switch comes from the typed text, not from the browser.
    const page = await openChat(browser, "en-US");
    const reply = "Для входа нужны email и пароль; после трёх неудачных попыток вход блокируется.";
    queueAnswer(reply);

    await composer(page).fill("Как работает вход в систему?");
    await composer(page).press("Enter");
    await expect(page.getByText(reply)).toBeVisible({ timeout: 30_000 });

    // The composer, its send button and its keyboard hints are now Russian.
    await expect(page.getByPlaceholder(RU_PLACEHOLDER)).toBeVisible();
    await expect(page.getByRole("button", { name: "Отправить" })).toBeVisible();
    await expect(page.getByText("— отправить")).toBeVisible();
    await expect(composer(page), "the English placeholder is gone").toHaveCount(0);
    // And persisted: the session the page shows is stored as Russian.
    const sessionId = scalar(`SELECT session_id FROM zyra_chat_messages WHERE project_id = ${literal(tenant!.mainProjectId)} AND role = 'user' LIMIT 1;`);
    expect(scalar(`SELECT language FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`)).toBe("ru");
  });

  test("ZYU-L-02 a Russian browser typing English keeps the whole screen in English", async ({ browser }) => {
    await allocateFakeAiKey();
    const page = await openChat(browser, "ru-RU");
    const reply = "Sign-in needs an email and a password; three failed attempts lock the account.";
    queueAnswer(reply);

    await composer(page).fill("How does sign-in work?");
    await composer(page).press("Enter");
    await expect(page.getByText(reply)).toBeVisible({ timeout: 30_000 });
    await expect(composer(page)).toBeVisible();
    await expect(page.getByPlaceholder(RU_PLACEHOLDER)).toHaveCount(0);
  });

  test("ZYU-L-03 Russian test cases are shown under Russian column headers, and a later English message switches back", async ({ browser }) => {
    await allocateFakeAiKey();
    const page = await openChat(browser);
    const title = `Вход с неверным паролем отклонён ${Date.now() % 100000}`;
    ai.queueReply({ reply: "", reasoningSummary: "Создание.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: 1, exhaustive: false });
    ai.queueReply({
      drafts: [{
        title,
        preconditions: "Пользователь на странице входа.",
        stepsJson: JSON.stringify([{ stepNumber: 1, action: "Ввести неверный пароль", expectedResult: "Показана ошибка" }]),
        testData: "",
        expectedSummary: "Вход отклонён.",
        priority: "P1",
        severity: "High",
        tags: ["zyra"],
        sourceRefs: [],
      }],
    });
    ai.queueReply("Noted.");

    await composer(page).fill("Создай тест-кейс для неверного пароля на странице входа.");
    await composer(page).press("Enter");
    await expect(page.getByText(title).first()).toBeVisible({ timeout: 30_000 });
    // The backend's own reply text and the screen's labels around the drafts are Russian.
    await expect(page.getByText(/Я подготовил\(а\) 1 тест-кейс\(ов\), изучив:/)).toBeVisible();
    await expect(page.getByText("Первый шаг").first()).toBeVisible();
    await expect(page.getByText("Выбрать все").first()).toBeVisible();
    // The severity a draft carries is stored as High and displayed in Russian.
    await expect(page.getByText("Высокая").first()).toBeVisible();

    // Now an English message: the next reply and the labels go back to English.
    const english = "Sure — these cover the wrong-password path.";
    queueAnswer(english);
    await page.getByPlaceholder(RU_PLACEHOLDER).fill("Summarize what you just drafted for the login page, please.");
    await page.getByPlaceholder(RU_PLACEHOLDER).press("Enter");
    await expect(page.getByText(english)).toBeVisible({ timeout: 30_000 });
    await expect(composer(page)).toBeVisible();
  });
});
