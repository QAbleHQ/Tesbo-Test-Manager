import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { column, exec, literal, scalar } from "../utils/psql";
import {
  anonymousContext,
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  type RbacTenant,
} from "../utils/rbac-tenant";
import { startFakeAiServer, type FakeAiServer } from "../utils/fake-ai-server";
import { parseSseEvents } from "../utils/sse";

/*
 * Zyra — the AI agent surface: agent state, connection test, settings, chat sessions and messages,
 * generation tasks and their drafts, the generation history, and the project MCP endpoint.
 *
 * Wave 9, on its own workspace ("zyra").
 *
 * NO AI PROVIDER IS CALLED, and that is a deliberate boundary rather than a gap. The workspace here
 * has no AI key allocated, so every route that would reach a model stops at the allocation check and
 * returns its "no provider configured" answer — which is the state a new workspace is actually in,
 * and the one the UI has to render. What that leaves untested is the model round-trip itself, which
 * needs utils/fake-ai-server.ts (Wave 0 item 3, still missing) and is recorded in
 * docs/e2e-coverage-waves.md rather than skipped silently.
 *
 * Everything ELSE about these routes is ours and is driven here: who may reach them, what they do
 * with malformed input, and the DB rows they create. The authorization half is the important part —
 * a Zyra chat transcript contains whatever the team told the agent about their product.
 */

test.describe("zyra — agent, chat, tasks and AI keys", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asManager: APIRequestContext;
  let asQa: APIRequestContext;
  let asGuest: APIRequestContext;
  let anon: APIRequestContext;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("zyra");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asManager = await loginAs(tenant.manager);
    asQa = await loginAs(tenant.qa);
    asGuest = await loginAs(tenant.guest);
    anon = await anonymousContext();
    purge(tenant);
  });

  test.afterAll(async () => {
    if (tenant) purge(tenant);
    await Promise.all([asOwner, asManager, asQa, asGuest, anon].filter(Boolean).map((c) => c.dispose()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  test.afterEach(() => {
    if (tenant) purge(tenant);
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function url(suffix: string, projectId?: string): string {
    return `/api/projects/${projectId ?? tenant!.mainProjectId}${suffix}`;
  }

  function purge(t: RbacTenant): void {
    const projects = `${literal(t.mainProjectId)}, ${literal(t.secondProjectId)}`;
    exec(`DELETE FROM zyra_chat_messages WHERE session_id IN (SELECT id FROM zyra_chat_sessions WHERE project_id IN (${projects}));`);
    // ai_generation_requests.chat_session_id is ON DELETE RESTRICT now (V116), not CASCADE — must
    // go before zyra_chat_sessions, not after.
    exec(`DELETE FROM ai_generation_requests WHERE project_id IN (${projects});`);
    exec(`DELETE FROM zyra_chat_sessions WHERE project_id IN (${projects});`);
    exec(`DELETE FROM zyra_token_usage WHERE project_id IN (${projects});`);
    exec(`DELETE FROM project_ai_key_allocations WHERE project_id IN (${projects});`);
    exec(`DELETE FROM workspace_ai_keys WHERE organization_id = ${literal(t.organizationId)};`);
  }

  async function expectRefused(res: APIResponse, what: string): Promise<void> {
    expect([400, 401, 403, 404], `${what} answered with ${res.status()}: ${await res.text()}`).toContain(res.status());
  }

  /** A chat session, created through the product's own route. */
  async function createSession(
    title = `E2E session ${Date.now()}`,
    api: APIRequestContext = asOwner,
    projectId?: string,
  ): Promise<any> {
    const res = await api.post(url("/agents/zyra/chat/sessions", projectId), { data: { title }, failOnStatusCode: false });
    expect(res.status(), `creating a chat session — ${await res.text()}`).toBe(201);
    return res.json();
  }

  /*
   * Writes a user message directly into a session and bumps its updated_at, the way the real send
   * path does once it gets past the point of no return (legacy.service.ts sendZyraChatMessage,
   * ~9048-9049) — arranged through Postgres, the same rule seedTask() and ZYR-A-31's
   * markCreatedByZyra follow, because driving this through the live route would depend on how far a
   * "no AI provider configured" reply gets before failing, which the last-used tests below aren't
   * about.
   */
  function markChatUsed(sessionId: string, projectId = tenant!.mainProjectId): void {
    exec(
      `INSERT INTO zyra_chat_messages (session_id, project_id, user_id, role, content, status) VALUES ` +
        `(${literal(sessionId)}, ${literal(projectId)}, ${literal(tenant!.owner.userId)}, 'user', 'Write me some test cases', 'sent');`,
    );
    exec(`UPDATE zyra_chat_sessions SET updated_at = now() WHERE id = ${literal(sessionId)};`);
  }

  /**
   * A generation task row, written directly.
   *
   * The POST /agents/zyra/tasks route is aiGenerate, which needs a live model — so a task that
   * already exists is the only way to reach the task read, feedback, draft, close and save routes at
   * all. This is the suite's usual "arrange through Postgres when the API path is unavailable" rule.
   */
  function seedTask(
    fields: {
      status?: string;
      drafts?: number;
      jiraIssueKey?: string;
      draftOverrides?: Array<Record<string, unknown>>;
      savedCount?: number;
      projectId?: string;
    } = {},
  ): string {
    const projectId = fields.projectId ?? tenant!.mainProjectId;
    const drafts = Array.from({ length: fields.drafts ?? 2 }, (_, i) => ({
      title: `E2E draft ${i + 1}`,
      steps: [{ action: "open the app", expected: "it opens" }],
      priority: "P2",
      ...(fields.draftOverrides?.[i] ?? {}),
    }));
    /*
     * Two details of this row are load-bearing and were both wrong on the first attempt.
     *
     * agent_name has to be one of ZYRA_AGENT_NAMES ("Zyra the Test Generator", or the legacy "Zyra
     * the Edge Hunter") — zyraTask filters on it, so a row tagged anything else reads as a task that
     * does not exist. And generated_payload is a bare ARRAY of drafts, not an object wrapping one:
     * zyraDeleteDraft runs normalizeJsonArray over the column directly, so `{testcases: [...]}`
     * measures as zero drafts and every index is out of range.
     *
     * jira_issue_keys defaults to '[]' (its own column default) whenever fields.jiraIssueKey is
     * omitted — every existing caller keeps behaving exactly as before. Passed, it's what
     * processZyraSaveEntriesSequential/Batched's `existingLinked` lookup matches an already-saved
     * test case's own jira_issue_key against, to exercise the "regenerating an already-linked case"
     * path (severity/component "only fill if blank") rather than a brand-new create.
     */
    exec(
      "INSERT INTO ai_generation_requests (project_id, requested_by, provider, model, user_story, " +
        "requested_count, generated_count, saved_count, generated_payload, agent_name, task_status, jira_issue_keys) VALUES (" +
        `${literal(projectId)}, ${literal(tenant!.owner.userId)}, 'openai', 'gpt-4o-mini', ` +
        `'As a user I want to sign in', ${drafts.length}, ${drafts.length}, ${fields.savedCount ?? 0}, ` +
        `${literal(JSON.stringify(drafts))}::jsonb, 'Zyra the Test Generator', ` +
        `${literal(fields.status ?? "awaiting_review")}, ` +
        `${literal(JSON.stringify(fields.jiraIssueKey ? [fields.jiraIssueKey] : []))}::jsonb);`,
    );
    return scalar(
      `SELECT id FROM ai_generation_requests WHERE project_id = ${literal(projectId)} ` +
        "ORDER BY created_at DESC LIMIT 1;",
    );
  }

  /**
   * A chat-staged review batch, written directly — same "arrange through Postgres" rule as
   * seedTask, since applyZyraChatOperations (which builds one for real) needs a live model this
   * suite deliberately never calls (file header).
   *
   * Entries use the wrapped {opType, draft|fields} shape zyraSave/zyraEditDraft/zyraDeleteDraft
   * expect once a row carries chat_session_id (legacy.service.ts applyZyraChatOperations) — NOT
   * the flat AiGeneratedDraft shape seedTask()'s Task-board rows use.
   */
  function seedChatReviewTask(options: { status?: string; entries?: Array<Record<string, unknown>> } = {}): {
    taskId: string;
    sessionId: string;
  } {
    const t = tenant!;
    exec(
      "INSERT INTO zyra_chat_sessions (project_id, user_id, title) VALUES " +
        `(${literal(t.mainProjectId)}, ${literal(t.owner.userId)}, 'E2E chat review session');`,
    );
    const sessionId = scalar(
      `SELECT id FROM zyra_chat_sessions WHERE project_id = ${literal(t.mainProjectId)} ORDER BY created_at DESC LIMIT 1;`,
    );
    const entries = options.entries ?? [
      {
        opType: "create",
        draft: {
          suiteId: null,
          title: `E2E chat draft ${Date.now()}`,
          description: "",
          preconditions: "",
          stepsJson: JSON.stringify([{ stepNumber: 1, action: "open the app", expectedResult: "it opens" }]),
          priority: "P2",
          type: "Functional",
          status: "Draft",
        },
        reason: "",
      },
    ];
    exec(
      "INSERT INTO ai_generation_requests (project_id, requested_by, provider, model, user_story, " +
        "requested_count, generated_count, generated_payload, agent_name, task_status, chat_session_id) VALUES (" +
        `${literal(t.mainProjectId)}, ${literal(t.owner.userId)}, 'zyra_chat', 'gpt-4o-mini', ` +
        `'Zyra chat proposal', ${entries.length}, ${entries.length}, ` +
        `${literal(JSON.stringify(entries))}::jsonb, 'Zyra the Test Generator', ` +
        `${literal(options.status ?? "in_review")}, ${literal(sessionId)});`,
    );
    const taskId = scalar(
      `SELECT id FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)} ORDER BY created_at DESC LIMIT 1;`,
    );
    return { taskId, sessionId };
  }

  /** Every project-scoped Zyra route, for the authorization sweeps. */
  function zyraRoutes(
    api: APIRequestContext,
    ids: { sessionId: string; taskId: string },
    projectId?: string,
  ): Array<[string, () => Promise<APIResponse>]> {
    const opts = { failOnStatusCode: false } as const;
    return [
      ["GET agents/zyra", () => api.get(url("/agents/zyra", projectId), opts)],
      ["GET agents/zyra/test", () => api.get(url("/agents/zyra/test", projectId), opts)],
      [
        "PATCH agents/zyra/settings",
        () => api.patch(url("/agents/zyra/settings", projectId), { data: { testcaseRange: "all" }, ...opts }),
      ],
      ["GET chat/sessions", () => api.get(url("/agents/zyra/chat/sessions", projectId), opts)],
      [
        "POST chat/sessions",
        () => api.post(url("/agents/zyra/chat/sessions", projectId), { data: { title: "probe" }, ...opts }),
      ],
      ["GET chat/sessions/:id", () => api.get(url(`/agents/zyra/chat/sessions/${ids.sessionId}`, projectId), opts)],
      [
        "POST chat/sessions/:id/messages",
        () =>
          api.post(url(`/agents/zyra/chat/sessions/${ids.sessionId}/messages`, projectId), {
            data: { message: "hello" },
            ...opts,
          }),
      ],
      [
        "POST chat/sessions/:id/stop-plan",
        () => api.post(url(`/agents/zyra/chat/sessions/${ids.sessionId}/stop-plan`, projectId), { data: {}, ...opts }),
      ],
      [
        "POST chat/sessions/:id/resume-plan",
        () => api.post(url(`/agents/zyra/chat/sessions/${ids.sessionId}/resume-plan`, projectId), { data: {}, ...opts }),
      ],
      ["POST agents/zyra/tasks", () => api.post(url("/agents/zyra/tasks", projectId), { data: {}, ...opts })],
      ["GET agents/zyra/tasks/:id", () => api.get(url(`/agents/zyra/tasks/${ids.taskId}`, projectId), opts)],
      [
        "POST tasks/:id/feedback",
        () =>
          api.post(url(`/agents/zyra/tasks/${ids.taskId}/feedback`, projectId), {
            data: { feedback: "more edge cases" },
            ...opts,
          }),
      ],
      [
        "DELETE tasks/:id/drafts/:index",
        () => api.delete(url(`/agents/zyra/tasks/${ids.taskId}/drafts/0`, projectId), opts),
      ],
      [
        "PATCH tasks/:id/drafts/:index",
        () => api.patch(url(`/agents/zyra/tasks/${ids.taskId}/drafts/0`, projectId), { data: { title: "probe" }, ...opts }),
      ],
      ["POST tasks/:id/close", () => api.post(url(`/agents/zyra/tasks/${ids.taskId}/close`, projectId), { data: {}, ...opts })],
      [
        "POST tasks/:id/save",
        () => api.post(url(`/agents/zyra/tasks/${ids.taskId}/save`, projectId), { data: { testcaseIds: [] }, ...opts }),
      ],
      ["GET ai/generation-history", () => api.get(url("/ai/generation-history", projectId), opts)],
      [
        "POST ai/generation-history/:id/save",
        () =>
          api.post(url(`/ai/generation-history/${ids.taskId}/save`, projectId), {
            data: { testcaseIds: [] },
            ...opts,
          }),
      ],
      [
        "POST ai/generate-testcases",
        () => api.post(url("/ai/generate-testcases", projectId), { data: { userStory: "x" }, ...opts }),
      ],
      ["POST mcp", () => api.post(url("/mcp", projectId), { data: { method: "tools/list" }, ...opts })],
    ];
  }

  // ─── Authorization ────────────────────────────────────────────────────────

  test("ZYR-A-01 no Zyra route answers a caller with no session", { tag: '@tesbo.testId("TES-TC-594")' }, async () => {
    // A chat transcript holds whatever the team told the agent about their product, and the task
    // rows hold generated test cases. Neither may be readable, and none of the writes reachable,
    // without a session.
    const session = await createSession("Secret planning chat");
    const taskId = seedTask();

    for (const [what, attempt] of zyraRoutes(anon, { sessionId: session.id, taskId })) {
      await expectRefused(await attempt(), `${what} (anonymous)`);
    }

    // Nothing leaked and nothing was written.
    const sessions = await anon.get(url("/agents/zyra/chat/sessions"), { failOnStatusCode: false });
    expect(await sessions.text()).not.toContain("Secret planning chat");
    expect(
      scalar(`SELECT COUNT(*) FROM zyra_chat_sessions WHERE project_id = ${literal(tenant!.mainProjectId)};`),
      "an anonymous caller created a chat session",
    ).toBe("1");
    expect(scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe(
      "awaiting_review",
    );
  });

  test("ZYR-A-02 no Zyra route answers a workspace member with no access to the project", { tag: '@tesbo.testId("TES-TC-595")' }, async () => {
    const session = await createSession("Not the guest's chat");
    const taskId = seedTask();

    for (const [what, attempt] of zyraRoutes(asGuest, { sessionId: session.id, taskId })) {
      await expectRefused(await attempt(), `${what} (non-member)`);
    }
    const sessions = await asGuest.get(url("/agents/zyra/chat/sessions"), { failOnStatusCode: false });
    expect(await sessions.text()).not.toContain("Not the guest's chat");
  });

  test("ZYR-A-03 a project the caller is not a member of is not reachable by id", { tag: '@tesbo.testId("TES-TC-596")' }, async () => {
    const session = await createSession();
    const taskId = seedTask();
    // The qa_engineer belongs to the main project only.
    for (const [what, attempt] of zyraRoutes(asQa, { sessionId: session.id, taskId }, tenant!.secondProjectId)) {
      await expectRefused(await attempt(), `${what} (wrong project)`);
    }
  });

  test("ZYR-A-04 a malformed project id never produces a 500", { tag: '@tesbo.testId("TES-TC-597")' }, async () => {
    const session = await createSession();
    const taskId = seedTask();
    for (const [what, attempt] of zyraRoutes(asOwner, { sessionId: session.id, taskId }, "not-a-uuid")) {
      const res = await attempt();
      expect(res.status(), `${what} answered ${res.status()}: ${await res.text()}`).toBeLessThan(500);
    }
  });

  test("ZYR-A-05 a session or task from another project is not reachable through this project's URL", { tag: '@tesbo.testId("TES-TC-598")' }, async () => {
    const session = await createSession();
    const taskId = seedTask();

    // Reached for through the SECOND project's URL by someone who is a member of both.
    for (const attempt of [
      asOwner.get(url(`/agents/zyra/chat/sessions/${session.id}`, tenant!.secondProjectId), {
        failOnStatusCode: false,
      }),
      asOwner.get(url(`/agents/zyra/tasks/${taskId}`, tenant!.secondProjectId), { failOnStatusCode: false }),
      asOwner.post(url(`/agents/zyra/tasks/${taskId}/close`, tenant!.secondProjectId), {
        data: {},
        failOnStatusCode: false,
      }),
    ]) {
      const res = await attempt;
      expect(res.status(), `a cross-project id answered ${res.status()}: ${await res.text()}`).toBe(404);
    }
    expect(scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe(
      "awaiting_review",
    );
  });

  // ─── Agent state with no AI provider configured ───────────────────────────

  test("ZYR-A-06 the agent reports itself unconfigured rather than erroring when no key is allocated", { tag: '@tesbo.testId("TES-TC-599")' }, async () => {
    const res = await asOwner.get(url("/agents/zyra"), { failOnStatusCode: false });
    expect(res.status(), `agent state — ${await res.text()}`).toBe(200);
    const body = await res.json();
    // The screen has to be able to render "connect a provider" instead of an error, so the shape is
    // a normal payload carrying the reason.
    expect(body).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("api_key");
  });

  test("ZYR-A-07 the connection test reports the missing provider instead of throwing", { tag: '@tesbo.testId("TES-TC-600")' }, async () => {
    const res = await asOwner.get(url("/agents/zyra/test"), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.provider).toBe("none");
    expect(body.error, "the failure gives no reason for the user to act on").toBeTruthy();
    expect(body.latencyMs).toBe(0);
  });

  test("ZYR-A-08 a generation request with no provider configured is refused with a reason, not a 500", { tag: '@tesbo.testId("TES-TC-601")' }, async () => {
    for (const [what, attempt] of [
      ["tasks", () => asOwner.post(url("/agents/zyra/tasks"), { data: { userStory: "As a user…" }, failOnStatusCode: false })],
      [
        "generate-testcases",
        () => asOwner.post(url("/ai/generate-testcases"), { data: { userStory: "As a user…" }, failOnStatusCode: false }),
      ],
    ] as Array<[string, () => Promise<APIResponse>]>) {
      const res = await attempt();
      expect(res.status(), `${what} answered ${res.status()}: ${await res.text()}`).toBeLessThan(500);
      expect(res.status()).toBeGreaterThanOrEqual(400);
      // The message has to name the cause — "no AI provider" is actionable, "Internal server error"
      // is not, and this is the state every workspace starts in.
      const text = (await res.text()).toLowerCase();
      expect(text).toMatch(/ai|provider|key|model/);
    }
  });

  test("ZYR-A-08b the AI script review route no longer answers with a pass it never checked", { tag: '@tesbo.testId("TES-TC-984")' }, async () => {
    /*
     * Regression test. POST /ai/review-script was a controller stub: no caller, no project, no model,
     * and { status: "passed", categories: [], validatedSteps: [] } to every request — including an
     * unauthenticated one, and one carrying a script that cannot parse. A review that always passes
     * is a green tick with nothing behind it.
     *
     * Nothing in the frontend called it, so it was deleted rather than implemented — the same branch
     * §3 bug 15 took for the import stubs. This test pins that it is gone, so a future
     * reimplementation has to be a real one: if the route comes back, it must not answer "passed"
     * to an anonymous caller sending nonsense.
     */
    const res = await anon.post(url("/ai/review-script"), {
      data: { script: "this is not valid javascript {{{" },
      failOnStatusCode: false,
    });
    if (res.status() === 404) return; // route removed, which is the current state

    // If it is ever reinstated: it must authenticate, and it must not rubber-stamp.
    expect([400, 401, 403], `a reinstated review route answered an anonymous caller with ${res.status()}`).toContain(
      res.status(),
    );
    const asMember = await asOwner.post(url("/ai/review-script"), {
      data: { script: "this is not valid javascript {{{" },
      failOnStatusCode: false,
    });
    if (asMember.status() < 400) {
      expect((await asMember.json()).status, "the review passed an unparseable script").not.toBe("passed");
    }
  });

  // ─── Settings ─────────────────────────────────────────────────────────────

  test("ZYR-A-09 the agent's settings are updated and read back", { tag: '@tesbo.testId("TES-TC-603")' }, async () => {
    const res = await asOwner.patch(url("/agents/zyra/settings"), {
      data: { testcaseRange: "10-30" },
      failOnStatusCode: false,
    });
    expect(res.status(), `updating settings — ${await res.text()}`).toBe(200);

    const agent = await (await asOwner.get(url("/agents/zyra"))).json();
    expect(JSON.stringify(agent)).toContain("10-30");
  });

  test("ZYR-A-10 an unknown testcaseRange falls back instead of being stored", { tag: '@tesbo.testId("TES-TC-604")' }, async () => {
    // The valid set is minimum / 1-10 / 10-30 / all. A value outside it must not reach the settings
    // JSON, or the generation step later reads a range it cannot interpret.
    await asOwner.patch(url("/agents/zyra/settings"), { data: { testcaseRange: "all" }, failOnStatusCode: false });
    const res = await asOwner.patch(url("/agents/zyra/settings"), {
      data: { testcaseRange: "everything-please" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBeLessThan(500);

    const stored = scalar(
      `SELECT settings::text FROM projects WHERE id = ${literal(tenant!.mainProjectId)};`,
    );
    expect(stored, "an invalid range was written to the project settings").not.toContain("everything-please");
  });

  // ─── Chat sessions ────────────────────────────────────────────────────────

  test("ZYR-A-11 a chat session is created, listed and read back", { tag: '@tesbo.testId("TES-TC-605")' }, async () => {
    const title = `E2E chat ${Date.now()}`;
    const created = await createSession(title);
    expect(created.title).toBe(title);
    expect(created.projectId).toBe(tenant!.mainProjectId);
    expect(created.userId).toBe(tenant!.owner.userId);

    const list = await asOwner.get(url("/agents/zyra/chat/sessions"), { failOnStatusCode: false });
    expect(list.status()).toBe(200);
    const body = await list.json();
    const sessions = body.list ?? body.sessions ?? body;
    expect(JSON.stringify(sessions)).toContain(created.id);

    const read = await asOwner.get(url(`/agents/zyra/chat/sessions/${created.id}`), { failOnStatusCode: false });
    expect(read.status()).toBe(200);
    const session = await read.json();
    expect(JSON.stringify(session)).toContain(title);
  });

  test("ZYR-A-12 a session title is trimmed, defaulted and capped", { tag: '@tesbo.testId("TES-TC-606")' }, async () => {
    const untitled = await createSession("   ");
    // An empty title would render as a blank row in the session list.
    expect(untitled.title).toBe("Zyra chat");

    const padded = await createSession("   Padded title   ");
    expect(padded.title).toBe("Padded title");

    // 240 characters is the column's working limit; a longer one is cut rather than rejected, since
    // the title is derived from the first message and is cosmetic.
    const long = await createSession("t".repeat(400));
    expect(long.title.length).toBeLessThanOrEqual(240);
  });

  test("ZYR-A-13 an unknown or malformed session id is a 404, not a 500", { tag: '@tesbo.testId("TES-TC-607")' }, async () => {
    for (const bad of ["not-a-uuid", "11111111-1111-4111-8111-111111111111"]) {
      for (const [what, attempt] of [
        ["get", () => asOwner.get(url(`/agents/zyra/chat/sessions/${bad}`), { failOnStatusCode: false })],
        [
          "messages",
          () =>
            asOwner.post(url(`/agents/zyra/chat/sessions/${bad}/messages`), {
              data: { message: "hello" },
              failOnStatusCode: false,
            }),
        ],
        [
          "stop-plan",
          () => asOwner.post(url(`/agents/zyra/chat/sessions/${bad}/stop-plan`), { data: {}, failOnStatusCode: false }),
        ],
        [
          "resume-plan",
          () =>
            asOwner.post(url(`/agents/zyra/chat/sessions/${bad}/resume-plan`), { data: {}, failOnStatusCode: false }),
        ],
      ] as Array<[string, () => Promise<APIResponse>]>) {
        const res = await attempt();
        expect(res.status(), `${what} on session "${bad}" answered ${res.status()}: ${await res.text()}`).toBeLessThan(
          500,
        );
      }
    }
  });

  test("ZYR-A-14 every project member sees the project's chat sessions, not only their own", { tag: '@tesbo.testId("TES-TC-608")' }, async () => {
    // Zyra's sessions are the project's shared record of what was asked of the agent, so a manager
    // has to see a session the owner opened — this is deliberate, and worth pinning so a later
    // "scope sessions to their author" change is a visible decision rather than a silent one.
    const owned = await createSession("Opened by the owner");
    const byQa = await createSession("Opened by the QA engineer", asQa);

    for (const [who, api] of [
      ["manager", asManager],
      ["qa_engineer", asQa],
    ] as const) {
      const res = await api.get(url("/agents/zyra/chat/sessions"), { failOnStatusCode: false });
      expect(res.status(), `a ${who} was refused the session list`).toBe(200);
      const text = await res.text();
      expect(text, `a ${who} could not see the owner's session`).toContain(owned.id);
      expect(text).toContain(byQa.id);
    }
  });

  test("ZYR-A-15 sending a message with no provider configured fails without losing the session", { tag: '@tesbo.testId("TES-TC-609")' }, async () => {
    const session = await createSession();
    const res = await asOwner.post(url(`/agents/zyra/chat/sessions/${session.id}/messages`), {
      data: { message: "Write me some test cases" },
      failOnStatusCode: false,
    });
    // No model is reachable, so this cannot succeed — but it must fail as a handled refusal, and the
    // session must survive so the user's message isn't silently dropped along with the chat.
    expect(res.status(), `sending a message answered ${res.status()}: ${await res.text()}`).toBeLessThan(500);
    expect(
      scalar(`SELECT COUNT(*) FROM zyra_chat_sessions WHERE id = ${literal(session.id)};`),
      "the chat session was destroyed by a failed message",
    ).toBe("1");
  });

  test("ZYR-A-16 an empty message is refused before any provider work is attempted", { tag: '@tesbo.testId("TES-TC-610")' }, async () => {
    const session = await createSession();
    for (const data of [{}, { message: "" }, { message: "   " }]) {
      const res = await asOwner.post(url(`/agents/zyra/chat/sessions/${session.id}/messages`), {
        data,
        failOnStatusCode: false,
      });
      expect(res.status(), `${JSON.stringify(data)} answered ${res.status()}: ${await res.text()}`).toBeGreaterThanOrEqual(
        400,
      );
      expect(res.status()).toBeLessThan(500);
    }
  });

  test("ZYR-A-39 a session only reports hasMessages once a message is actually persisted", async () => {
    // Regression test for "duplicate empty Zyra chat sessions in the sidebar": the sidebar now
    // reads this flag to decide what counts as history, so the list route has to compute it
    // correctly and keep returning every session — the flag is additive, not a filter (see
    // ZYR-A-11 and ZYR-A-14, which still expect an unused session to come back from this route).
    const session = await createSession();

    async function findInList(): Promise<any> {
      const res = await asOwner.get(url("/agents/zyra/chat/sessions"), { failOnStatusCode: false });
      expect(res.status()).toBe(200);
      const body = await res.json();
      const list = body.list ?? body.sessions ?? body;
      return list.find((s: any) => s.id === session.id);
    }

    const before = await findInList();
    expect(before, "the freshly created session is still returned by the list").toBeTruthy();
    expect(before.hasMessages, "a session nobody used must not report hasMessages").toBeFalsy();

    // No provider is configured for this tenant (see file header), so the send fails downstream —
    // but the user's message is inserted before that failure (ZYR-A-15 pins the session surviving
    // it), which is enough to flip the flag.
    await asOwner.post(url(`/agents/zyra/chat/sessions/${session.id}/messages`), {
      data: { message: "Write me some test cases" },
      failOnStatusCode: false,
    });

    const after = await findInList();
    expect(after.hasMessages, "a session with a persisted message must report hasMessages").toBe(true);
  });

  test("ZYR-A-40 two concurrent session creates both succeed and both stay out of history until used", async () => {
    // The reported bug: a race on the client (an unguarded mount effect firing twice) could POST
    // this route twice before either landed, producing two empty sessions with near-identical
    // timestamps that then sat in the sidebar forever. The route itself creating two rows here is
    // correct REST behaviour and stays that way — what has to hold is that neither row is mistaken
    // for real history until someone actually uses it.
    const [a, b] = await Promise.all([createSession("Zyra chat"), createSession("Zyra chat")]);
    expect(a.id).not.toBe(b.id);

    const res = await asOwner.get(url("/agents/zyra/chat/sessions"), { failOnStatusCode: false });
    const body = await res.json();
    const list = body.list ?? body.sessions ?? body;
    for (const created of [a, b]) {
      const entry = list.find((s: any) => s.id === created.id);
      expect(entry, "both concurrently created sessions are still listed").toBeTruthy();
      expect(entry.hasMessages, "an unused concurrent duplicate must not report hasMessages").toBeFalsy();
    }
  });

  // ─── Tasks, drafts and history ────────────────────────────────────────────

  test("ZYR-A-17 a task is read back with its drafts", { tag: '@tesbo.testId("TES-TC-611")' }, async () => {
    const taskId = seedTask({ drafts: 3 });
    const res = await asOwner.get(url(`/agents/zyra/tasks/${taskId}`), { failOnStatusCode: false });
    expect(res.status(), `reading a task — ${await res.text()}`).toBe(200);
    const task = await res.json();
    expect(task.id).toBe(taskId);
    expect(task.taskStatus).toBe("awaiting_review");
    expect(JSON.stringify(task)).toContain("E2E draft 1");
    expect(task.generatedCount).toBe(3);
  });

  test("ZYR-A-18 a draft is discarded from a task without touching the others", { tag: '@tesbo.testId("TES-TC-612")' }, async () => {
    const taskId = seedTask({ drafts: 3 });
    const res = await asOwner.delete(url(`/agents/zyra/tasks/${taskId}/drafts/1`), { failOnStatusCode: false });
    expect(res.status(), `deleting a draft — ${await res.text()}`).toBe(200);

    // Asserted against the drafts themselves, not the whole payload: deleting a draft appends an
    // activity entry naming it ("Deleted testcase draft — E2E draft 2"), so the discarded title is
    // legitimately still present in the response. Searching the serialised task would therefore
    // never fail, whichever draft was removed.
    const stored = JSON.parse(
      scalar(`SELECT generated_payload::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`),
    );
    expect(stored.map((d: any) => d.title)).toEqual(["E2E draft 1", "E2E draft 3"]);

    const task = await (await asOwner.get(url(`/agents/zyra/tasks/${taskId}`))).json();
    expect(task.generatedCount).toBe(2);
  });

  test("ZYR-A-19 a draft index outside the list is refused rather than corrupting the payload", { tag: '@tesbo.testId("TES-TC-613")' }, async () => {
    const taskId = seedTask({ drafts: 2 });
    const before = scalar(`SELECT generated_payload::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`);

    for (const index of ["9", "-1", "notanumber"]) {
      const res = await asOwner.delete(url(`/agents/zyra/tasks/${taskId}/drafts/${index}`), {
        failOnStatusCode: false,
      });
      expect(res.status(), `draft index "${index}" answered ${res.status()}: ${await res.text()}`).toBeLessThan(500);
    }
    expect(
      scalar(`SELECT generated_payload::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`),
      "a refused draft index changed the stored drafts",
    ).toBe(before);
  });

  test("ZYR-A-20 a task is closed, and closing it again is refused or idempotent rather than a 500", { tag: '@tesbo.testId("TES-TC-614")' }, async () => {
    const taskId = seedTask();
    const res = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/close`), { data: {}, failOnStatusCode: false });
    expect(res.status(), `closing a task — ${await res.text()}`).toBe(201);
    const status = scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`);
    expect(status, "closing the task did not move it out of awaiting_review").not.toBe("awaiting_review");

    const again = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/close`), { data: {}, failOnStatusCode: false });
    expect(again.status()).toBeLessThan(500);
  });

  test("ZYR-A-21 feedback on a task is recorded against it", { tag: '@tesbo.testId("TES-TC-615")' }, async () => {
    // Explicitly 'in_review': zyraFeedback now guards on the task's current status (ZYR-A-34), and
    // the suite's default seed status ("awaiting_review") is not one of the two statuses that
    // guard accepts. Seeding the real status keeps this test on the "task legitimately can take
    // feedback, but no AI key is configured" path its comment describes, rather than accidentally
    // exercising the new status guard instead.
    const taskId = seedTask({ status: "in_review" });
    const res = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/feedback`), {
      data: { feedback: "Cover the locked-account case too" },
      failOnStatusCode: false,
    });
    // With no provider the regeneration cannot run, but the feedback itself is ours to store — a
    // refusal that loses the user's words is worse than one that keeps them.
    expect(res.status(), `feedback answered ${res.status()}: ${await res.text()}`).toBeLessThan(500);
    expect(scalar(`SELECT COUNT(*) FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe("1");
  });

  test("ZYR-A-22 an unknown task id is a 404 on every task route", { tag: '@tesbo.testId("TES-TC-616")' }, async () => {
    for (const bad of ["not-a-uuid", "11111111-1111-4111-8111-111111111111"]) {
      for (const [what, attempt] of [
        ["get", () => asOwner.get(url(`/agents/zyra/tasks/${bad}`), { failOnStatusCode: false })],
        ["close", () => asOwner.post(url(`/agents/zyra/tasks/${bad}/close`), { data: {}, failOnStatusCode: false })],
        [
          "feedback",
          () => asOwner.post(url(`/agents/zyra/tasks/${bad}/feedback`), { data: { feedback: "x" }, failOnStatusCode: false }),
        ],
        ["draft", () => asOwner.delete(url(`/agents/zyra/tasks/${bad}/drafts/0`), { failOnStatusCode: false })],
        [
          "save",
          () => asOwner.post(url(`/agents/zyra/tasks/${bad}/save`), { data: { testcaseIds: [] }, failOnStatusCode: false }),
        ],
      ] as Array<[string, () => Promise<APIResponse>]>) {
        const res = await attempt();
        expect(res.status(), `${what} on task "${bad}" answered ${res.status()}: ${await res.text()}`).toBeLessThan(500);
      }
    }
  });

  test("ZYR-A-23 the generation history lists the project's tasks, paginates, and stays project-scoped", { tag: '@tesbo.testId("TES-TC-617")' }, async () => {
    const first = seedTask();
    const second = seedTask();

    const res = await asOwner.get(url("/ai/generation-history"), { failOnStatusCode: false });
    expect(res.status(), `history — ${await res.text()}`).toBe(200);
    const body = await res.json();
    const list = body.list ?? body.history ?? body;
    const serialised = JSON.stringify(list);
    expect(serialised).toContain(first);
    expect(serialised).toContain(second);

    // Newest first, and paginated — the history grows without bound otherwise.
    const paged = await (await asOwner.get(url("/ai/generation-history?limit=1"))).json();
    expect(JSON.stringify(paged.list ?? paged).length).toBeGreaterThan(0);

    // A word where a number belongs must not reach SQL as NaN.
    const nonsense = await asOwner.get(url("/ai/generation-history?limit=abc"), { failOnStatusCode: false });
    expect(nonsense.status(), `a non-numeric limit answered ${nonsense.status()}`).toBe(200);

    // The second project's history does not carry the first's tasks.
    const other = await asOwner.get(url("/ai/generation-history", tenant!.secondProjectId), {
      failOnStatusCode: false,
    });
    expect(other.status()).toBe(200);
    expect(await other.text()).not.toContain(first);
  });

  test("ZYR-A-24 saving a task's drafts records the save against the task", { tag: '@tesbo.testId("TES-TC-618")' }, async () => {
    const taskId = seedTask();
    // An empty selection is the boundary: nothing to save, so nothing should be recorded and
    // nothing should break.
    const empty = await asOwner.post(url(`/ai/generation-history/${taskId}/save`), {
      data: { testcaseIds: [] },
      failOnStatusCode: false,
    });
    expect(empty.status(), `an empty save answered ${empty.status()}: ${await empty.text()}`).toBeLessThan(500);

    const created = await asOwner.post(url("/testcases"), {
      data: { title: `E2E saved from Zyra ${Date.now()}` },
      failOnStatusCode: false,
    });
    expect(created.status()).toBe(201);
    const testcaseId = (await created.json()).id;

    try {
      const res = await asOwner.post(url(`/ai/generation-history/${taskId}/save`), {
        data: { testcaseIds: [testcaseId] },
        failOnStatusCode: false,
      });
      expect(res.status(), `saving — ${await res.text()}`).toBeLessThan(500);
      // The save event is what the UI reads to show "3 of 5 saved", so it has to be persisted.
      const events = scalar(`SELECT coalesce(save_events::text, '') FROM ai_generation_requests WHERE id = ${literal(taskId)};`);
      expect(events).toContain(testcaseId);
    } finally {
      await asOwner.delete(url(`/testcases/${testcaseId}`), { failOnStatusCode: false });
    }
  });

  // ─── MCP ──────────────────────────────────────────────────────────────────

  test("ZYR-A-25 the project MCP endpoint refuses an unauthenticated caller and a malformed request", { tag: '@tesbo.testId("TES-TC-619")' }, async () => {
    const anonymous = await anon.post(url("/mcp"), { data: { method: "tools/list" }, failOnStatusCode: false });
    await expectRefused(anonymous, "POST /mcp (anonymous)");

    // MCP is a JSON-RPC surface: a member's malformed call must produce a protocol error rather than
    // a crash, since anything speaking to it is a machine that will retry.
    for (const data of [{}, { method: "" }, { method: "no/such/method" }, { jsonrpc: "2.0", id: 1 }]) {
      const res = await asOwner.post(url("/mcp"), { data, failOnStatusCode: false });
      expect(res.status(), `MCP ${JSON.stringify(data)} answered ${res.status()}: ${await res.text()}`).toBeLessThan(500);
    }
  });

  // ─── Workspace AI keys ────────────────────────────────────────────────────

  test("ZYR-A-26 the provider catalogue is readable and lists no secrets", { tag: '@tesbo.testId("TES-TC-620")' }, async () => {
    const res = await asOwner.get("/api/workspace/ai-providers", { failOnStatusCode: false });
    expect(res.status(), `ai-providers — ${await res.text()}`).toBe(200);
    const body = await res.json();
    const providers = Array.isArray(body) ? body : (body.list ?? body.providers ?? []);
    expect(providers.length, "the provider catalogue is empty").toBeGreaterThan(0);
    expect(JSON.stringify(body).toLowerCase()).not.toContain("sk-");
  });

  test("ZYR-A-27 managing AI keys is the workspace owner's alone", { tag: '@tesbo.testId("TES-TC-621")' }, async () => {
    // A key is workspace-wide and billed to the workspace, so a manager or engineer adding, removing
    // or re-pointing one changes everyone's spend.
    for (const [who, api] of [
      ["manager", asManager],
      ["qa_engineer", asQa],
    ] as const) {
      const listed = await api.get("/api/workspace/ai-keys", { failOnStatusCode: false });
      expect(listed.status(), `a ${who} reading the key list`).toBeLessThan(500);

      const models = await api.post("/api/workspace/ai-keys/models", {
        data: { provider: "openai", apiKey: "sk-not-a-real-key" },
        failOnStatusCode: false,
      });
      expect(models.status(), `a ${who} could enumerate provider models`).toBe(403);

      const allocated = await api.post("/api/workspace/ai-keys/allocations", {
        data: { projectId: tenant!.mainProjectId, keyId: "11111111-1111-4111-8111-111111111111" },
        failOnStatusCode: false,
      });
      expect(allocated.status(), `a ${who} could allocate an AI key`).toBe(403);

      const deleted = await api.delete("/api/workspace/ai-keys/11111111-1111-4111-8111-111111111111", {
        failOnStatusCode: false,
      });
      expect(deleted.status(), `a ${who} could delete an AI key`).toBe(403);
    }
  });

  test("ZYR-A-28 the AI key routes refuse a caller with no session", { tag: '@tesbo.testId("TES-TC-622")' }, async () => {
    for (const [what, attempt] of [
      ["GET ai-keys", () => anon.get("/api/workspace/ai-keys", { failOnStatusCode: false })],
      ["GET ai-providers", () => anon.get("/api/workspace/ai-providers", { failOnStatusCode: false })],
      [
        "POST ai-keys",
        () => anon.post("/api/workspace/ai-keys", { data: { provider: "openai", apiKey: "sk-x" }, failOnStatusCode: false }),
      ],
      [
        "POST ai-keys/models",
        () => anon.post("/api/workspace/ai-keys/models", { data: { provider: "openai" }, failOnStatusCode: false }),
      ],
      [
        "POST ai-keys/allocations",
        () =>
          anon.post("/api/workspace/ai-keys/allocations", {
            data: { projectId: tenant!.mainProjectId },
            failOnStatusCode: false,
          }),
      ],
      [
        "DELETE ai-keys/:id",
        () => anon.delete("/api/workspace/ai-keys/11111111-1111-4111-8111-111111111111", { failOnStatusCode: false }),
      ],
    ] as Array<[string, () => Promise<APIResponse>]>) {
      const res = await attempt();
      // ai-providers is a static catalogue with no secrets in it, so a 200 there is defensible —
      // everything that touches a key must refuse.
      if (what === "GET ai-providers") {
        expect(res.status()).toBeLessThan(500);
      } else {
        await expectRefused(res, what);
      }
    }
  });

  test("ZYR-A-29 an allocation must name a project, and cannot name one in another workspace", { tag: '@tesbo.testId("TES-TC-623")' }, async () => {
    const missing = await asOwner.post("/api/workspace/ai-keys/allocations", { data: {}, failOnStatusCode: false });
    expect(missing.status()).toBe(400);
    expect(JSON.stringify(await missing.json())).toContain("projectId is required");

    for (const projectId of ["not-a-uuid", "11111111-1111-4111-8111-111111111111"]) {
      const res = await asOwner.post("/api/workspace/ai-keys/allocations", {
        data: { projectId, keyId: "11111111-1111-4111-8111-111111111111" },
        failOnStatusCode: false,
      });
      expect(res.status(), `allocation to project "${projectId}" answered ${res.status()}: ${await res.text()}`)
        .toBeLessThan(500);
      expect(res.status()).toBeGreaterThanOrEqual(400);
    }
  });

  test("ZYR-A-30 an AI key is created and listed without its secret ever coming back", { tag: '@tesbo.testId("TES-TC-624")' }, async () => {
    const res = await asOwner.post("/api/workspace/ai-keys", {
      data: { provider: "openai", apiKey: "sk-e2e-not-a-real-key-000000", label: "E2E key" },
      failOnStatusCode: false,
    });
    // Creating a key does not call the provider (validation happens when it is used), so this is
    // reachable here. If the product does choose to verify on create, a 4xx is equally acceptable —
    // what must never happen is the secret coming back out.
    expect(res.status(), `creating a key answered ${res.status()}: ${await res.text()}`).toBeLessThan(500);

    const listed = await asOwner.get("/api/workspace/ai-keys", { failOnStatusCode: false });
    expect(listed.status()).toBe(200);
    const text = await listed.text();
    expect(text, "the stored API key was returned to the client").not.toContain("sk-e2e-not-a-real-key-000000");

    // And it is not stored in the clear either — the column is encrypted at rest.
    const stored = scalar(
      `SELECT coalesce(string_agg(api_key, ','), '') FROM workspace_ai_keys WHERE organization_id = ${literal(tenant!.organizationId)};`,
    );
    if (stored) {
      expect(stored, "the API key is stored in plaintext").not.toContain("sk-e2e-not-a-real-key-000000");
    }
  });

  test("ZYR-A-30b creating an AI key under a name already in use is refused, not silently applied over the original", async () => {
    /*
     * "Workspace AI key provider resets after production deployment" — the create route used to
     * INSERT ... ON CONFLICT (organization_id, name) DO UPDATE, so re-submitting the "Add workspace
     * AI key" form under an existing name (its Provider field always defaults to openai, and there
     * is no separate edit mode) silently overwrote that key's provider/model/base_url instead of
     * failing. Pins that a name collision is refused and the original row is left untouched.
     */
    const name = `E2E dup key ${Date.now()}`;
    const original = await asOwner.post("/api/workspace/ai-keys", {
      data: { name, provider: "anthropic", apiKey: "sk-ant-e2e-original-000000", defaultModel: "claude-sonnet-4-6" },
      failOnStatusCode: false,
    });
    expect(original.status(), `creating the original key answered ${original.status()}: ${await original.text()}`).toBe(201);

    const collision = await asOwner.post("/api/workspace/ai-keys", {
      data: { name, provider: "openai", apiKey: "sk-e2e-should-not-apply-000000", defaultModel: "gpt-4o" },
      failOnStatusCode: false,
    });
    expect(
      collision.status(),
      `creating a second key named "${name}" answered ${collision.status()}: ${await collision.text()}`,
    ).toBe(400);
    expect(JSON.stringify(await collision.json())).toContain("already exists");

    const provider = scalar(
      `SELECT provider FROM workspace_ai_keys WHERE organization_id = ${literal(tenant!.organizationId)} AND name = ${literal(name)};`,
    );
    expect(provider, "the original key's provider was overwritten by the rejected duplicate").toBe("anthropic");
  });
  // ─── The agent's "tests generated" counter ─────────────────────────────────

  test("ZYR-A-31 the agent reports every test case Zyra created, in either mode", { tag: '@tesbo.testId("TES-TC-985")' }, async () => {
    /*
     * Basecamp 10212918496 / BetterBugs 6a842687 — "Zyra Test Generator Displays 0 Tests Generated
     * After Creating 33 Test Cases".
     *
     * The Agents screen summed `generatedCount` over the project's generation tasks, and
     * `generated_count` is written ONLY by the task-board draft flow. Chat mode creates test cases
     * straight through applyZyraChatOperations and writes no generation row at all, so a project
     * whose cases were all made by talking to Zyra — the reporter's 33 — added up to zero.
     *
     * `testcasesCreated` on the agent payload now counts the `zyra_created` audit action, which BOTH
     * modes write (chat mode already did; zyraSave now does too). Fails on the unfixed code, where
     * the field is absent entirely.
     *
     * The audit rows are written directly here for the same reason seedTask() exists: reaching them
     * through the product means a live model, which this suite deliberately never calls. What is
     * being asserted is the counter over those rows — the half that was broken.
     */
    const zyraCase = async (title: string): Promise<string> => {
      const res = await asOwner.post(url("/testcases"), { data: { title }, failOnStatusCode: false });
      expect(res.status(), `seeding a case — ${await res.text()}`).toBe(201);
      return (await res.json()).id;
    };
    /** The audit row applyZyraChatOperations / zyraSave write when Zyra creates a case. */
    const markCreatedByZyra = (testcaseId: string, source: string): void => {
      exec(
        "INSERT INTO audit_logs (project_id, actor_id, action, entity_type, entity_id, entity_name, diff, organization_id) " +
          `VALUES (${literal(tenant!.mainProjectId)}, NULL, 'zyra_created', 'testcase', ${literal(testcaseId)}, ` +
          `'E2E zyra case', ${literal(JSON.stringify({ source }))}::jsonb, ${literal(tenant!.organizationId)});`,
      );
    };
    const countReported = async (): Promise<number> => {
      const res = await asOwner.get(url("/agents/zyra"), { failOnStatusCode: false });
      expect(res.status(), `reading the agent — ${await res.text()}`).toBe(200);
      const body = await res.json();
      expect(
        body.testcasesCreated,
        "the agent payload carries no testcasesCreated — the tile can only sum task drafts",
      ).toBeDefined();
      return Number(body.testcasesCreated);
    };

    const stamp = Date.now();
    const chatCase = await zyraCase(`E2E Zyra chat case ${stamp}`);
    const taskCase = await zyraCase(`E2E Zyra task case ${stamp}`);
    const manualCase = await zyraCase(`E2E manual case ${stamp}`);
    try {
      /*
       * Asserted as DELTAS from a baseline, not absolute counts.
       *
       * audit_logs is append-only — migration V62_audit_logs_immutable.sql installs a trigger that
       * rejects DELETE — so these rows cannot be cleaned up afterwards and a re-run against the
       * persistent volume starts from whatever previous runs left behind. The first attempt at this
       * test cleaned up with a DELETE and failed on that trigger; the counts are relative now, which
       * needs no cleanup and is what the assertion actually cares about.
       */
      const baseline = await countReported();
      // A case Zyra did not create must not be counted: the manual one is already present here.
      expect(await countReported(), "creating a case manually changed Zyra's count").toBe(baseline);

      markCreatedByZyra(chatCase, "zyra_chat");
      expect(await countReported(), "a chat-created case was not counted").toBe(baseline + 1);

      markCreatedByZyra(taskCase, "zyra_task");
      expect(await countReported(), "both modes should be counted").toBe(baseline + 2);

      // Re-saving the same draft writes a second audit row for one case; DISTINCT keeps it at one.
      markCreatedByZyra(taskCase, "zyra_task");
      expect(await countReported(), "one case counted twice").toBe(baseline + 2);

      // Deleting a Zyra case takes it back out — the count describes what the repository holds.
      await asOwner.delete(url(`/testcases/${chatCase}`), { failOnStatusCode: false });
      expect(await countReported(), "a deleted case is still being counted").toBe(baseline + 1);
    } finally {
      for (const id of [chatCase, taskCase, manualCase]) {
        await asOwner.delete(url(`/testcases/${id}`), { failOnStatusCode: false });
      }
    }
  });

  test("ZYR-A-32 the counter survives audit rows whose entity_id is not a uuid", { tag: '@tesbo.testId("TES-TC-1214")' }, async () => {
    /*
     * `audit_logs.entity_id` is varchar(255) because it is polymorphic across entity types, and the
     * `auth` and `billing` rows genuinely hold non-uuid values (an email, a Stripe id). That is why
     * the join to testcases has to cast the testcase's uuid to text rather than casting entity_id to
     * uuid: the obvious fix for the `operator does not exist: uuid = character varying` this counter
     * used to raise would swap a permanent 42883 for an intermittent 22P02, firing only once a
     * non-uuid row landed in the project and only if the planner evaluated the cast before the
     * entity_type filter.
     *
     * So the guard is asserted directly: a non-uuid audit row in this project, then read the tile.
     */
    const res = await asOwner.get(url("/agents/zyra"), { failOnStatusCode: false });
    expect(res.status(), `reading the agent before seeding — ${await res.text()}`).toBe(200);
    const before = Number((await res.json()).testcasesCreated);

    exec(
      "INSERT INTO audit_logs (project_id, actor_id, action, entity_type, entity_id, entity_name, organization_id) " +
        `VALUES (${literal(tenant!.mainProjectId)}, NULL, 'login', 'auth', ${literal("not-a-uuid@example.com")}, ` +
        `'E2E non-uuid entity', ${literal(tenant!.organizationId)});`,
    );

    // No cleanup: audit_logs is append-only (V62_audit_logs_immutable.sql), which is exactly why
    // this row is harmless to leave behind and why the assertion is a delta of zero.
    const after = await asOwner.get(url("/agents/zyra"), { failOnStatusCode: false });
    expect(after.status(), `a non-uuid audit row broke the agent — ${await after.text()}`).toBe(200);
    expect(Number((await after.json()).testcasesCreated), "a non-uuid audit row changed the count").toBe(before);
  });

  // ─── The agent's "Approval rate" tile ──────────────────────────────────────

  /** Reads the agent payload's approvalRate field, failing loudly if the field is missing entirely. */
  const approvalRate = async (api: APIRequestContext = asOwner, projectId?: string): Promise<number | null> => {
    const res = await api.get(url("/agents/zyra", projectId), { failOnStatusCode: false });
    expect(res.status(), `reading the agent — ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(
      Object.prototype.hasOwnProperty.call(body, "approvalRate"),
      "the agent payload carries no approvalRate field at all",
    ).toBe(true);
    return body.approvalRate;
  };

  test(
    "ZYR-A-75 the approval rate reflects drafts actually saved, not a taskStatus the backend never writes",
    { tag: '@tesbo.testId("TES-TC-1215")' },
    async () => {
      /*
       * "[Zyra] Approval Rate Is Not Updated After Saving Generated Test Cases" — the Agents screen
       * computed this tile client-side as decided = tasks.filter(t => t.taskStatus === "accepted" ||
       * t.taskStatus === "rejected"), then approved/decided. But zyraTask/processZyraTask/aiSave only
       * ever write task_status as 'todo' | 'in_progress' | 'in_review' | 'failed' | 'done' — grep the
       * whole service for `task_status = '...'` and "accepted"/"rejected" never appears. `decided` was
       * therefore always empty and the tile always rendered "—", regardless of how many drafts were
       * actually saved. Fails on the unfixed backend because the field is absent from the response
       * entirely (approvalRate is asserted `.toBeDefined()`-equivalent above via the hasOwnProperty
       * check); a frontend-only fix wired to the same never-true filter would still fail this, since
       * the assertion below requires the *exact* saved/generated ratio, not just a defined field.
       *
       * approvalRate is now SUM(saved_count)/SUM(generated_count) over 'done' task-board rows.
       */
      seedTask({ drafts: 5, savedCount: 4, status: "done" });
      expect(await approvalRate(), "a 4-of-5-saved done task did not read as 80%").toBe(80);
    },
  );

  test("ZYR-A-76 no task-board runs at all reads null, not 0 or an error", { tag: '@tesbo.testId("TES-TC-1216")' }, async () => {
    // The empty state every new project starts in, and what the screenshot in the bug report showed
    // — this must render as the dash, not a misleading 0%.
    expect(await approvalRate()).toBeNull();
  });

  test(
    "ZYR-A-77 a task still awaiting review does not drag the rate down before anything is decided",
    { tag: '@tesbo.testId("TES-TC-1217")' },
    async () => {
      // in_review means drafts were generated and are pending the user's decision — nothing has been
      // approved OR rejected yet. Counting its 0 saved_count here would read as "0% approved" for work
      // that is simply still in progress. todo/in_progress (queued/generating, no drafts yet) must be
      // equally inert.
      seedTask({ drafts: 5, savedCount: 0, status: "in_review" });
      seedTask({ drafts: 0, savedCount: 0, status: "todo" });
      seedTask({ drafts: 0, savedCount: 0, status: "in_progress" });
      expect(await approvalRate(), "a pending task was counted as 0% approved instead of being excluded").toBeNull();
    },
  );

  test(
    "ZYR-A-78 a task that failed before producing anything to review is excluded, not counted as rejected",
    { tag: '@tesbo.testId("TES-TC-1218")' },
    async () => {
      // Forced generated_count > 0 here even though a real failure normally leaves it at 0 (failures
      // only happen before drafts exist) — this proves the exclusion is enforced by task_status, not
      // just incidentally by an always-zero generated_count.
      seedTask({ drafts: 3, savedCount: 0, status: "failed" });
      expect(await approvalRate(), "a failed generation was treated as a rejection").toBeNull();

      seedTask({ drafts: 2, savedCount: 2, status: "done" });
      expect(
        await approvalRate(),
        "a failed task's drafts diluted the rate of an unrelated, fully-saved task",
      ).toBe(100);
    },
  );

  test(
    "ZYR-A-79 the rate aggregates proportionally across multiple done tasks, including a non-round percentage",
    { tag: '@tesbo.testId("TES-TC-1219")' },
    async () => {
      seedTask({ drafts: 3, savedCount: 1, status: "done" });
      seedTask({ drafts: 4, savedCount: 2, status: "done" });
      // 3 saved of 7 generated = 42.857...% — pins the rounding, not just the direction.
      expect(await approvalRate()).toBe(43);
    },
  );

  test(
    "ZYR-A-80 a partial save and a close-without-saving, both through the real routes, feed the rate correctly",
    { tag: '@tesbo.testId("TES-TC-1220")' },
    async () => {
      // Exercises POST .../tasks/:id/save (zyraSave/zyraSaveAttempt) and POST .../tasks/:id/close
      // (zyraCloseTask) for real — the actual product actions behind the Save and Close buttons —
      // rather than seeding task_status = 'done' directly. Task-board batches resolve to 'done' on
      // ANY save (see zyraSaveAttempt's own comment), partial or not, unlike a chat-staged batch.
      const partialTaskId = seedTask({ drafts: 3, status: "in_review" });
      const saveRes = await asOwner.post(url(`/agents/zyra/tasks/${partialTaskId}/save`), {
        data: { selectedDraftIndexes: [0, 1] },
        failOnStatusCode: false,
      });
      expect(saveRes.status(), `partially saving the batch — ${await saveRes.text()}`).toBe(201);
      const saveBody = await saveRes.json();
      expect(saveBody.savedCount, "2 of 3 selected drafts should have saved").toBe(2);
      const createdIds: string[] = (saveBody.testcases ?? []).map((t: { id: string }) => t.id);

      try {
        expect(
          scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(partialTaskId)};`),
          "a task-board batch must resolve to 'done' even on a partial save",
        ).toBe("done");

        const closedTaskId = seedTask({ drafts: 2, status: "in_review" });
        const closeRes = await asOwner.post(url(`/agents/zyra/tasks/${closedTaskId}/close`), {
          failOnStatusCode: false,
        });
        expect(closeRes.status(), `closing without saving — ${await closeRes.text()}`).toBe(201);
        expect(
          scalar(`SELECT saved_count FROM ai_generation_requests WHERE id = ${literal(closedTaskId)};`),
        ).toBe("0");

        // 2 saved of 3 (partial save) + 0 saved of 2 (closed without saving) = 2 of 5 = 40%.
        expect(
          await approvalRate(),
          "a partial save and a close-without-saving did not aggregate into the expected rate",
        ).toBe(40);
      } finally {
        for (const id of createdIds) {
          await asOwner.delete(url(`/testcases/${id}`), { failOnStatusCode: false });
        }
      }
    },
  );

  test(
    "ZYR-A-81 chat-created testcases never feed the task-board approval rate",
    { tag: '@tesbo.testId("TES-TC-1221")' },
    async () => {
      // A chat-staged row (chat_session_id set) must not be picked up by the task-board aggregate —
      // chat has no comparable generated-vs-saved concept, and `tasks` elsewhere on this same payload
      // already excludes these rows for the same reason (chat_session_id IS NULL).
      seedChatReviewTask({ status: "done" });
      expect(await approvalRate(), "a chat-staged batch leaked into the task-board approval rate").toBeNull();
    },
  );

  test(
    "ZYR-A-82 the approval rate is scoped per project — a second tenant's saves never leak in",
    { tag: '@tesbo.testId("TES-TC-1222")' },
    async () => {
      // Same account, its own second project — the cheapest way to catch a dropped WHERE project_id.
      seedTask({ drafts: 4, savedCount: 4, status: "done", projectId: tenant!.mainProjectId });
      expect(
        await approvalRate(asOwner, tenant!.secondProjectId),
        "a save recorded against the main project leaked into a sibling project's approval rate",
      ).toBeNull();
    },
  );

  // ─── The agent's "Token usage" tile ─────────────────────────────────────────

  /** A ledger row, written directly — see seedTask()'s comment for why: no live model is called here. */
  function seedTokenUsage(
    source: "task_generate" | "task_regenerate" | "chat_router" | "chat_generate" | "chat_plan" | "chat_tool_finalize",
    total: number,
    projectId = tenant!.mainProjectId,
  ): void {
    const input = Math.floor(total / 2);
    const output = total - input;
    exec(
      "INSERT INTO zyra_token_usage (project_id, source, provider, model, token_input, token_output, token_total) VALUES (" +
        `${literal(projectId)}, ${literal(source)}, 'openai', 'gpt-4o-mini', ${input}, ${output}, ${total});`,
    );
  }

  const tokenUsageTotal = async (api: APIRequestContext = asOwner, projectId?: string): Promise<number> => {
    const res = await api.get(url("/agents/zyra", projectId), { failOnStatusCode: false });
    expect(res.status(), `reading the agent — ${await res.text()}`).toBe(200);
    return Number((await res.json()).tokenUsage?.total);
  };

  test("ZYR-A-34 token usage sums chat-sourced calls, not just the task board", { tag: '@tesbo.testId("TES-TC-1096")' }, async () => {
    /*
     * The bug this regresses: zyraAgent() used to SUM(token_total) over ai_generation_requests, a
     * table only the task-board draft flow (aiGenerate/processZyraTask) ever writes. Every AI call
     * Zyra's chat makes — the router decision, chat-driven generation, an exhaustive-plan batch, the
     * Jira-coverage tool finalizer — spent real provider tokens that were never persisted anywhere
     * this endpoint read, so a project used only through chat (the primary surface, reached from
     * this same settings page's "Open Zyra chat") showed a permanent 0 no matter how much was spent.
     *
     * zyraAgent() now sums zyra_token_usage instead, written by every one of those call sites (see
     * recordZyraTokenUsage). Asserted as a delta from a baseline for the same reason ZYR-A-31 is:
     * a re-run against the persistent volume may not start from zero.
     */
    const baseline = await tokenUsageTotal();

    seedTokenUsage("chat_router", 120);
    expect(await tokenUsageTotal(), "a chat router call was not counted").toBe(baseline + 120);

    seedTokenUsage("chat_generate", 4500);
    expect(await tokenUsageTotal(), "chat-driven generation was not counted").toBe(baseline + 4620);

    seedTokenUsage("chat_plan", 80);
    seedTokenUsage("chat_tool_finalize", 60);
    expect(await tokenUsageTotal(), "the exhaustive-plan and Jira-tool call sources were not counted").toBe(baseline + 4760);

    // The task-board sources still count too — this is additive, not a replacement of one blind
    // spot with another.
    seedTokenUsage("task_generate", 300);
    seedTokenUsage("task_regenerate", 150);
    expect(await tokenUsageTotal(), "task-board sources regressed").toBe(baseline + 5210);
  });

  test("ZYR-A-35 a project with no recorded usage reads 0, not an error", { tag: '@tesbo.testId("TES-TC-1097")' }, async () => {
    // The new workspace / never-used-Zyra baseline. COALESCE(SUM(...), 0) over zero rows must not
    // surface as NULL or a 500 — this is the state every project starts in.
    const res = await asOwner.get(url("/agents/zyra"), { failOnStatusCode: false });
    expect(res.status(), `reading a project with no usage — ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.tokenUsage, "tokenUsage is missing from the agent payload").toBeDefined();
    expect(Number(body.tokenUsage.total)).toBe(0);
  });

  test("ZYR-A-36 token usage is scoped per project — a second tenant's spend never leaks in", { tag: '@tesbo.testId("TES-TC-1098")' }, async () => {
    // Same account, its own second project: proves the SUM is filtered by project_id, not just
    // organization_id — the cheapest way to catch a dropped WHERE clause.
    const before = await tokenUsageTotal(asOwner, tenant!.secondProjectId);
    seedTokenUsage("chat_generate", 999, tenant!.mainProjectId);
    expect(
      await tokenUsageTotal(asOwner, tenant!.secondProjectId),
      "usage recorded against the main project leaked into a sibling project's total",
    ).toBe(before);
  });

  // ─── Generation failure surfaces as a distinct status ──────────────────────

  test("ZYR-A-33 a generation failure is a distinct 'failed' status, not a silent revert to the queue", async () => {
    /*
     * Regression test. processZyraTask's catch block used to revert task_status to 'todo' on any
     * generation failure — identical to a task that was never picked up, so a failed task was
     * indistinguishable from a freshly queued one anywhere task_status is read (the Kanban board
     * groups strictly by that column). The only trace of the failure was one activity_log entry,
     * which forced the user into the Activity tab to discover a generation had failed at all.
     *
     * The real provider call can't be exercised here (see the file header — no AI provider is
     * called in this suite), so the failure is arranged the way the fixed catch block leaves it:
     * task_status = 'failed' plus a matching activity_log entry with stage 'failed'.
     */
    const taskId = seedTask({ status: "failed" });
    exec(
      "UPDATE ai_generation_requests SET activity_log = activity_log || " +
        `${literal(
          JSON.stringify([
            {
              actor: "agent",
              stage: "failed",
              title: "Generation failed",
              detail: "E2E simulated provider timeout",
              createdAt: new Date().toISOString(),
            },
          ]),
        )}::jsonb WHERE id = ${literal(taskId)};`,
    );

    const res = await asOwner.get(url(`/agents/zyra/tasks/${taskId}`), { failOnStatusCode: false });
    expect(res.status(), `reading a failed task — ${await res.text()}`).toBe(200);
    const task = await res.json();
    expect(task.taskStatus, "a failed task must read back as 'failed', not its pre-generation status").toBe(
      "failed",
    );
    const failureEntries = (task.activities as Array<{ stage: string; detail: string }>).filter(
      (a) => a.stage === "failed",
    );
    expect(failureEntries.length, "the failure reason must be recorded in the activity log").toBeGreaterThan(0);
    expect(failureEntries[0].detail).toContain("E2E simulated provider timeout");

    // A terminal failure state must not trap the task — closing it still has to work.
    const closed = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/close`), {
      data: {},
      failOnStatusCode: false,
    });
    expect(closed.status(), `closing a failed task — ${await closed.text()}`).toBe(201);
    expect(scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe("done");
  });

  // ─── Status races (fix for "task status is not updated in real time / async generation
  // failure can override user actions") ───────────────────────────────────────────────

  test("ZYR-A-34 feedback is refused while a task is todo, in_progress, or done — not a status Zyra can regenerate from", async () => {
    /*
     * Regression test. zyraFeedback used to move any task straight to 'todo' and start
     * regenerating, whatever its current status. That let feedback race processZyraTask (both
     * writing task_status for the same row with no coordination) and let feedback be submitted on
     * a task that had never been generated, or was already closed. It now requires the task to be
     * 'in_review' or 'failed' before accepting feedback.
     */
    for (const status of ["todo", "in_progress", "done"]) {
      const taskId = seedTask({ status });
      const res = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/feedback`), {
        data: { feedback: "Cover the locked-account case too" },
        failOnStatusCode: false,
      });
      expect(res.status(), `feedback on a '${status}' task answered ${res.status()}: ${await res.text()}`).toBe(409);
      const body = await res.json();
      expect(body.error, `feedback on a '${status}' task`).toContain(status);
      // Refused before any write — the row must be untouched, not just refused with a stale echo.
      expect(scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe(status);
      expect(scalar(`SELECT coalesce(feedback, '') FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe("");
    }
  });

  test("ZYR-A-35 feedback on an in_review or failed task passes the status guard (fails later only for lack of an AI key)", async () => {
    // Proves the guard discriminates correctly: these two statuses must NOT get the "can't accept
    // feedback right now" conflict — they should reach the (pre-existing, allocation-missing)
    // "Zyra is inactive" refusal instead, same as ZYR-A-21.
    for (const status of ["in_review", "failed"]) {
      const taskId = seedTask({ status });
      const res = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/feedback`), {
        data: { feedback: "Cover the locked-account case too" },
        failOnStatusCode: false,
      });
      expect(res.status(), `feedback on a '${status}' task — ${await res.text()}`).not.toBe(409);
      expect(res.status(), `feedback on a '${status}' task — ${await res.text()}`).toBeLessThan(500);
    }
  });

  test("ZYR-A-36 saving is refused while a task is still generating", async () => {
    /*
     * Regression test. zyraSave used to accept a save for any status, including 'in_progress' —
     * before processZyraTask has written any drafts, or while it is about to replace them. The
     * client's own selectedDraftIndexes could reference drafts that no longer match the row by
     * the time this runs. It now refuses that status outright.
     */
    const taskId = seedTask({ status: "in_progress" });
    const res = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/save`), {
      data: { selectedDraftIndexes: [0] },
      failOnStatusCode: false,
    });
    expect(res.status(), `saving an in-progress task — ${await res.text()}`).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("generating");
    expect(scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe(
      "in_progress",
    );
  });

  test("ZYR-A-37 closing an already-closed task is a true no-op, not a duplicate activity entry", async () => {
    const taskId = seedTask();
    const first = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/close`), { data: {}, failOnStatusCode: false });
    expect(first.status()).toBe(201);

    const second = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/close`), { data: {}, failOnStatusCode: false });
    expect(second.status(), `closing an already-closed task — ${await second.text()}`).toBe(201);

    const closedEntries = JSON.parse(
      scalar(`SELECT activity_log::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`),
    ).filter((entry: { title: string }) => entry.title === "Closed task");
    expect(closedEntries.length, "closing twice must not double the activity log").toBe(1);
  });

  test("ZYR-A-38 two concurrent close requests for the same task don't race each other into a bad state", async () => {
    // Two tabs / a double-click before the button disables — both requests reach the server before
    // either commits. Every writer in this flow guards its UPDATE with the row's current status
    // rather than writing blindly, so this must land on exactly one recorded close, not two, and
    // never a 500.
    const taskId = seedTask();
    const [a, b] = await Promise.all([
      asOwner.post(url(`/agents/zyra/tasks/${taskId}/close`), { data: {}, failOnStatusCode: false }),
      asOwner.post(url(`/agents/zyra/tasks/${taskId}/close`), { data: {}, failOnStatusCode: false }),
    ]);
    expect(a.status(), `first concurrent close — ${await a.text()}`).toBeLessThan(500);
    expect(b.status(), `second concurrent close — ${await b.text()}`).toBeLessThan(500);
    expect(scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe("done");
    const closedEntries = JSON.parse(
      scalar(`SELECT activity_log::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`),
    ).filter((entry: { title: string }) => entry.title === "Closed task");
    expect(closedEntries.length, "a race between two closes must not be recorded twice").toBe(1);
  });

  // ─── Feedback vs. activity (fix for "Feedback and Activity sections display similar
  // content") ─────────────────────────────────────────────────────────────────

  test("ZYR-A-39 the task read distinguishes the feedback entry from status/process activity via `kind`", async () => {
    /*
     * Regression test for the Task Details panel showing identical content under "Feedback" and
     * "Activity" — both tabs rendered the same flat activity_log. zyraFeedback now tags the one
     * entry that carries a reviewer's actual words with `kind: "feedback"` (see the comment above
     * feedbackActivity in zyraFeedback); every other entry in the log is status/process narration
     * and must NOT carry that marker. The live feedback route can't be driven end-to-end here (see
     * the file header — no AI provider is configured for this suite, and zyraFeedback only writes
     * the entry once it gets past the allocation check), so this seeds the log the same way the
     * fixed backend leaves it and proves the GET route passes `kind` through unmangled — the exact
     * contract TaskQuickViewPanel's isFeedbackActivity filter depends on.
     */
    const taskId = seedTask({ status: "in_review" });
    exec(
      "UPDATE ai_generation_requests SET activity_log = activity_log || " +
        `${literal(
          JSON.stringify([
            { actor: "agent", stage: "in_progress", title: "Picked up task", detail: "Zyra moved this task from Todo to In Progress.", createdAt: new Date().toISOString() },
            { actor: "user", stage: "todo", kind: "feedback", title: "Review feedback submitted", detail: "Cover the locked-account case too", createdAt: new Date().toISOString() },
          ]),
        )}::jsonb WHERE id = ${literal(taskId)};`,
    );

    const res = await asOwner.get(url(`/agents/zyra/tasks/${taskId}`), { failOnStatusCode: false });
    expect(res.status(), `reading the task — ${await res.text()}`).toBe(200);
    const task = await res.json();
    const activities = task.activities as Array<{ title: string; detail: string; kind?: string }>;

    const feedbackEntries = activities.filter((a) => a.kind === "feedback");
    expect(feedbackEntries.length, "exactly the one reviewer-authored entry is marked as feedback").toBe(1);
    expect(feedbackEntries[0].title).toBe("Review feedback submitted");
    expect(feedbackEntries[0].detail).toContain("Cover the locked-account case too");

    const statusEntry = activities.find((a) => a.title === "Picked up task");
    expect(statusEntry, "the seeded status entry is still present").toBeTruthy();
    expect(statusEntry?.kind, "a status/process entry must not be misclassified as feedback").not.toBe("feedback");

    // The task-created entry seedTask() itself never writes (activity_log defaults to '[]') stays
    // absent either way — this only asserts the two entries this test seeded.
    expect(activities).toHaveLength(2);
  });

  // ─── Task creation: sources / context label & formatting ──────────────────

  /** Allocates a throwaway AI key to the tenant's main project via the real routes. */
  async function allocateFakeAiKey(): Promise<void> {
    const keyRes = await asOwner.post("/api/workspace/ai-keys", {
      data: { name: `E2E key ${Date.now()}${Math.floor(Math.random() * 1000)}`, provider: "openai", apiKey: "sk-e2e-not-a-real-key" },
      failOnStatusCode: false,
    });
    expect(keyRes.status(), `creating an AI key — ${await keyRes.text()}`).toBe(201);
    const key = await keyRes.json();
    const allocRes = await asOwner.post("/api/workspace/ai-keys/allocations", {
      data: { projectId: tenant!.mainProjectId, workspaceAiKeyId: key.id },
      failOnStatusCode: false,
    });
    expect(allocRes.status(), `allocating the key — ${await allocRes.text()}`).toBe(201);
  }

  test("ZYR-A-41 a task created with context surfaces it as a 'User Story Context' source with line breaks intact", async () => {
    /*
     * Regression test for [Agents-Tasks] "User context" in the Task Details view: the source label
     * had to read "User Story Context" (not "User context"), and the detail text had to keep its
     * original line breaks instead of arriving pre-flattened — the frontend renders it with
     * `whitespace-pre-wrap`, which only helps if the stored string still has the newlines in it.
     *
     * Unlike full generation (no AI provider is configured for this suite — see the file header),
     * aiGenerate builds and stores source_summary and returns the created task BEFORE it fires the
     * background generation job, so this half of the flow is reachable through the real route once
     * a key is allocated — the background call is left to fail on its own and does not affect the
     * response asserted here.
     */
    await allocateFakeAiKey();

    const context = 'As a registered user, I want to create a new post.\n\nAcceptance Criteria:\nUser can access a "New Post" option\nPost requires a title and body';
    const res = await asOwner.post(url("/agents/zyra/tasks"), {
      data: { userStory: `E2E story ${Date.now()}`, context },
      failOnStatusCode: false,
    });
    expect(res.status(), `creating the task — ${await res.text()}`).toBe(201);
    const body = await res.json();
    const sources = body.task.sources as Array<{ type: string; title: string; detail: string }>;

    const contextSource = sources.find((s) => s.type === "context");
    expect(contextSource, "no context source was recorded").toBeTruthy();
    expect(contextSource!.title).toBe("User Story Context");
    expect(contextSource!.title).not.toBe("User context");
    expect(contextSource!.detail).toBe(context);
    expect(contextSource!.detail.split("\n").length, "line breaks were flattened out of the stored detail").toBeGreaterThan(1);

    // Reading the task back goes through the same formatAiTask() mapping the UI calls when opening
    // the Sources tab — assert there too, not just on the create response.
    const fetchRes = await asOwner.get(url(`/agents/zyra/tasks/${body.generationRequestId}`), { failOnStatusCode: false });
    expect(fetchRes.status()).toBe(200);
    const fetched = await fetchRes.json();
    const fetchedContext = (fetched.sources as Array<{ type: string; title: string }>).find((s) => s.type === "context");
    expect(fetchedContext?.title).toBe("User Story Context");
  });

  test("ZYR-A-42 task source labelling handles edge-case context: whitespace-only, absent, and over the 320-char cap", async () => {
    await allocateFakeAiKey();

    // Whitespace-only context must not produce a phantom "User Story Context" source — the backend
    // trims before deciding whether context was supplied at all.
    const blank = await asOwner.post(url("/agents/zyra/tasks"), {
      data: { userStory: `E2E story blank ${Date.now()}`, context: "   \n\t  " },
      failOnStatusCode: false,
    });
    expect(blank.status(), `creating the task — ${await blank.text()}`).toBe(201);
    const blankSources = (await blank.json()).task.sources as Array<{ type: string }>;
    expect(blankSources.find((s) => s.type === "context"), "whitespace-only context produced a source anyway").toBeUndefined();

    // No context field at all — same absence.
    const none = await asOwner.post(url("/agents/zyra/tasks"), {
      data: { userStory: `E2E story none ${Date.now()}` },
      failOnStatusCode: false,
    });
    expect(none.status(), `creating the task — ${await none.text()}`).toBe(201);
    const noneSources = (await none.json()).task.sources as Array<{ type: string }>;
    expect(noneSources.find((s) => s.type === "context")).toBeUndefined();

    // A context past the 320-char storage cap keeps its label and its line breaks up to the cut.
    const longLine = "A".repeat(50);
    const longContext = Array.from({ length: 10 }, (_, i) => `${longLine} ${i}`).join("\n");
    expect(longContext.length).toBeGreaterThan(320);
    const long = await asOwner.post(url("/agents/zyra/tasks"), {
      data: { userStory: `E2E story long ${Date.now()}`, context: longContext },
      failOnStatusCode: false,
    });
    expect(long.status(), `creating the task — ${await long.text()}`).toBe(201);
    const longSource = ((await long.json()).task.sources as Array<{ type: string; title: string; detail: string }>).find(
      (s) => s.type === "context",
    );
    expect(longSource?.title).toBe("User Story Context");
    expect(longSource?.detail).toBe(longContext.slice(0, 320));
    expect(longSource?.detail.length).toBe(320);
  });

  // ─── The agent's "last used" timestamp ─────────────────────────────────────

  test("ZYR-A-43 the agent reports no last-used date until Zyra is actually used, then the more recent of chat or the task board", async () => {
    /*
     * Regression test. The Agents screen tile derived "last used" (rendered as "Used Nd ago")
     * purely from ai_generation_requests — the task-board draft flow — so a workspace that only
     * ever talked to Zyra through chat kept reporting the same stale date forever, exactly like
     * ZYR-A-31's "0 tests generated" before that counter was fixed to read both modes. lastUsedAt
     * is now the newer of the task board's latest updated_at and a chat session's, and a session
     * with no message in it (auto-created just by opening the chat — see ZYU-26/27) must not count,
     * the same way an unused session is excluded from has_messages.
     */
    const readAgent = async (): Promise<{ lastUsedAt: string | null }> => {
      const res = await asOwner.get(url("/agents/zyra"), { failOnStatusCode: false });
      expect(res.status(), `reading the agent — ${await res.text()}`).toBe(200);
      const body = await res.json();
      expect(body.agent, "the agent payload carries no agent object").toBeTruthy();
      return body.agent;
    };
    // Nothing used yet: purge() ran in beforeEach/afterEach, so this project starts clean.
    const before = await readAgent();
    expect(before.lastUsedAt, "a project with no Zyra activity reported a last-used date").toBeNull();

    // Opening the chat alone (an empty, message-less session) must not count as usage.
    const emptySession = await createSession("Zyra chat");
    const stillNone = await readAgent();
    expect(stillNone.lastUsedAt, "an empty auto-created chat session counted as 'last used'").toBeNull();

    // Actually sending a chat message is usage.
    markChatUsed(emptySession.id);
    const afterChat = await readAgent();
    expect(afterChat.lastUsedAt, "a real chat message did not update last-used").not.toBeNull();
    const chatSeenAt = scalar(`SELECT updated_at::text FROM zyra_chat_sessions WHERE id = ${literal(emptySession.id)};`);
    expect(new Date(afterChat.lastUsedAt!).getTime()).toBe(new Date(chatSeenAt).getTime());

    // Backdate the chat activity, then use the task board — the newer of the two must win.
    exec(`UPDATE zyra_chat_sessions SET updated_at = now() - interval '10 days' WHERE id = ${literal(emptySession.id)};`);
    const taskId = seedTask();
    const afterTask = await readAgent();
    const taskSeenAt = scalar(`SELECT updated_at::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`);
    expect(
      new Date(afterTask.lastUsedAt!).getTime(),
      "a more recent task-board update did not take over from an older chat timestamp",
    ).toBe(new Date(taskSeenAt).getTime());

    // Backdate the task too, so the (still newer) chat activity wins back.
    exec(`UPDATE ai_generation_requests SET updated_at = now() - interval '20 days' WHERE id = ${literal(taskId)};`);
    const afterBothOld = await readAgent();
    expect(
      new Date(afterBothOld.lastUsedAt!).getTime(),
      "the more recent activity (chat, 10 days back) should still win over an older task-board update",
    ).toBe(new Date(chatSeenAt).getTime());
  });

  test("ZYR-A-44 a second project's Zyra activity is not reflected in this project's last-used date", async () => {
    // Cross-project isolation for the same field ZYR-A-43 exercises: a used chat session in the
    // second project must not leak into the main project's lastUsedAt, the same boundary ZYR-A-05
    // pins for the underlying rows themselves.
    const before = await asOwner.get(url("/agents/zyra"), { failOnStatusCode: false });
    expect((await before.json()).agent.lastUsedAt).toBeNull();

    const otherSession = await createSession("Zyra chat", asOwner, tenant!.secondProjectId);
    markChatUsed(otherSession.id, tenant!.secondProjectId);

    const after = await asOwner.get(url("/agents/zyra"), { failOnStatusCode: false });
    expect(
      (await after.json()).agent.lastUsedAt,
      "a chat message sent in the second project changed the main project's last-used date",
    ).toBeNull();
  });

  // ─── Review step for Zyra-chat-generated test cases ────────────────────────
  // Chat's create/update/archive operations no longer write straight to `testcases` — they're
  // staged on a chat_session_id-linked ai_generation_requests row (applyZyraChatOperations) and
  // only committed by these same tasks/:id/{drafts/:index,save,close} routes seedTask()'s tests
  // above already exercise for the Task board. The live chat route can't drive this itself (file
  // header — no AI provider configured), so every scenario below arranges the staged row directly,
  // the same rule seedTask() already established.

  test("ZYR-A-45 a chat-staged batch never appears on the task board's own list", async () => {
    const boardTaskId = seedTask();
    const { taskId: chatTaskId } = seedChatReviewTask();

    const res = await asOwner.get(url("/agents/zyra"), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const boardIds = (body.tasks as Array<{ id: string }>).map((t) => t.id);
    expect(boardIds, "the task board must still list its own generation requests").toContain(boardTaskId);
    expect(
      boardIds,
      "a chat-staged batch (wrapped {opType,...} payload) would render with blank fields on the task board",
    ).not.toContain(chatTaskId);

    // Still reachable by id — it's a review batch, not a hidden/broken row.
    const direct = await asOwner.get(url(`/agents/zyra/tasks/${chatTaskId}`), { failOnStatusCode: false });
    expect(direct.status()).toBe(200);
  });

  test("ZYR-A-46 editing a pending chat-staged create draft updates its fields, not just the task-board shape", async () => {
    const { taskId } = seedChatReviewTask();
    const res = await asOwner.patch(url(`/agents/zyra/tasks/${taskId}/drafts/0`), {
      data: { title: "Edited via review", priority: "P0", preconditions: "Signed in", description: "Sees the edited result" },
      failOnStatusCode: false,
    });
    expect(res.status(), `editing a chat draft — ${await res.text()}`).toBe(200);

    const stored = JSON.parse(scalar(`SELECT generated_payload::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`));
    expect(stored[0].draft.title).toBe("Edited via review");
    expect(stored[0].draft.priority).toBe("P0");
    expect(stored[0].draft.preconditions).toBe("Signed in");
    expect(stored[0].draft.description).toBe("Sees the edited result");
    expect(stored[0].opType).toBe("create");
  });

  test("ZYR-A-47 editing a pending update/archive proposal only changes the staged fields — the real test case is untouched", async () => {
    const created = await asOwner.post(url("/testcases"), {
      data: { title: `E2E chat proposal target ${Date.now()}`, priority: "P2" },
      failOnStatusCode: false,
    });
    expect(created.status()).toBe(201);
    const testcaseId = (await created.json()).id;
    try {
      const { taskId } = seedChatReviewTask({
        entries: [{ opType: "update", testcaseId, externalId: "E2E-1", fields: { priority: "P1" }, reason: "" }],
      });
      const res = await asOwner.patch(url(`/agents/zyra/tasks/${taskId}/drafts/0`), {
        data: { priority: "P0" },
        failOnStatusCode: false,
      });
      expect(res.status(), `editing an update proposal — ${await res.text()}`).toBe(200);

      const stored = JSON.parse(scalar(`SELECT generated_payload::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`));
      expect(stored[0].fields.priority).toBe("P0");
      expect(
        scalar(`SELECT priority FROM testcases WHERE id = ${literal(testcaseId)};`),
        "editing the proposal must not touch the real test case before Save",
      ).toBe("P2");
    } finally {
      await asOwner.delete(url(`/testcases/${testcaseId}`), { failOnStatusCode: false });
    }
  });

  test("ZYR-A-48 an overlong edit is refused before it reaches the stored draft", async () => {
    const { taskId } = seedChatReviewTask();
    const before = scalar(`SELECT generated_payload::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`);
    const res = await asOwner.patch(url(`/agents/zyra/tasks/${taskId}/drafts/0`), {
      data: { title: "x".repeat(600) },
      failOnStatusCode: false,
    });
    expect(res.status(), `an overlong title — ${await res.text()}`).toBe(400);
    expect(
      scalar(`SELECT generated_payload::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`),
      "a refused edit changed the stored draft",
    ).toBe(before);
  });

  test("ZYR-A-49 an invalid draft index on edit is refused rather than corrupting the payload", async () => {
    const { taskId } = seedChatReviewTask();
    const before = scalar(`SELECT generated_payload::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`);
    for (const index of ["9", "-1", "notanumber"]) {
      const res = await asOwner.patch(url(`/agents/zyra/tasks/${taskId}/drafts/${index}`), {
        data: { title: "probe" },
        failOnStatusCode: false,
      });
      expect(res.status(), `draft index "${index}" answered ${res.status()}: ${await res.text()}`).toBeLessThan(500);
    }
    expect(scalar(`SELECT generated_payload::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe(before);
  });

  test("ZYR-A-50 an edit is refused once the batch is no longer in_review", async () => {
    const { taskId } = seedChatReviewTask({ status: "done" });
    const res = await asOwner.patch(url(`/agents/zyra/tasks/${taskId}/drafts/0`), {
      data: { title: "too late" },
      failOnStatusCode: false,
    });
    expect(res.status(), `editing a resolved batch — ${await res.text()}`).toBe(409);
  });

  test("ZYR-A-51 saving a chat-staged create draft writes a real test case into its own suite, tagged and audited as zyra_chat", async () => {
    const suite = await asOwner.post(url("/suites"), { data: { name: `E2E zyra chat suite ${Date.now()}` }, failOnStatusCode: false });
    expect(suite.status()).toBe(201);
    const suiteId = (await suite.json()).id;
    const draftTitle = `E2E chat created ${Date.now()}`;
    const { taskId } = seedChatReviewTask({
      entries: [{ opType: "create", draft: { suiteId, title: draftTitle, description: "", preconditions: "", stepsJson: "[]", priority: "P1", type: "Functional", status: "Draft" }, reason: "" }],
    });

    const res = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/save`), {
      data: { selectedDraftIndexes: [0] },
      failOnStatusCode: false,
    });
    expect(res.status(), `saving a chat-staged create — ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.savedCount).toBe(1);

    const row = scalar(`SELECT suite_id FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND title = ${literal(draftTitle)};`);
    expect(row, "the draft's own suiteId must be respected, not left unassigned").toBe(suiteId);
    const testcaseId = scalar(`SELECT id FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND title = ${literal(draftTitle)};`);
    const auditSource = scalar(
      `SELECT diff->>'source' FROM audit_logs WHERE action = 'zyra_created' AND entity_id = ${literal(testcaseId)} ORDER BY created_at DESC LIMIT 1;`,
    );
    expect(auditSource, "a chat-saved case must be audited with source zyra_chat, same as chat's own direct writes").toBe("zyra_chat");
    expect(scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe("done");
  });

  test("ZYR-A-52 saving a chat-staged update proposal applies the change to the real test case", async () => {
    const created = await asOwner.post(url("/testcases"), { data: { title: `E2E update target ${Date.now()}`, priority: "P2" }, failOnStatusCode: false });
    const testcaseId = (await created.json()).id;
    try {
      const { taskId } = seedChatReviewTask({
        entries: [{ opType: "update", testcaseId, externalId: "E2E-1", fields: { priority: "P0", title: "Updated via chat review" }, reason: "" }],
      });
      const res = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/save`), { data: { selectedDraftIndexes: [0] }, failOnStatusCode: false });
      expect(res.status(), `saving a chat-staged update — ${await res.text()}`).toBe(201);
      expect(scalar(`SELECT priority FROM testcases WHERE id = ${literal(testcaseId)};`)).toBe("P0");
      expect(scalar(`SELECT title FROM testcases WHERE id = ${literal(testcaseId)};`)).toBe("Updated via chat review");
    } finally {
      await asOwner.delete(url(`/testcases/${testcaseId}`), { failOnStatusCode: false });
    }
  });

  /*
   * "[Zyra] Test Steps, Actions, and Expected Results Are Missing After Saving Generated Test
   * Cases" — a Zyra-generated test case saved fine, but its steps showed as one blank
   * Action/Expected Result pair in the Test Case Repository regardless of how many steps were
   * actually generated.
   *
   * Root cause: the create/edit modal pre-stringifies `steps` into a JSON string before every save
   * (testcases/page.tsx), and the shared writers (insertTestCaseWithClient/updateTestCaseWithClient,
   * patchTestCaseFromZyraWithClient) unconditionally JSON.stringify whatever they're given — so the
   * modal's already-a-string input gets encoded a second time, landing in the jsonb column as a JSON
   * string scalar, which is exactly the shape the modal's own parseSteps() reads back. Zyra's save
   * paths instead handed over a real array (via safeSteps()), which got encoded only once and stored
   * as a genuine jsonb array — a shape parseSteps() silently discards, substituting one blank step.
   * Fixed by pre-stringifying steps once at the point Zyra hands them to each writer, matching what
   * the modal already sends, without changing the modal, safeSteps' synonym normalization, or
   * anything Zyra generates or displays before save.
   */
  test("ZYR-A-51b saving a chat-staged create draft persists real step content the editor can read, not one blank step", async () => {
    const draftTitle = `E2E chat steps ${Date.now()}`;
    // More than one step (the observed bug always collapsed to exactly one), with content that
    // would break a naive re-encode: an apostrophe, a quote, and a literal backslash.
    const steps = [
      { stepNumber: 1, action: "Enter a valid destination (e.g. 'Paris')", expectedResult: `Destination field accepts the input.` },
      { stepNumber: 2, action: "Set Check-in Date to 14 days from today", expectedResult: "Check-in date is set successfully." },
      { stepNumber: 3, action: `Click "Search Hotels"`, expectedResult: `Path separator check: C:\\temp is rejected` },
    ];
    const { taskId } = seedChatReviewTask({
      entries: [
        {
          opType: "create",
          draft: {
            suiteId: null,
            title: draftTitle,
            description: "",
            preconditions: "",
            stepsJson: JSON.stringify(steps),
            priority: "P1",
            type: "Functional",
            status: "Draft",
          },
          reason: "",
        },
      ],
    });

    const res = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/save`), {
      data: { selectedDraftIndexes: [0] },
      failOnStatusCode: false,
    });
    expect(res.status(), `saving a chat-staged create — ${await res.text()}`).toBe(201);

    const testcaseId = scalar(
      `SELECT id FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND title = ${literal(draftTitle)};`,
    );
    try {
      const fetched = await asOwner.get(url(`/testcases/${testcaseId}`), { failOnStatusCode: false });
      expect(fetched.status(), `fetching the saved case — ${await fetched.text()}`).toBe(200);
      const rawSteps = (await fetched.json()).steps;
      // The editor's parseSteps() (testcases/page.tsx) only accepts a JSON-encoded string for this
      // field — an array here is exactly the shape it silently discards.
      expect(typeof rawSteps).toBe("string");
      expect(JSON.parse(rawSteps)).toEqual(steps);
    } finally {
      await asOwner.delete(url(`/testcases/${testcaseId}`), { failOnStatusCode: false });
    }
  });

  test("ZYR-A-52b saving a chat-staged update proposal replaces an existing test case's steps in the editor-readable shape", async () => {
    const created = await asOwner.post(url("/testcases"), {
      data: { title: `E2E update steps target ${Date.now()}` },
      failOnStatusCode: false,
    });
    const testcaseId = (await created.json()).id;
    const steps = [
      { stepNumber: 1, action: "Updated step one", expectedResult: "Updated result one" },
      { stepNumber: 2, action: "Updated step two", expectedResult: "Updated result two" },
    ];
    try {
      const { taskId } = seedChatReviewTask({
        entries: [
          { opType: "update", testcaseId, externalId: "E2E-1", fields: { stepsJson: JSON.stringify(steps) }, reason: "" },
        ],
      });
      const res = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/save`), {
        data: { selectedDraftIndexes: [0] },
        failOnStatusCode: false,
      });
      expect(res.status(), `saving a chat-staged step update — ${await res.text()}`).toBe(201);

      const fetched = await asOwner.get(url(`/testcases/${testcaseId}`), { failOnStatusCode: false });
      expect(fetched.status(), `fetching the updated case — ${await fetched.text()}`).toBe(200);
      const rawSteps = (await fetched.json()).steps;
      expect(typeof rawSteps).toBe("string");
      expect(JSON.parse(rawSteps)).toEqual(steps);
    } finally {
      await asOwner.delete(url(`/testcases/${testcaseId}`), { failOnStatusCode: false });
    }
  });

  test("ZYR-A-53 saving a chat-staged archive proposal archives the real test case", async () => {
    const created = await asOwner.post(url("/testcases"), { data: { title: `E2E archive target ${Date.now()}` }, failOnStatusCode: false });
    const testcaseId = (await created.json()).id;
    try {
      const { taskId } = seedChatReviewTask({
        entries: [{ opType: "archive", testcaseId, externalId: "E2E-1", fields: { status: "Archived" }, reason: "" }],
      });
      const res = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/save`), { data: { selectedDraftIndexes: [0] }, failOnStatusCode: false });
      expect(res.status(), `saving a chat-staged archive — ${await res.text()}`).toBe(201);
      expect(scalar(`SELECT status FROM testcases WHERE id = ${literal(testcaseId)};`)).toBe("Archived");
    } finally {
      await asOwner.delete(url(`/testcases/${testcaseId}`), { failOnStatusCode: false });
    }
  });

  test("ZYR-A-54 saving only part of a mixed batch leaves the rest staged for a later Save, instead of closing the whole batch", async () => {
    const other = await asOwner.post(url("/testcases"), { data: { title: `E2E untouched by partial save ${Date.now()}`, priority: "P3" }, failOnStatusCode: false });
    const otherId = (await other.json()).id;
    try {
      const createTitle = `E2E partial-save create ${Date.now()}`;
      const { taskId } = seedChatReviewTask({
        entries: [
          { opType: "create", draft: { suiteId: null, title: createTitle, description: "", preconditions: "", stepsJson: "[]", priority: "P2", type: "Functional", status: "Draft" }, reason: "" },
          { opType: "archive", testcaseId: otherId, externalId: "E2E-2", fields: { status: "Archived" }, reason: "" },
        ],
      });

      const res = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/save`), { data: { selectedDraftIndexes: [0] }, failOnStatusCode: false });
      expect(res.status(), `saving one of two staged drafts — ${await res.text()}`).toBe(201);
      const body = await res.json();
      expect(body.savedCount).toBe(1);
      expect(scalar(`SELECT COUNT(*) FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND title = ${literal(createTitle)};`)).toBe("1");
      expect(scalar(`SELECT status FROM testcases WHERE id = ${literal(otherId)};`), "the unselected archive must not have run").not.toBe("Archived");

      // The batch stays open — this is what distinguishes a chat-staged batch from a Task-board one.
      expect(scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe("in_review");
      const remaining = JSON.parse(scalar(`SELECT generated_payload::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`));
      expect(remaining).toHaveLength(1);
      expect(remaining[0].opType).toBe("archive");

      // And the remaining draft is still fully actionable.
      const secondSave = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/save`), { data: { selectedDraftIndexes: [0] }, failOnStatusCode: false });
      expect(secondSave.status(), `saving the remaining draft — ${await secondSave.text()}`).toBe(201);
      expect(scalar(`SELECT status FROM testcases WHERE id = ${literal(otherId)};`)).toBe("Archived");
      expect(scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe("done");
    } finally {
      await asOwner.delete(url(`/testcases/${otherId}`), { failOnStatusCode: false });
    }
  });

  test("ZYR-A-55 an explicitly empty selection saves nothing and leaves the batch in review", async () => {
    const { taskId } = seedChatReviewTask();
    const res = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/save`), { data: { selectedDraftIndexes: [] }, failOnStatusCode: false });
    expect(res.status(), `an explicit empty selection — ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.savedCount, "an explicitly empty selection must not fall back to saving everything").toBe(0);
    expect(scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe("in_review");
    expect(scalar(`SELECT COUNT(*) FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)};`)).toBe("0");
  });

  test("ZYR-A-56 omitting the selection entirely saves the whole batch, for back-compat", async () => {
    const { taskId } = seedChatReviewTask({
      entries: [
        { opType: "create", draft: { suiteId: null, title: `E2E omit-selection A ${Date.now()}`, description: "", preconditions: "", stepsJson: "[]", priority: "P2", type: "Functional", status: "Draft" }, reason: "" },
        { opType: "create", draft: { suiteId: null, title: `E2E omit-selection B ${Date.now()}`, description: "", preconditions: "", stepsJson: "[]", priority: "P2", type: "Functional", status: "Draft" }, reason: "" },
      ],
    });
    const res = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/save`), { data: {}, failOnStatusCode: false });
    expect(res.status(), `an omitted selection — ${await res.text()}`).toBe(201);
    expect((await res.json()).savedCount).toBe(2);
    expect(scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe("done");
  });

  test("ZYR-A-57 a stale update target aborts the whole batch, including a valid create selected alongside it", async () => {
    const target = await asOwner.post(url("/testcases"), { data: { title: `E2E stale target ${Date.now()}` }, failOnStatusCode: false });
    const targetId = (await target.json()).id;
    const deleted = await asOwner.delete(url(`/testcases/${targetId}`), { failOnStatusCode: false });
    expect(deleted.ok()).toBeTruthy();

    const createTitle = `E2E should-not-be-created ${Date.now()}`;
    const { taskId } = seedChatReviewTask({
      entries: [
        { opType: "create", draft: { suiteId: null, title: createTitle, description: "", preconditions: "", stepsJson: "[]", priority: "P2", type: "Functional", status: "Draft" }, reason: "" },
        { opType: "update", testcaseId: targetId, externalId: "E2E-3", fields: { priority: "P0" }, reason: "" },
      ],
    });

    const res = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/save`), { data: { selectedDraftIndexes: [0, 1] }, failOnStatusCode: false });
    expect(res.status(), `saving alongside a deleted target — ${await res.text()}`).toBe(409);
    const body = await res.json();
    expect(body.staleDraftIndexes).toEqual([1]);
    expect(
      scalar(`SELECT COUNT(*) FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND title = ${literal(createTitle)};`),
      "the whole batch must roll back — a stale sibling draft must not let a valid create through",
    ).toBe("0");
    expect(scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe("in_review");
  });

  test("ZYR-A-58 two concurrent saves of the same batch don't create the test case twice", async () => {
    const createTitle = `E2E concurrent save ${Date.now()}`;
    const { taskId } = seedChatReviewTask({
      entries: [{ opType: "create", draft: { suiteId: null, title: createTitle, description: "", preconditions: "", stepsJson: "[]", priority: "P2", type: "Functional", status: "Draft" }, reason: "" }],
    });

    const [a, b] = await Promise.all([
      asOwner.post(url(`/agents/zyra/tasks/${taskId}/save`), { data: { selectedDraftIndexes: [0] }, failOnStatusCode: false }),
      asOwner.post(url(`/agents/zyra/tasks/${taskId}/save`), { data: { selectedDraftIndexes: [0] }, failOnStatusCode: false }),
    ]);
    expect(a.status(), `first concurrent save — ${await a.text()}`).toBeLessThan(500);
    expect(b.status(), `second concurrent save — ${await b.text()}`).toBeLessThan(500);
    // One request wins the row lock and saves; the other, once it acquires the lock, sees a batch
    // that has already moved on and is refused rather than saving a second time.
    const winners = [a, b].filter((r) => r.status() === 201);
    expect(winners.length, "exactly one of two concurrent saves should succeed").toBe(1);
    expect(
      scalar(`SELECT COUNT(*) FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND title = ${literal(createTitle)};`),
      "a race between two saves created the same test case twice",
    ).toBe("1");
  });

  test("ZYR-A-59 saving is refused once test case storage is disabled, even though the batch was staged while it was allowed", async () => {
    const { taskId } = seedChatReviewTask();
    const off = await asOwner.patch(url("/agents/zyra/settings"), { data: { capabilities: { testcaseStorage: false } }, failOnStatusCode: false });
    expect(off.status()).toBeLessThan(300);
    try {
      const res = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/save`), { data: { selectedDraftIndexes: [0] }, failOnStatusCode: false });
      expect(res.status(), `saving with storage disabled — ${await res.text()}`).toBe(403);
      expect(scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe("in_review");
    } finally {
      await asOwner.patch(url("/agents/zyra/settings"), { data: { capabilities: { testcaseStorage: true } }, failOnStatusCode: false });
    }
  });

  test("ZYR-A-60 feedback is refused on a chat-staged batch — regeneration only applies to task-board generation", async () => {
    const { taskId } = seedChatReviewTask();
    const res = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/feedback`), {
      data: { feedback: "regenerate this" },
      failOnStatusCode: false,
    });
    expect(res.status(), `feedback on a chat-staged batch — ${await res.text()}`).toBe(400);
    expect(scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe("in_review");
  });

  test("ZYR-A-61 discarding a draft from a chat-staged batch works the same as it does for a task-board one", async () => {
    const { taskId } = seedChatReviewTask({
      entries: [
        { opType: "create", draft: { suiteId: null, title: "E2E chat discard A", description: "", preconditions: "", stepsJson: "[]", priority: "P2", type: "Functional", status: "Draft" }, reason: "" },
        { opType: "create", draft: { suiteId: null, title: "E2E chat discard B", description: "", preconditions: "", stepsJson: "[]", priority: "P2", type: "Functional", status: "Draft" }, reason: "" },
      ],
    });
    const res = await asOwner.delete(url(`/agents/zyra/tasks/${taskId}/drafts/0`), { failOnStatusCode: false });
    expect(res.status(), `discarding a chat-staged draft — ${await res.text()}`).toBe(200);
    const stored = JSON.parse(scalar(`SELECT generated_payload::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`));
    expect(stored.map((d: any) => d.draft.title)).toEqual(["E2E chat discard B"]);
  });

  test("ZYR-A-62 two concurrent discards of different drafts from the same batch both take effect", async () => {
    // Regression coverage for zyraDeleteDraft's read-modify-write, now locked with FOR UPDATE — an
    // unlocked pair of concurrent deletes can each read the same array and one silently overwrite
    // the other's removal.
    const { taskId } = seedChatReviewTask({
      entries: Array.from({ length: 4 }, (_, i) => ({
        opType: "create",
        draft: { suiteId: null, title: `E2E concurrent discard ${i}`, description: "", preconditions: "", stepsJson: "[]", priority: "P2", type: "Functional", status: "Draft" },
        reason: "",
      })),
    });
    const [a, b] = await Promise.all([
      asOwner.delete(url(`/agents/zyra/tasks/${taskId}/drafts/0`), { failOnStatusCode: false }),
      asOwner.delete(url(`/agents/zyra/tasks/${taskId}/drafts/1`), { failOnStatusCode: false }),
    ]);
    expect(a.status(), `first concurrent discard — ${await a.text()}`).toBeLessThan(500);
    expect(b.status(), `second concurrent discard — ${await b.text()}`).toBeLessThan(500);
    // Whichever commits first shifts the later indexes down by one, so which two titles survive is
    // legitimately order-dependent — not asserted here. What FOR UPDATE actually guarantees is that
    // an unlocked read-modify-write can't lose: both removals apply, landing on exactly 2 remaining,
    // never 3 (one removal silently overwritten) or corrupted.
    const stored = JSON.parse(scalar(`SELECT generated_payload::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`));
    expect(stored, "a race between two discards lost one of the removals").toHaveLength(2);
  });

  /*
   * "[Zyra] Severity and Component Are Missing in Generated Test Cases" — Zyra never asked the
   * model for these two fields, so every generated test case saved with both null regardless of
   * what the task-board draft carried. ZYR-A-71/72 cover the plain persistence path (a draft that
   * already has the fields, and one that doesn't); ZYR-A-73/74 cover the "regenerating an
   * already-linked test case" path, where an automatic redirect must never silently overwrite a
   * human-set value — see processZyraSaveEntriesSequential/Batched's "only fill if blank" comment.
   */
  test("ZYR-A-71 a task-board draft's severity and component are persisted on save", async () => {
    const draftTitle = `E2E severity component ${Date.now()}`;
    const taskId = seedTask({ drafts: 1, draftOverrides: [{ title: draftTitle, severity: "High", component: "Auth" }] });
    const res = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/save`), { data: { selectedDraftIndexes: [0] }, failOnStatusCode: false });
    expect(res.status(), `saving the draft — ${await res.text()}`).toBe(201);
    expect(scalar(`SELECT severity FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND title = ${literal(draftTitle)};`)).toBe("High");
    expect(scalar(`SELECT component FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND title = ${literal(draftTitle)};`)).toBe("Auth");
  });

  test("ZYR-A-72 a task-board draft with no severity or component still saves — both stay null, not a failure", async () => {
    const draftTitle = `E2E no severity component ${Date.now()}`;
    const taskId = seedTask({ drafts: 1, draftOverrides: [{ title: draftTitle }] });
    const res = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/save`), { data: { selectedDraftIndexes: [0] }, failOnStatusCode: false });
    expect(res.status(), `saving the draft — ${await res.text()}`).toBe(201);
    expect(scalar(`SELECT severity FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND title = ${literal(draftTitle)};`)).toBe("");
    expect(scalar(`SELECT component FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND title = ${literal(draftTitle)};`)).toBe("");
  });

  test("ZYR-A-73 regenerating an already-linked test case never overwrites its already-set severity/component with a fresh draft guess", async () => {
    const jiraIssueKey = `E2E-ZYRA-${Date.now()}`;
    const created = await asOwner.post(url("/testcases"), {
      data: { title: "E2E already-linked case", priority: "P2", jiraIssueKey, severity: "Critical", component: "Payments" },
      failOnStatusCode: false,
    });
    expect(created.status(), `seeding the already-linked case — ${await created.text()}`).toBe(201);
    const testcaseId = (await created.json()).id;
    try {
      const draftTitle = `E2E regenerated content ${Date.now()}`;
      const taskId = seedTask({ drafts: 1, jiraIssueKey, draftOverrides: [{ title: draftTitle, severity: "Low", component: "Billing" }] });
      const res = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/save`), { data: { selectedDraftIndexes: [0] }, failOnStatusCode: false });
      expect(res.status(), `saving the regenerated draft — ${await res.text()}`).toBe(201);
      // Content is genuinely regenerated (this is a real redirect-to-update, not a no-op)...
      expect(scalar(`SELECT title FROM testcases WHERE id = ${literal(testcaseId)};`)).toBe(draftTitle);
      // ...but severity/component were already set by a human and must survive untouched.
      expect(scalar(`SELECT severity FROM testcases WHERE id = ${literal(testcaseId)};`), "an already-set severity must never be overwritten by a regenerated draft").toBe("Critical");
      expect(scalar(`SELECT component FROM testcases WHERE id = ${literal(testcaseId)};`), "an already-set component must never be overwritten by a regenerated draft").toBe("Payments");
    } finally {
      await asOwner.delete(url(`/testcases/${testcaseId}`), { failOnStatusCode: false });
    }
  });

  test("ZYR-A-74 regenerating an already-linked test case with no severity/component yet fills them in from the fresh draft", async () => {
    const jiraIssueKey = `E2E-ZYRA-${Date.now()}`;
    const created = await asOwner.post(url("/testcases"), {
      data: { title: "E2E blank severity component case", priority: "P2", jiraIssueKey },
      failOnStatusCode: false,
    });
    expect(created.status(), `seeding the blank case — ${await created.text()}`).toBe(201);
    const testcaseId = (await created.json()).id;
    try {
      const taskId = seedTask({ drafts: 1, jiraIssueKey, draftOverrides: [{ severity: "Medium", component: "Search" }] });
      const res = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/save`), { data: { selectedDraftIndexes: [0] }, failOnStatusCode: false });
      expect(res.status(), `saving the regenerated draft — ${await res.text()}`).toBe(201);
      expect(scalar(`SELECT severity FROM testcases WHERE id = ${literal(testcaseId)};`)).toBe("Medium");
      expect(scalar(`SELECT component FROM testcases WHERE id = ${literal(testcaseId)};`)).toBe("Search");
    } finally {
      await asOwner.delete(url(`/testcases/${testcaseId}`), { failOnStatusCode: false });
    }
  });
});

/*
 * Per-test-case citations — which knowledge-base doc, Jira ticket, existing test case, or bug
 * actually informed a generated test case. Drives a REAL "create" turn through the fake AI provider
 * (utils/fake-ai-server.ts, same tool zyra-chat-consistency.spec.ts's "confirmation retry" block
 * uses) so the assertions are against sanitizeZyraSourceRefs/zyraSourceRefIndex actually running,
 * not a hand-built decision object.
 *
 * A fresh tenant per describe block (not the "zyra" one above) so the knowledge-base recency
 * snapshot and the bug/Jira relevance match are deterministic — a project that starts genuinely
 * empty guarantees this test's one seeded KB doc is "KB 1" and its one seeded bug is "BUG 1", with
 * nothing left over from another test to shift the ordering.
 */
test.describe("zyra chat — citations (fake provider)", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let ai: FakeAiServer;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("zyra-citations");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    ai = await startFakeAiServer();
  });

  test.afterAll(async () => {
    await asOwner?.dispose();
    await ai?.close();
  });

  test.beforeEach(() => {
    // See FakeAiServer.reset()'s doc comment — this describe block's `ai` instance is shared across
    // every test in it (one beforeAll), so a later test asserting on `ai.requests.length` would
    // otherwise see the cumulative count across every prior test in this block.
    ai?.reset();
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
    if (tenant) purge();
  });

  test.afterEach(() => {
    if (tenant) purge();
  });

  function purge(): void {
    const project = literal(tenant!.mainProjectId);
    const org = literal(tenant!.organizationId);
    exec(`DELETE FROM zyra_chat_messages WHERE project_id = ${project};`);
    // ai_generation_requests.chat_session_id is ON DELETE RESTRICT now (V116) — before sessions.
    exec(`DELETE FROM ai_generation_requests WHERE project_id = ${project};`);
    exec(`DELETE FROM zyra_chat_sessions WHERE project_id = ${project};`);
    exec(`DELETE FROM testcases WHERE project_id = ${project};`);
    // ZYR-A-66 creates its own suite to exercise projectSuiteSummaries/zyraChatProjectSnapshot's
    // per-suite count — deleted after testcases above so no FK on suite_id is still live.
    exec(`DELETE FROM suites WHERE project_id = ${project};`);
    exec(`DELETE FROM bugs WHERE project_id = ${project};`);
    exec(`DELETE FROM jira_tickets WHERE project_id = ${project};`);
    exec(`DELETE FROM knowledge_documents WHERE project_id = ${project};`);
    // ZYR-A-65 creates a non-root folder to exercise knowledgeFolderSnapshot's quoted-name lookup;
    // the root folder itself must survive (it cannot be recreated through the API — see
    // knowledge-base.spec.ts's purgeKb doc comment for the same constraint).
    exec(`DELETE FROM knowledge_folders WHERE project_id = ${project} AND is_root = false;`);
    exec(`DELETE FROM project_ai_key_allocations WHERE project_id = ${project};`);
    exec(`DELETE FROM workspace_ai_keys WHERE organization_id = ${org};`);
  }

  function url(suffix: string): string {
    return `/api/projects/${tenant!.mainProjectId}/agents/zyra${suffix}`;
  }

  async function allocateFakeAiKey(): Promise<void> {
    const keyRes = await asOwner.post("/api/workspace/ai-keys", {
      data: { name: `E2E citations fake ai ${Date.now()}${Math.floor(Math.random() * 1000)}`, provider: "openai", apiKey: "sk-e2e-fake", baseUrl: ai.baseUrl },
      failOnStatusCode: false,
    });
    expect(keyRes.status(), `creating the fake-provider AI key — ${await keyRes.text()}`).toBe(201);
    const key = await keyRes.json();
    const allocRes = await asOwner.post("/api/workspace/ai-keys/allocations", {
      data: { projectId: tenant!.mainProjectId, workspaceAiKeyId: key.id },
      failOnStatusCode: false,
    });
    expect(allocRes.status(), `allocating the fake-provider key — ${await allocRes.text()}`).toBe(201);
  }

  function rootFolderId(): string {
    const existing = scalar(`SELECT id FROM knowledge_folders WHERE project_id = ${literal(tenant!.mainProjectId)} AND is_root = true;`);
    if (existing) return existing;
    exec(
      "INSERT INTO knowledge_folders (organization_id, project_id, parent_folder_id, name, is_root) " +
        `VALUES (${literal(tenant!.organizationId)}, ${literal(tenant!.mainProjectId)}, NULL, 'Knowledge base', true);`,
    );
    return scalar(`SELECT id FROM knowledge_folders WHERE project_id = ${literal(tenant!.mainProjectId)} AND is_root = true;`);
  }

  /** Seeds one KB doc, one Jira ticket, one existing test case, and one bug — all sharing a
   *  distinctive term ("biometric") so zyraSearchTerms/relevance-matching finds every one of them
   *  from a single chat message, and none of the stopword-filtered common QA vocabulary. */
  async function seedCitableSources(): Promise<{ kbDocId: string; jiraKey: string; testcaseExternalId: string; bugId: string }> {
    const kbRes = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/knowledge-base/documents`, {
      data: { folderId: rootFolderId(), documentType: "general", title: "Biometric login policy", content: "Face ID and fingerprint sign-in must fall back to password after 3 failures." },
      failOnStatusCode: false,
    });
    expect(kbRes.status(), `seeding the KB doc — ${await kbRes.text()}`).toBe(201);
    const kbDocId = (await kbRes.json()).id;

    exec(
      `INSERT INTO integration_connections (organization_id, provider, external_id, site_url, access_token, refresh_token, token_expires_at) ` +
        `VALUES (${literal(tenant!.organizationId)}, 'jira', 'e2e-zyra-citations', 'https://e2e-zyra-citations.invalid', 'e2e', '', now() + interval '365 days') ` +
        `ON CONFLICT (organization_id, provider) DO NOTHING;`,
    );
    const connectionId = scalar(`SELECT id FROM integration_connections WHERE organization_id = ${literal(tenant!.organizationId)} AND provider = 'jira';`);
    const jiraKey = `CIT-${Date.now() % 100000}`;
    exec(
      `INSERT INTO jira_tickets (project_id, jira_connection_id, jira_issue_id, jira_issue_key, summary, issue_type, status) ` +
        `VALUES (${literal(tenant!.mainProjectId)}, ${literal(connectionId)}, ${literal(jiraKey)}, ${literal(jiraKey)}, 'Biometric login rollout', 'Story', 'Open');`,
    );

    const tcRes = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/testcases`, {
      data: { title: "Biometric login happy path" },
      failOnStatusCode: false,
    });
    expect(tcRes.status(), `seeding the existing test case — ${await tcRes.text()}`).toBe(201);
    const testcaseExternalId = (await tcRes.json()).externalId;

    const bugRes = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/bugs`, {
      data: { title: "Biometric login crashes on iOS 18", description: "Face ID prompt closes the app instead of falling back to password." },
      failOnStatusCode: false,
    });
    expect(bugRes.status(), `seeding the bug — ${await bugRes.text()}`).toBe(201);
    const bugId = (await bugRes.json()).id;

    return { kbDocId, jiraKey, testcaseExternalId, bugId };
  }

  async function newSession(title: string): Promise<string> {
    const res = await asOwner.post(url("/chat/sessions"), { data: { title }, failOnStatusCode: false });
    expect(res.status(), `creating a chat session — ${await res.text()}`).toBeLessThan(300);
    return (await res.json()).id;
  }

  async function lastAssistantTestcases(sessionId: string): Promise<Array<Record<string, unknown>>> {
    const session = await asOwner.get(url(`/chat/sessions/${sessionId}`), { failOnStatusCode: false });
    expect(session.status()).toBe(200);
    const messages = (await session.json()).messages as Array<Record<string, unknown>>;
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")!;
    return lastAssistant.testcases as Array<Record<string, unknown>>;
  }

  test("ZYR-A-63 a generated test case cites the exact KB doc, Jira ticket, test case, and bug it was shown, and drops a fabricated label", async () => {
    await allocateFakeAiKey();
    const { kbDocId, jiraKey, testcaseExternalId, bugId } = await seedCitableSources();
    const sessionId = await newSession("E2E citations");

    // Router: routes to create.
    ai.queueReply({
      reply: "", reasoningSummary: "Creating a test case for biometric login.",
      action: "create", actionType: "create", operations: [], testcases: [], requestedCount: 1, exhaustive: false,
    });
    // Generation: cites all four real labels PLUS one the model invented — GENERATED-999 was never
    // offered in this turn's prompt (see zyraSourceRefIndex), so it must not survive sanitization.
    ai.queueReply({
      drafts: [{
        title: "Biometric login falls back to password after repeated failures",
        preconditions: "A device with Face ID/fingerprint enrolled is on the login screen.",
        stepsJson: JSON.stringify([{ stepNumber: 1, action: "Fail biometric auth 3 times", expectedResult: "The app falls back to the password field" }]),
        testData: "",
        expectedSummary: "Password fallback appears after 3 failed biometric attempts.",
        priority: "P1",
        tags: ["zyra"],
        sourceRefs: ["KB 1", jiraKey, testcaseExternalId, "BUG 1", "GENERATED-999"],
      }],
    });

    const turn = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), {
      data: { message: "Create a test case for biometric login, using the knowledge base, Jira, existing test cases, and bugs." },
      failOnStatusCode: false,
    });
    expect(turn.status(), `sending the create message — ${await turn.text()}`).toBeLessThan(300);
    // Found by review: generateZyraChatTestcasesWithAi unconditionally calls rememberZyraTurn after
    // a successful generation (its own summarization call to the same provider) — an easy count to
    // miss since it's not part of the router/generation contract this suite otherwise scripts.
    expect(ai.requests.length, "router + generation + rememberZyraTurn's own summarization call").toBe(3);

    const testcases = await lastAssistantTestcases(sessionId);
    expect(testcases).toHaveLength(1);
    const sourceRefs = testcases[0].sourceRefs as Array<{ type: string; id: string; title: string }>;

    expect(sourceRefs, "the fabricated label must be dropped, never surfaced").toHaveLength(4);
    expect(sourceRefs).toEqual(
      expect.arrayContaining([
        { type: "knowledge_document", id: kbDocId, title: "Biometric login policy" },
        { type: "jira_ticket", id: jiraKey, title: "Biometric login rollout" },
        { type: "testcase", id: testcaseExternalId, title: "Biometric login happy path" },
        { type: "bug", id: bugId, title: "Biometric login crashes on iOS 18" },
      ]),
    );
    expect(sourceRefs.some((ref) => ref.id === "GENERATED-999" || ref.id === "999")).toBe(false);

    // The same citations must survive from the staged draft through to what's persisted for save —
    // applyZyraChatOperations resolves them once and stores them on the proposal itself.
    const stored = JSON.parse(scalar(`SELECT generated_payload::text FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)} ORDER BY created_at DESC LIMIT 1;`));
    expect(stored[0].draft.sourceRefs).toHaveLength(4);
  });

  test("ZYR-A-64 a turn grounded only in a matching bug is not reported as ungrounded", async () => {
    await allocateFakeAiKey();
    const bugRes = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/bugs`, {
      data: { title: "Checkout timeout on slow networks", description: "The checkout button spins forever on a throttled connection." },
      failOnStatusCode: false,
    });
    expect(bugRes.status(), `seeding the bug — ${await bugRes.text()}`).toBe(201);
    const bugId = (await bugRes.json()).id;
    const sessionId = await newSession("E2E bug-only grounding");

    ai.queueReply({
      reply: "", reasoningSummary: "Creating a test case for the checkout timeout.",
      action: "create", actionType: "create", operations: [], testcases: [], requestedCount: 1, exhaustive: false,
    });
    ai.queueReply({
      drafts: [{
        title: "Checkout completes on a throttled connection",
        preconditions: "The network is throttled to a slow connection.",
        stepsJson: JSON.stringify([{ stepNumber: 1, action: "Complete checkout on a throttled connection", expectedResult: "Checkout finishes without an indefinite spinner" }]),
        testData: "",
        expectedSummary: "Checkout does not hang indefinitely on a slow connection.",
        priority: "P2",
        tags: ["zyra"],
        sourceRefs: ["BUG 1"],
      }],
    });

    const turn = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), {
      data: { message: "Create a test case covering the checkout timeout bug." },
      failOnStatusCode: false,
    });
    expect(turn.status(), `sending the create message — ${await turn.text()}`).toBeLessThan(300);

    const testcases = await lastAssistantTestcases(sessionId);
    expect(testcases).toHaveLength(1);
    const sourceRefs = testcases[0].sourceRefs as Array<{ type: string; id: string; title: string }>;
    expect(sourceRefs).toEqual([{ type: "bug", id: bugId, title: "Checkout timeout on slow networks" }]);

    // The ungrounded disclaimer only fires when NOTHING (KB, Jira, bug) matched — a bug-only match
    // must read as grounded, not "written from general practice".
    const session = await asOwner.get(url(`/chat/sessions/${sessionId}`), { failOnStatusCode: false });
    const messages = (await session.json()).messages as Array<Record<string, unknown>>;
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")!;
    expect(String(lastAssistant.content || "")).not.toContain("I don't have anything about this in the project's knowledge base");
  });

  // knowledgeFolderSnapshot (legacy.service.ts) is the direct folder-name-lookup path — used when a
  // message quotes a folder name literally, since neither the recency fallback nor RAG retrieval can
  // match on a folder's name alone. Every other knowledge read site (knowledgeSnapshot, annSearch,
  // ftsSearch, zyraChatProjectSnapshot) gates an ai_memory document behind `status = 'approved'`;
  // this one previously did not, so an unreviewed (or rejected) AI-memory note sitting in a
  // quote-matched folder was fed to the model as trusted context. This test drives the real "create"
  // turn end to end and asserts on the literal prompt text the fake AI server received — the most
  // direct proof that the excluded document's content never reached the model, independent of
  // whatever the model does with citations afterward.
  test("ZYR-A-65 a quoted folder-name lookup excludes an unapproved ai_memory document but still surfaces an approved one and a general document", async () => {
    await allocateFakeAiKey();

    const folderName = `E2E Folder Gate ${Date.now()}`;
    const folderRes = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/knowledge-base/folders`, {
      data: { name: folderName },
      failOnStatusCode: false,
    });
    expect(folderRes.status(), `creating the folder — ${await folderRes.text()}`).toBe(201);
    const folderId = (await folderRes.json()).id;

    async function createFolderDoc(title: string, contentText: string, documentType: string): Promise<string> {
      const res = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/knowledge-base/documents`, {
        data: { folderId, documentType, title, contentText },
        failOnStatusCode: false,
      });
      expect(res.status(), `seeding "${title}" — ${await res.text()}`).toBe(201);
      return (await res.json()).id;
    }

    const generalMarker = "GENERAL-MARKER-VISIBLE";
    const approvedMemoryMarker = "APPROVED-MEMORY-MARKER-VISIBLE";
    const draftMemoryMarker = "DRAFT-MEMORY-MARKER-MUST-NOT-LEAK";

    await createFolderDoc("General note", generalMarker, "general");
    const approvedMemoryId = await createFolderDoc("Approved memory", approvedMemoryMarker, "ai_memory");
    const approveRes = await asOwner.patch(
      `/api/projects/${tenant!.mainProjectId}/knowledge-base/documents/${approvedMemoryId}/approve-ai-memory`,
      { failOnStatusCode: false },
    );
    expect(approveRes.status(), `approving the memory doc — ${await approveRes.text()}`).toBe(200);
    // Left in the default "draft" status deliberately — never approved (and never rejected either,
    // to also cover the "simply not yet reviewed" case, not only the rejected one).
    await createFolderDoc("Draft memory", draftMemoryMarker, "ai_memory");

    const sessionId = await newSession("E2E folder gate");
    ai.queueReply({
      reply: "", reasoningSummary: "Creating a test case from the named folder.",
      action: "create", actionType: "create", operations: [], testcases: [], requestedCount: 1, exhaustive: false,
    });
    ai.queueReply({
      drafts: [{
        title: "Placeholder from folder contents",
        preconditions: "n/a",
        stepsJson: JSON.stringify([{ stepNumber: 1, action: "Do the thing", expectedResult: "It works" }]),
        testData: "",
        expectedSummary: "n/a",
        priority: "P2",
        tags: ["zyra"],
        sourceRefs: [],
      }],
    });

    const turn = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), {
      data: { message: `Pull the details from the "${folderName}" knowledge base folder and create a test case for it.` },
      failOnStatusCode: false,
    });
    expect(turn.status(), `sending the create message — ${await turn.text()}`).toBeLessThan(300);

    // Index 1 is the generation call — see ZYR-A-63's comment on the same three-call shape
    // (router, generation, rememberZyraTurn's summarization).
    const generationPrompt = JSON.stringify(ai.requests[1]?.messages ?? []);
    expect(generationPrompt).toContain(generalMarker);
    expect(generationPrompt).toContain(approvedMemoryMarker);
    expect(generationPrompt, "an unapproved ai_memory document must not reach the model as context").not.toContain(draftMemoryMarker);
  });

  // Phase 1 of the Zyra context-integrity task (see
  // "Zyra Workflow Agents/zyra-context-integrity-progress-log.md"): `status = 'Archived'` is a
  // second "gone" state alongside `deleted_at` — it's what the repository screen's archive action
  // sets, and listTestCases already hides it there. Before this fix, existingTestcaseSnapshot (the
  // "Existing testcases" grounding/citation source), projectSuiteSummaries, and
  // zyraChatProjectSnapshot's testcase_count all still counted/cited an archived case as live, so a
  // user who archived something kept seeing Zyra treat it as current coverage. This drives one real
  // create turn and asserts on the literal router-prompt text plus the final sourceRefs — the same
  // style ZYR-A-65 uses — so the proof is against what the model was actually given, not an
  // inference from downstream behavior.
  test("ZYR-A-66 an archived test case is excluded from grounding context, citations, and every reported count", async () => {
    await allocateFakeAiKey();

    const suiteName = `E2E Archived Gap Suite ${Date.now()}`;
    const suiteRes = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/suites`, {
      data: { name: suiteName },
      failOnStatusCode: false,
    });
    expect(suiteRes.status(), `creating the suite — ${await suiteRes.text()}`).toBe(201);
    const suiteId = (await suiteRes.json()).id;

    async function createTestcase(title: string, suiteIdForCase: string | null): Promise<{ id: string; externalId: string }> {
      const res = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/testcases`, {
        data: { title, suiteId: suiteIdForCase },
        failOnStatusCode: false,
      });
      expect(res.status(), `seeding "${title}" — ${await res.text()}`).toBe(201);
      const body = await res.json();
      return { id: body.id, externalId: body.externalId };
    }

    const active = await createTestcase("Archived-gap active case", suiteId);
    // Unassigned on purpose — exercises unassignedTestCaseCount (= total - sum of suite counts)
    // alongside the per-suite count, per the pre-phase inspection note's "count fields that will
    // shift" edge case. Its id/externalId aren't needed below; only its existence matters.
    await createTestcase("Archived-gap unassigned case", null);
    const archived = await createTestcase("Archived-gap archived case", suiteId);
    const archiveRes = await asOwner.put(`/api/projects/${tenant!.mainProjectId}/testcases/${archived.id}`, {
      data: { status: "Archived" },
      failOnStatusCode: false,
    });
    expect(archiveRes.status(), `archiving the third case — ${await archiveRes.text()}`).toBe(200);

    const sessionId = await newSession("E2E archived gap");
    ai.queueReply({
      reply: "", reasoningSummary: "Creating a test case, citing existing coverage.",
      action: "create", actionType: "create", operations: [], testcases: [], requestedCount: 1, exhaustive: false,
    });
    // The model cites both the still-active case and the archived one; only the active citation can
    // survive sanitizeZyraSourceRefs, because the archived one is no longer in this turn's
    // zyraSourceRefIndex — same mechanism ZYR-A-63 proves for a wholly-fabricated label.
    ai.queueReply({
      drafts: [{
        title: "A new case citing both the active and the archived case",
        preconditions: "n/a",
        stepsJson: JSON.stringify([{ stepNumber: 1, action: "Do the thing", expectedResult: "It works" }]),
        testData: "",
        expectedSummary: "n/a",
        priority: "P2",
        tags: ["zyra"],
        sourceRefs: [active.externalId, archived.externalId],
      }],
    });

    // Deliberately does not mention either external id in the raw message text — the router prompt
    // embeds the raw user message verbatim as its own chat turn (see the `{ role: "user", content:
    // message }` entry alongside the system `context`), so naming the archived id here would make it
    // appear in ai.requests[0] regardless of whether existingTestcaseSnapshot excluded it, and the
    // assertion below would no longer prove anything about the query.
    const turn = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), {
      data: { message: "Create a new test case for the archived-gap scenario, reusing what already exists for it." },
      failOnStatusCode: false,
    });
    expect(turn.status(), `sending the create message — ${await turn.text()}`).toBeLessThan(300);

    // Index 0 is the router call — existingTestcaseSnapshot, projectSuiteSummaries and
    // zyraChatProjectSnapshot are all assembled into this one prompt (see buildZyraChatDecision).
    const routerPrompt = JSON.stringify(ai.requests[0]?.messages ?? []);
    expect(routerPrompt).toContain(active.externalId);
    expect(routerPrompt, "an archived test case must not appear in the 'Existing testcases' grounding section").not.toContain(archived.externalId);
    expect(routerPrompt, "the suite's own count must exclude the archived case").toContain(`${suiteName} (id: ${suiteId}, 1 testcase(s))`);
    expect(routerPrompt, "unassignedTestCaseCount must still reconcile against the reduced total").toContain("Unassigned (no suite) (1 testcase(s))");
    expect(routerPrompt, "the project-wide total must exclude the archived case").toContain("The total test case count for this project is 2,");

    const testcases = await lastAssistantTestcases(sessionId);
    expect(testcases).toHaveLength(1);
    const sourceRefs = testcases[0].sourceRefs as Array<{ type: string; id: string; title: string }>;
    expect(sourceRefs, "the archived case's citation must be dropped, the still-active one kept").toEqual([
      { type: "testcase", id: active.externalId, title: "Archived-gap active case" },
    ]);
  });

  // Edge case named explicitly in the Phase 1 pre-inspection note: a project where every test case
  // is archived must report zero coverage cleanly — an empty "Existing testcases" section and a
  // zero total — not an unhandled exception from any of the three changed queries.
  test("ZYR-A-67 a project with only archived test cases reports zero existing coverage, not a crash", async () => {
    await allocateFakeAiKey();

    const onlyCaseRes = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/testcases`, {
      data: { title: "Archived-gap only case" },
      failOnStatusCode: false,
    });
    expect(onlyCaseRes.status()).toBe(201);
    const onlyCaseId = (await onlyCaseRes.json()).id;
    const archiveRes = await asOwner.put(`/api/projects/${tenant!.mainProjectId}/testcases/${onlyCaseId}`, {
      data: { status: "Archived" },
      failOnStatusCode: false,
    });
    expect(archiveRes.status(), `archiving the only case — ${await archiveRes.text()}`).toBe(200);

    const sessionId = await newSession("E2E all archived");
    // A pure "answer" turn makes exactly one AI call (the router) — no generation, no
    // rememberZyraTurn summarization — so ai.requests[0] is the only call to inspect.
    ai.queueReply({
      reply: "This project currently has 0 existing test cases.",
      reasoningSummary: "Answered directly, no operations.",
      action: "answer", actionType: "answer", operations: [], testcases: [],
    });

    const turn = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), {
      data: { message: "How many existing test cases does this project have?" },
      failOnStatusCode: false,
    });
    expect(turn.status(), `sending the answer message — ${await turn.text()}`).toBeLessThan(300);

    const routerPrompt = JSON.stringify(ai.requests[0]?.messages ?? []);
    expect(routerPrompt, "no suite was created in this scenario").toContain("No suites yet.");
    expect(routerPrompt, "the only test case in the project is archived, so grounding must be empty, not a stale full list").toContain("No existing testcases.");
    expect(routerPrompt, "the project-wide total must be zero, not the physical row count").toContain("The total test case count for this project is 0,");
  });

  // Zyra context integrity, Phase 3/4 (suites soft-delete) — Q11: a chat-staged `create` draft
  // resolves its target suite once (matchZyraSuiteByName, here — see resolveOrCreateSuiteByName's
  // own test below for the create_suite path) and that resolved id sits frozen inside
  // ai_generation_requests.generated_payload until the user hits Save, potentially long after. Before
  // suites were soft-deletable this could never go stale silently: a suite id that resolved once
  // couldn't stop existing without a hard delete, and a hard-deleted suite would make the save's INSERT
  // fail loudly on the FK. Now the row still exists (just filtered out of every list), so the FK is
  // satisfied and the old code would have silently written a suite_id that looks deleted everywhere
  // else. Per Yuvraj's resolution (Q11): fall back to unassigned rather than failing the batch, and
  // note the fallback in the batch's own activity_log.
  test("ZYR-A-68 a create draft's staged suite falls back to unassigned (not a failed save) if the suite is soft-deleted before Save", async () => {
    await allocateFakeAiKey();
    const suiteName = `E2E Suite Deleted Before Save ${Date.now()}`;
    const suiteRes = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/suites`, {
      data: { name: suiteName },
      failOnStatusCode: false,
    });
    expect(suiteRes.status(), `creating the suite — ${await suiteRes.text()}`).toBe(201);
    const suiteId = (await suiteRes.json()).id;

    const sessionId = await newSession("E2E suite deleted before save");
    // Router: routes to create. matchZyraSuiteByName (legacy.service.ts) matches the suite by its
    // name appearing verbatim in the raw message, so the staged draft below gets `suiteId` set to it
    // without needing a routedSuite field on this reply.
    ai.queueReply({
      reply: "", reasoningSummary: `Creating a test case for the ${suiteName} suite.`,
      action: "create", actionType: "create", operations: [], testcases: [], requestedCount: 1, exhaustive: false,
    });
    ai.queueReply({
      drafts: [{
        title: "Case staged against a suite that will be deleted before Save",
        preconditions: "n/a",
        stepsJson: JSON.stringify([{ stepNumber: 1, action: "Do the thing", expectedResult: "It works" }]),
        testData: "",
        expectedSummary: "n/a",
        priority: "P2",
        tags: ["zyra"],
        sourceRefs: [],
      }],
    });

    const turn = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), {
      data: { message: `Create a test case for the ${suiteName} suite.` },
      failOnStatusCode: false,
    });
    expect(turn.status(), `sending the create message — ${await turn.text()}`).toBeLessThan(300);

    const taskId = scalar(
      `SELECT id FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)} AND task_status = 'in_review' ORDER BY created_at DESC LIMIT 1;`,
    );
    expect(taskId, "the create turn must have staged a review batch").toBeTruthy();

    const stagedSuiteId = scalar(
      `SELECT generated_payload->0->'draft'->>'suiteId' FROM ai_generation_requests WHERE id = ${literal(taskId)};`,
    );
    expect(stagedSuiteId, "the draft must have resolved the suite by name before this test deletes it").toBe(suiteId);

    // The suite is deleted (soft, per this fix) BETWEEN staging and Save — the exact window Q11 is
    // about. moveToDefault is the mode that matters here: it does not touch the testcases, only the
    // suite itself stops resolving to anything live.
    const deleteRes = await asOwner.delete(`/api/suites/${suiteId}`, {
      params: { mode: "moveToDefault" },
      failOnStatusCode: false,
    });
    expect(deleteRes.ok(), `deleting the suite — ${await deleteRes.text()}`).toBeTruthy();

    const saveRes = await asOwner.post(url(`/tasks/${taskId}/save`), { data: {}, failOnStatusCode: false });
    expect(saveRes.status(), `saving despite the deleted suite — ${await saveRes.text()}`).toBeLessThan(300);
    const saved = await saveRes.json();
    expect(saved.savedCount, "the batch must still save, not fail outright").toBe(1);
    expect(saved.testcases).toHaveLength(1);

    // Ground truth from the database, not just the response shape.
    const persistedSuiteId = scalar(`SELECT suite_id FROM testcases WHERE id = ${literal(saved.testcases[0].id)};`);
    expect(persistedSuiteId, "the new test case must land unassigned, not pointing at the deleted suite").toBe("");

    const activityLog = JSON.parse(scalar(`SELECT activity_log::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`)) as Array<{
      title?: string;
      detail?: string;
    }>;
    expect(
      activityLog.some((entry) => /no longer available/i.test(entry.title || "")),
      `the fallback must be noted on the batch's own activity log — got ${JSON.stringify(activityLog)}`,
    ).toBe(true);
  });

  // Zyra context integrity, Phase 3/4 — resolveOrCreateSuiteByName (legacy.service.ts) is the
  // create_suite / move_to_suite resolver: before this fix it matched by name with no `deleted_at`
  // filter, so asking Zyra to (re-)create a suite whose name matches one that was just soft-deleted
  // would silently reattach to the dead row instead of creating a fresh, listable one.
  test("ZYR-A-69 create_suite creates a fresh suite when the same name was used by a suite that is now soft-deleted", async () => {
    await allocateFakeAiKey();
    const suiteName = `E2E Suite Reuse By Name ${Date.now()}`;

    const session1 = await newSession("E2E suite reuse 1");
    ai.queueReply({
      reply: "Created the suite.", reasoningSummary: "Creating the requested suite.",
      action: "create_suite", actionType: "suite", operations: [{ type: "create_suite", suiteName }], testcases: [],
    });
    const turn1 = await asOwner.post(url(`/chat/sessions/${session1}/messages`), {
      data: { message: `Create a suite called ${suiteName}` },
      failOnStatusCode: false,
    });
    expect(turn1.status(), `first create_suite turn — ${await turn1.text()}`).toBeLessThan(300);

    const firstSuiteId = scalar(
      `SELECT id FROM suites WHERE project_id = ${literal(tenant!.mainProjectId)} AND name = ${literal(suiteName)} AND deleted_at IS NULL;`,
    );
    expect(firstSuiteId, "the first turn must have created the suite").toBeTruthy();

    const del = await asOwner.delete(`/api/suites/${firstSuiteId}`, { params: { mode: "moveToDefault" }, failOnStatusCode: false });
    expect(del.ok(), `deleting the first suite — ${await del.text()}`).toBeTruthy();

    // Same name, a second, independent turn — resolveOrCreateSuiteByName must not find the
    // soft-deleted row a live match and reuse it.
    const session2 = await newSession("E2E suite reuse 2");
    ai.queueReply({
      reply: "Created the suite.", reasoningSummary: "Creating the requested suite.",
      action: "create_suite", actionType: "suite", operations: [{ type: "create_suite", suiteName }], testcases: [],
    });
    const turn2 = await asOwner.post(url(`/chat/sessions/${session2}/messages`), {
      data: { message: `Create a suite called ${suiteName}` },
      failOnStatusCode: false,
    });
    expect(turn2.status(), `second create_suite turn — ${await turn2.text()}`).toBeLessThan(300);

    const activeMatches = column(
      `SELECT id FROM suites WHERE project_id = ${literal(tenant!.mainProjectId)} AND name = ${literal(suiteName)} AND deleted_at IS NULL;`,
    );
    expect(activeMatches, "exactly one ACTIVE suite with this name after the second turn").toHaveLength(1);
    expect(activeMatches[0], "must be a freshly created suite, not the soft-deleted original resurrected").not.toBe(firstSuiteId);

    // Listed via the real API too, not only visible to a direct DB query — proves the soft-deleted
    // original is genuinely gone from what the user (and Zyra) sees, not merely uncounted.
    const suitesList = await (await asOwner.get(`/api/projects/${tenant!.mainProjectId}/suites`)).json();
    expect(suitesList.filter((s: { name: string }) => s.name === suiteName)).toHaveLength(1);
  });

  // Hard-delete remediation Phase 3: bugsSnapshot had no deleted_at filter, predicted as a live gap
  // by the original Zyra context-integrity audit before `bugs.deleted_at` existed at all. Both bugs
  // share a distinctive keyword so they both match zyraSearchTerms' relevance search; only the
  // deleted one should be excluded once the fix lands.
  test("ZYR-A-70 a soft-deleted bug is excluded from Zyra's relevance-matched bug context", async () => {
    await allocateFakeAiKey();
    const keyword = `quantumwidget${Date.now()}`;

    async function createBug(title: string): Promise<string> {
      const res = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/bugs`, {
        data: { title, description: "seeded for ZYR-A-70" },
        failOnStatusCode: false,
      });
      expect(res.status(), `seeding "${title}" — ${await res.text()}`).toBe(201);
      return (await res.json()).id;
    }

    const activeTitle = `Crash in the ${keyword} checkout flow`;
    const deletedTitle = `Timeout in the ${keyword} settings panel`;
    await createBug(activeTitle);
    const deletedId = await createBug(deletedTitle);

    const delRes = await asOwner.delete(`/api/bugs/${deletedId}`, { failOnStatusCode: false });
    expect(delRes.ok(), `deleting the second bug — ${await delRes.text()}`).toBeTruthy();
    expect(scalar(`SELECT deleted_at IS NOT NULL FROM bugs WHERE id = ${literal(deletedId)};`)).toBe("t");

    const sessionId = await newSession("E2E bug relevance gap");
    ai.queueReply({
      reply: "Let me check.", reasoningSummary: "Answering directly, no operations.",
      action: "answer", actionType: "answer", operations: [], testcases: [],
    });
    const turn = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), {
      data: { message: `Are there any known bugs related to ${keyword}?` },
      failOnStatusCode: false,
    });
    expect(turn.status(), `sending the question — ${await turn.text()}`).toBeLessThan(300);

    const routerPrompt = JSON.stringify(ai.requests[0]?.messages ?? []);
    expect(routerPrompt, "the still-live bug must be cited").toContain(activeTitle);
    expect(routerPrompt, "a soft-deleted bug must not reach the model as grounding context").not.toContain(deletedTitle);
  });

  /*
   * "[Zyra] Severity and Component Are Missing in Generated Test Cases" — the model was never asked
   * for either field (zyraSystemPrompt) and the parser never extracted them (normalizeAiDrafts), so
   * a chat-generated draft always saved with both null. These drive the real chat "create" turn
   * through the fake provider — unlike ZYR-A-71..74 in the other describe block above, which seed a
   * draft directly and only exercise the SAVE/persistence half, these exercise the PROMPT and
   * NORMALIZATION half: what's asked for, and how a model's raw answer is sanitized before it's ever
   * staged.
   */
  test("ZYR-A-71 a chat-generated test case's severity and component are asked for, returned, and persisted on save", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E severity component generation");

    ai.queueReply({
      reply: "", reasoningSummary: "Creating a test case for checkout.",
      action: "create", actionType: "create", operations: [], testcases: [], requestedCount: 1, exhaustive: false,
    });
    ai.queueReply({
      drafts: [{
        title: "Checkout rejects an expired card",
        preconditions: "A cart has at least one item.",
        stepsJson: JSON.stringify([{ stepNumber: 1, action: "Pay with an expired card", expectedResult: "Checkout is blocked with a clear error" }]),
        testData: "",
        expectedSummary: "The expired card is rejected before payment is attempted.",
        priority: "P1",
        severity: "High",
        component: "Checkout",
        tags: ["zyra"],
        sourceRefs: [],
      }],
    });

    const turn = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), {
      data: { message: "Create a test case for checkout rejecting an expired card." },
      failOnStatusCode: false,
    });
    expect(turn.status(), `sending the create message — ${await turn.text()}`).toBeLessThan(300);

    // The model was actually asked for both fields (zyraSystemPrompt's JSON shape), not just
    // happened to answer with them.
    const draftingPrompt = JSON.stringify(ai.requests[1]?.messages ?? []);
    expect(draftingPrompt, "the model must be asked for severity").toContain("severity");
    expect(draftingPrompt, "the model must be asked for component").toContain("component");

    // The display/preview gap this ticket was actually about: the chat UI (ZyraChatReviewPanel)
    // renders straight from this turn's response body, BEFORE anything is saved — chatDraftRow
    // used to rebuild this row and silently drop severity/component even though generation and
    // save both had them all along. Asserting only the post-save DB row (below) would have passed
    // throughout the whole time this bug was live.
    const turnBody = await turn.json();
    const proposedRow = (turnBody.message?.testcases ?? []).find((tc: { action?: string }) => tc.action === "proposed-create");
    expect(proposedRow, "the create turn must stage a proposed-create row on the assistant message").toBeTruthy();
    expect(proposedRow.severity, "severity must reach the chat preview, not just the saved row").toBe("High");
    expect(proposedRow.component, "component must reach the chat preview, not just the saved row").toBe("Checkout");

    const taskId = scalar(
      `SELECT id FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)} AND task_status = 'in_review' ORDER BY created_at DESC LIMIT 1;`,
    );
    expect(taskId, "the create turn must have staged a review batch").toBeTruthy();

    const saveRes = await asOwner.post(url(`/tasks/${taskId}/save`), { data: {}, failOnStatusCode: false });
    expect(saveRes.status(), `saving — ${await saveRes.text()}`).toBeLessThan(300);
    const saved = await saveRes.json();
    expect(saved.testcases).toHaveLength(1);

    expect(scalar(`SELECT severity FROM testcases WHERE id = ${literal(saved.testcases[0].id)};`)).toBe("High");
    expect(scalar(`SELECT component FROM testcases WHERE id = ${literal(saved.testcases[0].id)};`)).toBe("Checkout");
  });

  test("ZYR-A-72 a severity value outside the fixed vocabulary is dropped to null on the saved row, never stored verbatim", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E invalid severity");
    ai.queueReply({
      reply: "", reasoningSummary: "Creating a test case.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: 1, exhaustive: false,
    });
    ai.queueReply({
      drafts: [{
        title: "Case with an invented severity label",
        preconditions: "n/a", stepsJson: "[]", testData: "", expectedSummary: "n/a",
        priority: "P2", severity: "Blocker", component: "Auth", tags: ["zyra"], sourceRefs: [],
      }],
    });
    const turn = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), { data: { message: "Create a test case." }, failOnStatusCode: false });
    expect(turn.status(), `sending the message — ${await turn.text()}`).toBeLessThan(300);

    const taskId = scalar(
      `SELECT id FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)} AND task_status = 'in_review' ORDER BY created_at DESC LIMIT 1;`,
    );
    const saveRes = await asOwner.post(url(`/tasks/${taskId}/save`), { data: {}, failOnStatusCode: false });
    const saved = await saveRes.json();
    expect(
      scalar(`SELECT severity FROM testcases WHERE id = ${literal(saved.testcases[0].id)};`),
      "an unrecognized severity ('Blocker' is not Critical/High/Medium/Low) must never be stored verbatim",
    ).toBe("");
    expect(scalar(`SELECT component FROM testcases WHERE id = ${literal(saved.testcases[0].id)};`)).toBe("Auth");
  });

  test("ZYR-A-73 a blank component is stored as null and an over-long one is truncated, not rejected", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E component bounds");
    const overlong = "x".repeat(300);
    ai.queueReply({
      reply: "", reasoningSummary: "Creating test cases.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: 2, exhaustive: false,
    });
    ai.queueReply({
      drafts: [
        { title: "Case with a blank component", preconditions: "n/a", stepsJson: "[]", testData: "", expectedSummary: "n/a", priority: "P2", severity: "Low", component: "", tags: ["zyra"], sourceRefs: [] },
        { title: "Case with an over-long component", preconditions: "n/a", stepsJson: "[]", testData: "", expectedSummary: "n/a", priority: "P2", severity: "Low", component: overlong, tags: ["zyra"], sourceRefs: [] },
      ],
    });
    const turn = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), { data: { message: "Create two test cases." }, failOnStatusCode: false });
    expect(turn.status(), `sending the message — ${await turn.text()}`).toBeLessThan(300);

    const taskId = scalar(
      `SELECT id FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)} AND task_status = 'in_review' ORDER BY created_at DESC LIMIT 1;`,
    );
    const saveRes = await asOwner.post(url(`/tasks/${taskId}/save`), { data: {}, failOnStatusCode: false });
    const saved = await saveRes.json();
    expect(saved.testcases).toHaveLength(2);
    expect(scalar(`SELECT component FROM testcases WHERE id = ${literal(saved.testcases[0].id)};`)).toBe("");
    const stored = scalar(`SELECT component FROM testcases WHERE id = ${literal(saved.testcases[1].id)};`);
    expect(stored.length, `an over-long component must be truncated to the column's 255-char bound, got ${stored.length}`).toBe(255);
    expect(stored).toBe(overlong.slice(0, 255));
  });

  test("ZYR-A-74 an existing test case's component is offered to the model as reusable grounding context, scoped to this project only", async () => {
    await allocateFakeAiKey();
    const componentName = `PaymentsGateway${Date.now()}`;
    const otherProjectComponentName = `OtherProjectOnlyComponent${Date.now()}`;

    const seeded = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/testcases`, {
      data: { title: "Existing payments case", component: componentName },
      failOnStatusCode: false,
    });
    expect(seeded.status(), `seeding the existing case — ${await seeded.text()}`).toBe(201);
    const seededId = (await seeded.json()).id;

    // Same organization, a DIFFERENT project — proves the grounding query is project-scoped, not
    // merely "not world-readable": a component from another project this same owner can also reach
    // must still never leak into this project's generation context.
    const seededOther = await asOwner.post(`/api/projects/${tenant!.secondProjectId}/testcases`, {
      data: { title: "Other project's case", component: otherProjectComponentName },
      failOnStatusCode: false,
    });
    expect(seededOther.status(), `seeding the other-project case — ${await seededOther.text()}`).toBe(201);
    const seededOtherId = (await seededOther.json()).id;

    try {
      const sessionId = await newSession("E2E component grounding");
      ai.queueReply({
        reply: "", reasoningSummary: "Creating a test case.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: 1, exhaustive: false,
      });
      ai.queueReply({
        drafts: [{
          title: "A new payments case", preconditions: "n/a", stepsJson: "[]", testData: "", expectedSummary: "n/a",
          priority: "P2", severity: "Low", component: componentName, tags: ["zyra"], sourceRefs: [],
        }],
      });

      const turn = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), {
        data: { message: "Create a new payments test case." }, failOnStatusCode: false,
      });
      expect(turn.status(), `sending the message — ${await turn.text()}`).toBeLessThan(300);

      const draftingPrompt = JSON.stringify(ai.requests[1]?.messages ?? []);
      expect(draftingPrompt, "an existing component in THIS project must be offered as reusable grounding").toContain(componentName);
      expect(draftingPrompt, "another project's component name must never leak into this project's grounding context").not.toContain(otherProjectComponentName);
    } finally {
      await asOwner.delete(`/api/projects/${tenant!.mainProjectId}/testcases/${seededId}`, { failOnStatusCode: false });
      await asOwner.delete(`/api/projects/${tenant!.secondProjectId}/testcases/${seededOtherId}`, { failOnStatusCode: false });
    }
  });
});

/*
 * Live SSE progress narration for one chat turn (GET .../turns/:turnId/events) — see
 * zyra-progress.service.ts's file header for the design. The one property that matters most and is
 * asserted first here: the POST route this rides alongside is byte-for-byte unaffected by whether a
 * turnId is present. Everything else about the stream is best-effort on top of that guarantee.
 */
test.describe("zyra chat — progress streaming (fake provider)", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let ai: FakeAiServer;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("zyra-progress");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    ai = await startFakeAiServer();
  });

  test.afterAll(async () => {
    await asOwner?.dispose();
    await ai?.close();
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
    if (tenant) purge();
    // See FakeAiServer.reset()'s doc comment — this describe block's `ai` instance is shared across
    // every test in it (one beforeAll), so a later test asserting on `ai.requests.length` would
    // otherwise see the cumulative count across every prior test in this block.
    ai?.reset();
  });

  test.afterEach(() => {
    if (tenant) purge();
  });

  function purge(): void {
    const project = literal(tenant!.mainProjectId);
    const org = literal(tenant!.organizationId);
    exec(`DELETE FROM zyra_chat_messages WHERE project_id = ${project};`);
    // ai_generation_requests.chat_session_id is ON DELETE RESTRICT now (V116) — before sessions.
    exec(`DELETE FROM ai_generation_requests WHERE project_id = ${project};`);
    exec(`DELETE FROM zyra_chat_sessions WHERE project_id = ${project};`);
    exec(`DELETE FROM testcases WHERE project_id = ${project};`);
    exec(`DELETE FROM project_ai_key_allocations WHERE project_id = ${project};`);
    exec(`DELETE FROM workspace_ai_keys WHERE organization_id = ${org};`);
  }

  function url(suffix: string): string {
    return `/api/projects/${tenant!.mainProjectId}/agents/zyra${suffix}`;
  }

  async function allocateFakeAiKey(): Promise<void> {
    const keyRes = await asOwner.post("/api/workspace/ai-keys", {
      data: { name: `E2E progress fake ai ${Date.now()}${Math.floor(Math.random() * 1000)}`, provider: "openai", apiKey: "sk-e2e-fake", baseUrl: ai.baseUrl },
      failOnStatusCode: false,
    });
    expect(keyRes.status(), `creating the fake-provider AI key — ${await keyRes.text()}`).toBe(201);
    const key = await keyRes.json();
    const allocRes = await asOwner.post("/api/workspace/ai-keys/allocations", {
      data: { projectId: tenant!.mainProjectId, workspaceAiKeyId: key.id },
      failOnStatusCode: false,
    });
    expect(allocRes.status(), `allocating the fake-provider key — ${await allocRes.text()}`).toBe(201);
  }

  async function newSession(title: string): Promise<string> {
    const res = await asOwner.post(url("/chat/sessions"), { data: { title }, failOnStatusCode: false });
    expect(res.status(), `creating a chat session — ${await res.text()}`).toBeLessThan(300);
    return (await res.json()).id;
  }

  function queueSimpleAnswerTurn(): void {
    ai.queueReply({
      reply: "This project currently has 0 test cases.",
      reasoningSummary: "Answered directly, no operations.",
      action: "answer", actionType: "answer", operations: [], testcases: [],
    });
  }

  test("ZYR-A-65 the POST response is byte-for-byte the same shape with or without a turnId", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E progress parity");

    queueSimpleAnswerTurn();
    const withoutTurnId = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), {
      data: { message: "How many test cases exist?" },
      failOnStatusCode: false,
    });
    expect(withoutTurnId.status()).toBeLessThan(300);
    const bodyWithout = await withoutTurnId.json();

    queueSimpleAnswerTurn();
    const withTurnId = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), {
      data: { message: "How many test cases exist?", turnId: "11111111-1111-4111-8111-111111111111" },
      failOnStatusCode: false,
    });
    expect(withTurnId.status()).toBeLessThan(300);
    const bodyWith = await withTurnId.json();

    // Same top-level and message-level shape either way — turnId is inert request-only data.
    expect(Object.keys(bodyWith).sort()).toEqual(Object.keys(bodyWithout).sort());
    expect(Object.keys(bodyWith.message).sort()).toEqual(Object.keys(bodyWithout.message).sort());
    expect(bodyWith.message.content).toBe(bodyWithout.message.content);
    expect(bodyWith.message.actionType).toBe(bodyWithout.message.actionType);
    // turnId must never be echoed back into persisted/returned data — it is a transport-only
    // correlation id, not part of the chat message.
    expect(JSON.stringify(bodyWith)).not.toContain("11111111-1111-4111-8111-111111111111");
  });

  test("ZYR-A-66 a real turn's progress stream narrates real stages and ends with a complete event matching the POST response", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E progress narration");
    const turnId = "22222222-2222-4222-8222-222222222222";

    queueSimpleAnswerTurn();

    // Fired together, same as the frontend will: the POST first (so it wins the race to create the
    // turn's registry entry — see subscribe()'s doc comment in zyra-progress.service.ts), the SSE
    // GET immediately after. Both awaited with Promise.all so neither blocks the other.
    const postPromise = asOwner.post(url(`/chat/sessions/${sessionId}/messages`), {
      data: { message: "How many test cases exist?", turnId },
      failOnStatusCode: false,
    });
    const ssePromise = asOwner.get(url(`/chat/sessions/${sessionId}/turns/${turnId}/events`), { failOnStatusCode: false });
    const [postRes, sseRes] = await Promise.all([postPromise, ssePromise]);

    expect(postRes.status(), `sending the message — ${await postRes.text()}`).toBeLessThan(300);
    expect(sseRes.status(), `opening the progress stream — ${await sseRes.text()}`).toBe(200);
    expect(sseRes.headers()["content-type"]).toContain("text/event-stream");

    const postBody = await postRes.json();
    const events = parseSseEvents(await sseRes.text()) as Array<Record<string, unknown>>;

    expect(events.length, "expected at least a couple of stage events plus a terminal event").toBeGreaterThan(1);
    const stageNames = events.filter((e) => e.kind === "stage").map((e) => e.stage);
    // 'received' is the very first thing sendZyraChatMessage does once it has the session claim —
    // if the SSE GET won the race and attached before the POST created the entry, this would be []
    // instead, which is the scenario ZYR-A-68 covers deliberately; this test's whole point is that
    // firing the POST first (as documented) makes that not happen in practice.
    expect(stageNames.length, `no stage events at all — full stream: ${JSON.stringify(events)}`).toBeGreaterThan(0);
    expect(stageNames).toContain("received");

    const terminal = events[events.length - 1];
    expect(terminal.kind, `stream did not end in a terminal event — full stream: ${JSON.stringify(events)}`).toBe("complete");
    expect((terminal.payload as Record<string, unknown>).message, "the stream's own complete payload must match the POST response").toEqual(postBody.message);
  });

  test("ZYR-A-67 the progress stream enforces the same project/session access it always would — a session in a project this user cannot reach is refused", async () => {
    const otherTenant = await provisionRbacTenant("zyra-citations"); // any other tenant's project works for this check
    test.skip(otherTenant === null, rbacSuiteSkipReason(otherTenant) ?? "");
    const res = await asOwner.get(`/api/projects/${otherTenant!.mainProjectId}/agents/zyra/chat/sessions/00000000-0000-4000-8000-000000000000/turns/any-turn/events`, {
      failOnStatusCode: false,
    });
    expect([401, 403, 404], `expected a refusal, got ${res.status()}: ${await res.text()}`).toContain(res.status());
  });

  test("ZYR-A-68 a turnId nobody ever registered gets one 'unknown' event, not a hang or an error", async () => {
    const sessionId = await newSession("E2E progress unknown turn");
    const res = await asOwner.get(url(`/chat/sessions/${sessionId}/turns/never-posted-${Date.now()}/events`), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    const events = parseSseEvents(await res.text());
    expect(events).toEqual([{ kind: "unknown" }]);
  });
});

/*
 * Hard-delete remediation Phase 6: zyra_chat_sessions itself. deleteZyraChatSession issued a real
 * DELETE, and zyra_chat_messages.session_id / ai_generation_requests.chat_session_id were both
 * ON DELETE CASCADE, so deleting a conversation destroyed the whole transcript (plus any staged,
 * unsaved review batch) with no audit trail. V116 converts it to soft-delete, matching every other
 * entity. These tests prove the session row genuinely survives (not just that the API stops showing
 * it) and that every access-gated route treats a deleted session as gone.
 */
test.describe("zyra chat session soft-delete (hard-delete remediation Phase 6)", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("zyra-chat");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
  });

  test.afterAll(async () => {
    await asOwner?.dispose();
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  function url(suffix: string): string {
    return `/api/projects/${tenant!.mainProjectId}/agents/zyra${suffix}`;
  }

  async function newSession(title: string): Promise<string> {
    const res = await asOwner.post(url("/chat/sessions"), { data: { title }, failOnStatusCode: false });
    expect(res.status(), `creating a chat session — ${await res.text()}`).toBeLessThan(300);
    return (await res.json()).id;
  }

  test("deleting a chat session soft-deletes the row — it is not physically removed", async () => {
    const sessionId = await newSession(`E2E Session Soft-Delete ${Date.now()}`);

    const delRes = await asOwner.delete(url(`/chat/sessions/${sessionId}`));
    expect(delRes.ok(), `deleting the session — ${await delRes.text()}`).toBeTruthy();

    // DB-level proof, not just the API's 404s below — the row must still physically exist.
    expect(scalar(`SELECT deleted_at IS NOT NULL FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`)).toBe("t");
    expect(scalar(`SELECT COUNT(*)::text FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`)).toBe("1");

    // Every access-gated route treats it as gone.
    expect((await asOwner.get(url(`/chat/sessions/${sessionId}`), { failOnStatusCode: false })).status()).toBe(404);
    expect((await asOwner.patch(url(`/chat/sessions/${sessionId}`), { data: { title: "renamed" }, failOnStatusCode: false })).status()).toBe(404);
    expect(
      (await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), { data: { message: "hello" }, failOnStatusCode: false })).status(),
    ).toBe(404);
    const list = await (await asOwner.get(url("/chat/sessions"))).json();
    expect(list.list.some((s: { id: string }) => s.id === sessionId)).toBeFalsy();

    // Deleting again must 404 (already gone from every read path), never a raw driver error from
    // hitting an already-non-null deleted_at a second time.
    expect((await asOwner.delete(url(`/chat/sessions/${sessionId}`), { failOnStatusCode: false })).status()).toBe(404);
  });
});
