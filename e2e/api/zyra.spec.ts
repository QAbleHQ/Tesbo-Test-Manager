import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { column, exec, literal, scalar } from "../utils/psql";
import { purgeProject } from "../utils/seed";
import {
  anonymousContext,
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  type RbacTenant,
} from "../utils/rbac-tenant";
import { startFakeAiServer, type FakeAiServer } from "../utils/fake-ai-server";
import { env } from "../utils/env";
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
        // "awaiting_review" was the default here previously — it appears nowhere in the backend
        // (grep the whole Tesbo-Backend-Nest tree) and isn't one of the two statuses zyraSave
        // accepts ('in_review' or 'failed', legacy.service.ts's own status guard). Every caller
        // that omits `status` gets a task-board row zyraSave then refuses to save, a stale
        // mismatch from before task_status was renamed.
        `${literal(fields.status ?? "in_review")}, ` +
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
  function seedChatReviewTask(
    options: { status?: string; entries?: Array<Record<string, unknown>>; savedCount?: number } = {},
  ): {
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
        "requested_count, generated_count, saved_count, generated_payload, agent_name, task_status, chat_session_id) VALUES (" +
        `${literal(t.mainProjectId)}, ${literal(t.owner.userId)}, 'zyra_chat', 'gpt-4o-mini', ` +
        `'Zyra chat proposal', ${entries.length}, ${entries.length}, ${options.savedCount ?? 0}, ` +
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

    // Each tier reports its upper bound — the count generation actually keeps. 10-30 used to report
    // (and cap at) 25.
    expect((await res.json()).testcaseCount).toBe(30);

    const agent = await (await asOwner.get(url("/agents/zyra"))).json();
    expect(JSON.stringify(agent)).toContain("10-30");
    expect(agent.settings.testcaseCount).toBe(30);

    const small = await asOwner.patch(url("/agents/zyra/settings"), { data: { testcaseRange: "1-10" }, failOnStatusCode: false });
    expect(small.status()).toBe(200);
    expect((await small.json()).testcaseCount).toBe(10);
  });

  test("ZYR-A-09b the 30-50 tier round-trips the same way as every other range", { tag: '@tesbo.testId("TES-TC-603")' }, async () => {
    const res = await asOwner.patch(url("/agents/zyra/settings"), {
      data: { testcaseRange: "30-50" },
      failOnStatusCode: false,
    });
    expect(res.status(), `updating settings — ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.testcaseRange).toBe("30-50");
    // 50, the tier's upper bound: at 40, normalizeAiDrafts discarded every draft past the 40th.
    expect(body.testcaseCount).toBe(50);

    const agent = await (await asOwner.get(url("/agents/zyra"))).json();
    expect(agent.settings.testcaseRange).toBe("30-50");
    expect(agent.settings.testcaseCount).toBe(50);
  });

  test("ZYR-A-10 an unknown testcaseRange falls back instead of being stored", { tag: '@tesbo.testId("TES-TC-604")' }, async () => {
    // The valid set is 1-10 / 10-30 / 30-50 / all. A value outside it must not reach the settings
    // JSON, or the generation step later reads a range it cannot interpret. The removed "minimum"
    // tier is exercised here too — it is now just another unrecognized string, the same as any
    // other invalid value, and must not be stored or silently reinterpreted.
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

    const minimumRes = await asOwner.patch(url("/agents/zyra/settings"), {
      data: { testcaseRange: "minimum" },
      failOnStatusCode: false,
    });
    expect(minimumRes.status()).toBeLessThan(500);
    const minimumBody = await minimumRes.json();
    expect(minimumBody.testcaseRange, "the removed 'minimum' tier must not be accepted").not.toBe("minimum");

    const storedAfterMinimum = scalar(
      `SELECT settings::text FROM projects WHERE id = ${literal(tenant!.mainProjectId)};`,
    );
    expect(storedAfterMinimum, "the removed 'minimum' tier reached the stored settings").not.toContain('"minimum"');
  });

  test("ZYR-A-10b a project that has never saved this setting defaults to 30-50, not 1-10", { tag: '@tesbo.testId("TES-TC-604")' }, async () => {
    // A dedicated project, not the shared tenant's mainProjectId — every other test in this file
    // PATCHes that project's testcaseRange, so it never reflects the true "nothing ever saved" state.
    // Projects cap name at 30 chars — "E2E Zyra Default Range " plus a 13-digit timestamp
    // overflowed that by 7, so every run of this test failed on project creation itself.
    const created = await asOwner.post("/api/projects", {
      data: { name: `E2E Range ${Date.now()}` },
      failOnStatusCode: false,
    });
    expect(created.status(), await created.text()).toBe(201);
    const project = await created.json();
    try {
      const agent = await (await asOwner.get(url("/agents/zyra", project.id))).json();
      expect(agent.settings.testcaseRange, "a fresh project's default range").toBe("30-50");
      expect(agent.settings.testcaseCount).toBe(50);
    } finally {
      purgeProject(project.id);
    }
  });

  // ─── Continue / resume ────────────────────────────────────────────────────

  /*
   * A "timed_out" assistant message with a usable resume_checkpoint, written directly — same
   * "arrange through Postgres" rule as seedTask/seedChatReviewTask, since actually reaching this
   * state through the live route needs a provider call that genuinely stalls for minutes, which
   * this suite deliberately never drives (file header). The checkpoint's stage is "generate" (skip
   * routing) with no AI key allocated on this tenant, so buildZyraChatDecision's own "no provider
   * configured" degraded path resolves the resume almost instantly — real enough to exercise the
   * fire-and-forget claim/complete lifecycle without a multi-minute wait.
   */
  function seedTimedOutMessage(options: { resumeAttempt?: number; sessionId?: string } = {}): { sessionId: string; messageId: string } {
    const t = tenant!;
    const sessionId = options.sessionId ?? (() => {
      exec(`INSERT INTO zyra_chat_sessions (project_id, user_id, title) VALUES (${literal(t.mainProjectId)}, ${literal(t.owner.userId)}, 'E2E resume session');`);
      return scalar(`SELECT id FROM zyra_chat_sessions WHERE project_id = ${literal(t.mainProjectId)} ORDER BY created_at DESC LIMIT 1;`);
    })();
    const checkpoint = JSON.stringify({
      stage: "generate",
      userMessageId: "",
      message: "Write me some test cases",
      routedSuite: null,
      routedCount: { requestedCount: 10, exhaustive: false },
    });
    exec(
      "INSERT INTO zyra_chat_messages (session_id, project_id, user_id, role, content, status, resume_checkpoint, resume_attempt) VALUES " +
        `(${literal(sessionId)}, ${literal(t.mainProjectId)}, ${literal(t.owner.userId)}, 'assistant', ` +
        `'⏱️ I did not hear back from the AI provider in time.', 'timed_out', ${literal(checkpoint)}::jsonb, ${options.resumeAttempt ?? 0});`,
    );
    const messageId = scalar(
      `SELECT id FROM zyra_chat_messages WHERE session_id = ${literal(sessionId)} AND status = 'timed_out' ORDER BY created_at DESC LIMIT 1;`,
    );
    return { sessionId, messageId };
  }

  /** Polls until the seeded message leaves 'resuming', or the attempt budget runs out. */
  async function waitForResumeToSettle(sessionId: string, messageId: string, maxAttempts = 20): Promise<string> {
    for (let i = 0; i < maxAttempts; i++) {
      const status = scalar(`SELECT status FROM zyra_chat_messages WHERE id = ${literal(messageId)};`);
      if (status !== "resuming") return status ?? "";
      await new Promise((r) => setTimeout(r, 250));
    }
    return scalar(`SELECT status FROM zyra_chat_messages WHERE id = ${literal(messageId)};`) ?? "";
  }

  test("ZYR-A-86 Continue returns immediately (fire-and-forget), and the resume completes in the background", { tag: '@tesbo.testId("TES-TC-3016")' }, async () => {
    const { sessionId, messageId } = seedTimedOutMessage();

    const start = Date.now();
    const res = await asOwner.post(url(`/agents/zyra/chat/sessions/${sessionId}/messages/${messageId}/continue`), { failOnStatusCode: false });
    const elapsedMs = Date.now() - start;
    // NestJS defaults every undecorated @Post() to 201 — none of the Zyra POST routes in this
    // controller override it with @HttpCode(200), continueZyraChatMessage included, so 201 is
    // this route's real, consistent response code, not 200.
    expect(res.status(), `Continue — ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.accepted, "the claiming request must be told it started the resume").toBe(true);

    // The whole point of the fix: this must never block for anywhere near the multi-minute
    // generate budget. A generous ceiling (well under even the base 180s) still catches a
    // regression back to the old synchronous behavior without being flaky on a loaded CI box.
    expect(elapsedMs, "Continue must return fast, not hold the connection open for the resume itself").toBeLessThan(15000);

    const claimedMessage = body.session.messages.find((m: { id: string }) => m.id === messageId);
    expect(claimedMessage.status, "the claimed message flips to 'resuming' in the same response").toBe("resuming");

    const finalStatus = await waitForResumeToSettle(sessionId, messageId);
    expect(finalStatus, "a resume with no real AI key resolves quickly via the degraded path, not stuck in 'resuming'").toBe("resumed");

    const session = await (await asOwner.get(url(`/agents/zyra/chat/sessions/${sessionId}`))).json();
    const newMessage = session.messages.find((m: { id: string; role: string }) => m.role === "assistant" && m.id !== messageId);
    expect(newMessage, "the resumed turn's own follow-up message").toBeTruthy();
    expect(newMessage.resumeAttempt, "a genuine completion resets the chain").toBe(0);
  });

  test("ZYR-A-87 a second concurrent Continue on the same message is not accepted", { tag: '@tesbo.testId("TES-TC-3017")' }, async () => {
    const { sessionId, messageId } = seedTimedOutMessage();
    const [first, second] = await Promise.all([
      asOwner.post(url(`/agents/zyra/chat/sessions/${sessionId}/messages/${messageId}/continue`), { failOnStatusCode: false }),
      asOwner.post(url(`/agents/zyra/chat/sessions/${sessionId}/messages/${messageId}/continue`), { failOnStatusCode: false }),
    ]);
    // See ZYR-A-86's comment: this route's real (undecorated, NestJS-default) status is 201.
    expect(first.status()).toBe(201);
    expect(second.status()).toBe(201);
    const [firstBody, secondBody] = await Promise.all([first.json(), second.json()]);
    const acceptedCount = [firstBody.accepted, secondBody.accepted].filter(Boolean).length;
    expect(acceptedCount, "exactly one of two simultaneous Continue calls claims the row").toBe(1);

    await waitForResumeToSettle(sessionId, messageId);
    const generatedCount = scalar(
      `SELECT COUNT(*)::text FROM zyra_chat_messages WHERE session_id = ${literal(sessionId)} AND role = 'assistant';`,
    );
    // The original timed-out message plus exactly one follow-up — never two, which is what a
    // double-fired generation would leave behind.
    expect(generatedCount, "only one resume actually ran the generation pipeline").toBe("2");
  });

  test("ZYR-A-88 after the cap, a plain Continue is rejected and a narrowed one is accepted", { tag: '@tesbo.testId("TES-TC-3018")' }, async () => {
    const { sessionId, messageId } = seedTimedOutMessage({ resumeAttempt: 2 });

    const plain = await asOwner.post(url(`/agents/zyra/chat/sessions/${sessionId}/messages/${messageId}/continue`), { failOnStatusCode: false });
    expect(plain.status(), "a plain Continue past the cap must be refused, not silently retried at full size").toBe(400);
    const plainBody = await plain.json();
    expect(plainBody.code).toBe("zyra_resume_cap_exceeded");
    // Refused before ever claiming the row — still 'timed_out', not 'resuming'.
    expect(scalar(`SELECT status FROM zyra_chat_messages WHERE id = ${literal(messageId)};`)).toBe("timed_out");

    const narrowed = await asOwner.post(url(`/agents/zyra/chat/sessions/${sessionId}/messages/${messageId}/continue`), {
      data: { narrow: true },
      failOnStatusCode: false,
    });
    // See ZYR-A-86's comment: this route's real (undecorated, NestJS-default) status is 201.
    expect(narrowed.status(), `a narrowed Continue past the cap must be accepted — ${await narrowed.text()}`).toBe(201);
    expect((await narrowed.json()).accepted).toBe(true);
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
    "ZYR-A-81 a chat-approved batch counts toward the approval rate exactly like a task-board save",
    { tag: '@tesbo.testId("TES-TC-1221")' },
    async () => {
      /*
       * "[Zyra] Approval Rate does not update after approving additional test cases" — reproduced
       * against the ZYR-A-75 fix itself: that fix scoped the aggregate to `chat_session_id IS NULL`
       * on the theory that chat "has no comparable generated-vs-saved concept". It does: chat
       * proposals are inserted into this same table with a real generated_count
       * (applyZyraChatOperations), and approving them in the Agent workspace calls the exact same
       * aiSave route the task board uses (ZyraChatReviewPanel -> saveZyraTask), which increments
       * saved_count and sets task_status = 'done' with no branch on chat_session_id at all. So a
       * chat-approved batch is byte-for-byte the same shape as a task-board one once saved, and
       * excluding it is what left the tile frozen for anyone whose whole workflow is the chat panel.
       */
      seedChatReviewTask({ status: "done", savedCount: 1 });
      expect(await approvalRate(), "an approved chat batch did not count toward the rate").toBe(100);
    },
  );

  test("ZYR-A-83 the rate aggregates chat and task-board saves together, not just one or the other", async () => {
    seedTask({ drafts: 2, savedCount: 1, status: "done" });
    seedChatReviewTask({
      status: "done",
      savedCount: 1,
      entries: [
        { opType: "create", draft: { title: "E2E chat draft A" }, reason: "" },
        { opType: "create", draft: { title: "E2E chat draft B" }, reason: "" },
      ],
    });
    // 1 saved of 2 (task board) + 1 saved of 2 (chat) = 2 of 4 = 50%.
    expect(await approvalRate(), "chat and task-board saves did not aggregate into one rate").toBe(50);
  });

  test(
    "ZYR-A-84 closing a chat batch without saving, through the real route, still counts its drafts as unapproved",
    async () => {
      // Mirrors ZYR-A-80's task-board close, but through a chat-staged row — zyraCloseTask branches
      // on nothing chat-specific, so this must resolve to 'done' with saved_count 0 exactly the same.
      const { taskId } = seedChatReviewTask({ status: "in_review" });
      const closeRes = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/close`), { failOnStatusCode: false });
      expect(closeRes.status(), `closing a chat batch without saving — ${await closeRes.text()}`).toBe(201);
      expect(
        scalar(`SELECT task_status, saved_count FROM ai_generation_requests WHERE id = ${literal(taskId)};`),
      ).toBe("done");

      seedTask({ drafts: 1, savedCount: 1, status: "done" });
      // 1 saved of 1 (task board) + 0 saved of 1 (closed chat batch) = 1 of 2 = 50%.
      expect(
        await approvalRate(),
        "a closed-without-saving chat batch was not counted as generated-but-unapproved",
      ).toBe(50);
    },
  );

  test("ZYR-A-85 a chat batch still awaiting review does not drag the rate down before anything is decided", async () => {
    // Same reasoning as ZYR-A-77's task-board case, now for the origin that used to be exempt from
    // this aggregate entirely — an undecided chat batch must be excluded, not counted as 0% approved.
    seedChatReviewTask({ status: "in_review" });
    expect(await approvalRate(), "a pending chat batch was counted as 0% approved instead of being excluded").toBeNull();
  });

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
    // Re-read after backdating — chatSeenAt above is the PRE-backdate value, no longer what the
    // row holds; comparing later assertions against it (instead of this) was off by exactly the
    // 10-day interval just applied.
    const chatBackdatedAt = scalar(`SELECT updated_at::text FROM zyra_chat_sessions WHERE id = ${literal(emptySession.id)};`);
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
    ).toBe(new Date(chatBackdatedAt).getTime());
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

  /*
   * "[Zyra] Edit Test Case View Is Missing Fields Available After Saving" — testData was generated,
   * staged and saved correctly, but chatDraftRow (the row every review surface and the draft
   * editor are seeded from) never carried it, so the editor had nothing to show.
   */
  test("ZYR-A-142 a chat-staged create draft's test data is served on the review row and round-trips through an edit", async () => {
    const { taskId } = seedChatReviewTask({
      entries: [
        {
          opType: "create",
          draft: {
            suiteId: null,
            title: `E2E chat test data ${Date.now()}`,
            description: "The order is placed",
            preconditions: "",
            stepsJson: "[]",
            testData: "card: 4242 4242 4242 4242",
            priority: "P2",
          },
          reason: "",
        },
      ],
    });

    const before = await asOwner.get(url(`/agents/zyra/tasks/${taskId}`), { failOnStatusCode: false });
    expect(before.status()).toBe(200);
    const beforeRow = (await before.json()).drafts[0];
    expect(beforeRow.testData, "the review row must carry the staged draft's test data").toBe("card: 4242 4242 4242 4242");
    expect(beforeRow.expectedSummary, "the description must still be served on the review row").toBe("The order is placed");

    const res = await asOwner.patch(url(`/agents/zyra/tasks/${taskId}/drafts/0`), {
      data: { testData: "card: 4000 0000 0000 0002" },
      failOnStatusCode: false,
    });
    expect(res.status(), `editing test data — ${await res.text()}`).toBe(200);
    expect((await res.json()).drafts[0].testData).toBe("card: 4000 0000 0000 0002");

    const stored = JSON.parse(scalar(`SELECT generated_payload::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`));
    expect(stored[0].draft.testData).toBe("card: 4000 0000 0000 0002");
    expect(stored[0].draft.description, "an edit of one field must not touch the others").toBe("The order is placed");
  });

  test("ZYR-A-143 a create draft with no test data serves an empty string, and clearing test data persists as empty", async () => {
    const { taskId } = seedChatReviewTask();
    const before = await asOwner.get(url(`/agents/zyra/tasks/${taskId}`), { failOnStatusCode: false });
    expect(before.status()).toBe(200);
    expect((await before.json()).drafts[0].testData, "absent test data must be '' on the row, never undefined").toBe("");

    await asOwner.patch(url(`/agents/zyra/tasks/${taskId}/drafts/0`), { data: { testData: "temporary" }, failOnStatusCode: false });
    const cleared = await asOwner.patch(url(`/agents/zyra/tasks/${taskId}/drafts/0`), { data: { testData: "" }, failOnStatusCode: false });
    expect(cleared.status(), `clearing test data — ${await cleared.text()}`).toBe(200);
    const stored = JSON.parse(scalar(`SELECT generated_payload::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`));
    expect(stored[0].draft.testData, "clearing must persist as empty, not be ignored").toBe("");
  });

  test("ZYR-A-144 an update proposal's review row previews the real test case's test data (and a staged change to it)", async () => {
    const created = await asOwner.post(url("/testcases"), {
      data: { title: `E2E chat update test data ${Date.now()}`, priority: "P2", testData: "user: alice" },
      failOnStatusCode: false,
    });
    expect(created.status()).toBe(201);
    const testcaseId = (await created.json()).id;
    try {
      const untouched = seedChatReviewTask({
        entries: [{ opType: "update", testcaseId, externalId: "E2E-1", fields: { priority: "P1" }, reason: "" }],
      });
      const unchangedRes = await asOwner.get(url(`/agents/zyra/tasks/${untouched.taskId}`), { failOnStatusCode: false });
      expect(unchangedRes.status()).toBe(200);
      expect(
        (await unchangedRes.json()).drafts[0].testData,
        "a proposal that doesn't touch test data must preview the case's current value (chatTestcaseRow)",
      ).toBe("user: alice");

      const changing = seedChatReviewTask({
        entries: [{ opType: "update", testcaseId, externalId: "E2E-1", fields: { testData: "user: bob" }, reason: "" }],
      });
      const changingRes = await asOwner.get(url(`/agents/zyra/tasks/${changing.taskId}`), { failOnStatusCode: false });
      expect((await changingRes.json()).drafts[0].testData, "the preview shows the value after saving").toBe("user: bob");
      expect(
        scalar(`SELECT test_data FROM testcases WHERE id = ${literal(testcaseId)};`),
        "previewing must not touch the real test case before Save",
      ).toBe("user: alice");
    } finally {
      await asOwner.delete(url(`/testcases/${testcaseId}`), { failOnStatusCode: false });
    }
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

  /*
   * Zyra regeneration silently wiped an already-linked case's existing citations. draft.sourceRefs
   * was always written as a real (possibly empty) array, so updateTestCaseWithClient's
   * `COALESCE($28::jsonb, source_refs)` always took the new value and never fell back to what the
   * row already had — an ungrounded re-run (no citations resolved this turn) erased them outright.
   * Same "only fill if blank" protection severity/component get in ZYR-A-73 above, now extended to
   * source_refs. Invisible before the repository table's Context column existed (nothing rendered
   * source_refs after creation); ZYR-A-89/90 pin both directions now that it's a real user-facing
   * regression.
   */
  test("ZYR-A-89 regenerating an already-linked test case with no new citations never wipes its existing ones", async () => {
    const jiraIssueKey = `E2E-ZYRA-${Date.now()}`;
    const existingCitation = { type: "testcase", id: `E2E-CITED-${Date.now()}`, title: "E2E previously cited case" };
    const created = await asOwner.post(url("/testcases"), {
      data: { title: "E2E already-cited case", priority: "P2", jiraIssueKey, sourceRefs: [existingCitation] },
      failOnStatusCode: false,
    });
    expect(created.status(), `seeding the already-cited case — ${await created.text()}`).toBe(201);
    const testcaseId = (await created.json()).id;
    try {
      const draftTitle = `E2E regenerated content ${Date.now()}`;
      // draftOverrides omits sourceRefs entirely — the same shape a task-board draft (no chat
      // pipeline, no citations ever attached) always has.
      const taskId = seedTask({ drafts: 1, jiraIssueKey, draftOverrides: [{ title: draftTitle }] });
      const res = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/save`), { data: { selectedDraftIndexes: [0] }, failOnStatusCode: false });
      expect(res.status(), `saving the regenerated draft — ${await res.text()}`).toBe(201);
      // Content is genuinely regenerated (this is a real redirect-to-update, not a no-op)...
      expect(scalar(`SELECT title FROM testcases WHERE id = ${literal(testcaseId)};`)).toBe(draftTitle);
      // ...but the citation this case already had must survive untouched.
      const after = await (await asOwner.get(url(`/testcases/${testcaseId}`))).json();
      expect(after.sourceRefs, "an ungrounded regeneration must never wipe citations the case already had").toEqual([existingCitation]);
    } finally {
      await asOwner.delete(url(`/testcases/${testcaseId}`), { failOnStatusCode: false });
    }
  });

  test("ZYR-A-90 regenerating an already-linked test case with freshly resolved citations replaces the stale ones", async () => {
    const jiraIssueKey = `E2E-ZYRA-${Date.now()}`;
    const staleCitation = { type: "testcase", id: `E2E-STALE-${Date.now()}`, title: "E2E stale citation" };
    const created = await asOwner.post(url("/testcases"), {
      data: { title: "E2E stale-cited case", priority: "P2", jiraIssueKey, sourceRefs: [staleCitation] },
      failOnStatusCode: false,
    });
    expect(created.status(), `seeding the stale-cited case — ${await created.text()}`).toBe(201);
    const testcaseId = (await created.json()).id;
    try {
      const freshCitation = { type: "bug", id: `E2E-FRESH-${Date.now()}`, title: "E2E fresh citation" };
      const taskId = seedTask({ drafts: 1, jiraIssueKey, draftOverrides: [{ sourceRefs: [freshCitation] }] });
      const res = await asOwner.post(url(`/agents/zyra/tasks/${taskId}/save`), { data: { selectedDraftIndexes: [0] }, failOnStatusCode: false });
      expect(res.status(), `saving the regenerated draft — ${await res.text()}`).toBe(201);
      const after = await (await asOwner.get(url(`/testcases/${testcaseId}`))).json();
      expect(after.sourceRefs, "a regeneration that actually resolved citations must overwrite the stale ones, not just add to them").toEqual([freshCitation]);
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

  /*
   * provider is deliberately a custom-gateway string, not "openai" — OpenAI-wire by convention
   * (providerWire's own comment in legacy.service.ts), so still compatible with this fake
   * server's chat-completions shape, but absent from EMBEDDING_CAPABLE_PROVIDERS
   * (rag-embedding-providers.ts: openai/google/mistral only). A KB doc seeded below
   * (seedCitableSources) enqueues a real background embedding job (createKnowledgeDocument ->
   * enqueueEmbedding); with provider "openai" that job treats this key as embeddings-capable and
   * fires a real POST against this fake server's one chat-completions handler, which returns the
   * wrong response shape and — since it shares the same request log and reply queue as the
   * test's own router/generation calls — intermittently consumes a queued reply or inflates
   * ai.requests.length out from under the test. Same technique ZYR-A-91/92 use.
   */
  async function allocateFakeAiKey(): Promise<void> {
    const keyRes = await asOwner.post("/api/workspace/ai-keys", {
      data: { name: `E2E citations fake ai ${Date.now()}${Math.floor(Math.random() * 1000)}`, provider: "e2e-fake-gateway", apiKey: "sk-e2e-fake", baseUrl: ai.baseUrl, defaultModel: "gpt-4o-mini" },
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

/*
 * Task-board generation (processZyraTask, behind POST /agents/zyra/tasks — aiGenerate) is fire-
 * and-forget: the route returns 201 immediately and the real work happens in the background, which
 * is why the top describe block above never drives it through a live model (seedTask() arranges
 * rows directly instead — see that function's own comment). That left this path's actual knowledge
 * selection completely unexercised against a real generation call. This block drives it for real,
 * polling task_status the way ZYR-A-86's waitForResumeToSettle already does for chat resume.
 */
test.describe("zyra task-board generation — knowledge relevance (fake provider)", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let ai: FakeAiServer;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("zyra-relevance");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    ai = await startFakeAiServer();
  });

  test.afterAll(async () => {
    await asOwner?.dispose();
    await ai?.close();
  });

  test.beforeEach(() => {
    // See FakeAiServer.reset()'s doc comment — one server instance is shared across this block's
    // tests (one beforeAll).
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
    exec(`DELETE FROM ai_generation_requests WHERE project_id = ${project};`);
    exec(`DELETE FROM knowledge_documents WHERE project_id = ${project};`);
    exec(`DELETE FROM knowledge_folders WHERE project_id = ${project} AND is_root = false;`);
    exec(`DELETE FROM project_ai_key_allocations WHERE project_id = ${project};`);
    exec(`DELETE FROM workspace_ai_keys WHERE organization_id = ${org};`);
  }

  function url(suffix: string): string {
    return `/api/projects/${tenant!.mainProjectId}/agents/zyra${suffix}`;
  }

  /*
   * A custom-gateway provider (anything absent from PROVIDER_CATALOG) is OpenAI-wire by
   * convention (see providerWire's own comment in legacy.service.ts) — compatible with this fake
   * server's chat-completions shape — but is deliberately NOT one of the three
   * EMBEDDING_CAPABLE_PROVIDERS (openai/google/mistral only, rag-embedding-providers.ts). That
   * makes resolveEmbeddingAllocation report no embeddings-capable key anywhere, so
   * RagRetrievalService skips its ANN half entirely instead of calling this fake server's
   * chat-only endpoint as if it were a real /v1/embeddings and getting back the wrong response
   * shape. Only the full-text half of retrieval runs, which is exactly what this test needs and
   * keeps it independent of a real embeddings provider.
   */
  async function allocateFakeAiKey(): Promise<void> {
    const keyRes = await asOwner.post("/api/workspace/ai-keys", {
      data: {
        name: `E2E relevance fake ai ${Date.now()}${Math.floor(Math.random() * 1000)}`,
        provider: "e2e-fake-gateway",
        apiKey: "sk-e2e-fake",
        baseUrl: ai.baseUrl,
        defaultModel: "gpt-4o-mini",
      },
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

  async function createDoc(title: string, contentText: string): Promise<string> {
    const res = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/knowledge-base/documents`, {
      data: { folderId: rootFolderId(), documentType: "general", title, contentText },
      failOnStatusCode: false,
    });
    expect(res.status(), `seeding "${title}" — ${await res.text()}`).toBe(201);
    return (await res.json()).id;
  }

  /** Polls until the task leaves 'todo'/'in_progress', or the attempt budget runs out — same
   *  pattern as ZYR-A-86's waitForResumeToSettle for chat resume. */
  async function waitForTaskSettled(taskId: string, maxAttempts = 40): Promise<string> {
    for (let i = 0; i < maxAttempts; i++) {
      const status = scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`);
      if (status !== "todo" && status !== "in_progress") return status ?? "";
      await new Promise((r) => setTimeout(r, 250));
    }
    return scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`) ?? "";
  }

  test("ZYR-A-91 task-board generation surfaces a KB document outside the 12-most-recently-updated window", async () => {
    await allocateFakeAiKey();

    // Created FIRST so the 12 filler docs below push it out of knowledgeSnapshot's own
    // `ORDER BY updated_at DESC LIMIT 12` window — the exact shape of the reported bug: the
    // relevant document genuinely exists in the knowledge base, it just isn't among the 12 most
    // recently touched.
    await createDoc(
      "Aurora session policy",
      "All authenticated sessions in the Aurora billing portal expire after exactly 20 minutes of inactivity, regardless of subscription tier.",
    );
    for (let i = 0; i < 12; i++) {
      await createDoc(`Filler onboarding note ${i}`, "Unrelated onboarding checklist item with no bearing on this task.");
    }

    // Deliberately no `E2E ... ${Date.now()}` uniqueness prefix here (unlike this file's other
    // fixtures) — user_story has no uniqueness constraint to collide on, and every extra word
    // would join the full-text AND-query below (plainto_tsquery requires every query lexeme to be
    // present in the matched document), so the story is kept to exactly the terms the Aurora doc
    // above actually contains.
    //
    // Deliberately does NOT mention "20 minutes" — zyraDynamicTaskPrompt always embeds the raw
    // story text verbatim as its own "Story:" line, independent of what knowledge gets
    // retrieved, so the story text must not itself carry the value this test proves came from
    // the KB doc, or the assertion below would pass whether or not retrieval worked at all.
    const story = "Aurora billing portal sessions expire from inactivity.";
    ai.queueReply({
      drafts: [{
        title: "Session expires after the configured inactivity timeout",
        preconditions: "The user is signed in to the Aurora billing portal.",
        stepsJson: JSON.stringify([{ stepNumber: 1, action: "Leave the session idle for the configured timeout", expectedResult: "The session expires" }]),
        testData: "",
        expectedSummary: "The session expires after the configured timeout.",
        priority: "P1",
        tags: ["zyra"],
        sourceRefs: ["KB 1"],
      }],
    });
    // rememberZyraTurn's own summarization call, made unconditionally after a successful
    // generation — same two-call shape processZyraTask always makes, not something this test
    // is about, so a plain non-JSON reply (rememberZyraTurn just splits it into bullet lines).
    ai.queueReply("- Generated a session-timeout test case for the Aurora billing portal.");

    const taskRes = await asOwner.post(url("/tasks"), { data: { userStory: story }, failOnStatusCode: false });
    expect(taskRes.status(), `creating the task — ${await taskRes.text()}`).toBe(201);
    const taskId = (await taskRes.json()).generationRequestId;

    const finalStatus = await waitForTaskSettled(taskId);
    expect(finalStatus, "generation must complete, not fail").toBe("in_review");

    // Not asserting ai.requests.length here: task_status flips to 'in_review' (what
    // waitForTaskSettled polls for) before processZyraTask's own later, unawaited-by-us call to
    // rememberZyraTurn's summarization pass reaches this fake server — a real race against that
    // second background call, not something this test is about. ai.requests[0] (the generation
    // call) is already guaranteed to exist by the time task_status flips, since generation runs
    // and its result is persisted before that UPDATE.
    const generationPrompt = JSON.stringify(ai.requests[0]?.messages ?? []);
    expect(
      generationPrompt,
      "a KB doc outside the 12-most-recent window must still reach the model when the request is actually about it",
    ).toContain("20 minutes of inactivity");
  });

  test("ZYR-A-92 regeneration after reviewer feedback also retrieves a KB document outside the 12-most-recently-updated window", async () => {
    await allocateFakeAiKey();

    await createDoc(
      "Aurora session policy",
      "All authenticated sessions in the Aurora billing portal expire after exactly 20 minutes of inactivity, regardless of subscription tier.",
    );
    for (let i = 0; i < 12; i++) {
      await createDoc(`Filler onboarding note ${i}`, "Unrelated onboarding checklist item with no bearing on this task.");
    }

    // The INITIAL story deliberately shares nothing with the Aurora doc — this test is about what
    // processZyraFeedback retrieves for the regeneration, not the initial generation (that's
    // ZYR-A-91's job).
    const initialStory = "Checkout page redesign for the mobile app.";
    ai.queueReply({
      drafts: [{
        title: "Checkout page renders on mobile",
        preconditions: "The user is on the checkout page.",
        stepsJson: JSON.stringify([{ stepNumber: 1, action: "Open checkout on a mobile device", expectedResult: "The redesigned layout renders" }]),
        testData: "",
        expectedSummary: "The redesigned checkout page renders correctly on mobile.",
        priority: "P2",
        tags: ["zyra"],
        sourceRefs: [],
      }],
    });
    ai.queueReply("- Generated a checkout page test case.");

    const taskRes = await asOwner.post(url("/tasks"), { data: { userStory: initialStory }, failOnStatusCode: false });
    expect(taskRes.status(), `creating the task — ${await taskRes.text()}`).toBe(201);
    const taskId = (await taskRes.json()).generationRequestId;
    expect(await waitForTaskSettled(taskId), "initial generation must complete, not fail").toBe("in_review");

    // task_status flips to 'in_review' before processZyraTask's own later, unawaited call to
    // rememberZyraTurn's summarization pass reaches this fake server (see ZYR-A-91's identical
    // comment) — drain that still-in-flight request before resetting below, or it lands AFTER the
    // reset and steals one of the two replies queued for the regeneration phase, one call late.
    for (let i = 0; i < 40 && ai.requests.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }

    // Isolates the requests this fake server sees from here on to the regeneration alone, so the
    // assertion below can read ai.requests[0] unambiguously instead of guessing an index past
    // however many calls the initial generation made (see ZYR-A-91's comment on that same race).
    ai.reset();
    ai.queueReply({
      drafts: [{
        title: "Session expires after the configured inactivity timeout",
        preconditions: "The user is signed in to the Aurora billing portal.",
        stepsJson: JSON.stringify([{ stepNumber: 1, action: "Leave the session idle for the configured timeout", expectedResult: "The session expires" }]),
        testData: "",
        expectedSummary: "The session expires after the configured timeout.",
        priority: "P1",
        tags: ["zyra"],
        sourceRefs: ["KB 1"],
      }],
    });
    ai.queueReply("- Regenerated with a session-timeout test case for the Aurora billing portal.");

    // Same reasoning as ZYR-A-91's story: only the exact terms the Aurora doc contains, so the
    // full-text AND-query matches it, and no "20 minutes" here — that value must come from the
    // retrieved document, not be echoed back from the feedback text itself (feedback, like story,
    // is embedded verbatim in the regeneration prompt).
    const feedbackRes = await asOwner.post(url(`/tasks/${taskId}/feedback`), {
      data: { feedback: "Aurora billing portal sessions expire from inactivity." },
      failOnStatusCode: false,
    });
    expect(feedbackRes.status(), `submitting feedback — ${await feedbackRes.text()}`).toBe(201);
    expect(await waitForTaskSettled(taskId), "regeneration must complete, not fail").toBe("in_review");

    const regenerationPrompt = JSON.stringify(ai.requests[0]?.messages ?? []);
    expect(
      regenerationPrompt,
      "regeneration after feedback must also retrieve a KB doc outside the 12-most-recent window, not just the initial generation",
    ).toContain("20 minutes of inactivity");
  });

  test("ZYR-A-93 feedback's linearIssueKeys reach the regeneration prompt and are merged, de-duplicated, onto the task", async () => {
    // Backs the task-detail Feedback form's "Attach Linear tickets" picker (ZYU-113..116): the page
    // sends the picked keys as linearIssueKeys, and this is what the server must do with them.
    await allocateFakeAiKey();
    const org = literal(tenant!.organizationId);
    const project = literal(tenant!.mainProjectId);
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const oldKey = `LFA-${suffix}-1`;
    const newKey = `LFA-${suffix}-2`;
    const newSummary = `Linear feedback ticket ${suffix} covers the refund window`;
    try {
      // linearSnapshot reads linear_tickets by key alone (no mapping filter), so the connection and
      // ticket rows are all a sync would have needed to leave behind for the summary to be found.
      exec(
        `INSERT INTO integration_connections (organization_id, provider, external_id, site_url, access_token, refresh_token, token_expires_at) ` +
          `VALUES (${org}, 'linear', 'e2e-zyra-feedback', 'https://e2e-zyra-feedback.invalid', 'e2e', '', now() + interval '365 days') ` +
          `ON CONFLICT (organization_id, provider) DO NOTHING;`,
      );
      const connectionId = scalar(`SELECT id FROM integration_connections WHERE organization_id = ${org} AND provider = 'linear';`);
      exec(
        `INSERT INTO linear_tickets (project_id, integration_connection_id, linear_issue_id, linear_issue_key, summary, issue_type, status) ` +
          `VALUES (${project}, ${literal(connectionId)}, ${literal(newKey)}, ${literal(newKey)}, ${literal(newSummary)}, 'Story', 'Todo');`,
      );
      const userStory = `E2E linear feedback story ${suffix}`;
      exec(
        `INSERT INTO ai_generation_requests
          (project_id, requested_by, provider, model, user_story, requested_count, generated_count, generated_payload,
           agent_name, task_status, feedback, context, jira_issue_keys, linear_issue_keys, activity_log)
         VALUES (${project}, ${literal(tenant!.owner.userId)}, 'e2e-fake-gateway', 'gpt-4o-mini', ${literal(userStory)}, 1, 1,
           ${literal(JSON.stringify([{ title: "Seeded draft", priority: "P2", preconditions: "", steps: [] }]))}::jsonb,
           'Zyra the Test Generator', 'in_review', '', '', '[]'::jsonb, ${literal(JSON.stringify([oldKey]))}::jsonb, '[]'::jsonb);`,
      );
      const taskId = scalar(`SELECT id FROM ai_generation_requests WHERE project_id = ${project} AND user_story = ${literal(userStory)};`);

      ai.queueReply({
        drafts: [{
          title: "Refund is refused after the refund window closes",
          preconditions: "",
          stepsJson: JSON.stringify([{ stepNumber: 1, action: "Request a refund after the window", expectedResult: "The refund is refused" }]),
          testData: "",
          expectedSummary: "The refund is refused.",
          priority: "P1",
          tags: ["zyra"],
          sourceRefs: [],
        }],
      });

      const res = await asOwner.post(url(`/tasks/${taskId}/feedback`), {
        // A repeat of the new key and of the key the task already carries, plus an empty entry —
        // the picker itself prevents repeats, but the server must not trust that.
        data: { feedback: "Cover the refund window from the Linear ticket.", linearIssueKeys: [newKey, newKey, oldKey, ""] },
        failOnStatusCode: false,
      });
      expect(res.status(), `submitting feedback — ${await res.text()}`).toBe(201);
      expect(await waitForTaskSettled(taskId), "regeneration must complete, not fail").toBe("in_review");

      const storedKeys = JSON.parse(scalar(`SELECT linear_issue_keys::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`));
      expect(storedKeys, "existing key kept, new key appended once, empty entry dropped").toEqual([oldKey, newKey]);
      const storedJira = JSON.parse(scalar(`SELECT jira_issue_keys::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`));
      expect(storedJira, "Linear keys must not leak into the Jira list").toEqual([]);

      const task = await (await asOwner.get(url(`/tasks/${taskId}`))).json();
      expect(task.linearIssueKeys).toEqual([oldKey, newKey]);
      expect(
        task.activities.some((a: { kind?: string; detail?: string }) => a.kind === "feedback" && String(a.detail).includes(`Linear tickets: ${newKey}`)),
        "the feedback entry names the attached Linear ticket",
      ).toBe(true);

      const prompt = JSON.stringify(ai.requests[0]?.messages ?? []);
      expect(prompt, "the attached Linear ticket's summary must be in the regeneration prompt").toContain(newSummary);
    } finally {
      exec(`DELETE FROM linear_tickets WHERE project_id = ${project};`);
      exec(`DELETE FROM integration_connections WHERE organization_id = ${org} AND provider = 'linear';`);
    }
  });

  test("ZYR-A-94 feedback with a non-array linearIssueKeys is accepted and attaches nothing, rather than failing", async () => {
    // Wrong-type payload: normalizeJsonArray treats anything but an array as empty. Checked with no
    // AI key allocated so it stops at the allocation check — the point is it is a clean 4xx/2xx
    // decision, never a 500 from calling .map on a string.
    const project = literal(tenant!.mainProjectId);
    const userStory = `E2E linear wrong-type story ${Date.now()}${Math.floor(Math.random() * 1000)}`;
    exec(
      `INSERT INTO ai_generation_requests
        (project_id, requested_by, provider, model, user_story, requested_count, generated_count, generated_payload,
         agent_name, task_status, feedback, context, jira_issue_keys, linear_issue_keys, activity_log)
       VALUES (${project}, ${literal(tenant!.owner.userId)}, 'openai', 'gpt-4o-mini', ${literal(userStory)}, 0, 0, '[]'::jsonb,
         'Zyra the Test Generator', 'in_review', '', '', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);`,
    );
    const taskId = scalar(`SELECT id FROM ai_generation_requests WHERE project_id = ${project} AND user_story = ${literal(userStory)};`);
    const res = await asOwner.post(url(`/tasks/${taskId}/feedback`), {
      data: { feedback: "x", linearIssueKeys: "LIN-1" },
      failOnStatusCode: false,
    });
    expect(res.status(), await res.text()).toBe(400);
    expect(await res.text()).toContain("Zyra is inactive");
    expect(scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe("in_review");
    expect(scalar(`SELECT linear_issue_keys::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe("[]");
  });
});

/*
 * Ticket auto-comment after a Zyra save — "Auto-comment on Jira/Linear ticket" in the project's
 * integration settings (projects.settings.jiraAutoComment / linearAutoComment).
 *
 * The flow under test, end to end through the real routes:
 *   1. a Task-board task is created with Knowledge Base documents selected; a document that is a
 *      ticket's mirror (source_role = 'mirror') links the task to that ticket — but only when the
 *      selection points at exactly ONE ticket;
 *   2. Zyra generates drafts (the fake provider, utils/fake-ai-server.ts);
 *   3. the save links the new test cases to the ticket and records ONE ticket comment for that save
 *      in integration_ticket_comments (V123), listing exactly the test cases it wrote.
 *
 * WHAT IS AND ISN'T OBSERVABLE. Jira and Linear base URLs are compiled in (see
 * api/integrations.spec.ts's header), so no fake upstream can receive the comment. What IS proven
 * here is everything Tesbo decides and records: whether a comment is due, for which ticket, with
 * which test cases, in what words, and that a skip or a provider failure never fails the save. The
 * "posted" end state itself needs a real Jira site and is verified by hand, not here.
 *
 * One consequence worth knowing: a delivery test (setting on + connected) reaches the real
 * api.atlassian.com / api.linear.app with the fixture's nonsense token. That request cannot write
 * anything — it is refused (or fails to connect, on a box with no egress) — and the ledger records
 * it as 'failed', which is the terminal state these tests wait for.
 */
test.describe("zyra task-board — ticket auto-comment (fake provider)", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let ai: FakeAiServer;
  // Replies scripted since the last ai.reset() — see drainBackgroundAi().
  let queued = 0;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("zyra-autocomment");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    ai = await startFakeAiServer();
  });

  test.afterAll(async () => {
    await asOwner?.dispose();
    await ai?.close();
  });

  test.beforeEach(() => {
    // Same shared-server reset as the other fake-provider blocks in this file.
    ai?.reset();
    queued = 0;
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
    if (tenant) purge();
  });

  test.afterEach(async () => {
    if (!tenant) return;
    await drainBackgroundAi();
    purge();
  });

  /*
   * processZyraTask runs in the background, and makes one more provider call (rememberZyraTurn's
   * summary) AFTER the task already reads in_review. Either can reach the shared fake server after
   * the next test's ai.reset() and consume the reply that test scripted. So before a test ends:
   * every task in the project has settled, and every reply it scripted has been asked for.
   */
  async function drainBackgroundAi(): Promise<void> {
    for (let i = 0; i < 80; i++) {
      const busy = scalar(
        "SELECT count(*) FROM ai_generation_requests WHERE project_id = " + literal(tenant!.mainProjectId) +
          " AND task_status IN ('todo', 'in_progress');",
      );
      if (busy === "0" && ai.requests.length >= queued) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  function purge(): void {
    const projects = `${literal(tenant!.mainProjectId)}, ${literal(tenant!.secondProjectId)}`;
    const org = literal(tenant!.organizationId);
    // integration_ticket_comments cascades off ai_generation_requests (ON DELETE CASCADE, V123).
    exec(`DELETE FROM ai_generation_requests WHERE project_id IN (${projects});`);
    exec(`DELETE FROM testcases WHERE project_id IN (${projects});`);
    exec(`DELETE FROM jira_tickets WHERE project_id IN (${projects});`);
    exec(`DELETE FROM linear_tickets WHERE project_id IN (${projects});`);
    exec(`DELETE FROM knowledge_documents WHERE project_id IN (${projects});`);
    exec(`DELETE FROM knowledge_folders WHERE project_id IN (${projects}) AND is_root = false;`);
    exec(`DELETE FROM integration_connections WHERE organization_id = ${org};`);
    exec(`DELETE FROM project_ai_key_allocations WHERE project_id IN (${projects});`);
    exec(`DELETE FROM workspace_ai_keys WHERE organization_id = ${org};`);
    exec(`UPDATE projects SET settings = '{}'::jsonb WHERE id IN (${projects});`);
  }

  function url(suffix: string): string {
    return `/api/projects/${tenant!.mainProjectId}/agents/zyra${suffix}`;
  }

  // Same custom-gateway provider as the relevance block above, for the same reason: OpenAI-wire, so
  // the fake server can answer it, but not embeddings-capable, so a seeded KB doc's background
  // embedding job never consumes one of this test's queued replies.
  async function allocateFakeAiKey(): Promise<void> {
    const keyRes = await asOwner.post("/api/workspace/ai-keys", {
      data: {
        name: `E2E autocomment fake ai ${Date.now()}${Math.floor(Math.random() * 1000)}`,
        provider: "e2e-fake-gateway",
        apiKey: "sk-e2e-fake",
        baseUrl: ai.baseUrl,
        defaultModel: "gpt-4o-mini",
      },
      failOnStatusCode: false,
    });
    expect(keyRes.status(), `creating the fake-provider AI key — ${await keyRes.text()}`).toBe(201);
    const allocRes = await asOwner.post("/api/workspace/ai-keys/allocations", {
      data: { projectId: tenant!.mainProjectId, workspaceAiKeyId: (await keyRes.json()).id },
      failOnStatusCode: false,
    });
    expect(allocRes.status(), `allocating the fake-provider key — ${await allocRes.text()}`).toBe(201);
  }

  /** Saved through the same PATCH the integration settings panel sends (IntegrationAiGenerationSettings.tsx). */
  async function setAutoComment(settings: { jiraAutoComment?: boolean; linearAutoComment?: boolean }): Promise<void> {
    const current = await (await asOwner.get(`/api/projects/${tenant!.mainProjectId}`)).json();
    const parsed = typeof current.settings === "string" ? JSON.parse(current.settings || "{}") : current.settings || {};
    const res = await asOwner.patch(`/api/projects/${tenant!.mainProjectId}`, {
      data: { settings: JSON.stringify({ ...parsed, ...settings }) },
      failOnStatusCode: false,
    });
    expect(res.status(), `saving the auto-comment setting — ${await res.text()}`).toBeLessThan(300);
  }

  /** A workspace connection row, as api/integrations.spec.ts seeds it — never a real OAuth leg. */
  function seedConnection(provider: "jira" | "linear", options: { disconnected?: boolean } = {}): string {
    exec(
      "INSERT INTO integration_connections (organization_id, provider, external_id, site_url, access_token, " +
        `refresh_token, token_expires_at, connected_by, disconnected_at) VALUES (${literal(tenant!.organizationId)}, ` +
        `${literal(provider)}, ${literal(`e2e-${provider}-site`)}, 'https://e2e.invalid', 'e2e-not-a-real-token', '', ` +
        `now() + interval '1 hour', ${literal(tenant!.owner.userId)}, ${options.disconnected ? "now()" : "NULL"});`,
    );
    return scalar(
      `SELECT id FROM integration_connections WHERE organization_id = ${literal(tenant!.organizationId)} ` +
        `AND provider = ${literal(provider)} ORDER BY created_at DESC LIMIT 1;`,
    );
  }

  function rootFolderId(projectId = tenant!.mainProjectId): string {
    const existing = scalar(`SELECT id FROM knowledge_folders WHERE project_id = ${literal(projectId)} AND is_root = true;`);
    if (existing) return existing;
    exec(
      "INSERT INTO knowledge_folders (organization_id, project_id, parent_folder_id, name, is_root) " +
        `VALUES (${literal(tenant!.organizationId)}, ${literal(projectId)}, NULL, 'Knowledge base', true);`,
    );
    return scalar(`SELECT id FROM knowledge_folders WHERE project_id = ${literal(projectId)} AND is_root = true;`);
  }

  /**
   * A synced ticket and its Knowledge Base mirror, exactly as integration-sync.processor.ts leaves
   * them: the mirror's source_external_id is the provider's issue ID, not the key — which is why the
   * backend has to go through the ticket table to find the key at all.
   */
  function seedTicketWithMirror(provider: "jira" | "linear", connectionId: string, key: string, projectId = tenant!.mainProjectId): string {
    const issueId = `id-${key}-${Date.now()}`;
    if (provider === "jira") {
      exec(
        "INSERT INTO jira_tickets (project_id, jira_connection_id, jira_issue_id, jira_issue_key, summary, description, " +
          `issue_type, status, jira_url) VALUES (${literal(projectId)}, ${literal(connectionId)}, ${literal(issueId)}, ` +
          `${literal(key)}, ${literal(`E2E ${key} loan approval`)}, 'seeded by the e2e suite', 'Story', 'To Do', ` +
          `${literal(`https://e2e.invalid/browse/${key}`)});`,
      );
    } else {
      exec(
        "INSERT INTO linear_tickets (project_id, integration_connection_id, linear_issue_id, linear_issue_key, summary, " +
          `description, issue_type, status, linear_url) VALUES (${literal(projectId)}, ${literal(connectionId)}, ` +
          `${literal(issueId)}, ${literal(key)}, ${literal(`E2E ${key} loan approval`)}, 'seeded by the e2e suite', 'Bug', ` +
          `'Todo', ${literal(`https://e2e.invalid/issue/${key}`)});`,
      );
    }
    exec(
      "INSERT INTO knowledge_documents (organization_id, project_id, folder_id, title, content_text, content_html, " +
        "document_type, status, source_provider, source_external_id, source_role, is_read_only) VALUES (" +
        `${literal(tenant!.organizationId)}, ${literal(projectId)}, ${literal(rootFolderId(projectId))}, ` +
        `${literal(`${key}: E2E loan approval`)}, 'Approve or reject loan applications.', '<p>Approve or reject loan applications.</p>', ` +
        `'requirement_note', 'published', ${literal(provider)}, ${literal(issueId)}, 'mirror', true);`,
    );
    return scalar(
      `SELECT id FROM knowledge_documents WHERE project_id = ${literal(projectId)} AND source_external_id = ${literal(issueId)};`,
    );
  }

  /** A plain, user-written KB document — not a ticket mirror, even if it mentions a key. */
  async function createNote(title: string, contentText: string): Promise<string> {
    const res = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/knowledge-base/documents`, {
      data: { folderId: rootFolderId(), documentType: "general", title, contentText },
      failOnStatusCode: false,
    });
    expect(res.status(), `seeding "${title}" — ${await res.text()}`).toBe(201);
    return (await res.json()).id;
  }

  function draft(title: string): Record<string, unknown> {
    return {
      title,
      preconditions: "A loan application is pending.",
      stepsJson: JSON.stringify([{ stepNumber: 1, action: "Open the application", expectedResult: "It opens" }]),
      testData: "",
      expectedSummary: "The application can be reviewed.",
      priority: "P2",
      tags: ["zyra"],
      sourceRefs: [],
    };
  }

  /** Scripts one generation (plus the memory-summarization call processZyraTask always makes after). */
  function queueGeneration(titles: string[]): void {
    ai.queueReply({ drafts: titles.map(draft) });
    ai.queueReply("- Generated loan approval test cases.");
    queued += 2;
  }

  async function waitForTaskSettled(taskId: string, maxAttempts = 60): Promise<string> {
    for (let i = 0; i < maxAttempts; i++) {
      const status = scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`);
      if (status !== "todo" && status !== "in_progress") return status ?? "";
      await new Promise((r) => setTimeout(r, 250));
    }
    return scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`) ?? "";
  }

  /** Creates a task through the real route (aiGenerate) and returns the created task. */
  async function createTask(data: Record<string, unknown>): Promise<any> {
    const res = await asOwner.post(url("/tasks"), { data: { userStory: `E2E loan approval ${Date.now()}`, ...data }, failOnStatusCode: false });
    expect(res.status(), `creating the task — ${await res.text()}`).toBe(201);
    return res.json();
  }

  /**
   * A Task-board row already in review, written directly — for the save-side cases that don't need
   * to re-prove generation. Same load-bearing details as seedTask() in the first block
   * (agent_name, bare-array generated_payload).
   */
  function seedReviewTask(fields: { titles: string[]; jiraIssueKey?: string; linearIssueKey?: string }): string {
    const drafts = fields.titles.map(draft);
    exec(
      "INSERT INTO ai_generation_requests (project_id, requested_by, provider, model, user_story, requested_count, " +
        "generated_count, saved_count, generated_payload, agent_name, task_status, jira_issue_keys, linear_issue_keys) VALUES (" +
        `${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'openai', 'gpt-4o-mini', 'E2E loan approval', ` +
        `${drafts.length}, ${drafts.length}, 0, ${literal(JSON.stringify(drafts))}::jsonb, 'Zyra the Test Generator', 'in_review', ` +
        `${literal(JSON.stringify(fields.jiraIssueKey ? [fields.jiraIssueKey] : []))}::jsonb, ` +
        `${literal(JSON.stringify(fields.linearIssueKey ? [fields.linearIssueKey] : []))}::jsonb);`,
    );
    return scalar(
      `SELECT id FROM ai_generation_requests WHERE project_id = ${literal(tenant!.mainProjectId)} ORDER BY created_at DESC LIMIT 1;`,
    );
  }

  async function save(taskId: string, selectedDraftIndexes?: number[]): Promise<APIResponse> {
    return asOwner.post(url(`/tasks/${taskId}/save`), {
      data: selectedDraftIndexes ? { selectedDraftIndexes } : {},
      failOnStatusCode: false,
    });
  }

  type LedgerRow = { provider: string; issue_key: string; status: string; testcase_ids: string[]; comment_text: string; reason: string | null; save_event_id: string };

  function ledger(taskId: string): LedgerRow[] {
    const raw = scalar(
      "SELECT coalesce(json_agg(json_build_object('provider', provider, 'issue_key', issue_key, 'status', status, " +
        "'testcase_ids', testcase_ids, 'comment_text', comment_text, 'reason', reason, 'save_event_id', save_event_id) " +
        `ORDER BY created_at), '[]') FROM integration_ticket_comments WHERE generation_request_id = ${literal(taskId)};`,
    );
    return JSON.parse(raw || "[]");
  }

  /** Waits for a delivery to leave 'pending' — it runs in the background after the save returns. */
  async function waitForDelivery(taskId: string, maxAttempts = 120): Promise<LedgerRow[]> {
    for (let i = 0; i < maxAttempts; i++) {
      const rows = ledger(taskId);
      if (rows.length && rows.every((row) => row.status !== "pending")) return rows;
      await new Promise((r) => setTimeout(r, 250));
    }
    return ledger(taskId);
  }

  function activityTitles(taskId: string): string[] {
    const raw = scalar(`SELECT activity_log::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`);
    return (JSON.parse(raw || "[]") as Array<{ title: string }>).map((entry) => entry.title);
  }

  function linkedKey(testcaseId: string, column: "jira_issue_key" | "linear_issue_key" = "jira_issue_key"): string {
    return scalar(`SELECT coalesce(${column}, '') FROM testcases WHERE id = ${literal(testcaseId)};`);
  }

  // ─── The primary flow ─────────────────────────────────────────────────────

  test("ZYR-AC-01 KB doc of a Jira ticket → Zyra generates → save posts ONE comment listing exactly those test cases", async () => {
    await allocateFakeAiKey();
    const connectionId = seedConnection("jira");
    const key = "MFLP-6";
    const docId = seedTicketWithMirror("jira", connectionId, key);
    await setAutoComment({ jiraAutoComment: true });

    // An unrelated test case already in the project — it must never appear in the ticket's comment.
    const unrelated = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/testcases`, {
      data: { title: `E2E unrelated case ${Date.now()}` },
      failOnStatusCode: false,
    });
    expect(unrelated.status()).toBe(201);
    const unrelatedTitle = (await unrelated.json()).title;

    const titles = ["Approver can approve a pending loan", "Approver can reject a pending loan with a reason"];
    queueGeneration(titles);
    const created = await createTask({ knowledgeItemIds: [docId] });
    const taskId = created.generationRequestId;

    // The KB selection alone linked the task to its ticket — no key was sent.
    expect(created.task.jiraIssueKeys).toEqual([key]);
    const jiraSource = (created.task.sources as Array<{ type: string; title: string; detail: string }>).find((s) => s.type === "jira");
    expect(jiraSource).toMatchObject({ title: key, detail: "Linked from the selected Knowledge Base document." });

    expect(await waitForTaskSettled(taskId), "generation must complete").toBe("in_review");
    const saveRes = await save(taskId);
    expect(saveRes.status(), `saving — ${await saveRes.text()}`).toBe(201);
    const saved = await saveRes.json();
    expect(saved.savedCount).toBe(2);
    expect(saved).not.toHaveProperty("saveEventId");
    const savedIds = (saved.testcases as Array<{ id: string }>).map((t) => t.id);
    for (const id of savedIds) expect(linkedKey(id), "each saved test case is linked to the ticket").toBe(key);

    const rows = await waitForDelivery(taskId);
    expect(rows, "exactly one comment for the one ticket this save touched").toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ provider: "jira", issue_key: key });
    expect([...row.testcase_ids].sort()).toEqual([...savedIds].sort());
    expect(row.comment_text.split("\n")[0]).toBe("**Generated by Tesbo Test Manager**");
    expect(row.comment_text).toContain(`Zyra saved 2 test cases for ${key} in Tesbo.`);
    expect(row.comment_text).toContain("**Added (2)**");
    // Against this machine's stack (FRONTEND_URL=http://localhost:…, no PUBLIC_APP_URL) each test case
    // must be plain "ID — title": a link would open every reader's own localhost. Against a deployed
    // stack (stage) it must link to that test case's page on that same deployment. The full matrix,
    // including PUBLIC_APP_URL, is pinned in Tesbo-Backend-Nest's ticket-comment-links.spec.ts.
    for (const t of saved.testcases as Array<{ id: string; externalId: string; title: string }>) {
      if (env.targetIsLocal) {
        expect(row.comment_text).toContain(`- ${t.externalId} — ${t.title}`);
      } else {
        expect(row.comment_text).toContain(`[${t.externalId}](`);
        expect(row.comment_text).toContain(`/projects/${tenant!.mainProjectId}/testcases/${t.id}) — ${t.title}`);
      }
    }
    expect(row.comment_text).not.toMatch(/localhost|127\.0\.0\.1/);
    if (env.targetIsLocal) expect(row.comment_text).not.toContain("](");
    expect(row.comment_text).not.toContain(unrelatedTitle);

    // The fixture connection can't actually post (see the block header), so the terminal state here
    // is 'failed' with the provider's reason — and the save above still succeeded regardless.
    expect(["posted", "failed"]).toContain(row.status);
    if (row.status === "failed") expect(row.reason, "a failure records why").toBeTruthy();
    const save_events = scalar(`SELECT save_events::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`);
    expect(save_events, "the ledger's save event is the one the task recorded").toContain(row.save_event_id);
    expect(activityTitles(taskId)).toContain(row.status === "posted" ? "Posted Jira comment" : "Jira comment failed");
  });

  test("ZYR-AC-02 regenerating with feedback keeps the ticket link, and the comment lists the regenerated test cases", async () => {
    await allocateFakeAiKey();
    const connectionId = seedConnection("jira");
    const key = "MFLP-7";
    const docId = seedTicketWithMirror("jira", connectionId, key);
    await setAutoComment({ jiraAutoComment: true });

    queueGeneration(["First-pass loan check"]);
    const taskId = (await createTask({ knowledgeItemIds: [docId] })).generationRequestId;
    expect(await waitForTaskSettled(taskId)).toBe("in_review");
    // Drain the first run's memory-summarization call before re-scripting (see ZYR-A-92's comment).
    for (let i = 0; i < 40 && ai.requests.length < 2; i++) await new Promise((r) => setTimeout(r, 250));
    ai.reset();
    queued = 0;

    queueGeneration(["Regenerated loan approval audit trail"]);
    const feedback = await asOwner.post(url(`/tasks/${taskId}/feedback`), {
      data: { feedback: "Also cover the audit trail." },
      failOnStatusCode: false,
    });
    expect(feedback.status(), `submitting feedback — ${await feedback.text()}`).toBe(201);
    expect(await waitForTaskSettled(taskId)).toBe("in_review");
    // Nothing is commented until the user saves — regeneration alone never posts.
    expect(ledger(taskId)).toHaveLength(0);

    const saveRes = await save(taskId);
    expect(saveRes.status(), `saving — ${await saveRes.text()}`).toBe(201);
    const saved = await saveRes.json();
    const rows = await waitForDelivery(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0].issue_key).toBe(key);
    expect(rows[0].comment_text).toContain("Regenerated loan approval audit trail");
    expect(rows[0].comment_text).not.toContain("First-pass loan check");
    expect(rows[0].testcase_ids).toEqual((saved.testcases as Array<{ id: string }>).map((t) => t.id));
  });

  // ─── The setting and the connection ───────────────────────────────────────

  test("ZYR-AC-03 auto-comment OFF: the test cases are saved and linked as normal, and no comment is attempted", async () => {
    seedConnection("jira");
    await setAutoComment({ jiraAutoComment: false });
    const taskId = seedReviewTask({ titles: ["Off-case A", "Off-case B"], jiraIssueKey: "MFLP-8" });

    const saveRes = await save(taskId);
    expect(saveRes.status(), `saving — ${await saveRes.text()}`).toBe(201);
    const saved = await saveRes.json();
    expect(saved.savedCount).toBe(2);
    for (const t of saved.testcases as Array<{ id: string }>) expect(linkedKey(t.id)).toBe("MFLP-8");

    const rows = ledger(taskId);
    expect(rows.map((r) => r.status)).toEqual(["skipped_disabled"]);
    expect(activityTitles(taskId)).toContain("No Jira comment posted");
  });

  test("ZYR-AC-04 auto-comment never switched on (no setting at all) is treated as off", async () => {
    seedConnection("jira");
    const taskId = seedReviewTask({ titles: ["Default-case"], jiraIssueKey: "MFLP-9" });

    expect((await save(taskId)).status()).toBe(201);
    expect(ledger(taskId).map((r) => r.status)).toEqual(["skipped_disabled"]);
  });

  test("ZYR-AC-05 Jira disconnected: the save succeeds and the comment is recorded as skipped, not failed", async () => {
    seedConnection("jira", { disconnected: true });
    await setAutoComment({ jiraAutoComment: true });
    const taskId = seedReviewTask({ titles: ["Disconnected-case"], jiraIssueKey: "MFLP-10" });

    const saveRes = await save(taskId);
    expect(saveRes.status(), `saving — ${await saveRes.text()}`).toBe(201);
    expect((await saveRes.json()).savedCount).toBe(1);
    expect(ledger(taskId).map((r) => r.status)).toEqual(["skipped_not_connected"]);
  });

  test("ZYR-AC-06 Jira never connected: same — skipped, and the save is unaffected", async () => {
    await setAutoComment({ jiraAutoComment: true });
    const taskId = seedReviewTask({ titles: ["Never-connected-case"], jiraIssueKey: "MFLP-11" });

    expect((await save(taskId)).status()).toBe(201);
    expect(ledger(taskId).map((r) => r.status)).toEqual(["skipped_not_connected"]);
  });

  // ─── Which test cases, and how many comments ──────────────────────────────

  test("ZYR-AC-07 a partial save lists only the drafts actually saved", async () => {
    await setAutoComment({ jiraAutoComment: false });
    const taskId = seedReviewTask({ titles: ["Kept one", "Dropped one", "Kept two"], jiraIssueKey: "MFLP-12" });

    const saveRes = await save(taskId, [0, 2]);
    expect(saveRes.status(), `saving — ${await saveRes.text()}`).toBe(201);
    const saved = await saveRes.json();
    const [row] = ledger(taskId);
    expect(row.testcase_ids).toEqual((saved.testcases as Array<{ id: string }>).map((t) => t.id));
    expect(row.comment_text).toContain("Kept one");
    expect(row.comment_text).toContain("Kept two");
    expect(row.comment_text).not.toContain("Dropped one");
  });

  test("ZYR-AC-08 saving nothing (every draft deselected) records no comment at all", async () => {
    await setAutoComment({ jiraAutoComment: true });
    seedConnection("jira");
    const taskId = seedReviewTask({ titles: ["Never saved"], jiraIssueKey: "MFLP-13" });

    const saveRes = await save(taskId, []);
    expect(saveRes.status()).toBeLessThan(300);
    expect((await saveRes.json()).savedCount).toBe(0);
    expect(ledger(taskId)).toHaveLength(0);
  });

  test("ZYR-AC-09 two concurrent saves of the same task produce exactly one comment", async () => {
    await setAutoComment({ jiraAutoComment: false });
    const taskId = seedReviewTask({ titles: ["Race-case"], jiraIssueKey: "MFLP-14" });

    const [a, b] = await Promise.all([save(taskId), save(taskId)]);
    expect([a.status(), b.status()].sort(), "one save wins, the other is refused as already saved").toEqual([201, 409]);
    expect(ledger(taskId)).toHaveLength(1);

    // And a later re-submit is refused the same way — still one comment.
    expect((await save(taskId)).status()).toBe(409);
    expect(ledger(taskId)).toHaveLength(1);
  });

  test("ZYR-AC-10 re-running a ticket updates its linked test cases in place, and that save's comment lists them as Updated", async () => {
    await setAutoComment({ jiraAutoComment: false });
    const first = seedReviewTask({ titles: ["Original loan case"], jiraIssueKey: "MFLP-15" });
    const firstSave = await (await save(first)).json();
    const originalId = (firstSave.testcases as Array<{ id: string }>)[0].id;

    const second = seedReviewTask({ titles: ["Refined loan case"], jiraIssueKey: "MFLP-15" });
    const secondRes = await save(second);
    expect(secondRes.status(), `saving — ${await secondRes.text()}`).toBe(201);

    const [row] = ledger(second);
    expect(row.testcase_ids).toEqual([originalId]);
    expect(row.comment_text).toContain("**Updated (1)**");
    expect(row.comment_text).toContain("Refined loan case");
    expect(row.comment_text).not.toContain("**Added");
    // Each save keeps its own record: the first task's comment is untouched by the second save.
    expect(ledger(first)).toHaveLength(1);
    expect(ledger(first)[0].save_event_id).not.toBe(row.save_event_id);
  });

  // ─── Several tickets on one task ──────────────────────────────────────────
  //
  // "[Zyra] Test Cases Generated and Saved from Linked Tickets Are Not Posted Back to Their Respective
  // Jira/Linear Tickets" — a task naming several tickets (the Feedback tab's pickers, or several keys
  // sent to createZyraTask) used to link EVERY saved test case to the first key of each provider: one
  // ticket's comment listed all of them, the others got nothing, and with Jira + Linear both tickets
  // listed everything. Each draft is now attributed at generation time to the one ticket it cites
  // (zyraAttributeDraftsToTickets), and the save writes that key per draft.

  /** A ticket key unique to this run, so linked-row lookups never see another test's rows. */
  function ticketKey(prefix: string): string {
    return `${prefix}-${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 90 + 10)}`;
  }

  /** Scripts one generation whose drafts cite the given labels (the model's raw sourceRefs). */
  function queueCitedGeneration(drafts: Array<{ title: string; refs: string[] }>): void {
    ai.queueReply({ drafts: drafts.map(({ title, refs }) => ({ ...draft(title), sourceRefs: refs })) });
    ai.queueReply("- Generated multi-ticket test cases.");
    queued += 2;
  }

  /** Generates through the real route for an explicit multi-ticket selection; returns the task id. */
  async function generateForTickets(keys: { jira?: string[]; linear?: string[] }, drafts: Array<{ title: string; refs: string[] }>): Promise<string> {
    await allocateFakeAiKey();
    queueCitedGeneration(drafts);
    const created = await createTask({ jiraIssueKeys: keys.jira ?? [], linearIssueKeys: keys.linear ?? [] });
    const taskId = created.generationRequestId;
    expect(await waitForTaskSettled(taskId), "generation must complete").toBe("in_review");
    return taskId;
  }

  /** An in-review task whose drafts already carry their attributed keys — for the save-only cases. */
  function seedMultiTicketReviewTask(
    drafts: Array<{ title: string; jiraIssueKey?: string; linearIssueKey?: string }>,
    keys: { jira?: string[]; linear?: string[] },
  ): string {
    const payload = drafts.map(({ title, jiraIssueKey, linearIssueKey }) => ({ ...draft(title), jiraIssueKey: jiraIssueKey ?? null, linearIssueKey: linearIssueKey ?? null }));
    exec(
      "INSERT INTO ai_generation_requests (project_id, requested_by, provider, model, user_story, requested_count, " +
        "generated_count, saved_count, generated_payload, agent_name, task_status, jira_issue_keys, linear_issue_keys) VALUES (" +
        `${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'openai', 'gpt-4o-mini', 'E2E multi-ticket', ` +
        `${payload.length}, ${payload.length}, 0, ${literal(JSON.stringify(payload))}::jsonb, 'Zyra the Test Generator', 'in_review', ` +
        `${literal(JSON.stringify(keys.jira ?? []))}::jsonb, ${literal(JSON.stringify(keys.linear ?? []))}::jsonb);`,
    );
    return scalar(`SELECT id FROM ai_generation_requests WHERE project_id = ${literal(tenant!.mainProjectId)} ORDER BY created_at DESC LIMIT 1;`);
  }

  async function saveAll(taskId: string): Promise<Map<string, string>> {
    const res = await save(taskId);
    expect(res.status(), `saving — ${await res.text()}`).toBe(201);
    const saved = await res.json();
    return new Map((saved.testcases as Array<{ id: string; title: string }>).map((t) => [t.title, t.id]));
  }

  function commentFor(rows: LedgerRow[], provider: "jira" | "linear", key: string): LedgerRow {
    const row = rows.find((r) => r.provider === provider && r.issue_key === key);
    expect(row, `a ${provider} comment for ${key}`).toBeTruthy();
    return row!;
  }

  test("ZYR-AC-31 single Linear ticket by explicit key: every draft links to it even when none cites it, and one Linear comment lists them", async () => {
    seedConnection("linear");
    await setAutoComment({ linearAutoComment: true });
    const key = ticketKey("LIN");
    const taskId = await generateForTickets({ linear: [key] }, [
      { title: "Single Linear uncited A", refs: [] },
      { title: "Single Linear uncited B", refs: [] },
    ]);

    const ids = await saveAll(taskId);
    for (const id of ids.values()) {
      expect(linkedKey(id, "linear_issue_key"), "a single-ticket task links every draft to its ticket").toBe(key);
      expect(linkedKey(id, "jira_issue_key")).toBe("");
    }
    const rows = await waitForDelivery(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "linear", issue_key: key });
    expect([...rows[0].testcase_ids].sort()).toEqual([...ids.values()].sort());
    expect(activityTitles(taskId)).not.toContain("Some drafts not linked to a ticket");
  });

  test("ZYR-AC-32 single Jira ticket by explicit key: unchanged — every draft links, one Jira comment", async () => {
    seedConnection("jira");
    await setAutoComment({ jiraAutoComment: true });
    const key = ticketKey("JRA");
    const taskId = await generateForTickets({ jira: [key] }, [
      { title: "Single Jira cited", refs: [key] },
      { title: "Single Jira uncited", refs: [] },
    ]);

    const ids = await saveAll(taskId);
    for (const id of ids.values()) expect(linkedKey(id)).toBe(key);
    const rows = await waitForDelivery(taskId);
    expect(rows.map((r) => `${r.provider}:${r.issue_key}`)).toEqual([`jira:${key}`]);
    expect(rows[0].testcase_ids).toHaveLength(2);
  });

  test("ZYR-AC-33 two Jira tickets: each test case links to the ticket it cites, and each ticket's comment lists only its own", async () => {
    seedConnection("jira");
    await setAutoComment({ jiraAutoComment: true });
    const [j1, j2] = [ticketKey("JA"), ticketKey("JB")];
    const taskId = await generateForTickets({ jira: [j1, j2] }, [
      { title: "Multi Jira one first", refs: [j1, "KB 1"] },
      { title: "Multi Jira two only", refs: [j2] },
      { title: "Multi Jira one second", refs: [j1] },
    ]);

    const ids = await saveAll(taskId);
    expect(linkedKey(ids.get("Multi Jira one first")!)).toBe(j1);
    expect(linkedKey(ids.get("Multi Jira one second")!)).toBe(j1);
    expect(linkedKey(ids.get("Multi Jira two only")!), "the second ticket's case must not inherit the first key").toBe(j2);

    const rows = await waitForDelivery(taskId);
    expect(rows).toHaveLength(2);
    const first = commentFor(rows, "jira", j1);
    const second = commentFor(rows, "jira", j2);
    expect([...first.testcase_ids].sort()).toEqual([ids.get("Multi Jira one first"), ids.get("Multi Jira one second")].sort());
    expect(second.testcase_ids).toEqual([ids.get("Multi Jira two only")]);
    expect(first.comment_text).not.toContain("Multi Jira two only");
    expect(second.comment_text).not.toContain("Multi Jira one");
  });

  test("ZYR-AC-34 two Linear tickets: same per-ticket split, on Linear", async () => {
    seedConnection("linear");
    await setAutoComment({ linearAutoComment: true });
    const [l1, l2] = [ticketKey("LA"), ticketKey("LB")];
    const taskId = await generateForTickets({ linear: [l1, l2] }, [
      { title: "Multi Linear one", refs: [l1] },
      // Labels are matched case-insensitively — the model sometimes changes a key's case.
      { title: "Multi Linear two", refs: [l2.toLowerCase()] },
    ]);

    const ids = await saveAll(taskId);
    expect(linkedKey(ids.get("Multi Linear one")!, "linear_issue_key")).toBe(l1);
    expect(linkedKey(ids.get("Multi Linear two")!, "linear_issue_key"), "stored with the task's own spelling of the key").toBe(l2);

    const rows = await waitForDelivery(taskId);
    expect(rows).toHaveLength(2);
    expect(commentFor(rows, "linear", l1).testcase_ids).toEqual([ids.get("Multi Linear one")]);
    expect(commentFor(rows, "linear", l2).testcase_ids).toEqual([ids.get("Multi Linear two")]);
  });

  test("ZYR-AC-35 Jira + Linear: Jira-cited cases go only to Jira, Linear-cited only to Linear, a case citing both goes to both", async () => {
    seedConnection("jira");
    seedConnection("linear");
    await setAutoComment({ jiraAutoComment: true, linearAutoComment: true });
    const [j1, l1] = [ticketKey("JM"), ticketKey("LM")];
    const taskId = await generateForTickets({ jira: [j1], linear: [l1] }, [
      { title: "Mixed Jira case", refs: [j1] },
      { title: "Mixed Linear case", refs: [l1] },
      { title: "Mixed shared case", refs: [j1, l1] },
    ]);

    const ids = await saveAll(taskId);
    expect([linkedKey(ids.get("Mixed Jira case")!), linkedKey(ids.get("Mixed Jira case")!, "linear_issue_key")]).toEqual([j1, ""]);
    expect([linkedKey(ids.get("Mixed Linear case")!), linkedKey(ids.get("Mixed Linear case")!, "linear_issue_key")]).toEqual(["", l1]);
    expect([linkedKey(ids.get("Mixed shared case")!), linkedKey(ids.get("Mixed shared case")!, "linear_issue_key")]).toEqual([j1, l1]);

    const rows = await waitForDelivery(taskId);
    expect(rows).toHaveLength(2);
    const jira = commentFor(rows, "jira", j1);
    const linear = commentFor(rows, "linear", l1);
    expect([...jira.testcase_ids].sort()).toEqual([ids.get("Mixed Jira case"), ids.get("Mixed shared case")].sort());
    expect([...linear.testcase_ids].sort()).toEqual([ids.get("Mixed Linear case"), ids.get("Mixed shared case")].sort());
    expect(jira.comment_text, "no Linear-only case on the Jira ticket").not.toContain("Mixed Linear case");
    expect(linear.comment_text, "no Jira-only case on the Linear ticket").not.toContain("Mixed Jira case");
  });

  test("ZYR-AC-36 multi-ticket drafts that cite no ticket, two tickets of one provider, or a key not on the task are saved unlinked and say so", async () => {
    seedConnection("jira");
    await setAutoComment({ jiraAutoComment: true });
    const [j1, j2] = [ticketKey("JU"), ticketKey("JV")];
    const taskId = await generateForTickets({ jira: [j1, j2] }, [
      { title: "Unattributed none", refs: [] },
      { title: "Unattributed both", refs: [j1, j2] },
      { title: "Unattributed foreign", refs: ["NOT-ON-TASK-1"] },
      { title: "Attributed one", refs: [j1] },
    ]);
    expect(activityTitles(taskId)).toContain("Some drafts not linked to a ticket");
    const note = JSON.parse(scalar(`SELECT activity_log::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`))
      .find((entry: { title: string }) => entry.title === "Some drafts not linked to a ticket");
    expect(note.detail).toContain("3 of 4 draft(s)");

    const ids = await saveAll(taskId);
    for (const title of ["Unattributed none", "Unattributed both", "Unattributed foreign"]) {
      expect(linkedKey(ids.get(title)!), `${title} must not be guessed onto a ticket`).toBe("");
    }
    expect(linkedKey(ids.get("Attributed one")!)).toBe(j1);

    const rows = await waitForDelivery(taskId);
    expect(rows.map((r) => `${r.provider}:${r.issue_key}`), "only the ticket that actually has a case is commented on").toEqual([`jira:${j1}`]);
    expect(rows[0].testcase_ids).toEqual([ids.get("Attributed one")]);
  });

  test("ZYR-AC-37 one ticket's provider failing doesn't stop the other: Linear skipped (not connected) while Jira still goes out, and retrying Jira leaves Linear alone", async () => {
    seedConnection("jira");
    // No Linear connection in this tenant: that ticket's comment is recorded as skipped.
    await setAutoComment({ jiraAutoComment: true, linearAutoComment: true });
    const [j1, l1] = [ticketKey("JP"), ticketKey("LP")];
    const taskId = seedMultiTicketReviewTask(
      [
        { title: "Partial Jira case", jiraIssueKey: j1 },
        { title: "Partial Linear case", linearIssueKey: l1 },
      ],
      { jira: [j1], linear: [l1] },
    );

    await saveAll(taskId);
    const rows = await waitForDelivery(taskId);
    expect(rows).toHaveLength(2);
    const jira = commentFor(rows, "jira", j1);
    expect(commentFor(rows, "linear", l1).status).toBe("skipped_not_connected");
    // The fixture Jira connection can't actually post (block header), so it ends posted or failed —
    // either way it was attempted despite the Linear ticket being skipped.
    expect(["posted", "failed"]).toContain(jira.status);

    if (jira.status === "failed") {
      const jiraId = scalar(
        `SELECT id FROM integration_ticket_comments WHERE generation_request_id = ${literal(taskId)} AND provider = 'jira';`,
      );
      const retry = await asOwner.post(retryUrl(taskId, jiraId), { failOnStatusCode: false });
      expect(retry.status(), await retry.text()).toBe(201);
      const after = ledger(taskId);
      expect(after, "a retry re-sends one ticket's comment, never adds a row").toHaveLength(2);
      expect(commentFor(after, "linear", l1).status, "retrying Jira must not touch the Linear ticket's record").toBe("skipped_not_connected");
      expect(commentFor(after, "jira", j1).comment_text).not.toContain("Partial Linear case");
    }
  });

  test("ZYR-AC-38 concurrent and repeated saves of a multi-ticket task: exactly one comment per ticket", async () => {
    await setAutoComment({ jiraAutoComment: false, linearAutoComment: false });
    const [j1, j2, l1] = [ticketKey("JR"), ticketKey("JS"), ticketKey("LR")];
    const taskId = seedMultiTicketReviewTask(
      [
        { title: "Race J1", jiraIssueKey: j1 },
        { title: "Race J2", jiraIssueKey: j2 },
        { title: "Race L1", linearIssueKey: l1 },
      ],
      { jira: [j1, j2], linear: [l1] },
    );

    const [a, b] = await Promise.all([save(taskId), save(taskId)]);
    expect([a.status(), b.status()].sort(), "one save wins, the other is refused as already saved").toEqual([201, 409]);
    expect(ledger(taskId).map((r) => `${r.provider}:${r.issue_key}`).sort()).toEqual([`jira:${j1}`, `jira:${j2}`, `linear:${l1}`].sort());

    expect((await save(taskId)).status()).toBe(409);
    expect(ledger(taskId), "a refused re-save adds nothing").toHaveLength(3);
  });

  test("ZYR-AC-39 regenerating a two-ticket task updates each ticket's own linked case in place, never the other ticket's", async () => {
    await setAutoComment({ jiraAutoComment: false });
    const [j1, j2] = [ticketKey("JX"), ticketKey("JY")];
    const first = seedMultiTicketReviewTask(
      [
        { title: "Regen J1 original", jiraIssueKey: j1 },
        { title: "Regen J2 original", jiraIssueKey: j2 },
      ],
      { jira: [j1, j2] },
    );
    const original = await saveAll(first);

    // Reversed order on purpose: pairing across the whole save (the old behaviour) would rewrite J1's
    // case with J2's draft.
    const second = seedMultiTicketReviewTask(
      [
        { title: "Regen J2 refined", jiraIssueKey: j2 },
        { title: "Regen J1 refined", jiraIssueKey: j1 },
      ],
      { jira: [j1, j2] },
    );
    const refined = await saveAll(second);
    expect(refined.get("Regen J1 refined"), "J1's draft updates J1's existing case").toBe(original.get("Regen J1 original"));
    expect(refined.get("Regen J2 refined"), "J2's draft updates J2's existing case").toBe(original.get("Regen J2 original"));
    expect(linkedKey(original.get("Regen J1 original")!)).toBe(j1);
    expect(linkedKey(original.get("Regen J2 original")!)).toBe(j2);

    const rows = ledger(second);
    expect(commentFor(rows, "jira", j1).testcase_ids).toEqual([original.get("Regen J1 original")]);
    expect(commentFor(rows, "jira", j2).testcase_ids).toEqual([original.get("Regen J2 original")]);
  });

  // ─── Which ticket the KB selection links to ───────────────────────────────

  // Changed on purpose ("[Zyra] Test Cases Generated and Saved from Linked Tickets Are Not Posted Back
  // to Their Respective Jira/Linear Tickets"): this used to assert that a selection spanning two
  // tickets linked NEITHER, because a save could only ever link one ticket. Each draft is now
  // attributed to the ticket it cites, so every ticket behind the selection is linked instead.
  test("ZYR-AC-11 KB docs from TWO tickets link both, and each ticket's comment lists only the cases citing it", async () => {
    await allocateFakeAiKey();
    const connectionId = seedConnection("jira");
    const [k1, k2] = [ticketKey("MFA"), ticketKey("MFB")];
    const docA = seedTicketWithMirror("jira", connectionId, k1);
    const docB = seedTicketWithMirror("jira", connectionId, k2);
    await setAutoComment({ jiraAutoComment: true });

    queueCitedGeneration([
      { title: "KB two-ticket first", refs: [k1] },
      { title: "KB two-ticket second", refs: [k2] },
    ]);
    const created = await createTask({ knowledgeItemIds: [docA, docB] });
    const taskId = created.generationRequestId;
    expect([...created.task.jiraIssueKeys].sort()).toEqual([k1, k2].sort());
    expect(activityTitles(taskId)).not.toContain("Not linked to a ticket");
    const sources = created.task.sources as Array<{ type: string; title: string; detail: string }>;
    expect(sources.filter((s) => s.type === "jira").map((s) => s.detail)).toEqual([
      "Linked from the selected Knowledge Base documents.",
      "Linked from the selected Knowledge Base documents.",
    ]);

    expect(await waitForTaskSettled(taskId)).toBe("in_review");
    const ids = await saveAll(taskId);
    expect(linkedKey(ids.get("KB two-ticket first")!)).toBe(k1);
    expect(linkedKey(ids.get("KB two-ticket second")!)).toBe(k2);
    const rows = await waitForDelivery(taskId);
    expect(rows).toHaveLength(2);
    expect(commentFor(rows, "jira", k1).testcase_ids).toEqual([ids.get("KB two-ticket first")]);
    expect(commentFor(rows, "jira", k2).testcase_ids).toEqual([ids.get("KB two-ticket second")]);
  });

  test("ZYR-AC-40 KB docs from THREE Linear tickets: every ticket is linked and gets a comment with only its own cases", async () => {
    await allocateFakeAiKey();
    const connectionId = seedConnection("linear");
    const keys = [ticketKey("YA"), ticketKey("YB"), ticketKey("YC")];
    const docs = keys.map((key) => seedTicketWithMirror("linear", connectionId, key));
    await setAutoComment({ linearAutoComment: true });

    queueCitedGeneration(keys.map((key, i) => ({ title: `Three Linear case ${i + 1}`, refs: [key] })));
    const created = await createTask({ knowledgeItemIds: docs });
    const taskId = created.generationRequestId;
    expect([...created.task.linearIssueKeys].sort()).toEqual([...keys].sort());
    expect(created.task.jiraIssueKeys).toEqual([]);

    expect(await waitForTaskSettled(taskId)).toBe("in_review");
    const ids = await saveAll(taskId);
    const rows = await waitForDelivery(taskId);
    expect(rows).toHaveLength(3);
    keys.forEach((key, i) => {
      const id = ids.get(`Three Linear case ${i + 1}`)!;
      expect(linkedKey(id, "linear_issue_key")).toBe(key);
      expect(commentFor(rows, "linear", key).testcase_ids).toEqual([id]);
    });
  });

  test("ZYR-AC-41 a draft citing a ticket's KB mirror as 'KB N' is attributed to that ticket; a 'KB N' of a plain note is not a ticket", async () => {
    await allocateFakeAiKey();
    const connectionId = seedConnection("jira");
    const [k1, k2] = [ticketKey("KBA"), ticketKey("KBB")];
    const docA = seedTicketWithMirror("jira", connectionId, k1);
    const docB = seedTicketWithMirror("jira", connectionId, k2);
    const note = await createNote(`E2E plain note ${Date.now()}`, "Loan officers work in two shifts.");
    await setAutoComment({ jiraAutoComment: true });

    queueCitedGeneration([
      { title: "Cites KB 1", refs: ["KB 1"] },
      { title: "Cites KB 2", refs: ["KB 2"] },
      { title: "Cites KB 3", refs: ["KB 3"] },
    ]);
    const taskId = (await createTask({ knowledgeItemIds: [docA, docB, note] })).generationRequestId;
    expect(await waitForTaskSettled(taskId)).toBe("in_review");

    // Which document got which "KB N" label is the backend's choice, so read it off the prompt the
    // fake provider actually received rather than assuming the selection order.
    const prompt = ai.requests.map((r) => JSON.stringify(r.messages)).find((m) => m.includes("cite by its 'KB N' label")) ?? "";
    // Titles here are "<key>: E2E loan approval" — letters, digits, '-' and ':' only, nothing to escape.
    const labelOf = (title: string) => prompt.match(new RegExp(`KB (\\d+): ${title}`))?.[1];
    const kbOfK1 = labelOf(`${k1}: E2E loan approval`);
    const kbOfK2 = labelOf(`${k2}: E2E loan approval`);
    expect(kbOfK1, "the first ticket's mirror reached the prompt as a KB item").toBeTruthy();
    expect(kbOfK2, "the second ticket's mirror reached the prompt as a KB item").toBeTruthy();
    const noteLabel = ["1", "2", "3"].find((n) => n !== kbOfK1 && n !== kbOfK2)!;

    const ids = await saveAll(taskId);
    expect(linkedKey(ids.get(`Cites KB ${kbOfK1}`)!)).toBe(k1);
    expect(linkedKey(ids.get(`Cites KB ${kbOfK2}`)!)).toBe(k2);
    expect(linkedKey(ids.get(`Cites KB ${noteLabel}`)!), "a plain note is not a ticket").toBe("");
    expect(activityTitles(taskId)).toContain("Some drafts not linked to a ticket");
    const rows = await waitForDelivery(taskId);
    expect(rows.map((r) => r.issue_key).sort()).toEqual([k1, k2].sort());
  });

  test("ZYR-AC-12 two docs of the SAME ticket still link to it", async () => {
    await allocateFakeAiKey();
    const connectionId = seedConnection("jira");
    const docA = seedTicketWithMirror("jira", connectionId, "MFLP-22");
    // A second mirror for the same key (e.g. re-synced under a new mapping) — one ticket, not two.
    const docB = seedTicketWithMirror("jira", connectionId, "MFLP-22");
    const created = await createTask({ knowledgeItemIds: [docA, docB] });
    expect(created.task.jiraIssueKeys).toEqual(["MFLP-22"]);
  });

  test("ZYR-AC-13 a user's own KB note is not a ticket, even if it mentions a key — no link", async () => {
    await allocateFakeAiKey();
    const noteId = await createNote("Notes on MFLP-6", "MFLP-6 needs an approval workflow.");
    const created = await createTask({ knowledgeItemIds: [noteId] });
    expect(created.task.jiraIssueKeys).toEqual([]);
    expect(created.task.linearIssueKeys ?? []).toEqual([]);
  });

  test("ZYR-AC-14 a ticket mirror from ANOTHER project can't link this project's task", async () => {
    await allocateFakeAiKey();
    const connectionId = seedConnection("jira");
    const foreignDoc = seedTicketWithMirror("jira", connectionId, "MFLP-23", tenant!.secondProjectId);
    const created = await createTask({ knowledgeItemIds: [foreignDoc] });
    expect(created.task.jiraIssueKeys).toEqual([]);
  });

  test("ZYR-AC-15 an explicit ticket key (the Requirements page) wins over the KB selection", async () => {
    await allocateFakeAiKey();
    const connectionId = seedConnection("jira");
    const docId = seedTicketWithMirror("jira", connectionId, "MFLP-24");
    const created = await createTask({ jiraIssueKeys: ["MFLP-99"], knowledgeItemIds: [docId] });
    expect(created.task.jiraIssueKeys).toEqual(["MFLP-99"]);
  });

  test("ZYR-AC-16 malformed and unknown knowledgeItemIds are ignored, not a 500", async () => {
    await allocateFakeAiKey();
    const created = await createTask({ knowledgeItemIds: ["not-a-uuid", "00000000-0000-4000-8000-000000000000", 42, null] });
    expect(created.task.jiraIssueKeys).toEqual([]);
  });

  // ─── Linear follows the same rules ────────────────────────────────────────

  test("ZYR-AC-17 Linear: a KB doc of a Linear ticket links it, and linearAutoComment gates a markdown comment", async () => {
    await allocateFakeAiKey();
    const connectionId = seedConnection("linear");
    const docId = seedTicketWithMirror("linear", connectionId, "ENG-42");
    await setAutoComment({ linearAutoComment: true, jiraAutoComment: false });

    queueGeneration(["Linear loan case"]);
    const created = await createTask({ knowledgeItemIds: [docId] });
    const taskId = created.generationRequestId;
    expect(created.task.jiraIssueKeys).toEqual([]);
    expect(scalar(`SELECT linear_issue_keys::text FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe('["ENG-42"]');

    expect(await waitForTaskSettled(taskId)).toBe("in_review");
    const saved = await (await save(taskId)).json();
    const testcaseId = (saved.testcases as Array<{ id: string }>)[0].id;
    expect(linkedKey(testcaseId, "linear_issue_key")).toBe("ENG-42");

    const rows = await waitForDelivery(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "linear", issue_key: "ENG-42" });
    expect(rows[0].comment_text).toMatch(/^\*\*Generated by Tesbo Test Manager\*\*/);
    expect(rows[0].comment_text).toContain("Linear loan case");
    expect(["posted", "failed"]).toContain(rows[0].status);
  });

  test("ZYR-AC-18 Linear off: skipped even while Jira's setting is on", async () => {
    seedConnection("linear");
    await setAutoComment({ jiraAutoComment: true, linearAutoComment: false });
    const taskId = seedReviewTask({ titles: ["Linear off case"], linearIssueKey: "ENG-43" });

    expect((await save(taskId)).status()).toBe(201);
    expect(ledger(taskId).map((r) => [r.provider, r.status])).toEqual([["linear", "skipped_disabled"]]);
  });

  // ─── Authorization ────────────────────────────────────────────────────────

  test("ZYR-AC-19 another workspace's user can't save the task, so nothing is commented", async () => {
    await setAutoComment({ jiraAutoComment: true });
    const taskId = seedReviewTask({ titles: ["Foreign save"], jiraIssueKey: "MFLP-30" });
    const outsider = await provisionRbacTenant("zyra");
    test.skip(!outsider, "the second tenant could not be provisioned");
    const asOutsider = await loginAs(outsider!.owner);
    try {
      const res = await asOutsider.post(url(`/tasks/${taskId}/save`), { data: {}, failOnStatusCode: false });
      expect([401, 403, 404]).toContain(res.status());
      expect(ledger(taskId)).toHaveLength(0);
      expect(scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`)).toBe("in_review");
    } finally {
      await asOutsider.dispose();
    }
  });

  // ─── Ticket keys have no length limit (V124) ──────────────────────────────

  /*
   * Regression test. Every column a ticket key passes through was VARCHAR(64), so a longer key
   * failed the save outright at the testcases write (a truncation error), and could not be synced
   * into jira_tickets at all. Both halves are driven: the KB-link path (jira_tickets → task) and the
   * save path (task → testcases → integration_ticket_comments).
   */
  test("ZYR-AC-20 a ticket key longer than 64 characters links, saves and is recorded in full", async () => {
    await allocateFakeAiKey();
    const connectionId = seedConnection("jira");
    const longKey = `MFLP-${"9".repeat(295)}`;
    expect(longKey.length).toBe(300);
    const docId = seedTicketWithMirror("jira", connectionId, longKey);
    await setAutoComment({ jiraAutoComment: false });

    queueGeneration(["Long-key loan case"]);
    const created = await createTask({ knowledgeItemIds: [docId] });
    expect(created.task.jiraIssueKeys).toEqual([longKey]);
    const taskId = created.generationRequestId;
    expect(await waitForTaskSettled(taskId)).toBe("in_review");

    const saveRes = await save(taskId);
    expect(saveRes.status(), `saving — ${await saveRes.text()}`).toBe(201);
    const testcaseId = ((await saveRes.json()).testcases as Array<{ id: string }>)[0].id;
    expect(linkedKey(testcaseId), "the full key is stored on the test case, not truncated").toBe(longKey);

    const rows = ledger(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0].issue_key).toBe(longKey);
    expect(rows[0].comment_text).toContain(`for ${longKey} in Tesbo.`);
  });

  test("ZYR-AC-21 an explicit long key (the Requirements page path) saves in full too", async () => {
    await setAutoComment({ jiraAutoComment: false });
    const longKey = `REQ-${"x".repeat(196)}`;
    const taskId = seedReviewTask({ titles: ["Explicit long-key case"], jiraIssueKey: longKey });

    const saveRes = await save(taskId);
    expect(saveRes.status(), `saving — ${await saveRes.text()}`).toBe(201);
    const testcaseId = ((await saveRes.json()).testcases as Array<{ id: string }>)[0].id;
    expect(linkedKey(testcaseId)).toBe(longKey);
    expect(ledger(taskId).map((r) => r.issue_key)).toEqual([longKey]);
  });
  // ─── Listing a task's ticket comments, and retrying a failed one ─────────

  /** Makes a save's recorded comment 'failed', as a refused post would have left it. */
  function markFailed(taskId: string, reason = "seeded failure"): string {
    exec(`UPDATE integration_ticket_comments SET status = 'failed', reason = ${literal(reason)} WHERE generation_request_id = ${literal(taskId)};`);
    return scalar(`SELECT id FROM integration_ticket_comments WHERE generation_request_id = ${literal(taskId)} LIMIT 1;`);
  }

  function retryUrl(taskId: string, commentId: string): string {
    return url(`/tasks/${taskId}/ticket-comments/${commentId}/retry`);
  }

  test("ZYR-AC-22 GET ticket-comments lists this task's comments only, with their outcome", async () => {
    await setAutoComment({ jiraAutoComment: false });
    const mine = seedReviewTask({ titles: ["Listed A", "Listed B"], jiraIssueKey: "KAN-40" });
    const other = seedReviewTask({ titles: ["Other task"], jiraIssueKey: "KAN-41" });
    expect((await save(mine)).status()).toBe(201);
    expect((await save(other)).status()).toBe(201);

    const res = await asOwner.get(url(`/tasks/${mine}/ticket-comments`), { failOnStatusCode: false });
    expect(res.status(), await res.text()).toBe(200);
    const { list } = await res.json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ provider: "jira", issueKey: "KAN-40", status: "skipped_disabled", reason: null, testcaseCount: 2 });
    // Internal columns (the comment body, who posted it) are not part of this response.
    expect(list[0]).not.toHaveProperty("commentText");
    expect(list[0]).not.toHaveProperty("comment_text");

    // A task with no saves yet has an empty list, not an error.
    const unsaved = seedReviewTask({ titles: ["Unsaved"], jiraIssueKey: "KAN-42" });
    expect((await (await asOwner.get(url(`/tasks/${unsaved}/ticket-comments`))).json()).list).toEqual([]);
  });

  test("ZYR-AC-23 retrying a failed comment re-sends it and records the new outcome (Jira not connected here: fails offline, with that reason)", async () => {
    await setAutoComment({ jiraAutoComment: false });
    const taskId = seedReviewTask({ titles: ["Retry me"], jiraIssueKey: "KAN-43" });
    expect((await save(taskId)).status()).toBe(201);
    const commentId = markFailed(taskId);

    const res = await asOwner.post(retryUrl(taskId, commentId), { failOnStatusCode: false });
    expect(res.status(), await res.text()).toBe(201);
    const body = await res.json();
    // No connection in this tenant, so the re-send stops before any outbound call — and the record
    // says so, replacing the earlier reason.
    expect(body).toMatchObject({ id: commentId, status: "failed", reason: "Jira is not connected." });
    expect(scalar(`SELECT reason FROM integration_ticket_comments WHERE id = ${literal(commentId)};`)).toBe("Jira is not connected.");
    const titles = activityTitles(taskId);
    expect(titles).toContain("Retrying Jira comment");
    expect(titles[titles.length - 1]).toBe("Jira comment failed");
    // The rebuilt comment still lists exactly the saved test case.
    expect(scalar(`SELECT comment_text FROM integration_ticket_comments WHERE id = ${literal(commentId)};`)).toContain("Retry me");
  });

  test("ZYR-AC-24 only a failed comment can be retried: skipped → 409, unknown or malformed id → 404", async () => {
    await setAutoComment({ jiraAutoComment: false });
    const taskId = seedReviewTask({ titles: ["Skipped one"], jiraIssueKey: "KAN-44" });
    expect((await save(taskId)).status()).toBe(201);
    const commentId = scalar(`SELECT id FROM integration_ticket_comments WHERE generation_request_id = ${literal(taskId)};`);

    const skipped = await asOwner.post(retryUrl(taskId, commentId), { failOnStatusCode: false });
    expect(skipped.status()).toBe(409);
    expect(await skipped.text()).toContain("only a failed comment can be retried");
    expect(scalar(`SELECT status FROM integration_ticket_comments WHERE id = ${literal(commentId)};`)).toBe("skipped_disabled");

    expect((await asOwner.post(retryUrl(taskId, "00000000-0000-4000-8000-000000000000"), { failOnStatusCode: false })).status()).toBe(404);
    expect((await asOwner.post(retryUrl(taskId, "not-a-uuid"), { failOnStatusCode: false })).status()).toBe(404);
    // A real comment id under the wrong task is not found either.
    const otherTask = seedReviewTask({ titles: ["Elsewhere"] });
    expect((await asOwner.post(retryUrl(otherTask, commentId), { failOnStatusCode: false })).status()).toBe(404);
  });

  test("ZYR-AC-25 two retries at once: one re-sends, the other is refused — never two concurrent posts", async () => {
    await setAutoComment({ jiraAutoComment: false });
    const taskId = seedReviewTask({ titles: ["Double retry"], jiraIssueKey: "KAN-45" });
    expect((await save(taskId)).status()).toBe(201);
    const commentId = markFailed(taskId);

    const [a, b] = await Promise.all([
      asOwner.post(retryUrl(taskId, commentId), { failOnStatusCode: false }),
      asOwner.post(retryUrl(taskId, commentId), { failOnStatusCode: false }),
    ]);
    const statuses = [a.status(), b.status()].sort();
    // The loser either lost the failed -> pending claim (409), or ran after the winner had already
    // finished and found it failed again (201). What must never happen is two re-sends at once:
    // exactly one "Retrying" entry per successful claim.
    expect(statuses[0]).toBe(201);
    expect([201, 409]).toContain(statuses[1]);
    const retries = activityTitles(taskId).filter((t) => t === "Retrying Jira comment").length;
    expect(retries).toBe(statuses.filter((s) => s === 201).length);
  });

  test("ZYR-AC-26 retrying after every listed test case was deleted fails with that reason, and posts nothing", async () => {
    await setAutoComment({ jiraAutoComment: false });
    const taskId = seedReviewTask({ titles: ["Deleted before retry"], jiraIssueKey: "KAN-46" });
    const saved = await (await save(taskId)).json();
    const commentId = markFailed(taskId);
    for (const t of saved.testcases as Array<{ id: string }>) {
      const del = await asOwner.delete(`/api/projects/${tenant!.mainProjectId}/testcases/${t.id}`, { failOnStatusCode: false });
      expect(del.status(), await del.text()).toBeLessThan(300);
    }

    const body = await (await asOwner.post(retryUrl(taskId, commentId), { failOnStatusCode: false })).json();
    expect(body.status).toBe("failed");
    expect(body.reason).toMatch(/None of the test cases in this comment exist anymore/);
    expect(activityTitles(taskId)).not.toContain("Retrying Jira comment");
  });

  test("ZYR-AC-27 the ticket-comment routes are refused to an anonymous caller and to another workspace", async () => {
    await setAutoComment({ jiraAutoComment: false });
    const taskId = seedReviewTask({ titles: ["Private comment"], jiraIssueKey: "KAN-47" });
    expect((await save(taskId)).status()).toBe(201);
    const commentId = markFailed(taskId);

    const outsider = await provisionRbacTenant("zyra");
    test.skip(!outsider, "the second tenant could not be provisioned");
    const anon = await anonymousContext();
    const asOutsider = await loginAs(outsider!.owner);
    try {
      for (const [who, api] of [["anonymous", anon], ["another workspace", asOutsider]] as const) {
        const list = await api.get(url(`/tasks/${taskId}/ticket-comments`), { failOnStatusCode: false });
        expect([401, 403, 404], `${who} listing answered ${list.status()}`).toContain(list.status());
        const retry = await api.post(retryUrl(taskId, commentId), { failOnStatusCode: false });
        expect([401, 403, 404], `${who} retrying answered ${retry.status()}`).toContain(retry.status());
      }
      // Nothing was re-sent: the record is exactly as the owner left it.
      expect(scalar(`SELECT status || '|' || reason FROM integration_ticket_comments WHERE id = ${literal(commentId)};`)).toBe("failed|seeded failure");
    } finally {
      await anon.dispose();
      await asOutsider.dispose();
    }
  });
  // ─── Credential lifecycle: a connection this deployment can't renew (V125) ─

  /*
   * The KAN-4 root cause, reproduced: the connection's token was issued to a different Atlassian
   * OAuth app than the one this deployment renews with, so renewal can never succeed here. The token
   * is an unsigned JWT naming another client_id — getIntegrationConnection reads that claim and
   * refuses BEFORE contacting Atlassian, so these tests make no outbound call. Stored as plaintext,
   * which decryptSecret passes through, like the other connection fixtures in this suite.
   */
  function foreignAppToken(): string {
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${b64({ alg: "RS256" })}.${b64({ client_id: `e2e-other-deployment-app-${Date.now()}` })}.sig`;
  }

  function seedForeignAppConnection(options: { expired: boolean }): string {
    exec(
      "INSERT INTO integration_connections (organization_id, provider, external_id, site_url, access_token, " +
        `refresh_token, token_expires_at, connected_by) VALUES (${literal(tenant!.organizationId)}, 'jira', ` +
        `'e2e-jira-site', 'https://e2e.invalid', ${literal(foreignAppToken())}, 'e2e-refresh-token', ` +
        `${options.expired ? "now() - interval '5 minutes'" : "now() + interval '1 hour'"}, ${literal(tenant!.owner.userId)});`,
    );
    return scalar(`SELECT id FROM integration_connections WHERE organization_id = ${literal(tenant!.organizationId)} AND provider = 'jira';`);
  }

  async function jiraStatus(): Promise<any> {
    const res = await asOwner.get(`/api/projects/${tenant!.mainProjectId}/jira/status`, { failOnStatusCode: false });
    expect(res.status(), await res.text()).toBe(200);
    return res.json();
  }

  test("ZYR-AC-28 status no longer reads healthy for a connection this deployment can't renew", async () => {
    seedForeignAppConnection({ expired: false });
    const status = await jiraStatus();
    expect(status.connected).toBe(true);
    expect(status.needsReconnect).toBe(true);
    expect(status.authError).toMatch(/different Atlassian OAuth app/);

    // The workspace-level status (the page where Reconnect lives) says the same.
    const ws = await (await asOwner.get("/api/workspace/integrations/jira/status")).json();
    expect(ws).toMatchObject({ connected: true, needsReconnect: true });
  });

  test("ZYR-AC-29 an expired foreign-app token: the comment fails with an actionable reason, and the dead refresh token is recorded, not re-sent", async () => {
    const connectionId = seedForeignAppConnection({ expired: true });
    await setAutoComment({ jiraAutoComment: true });
    const taskId = seedReviewTask({ titles: ["Foreign app case"], jiraIssueKey: "KAN-50" });
    expect((await save(taskId)).status()).toBe(201);

    const [row] = await waitForDelivery(taskId);
    expect(row.status).toBe("failed");
    expect(row.reason).toMatch(/needs to be reconnected from this Tesbo deployment/);
    expect(row.reason).toMatch(/different Atlassian OAuth app/);

    // The refusal is recorded against this exact refresh token (V125)…
    const markedAt = scalar(`SELECT auth_error_at::text FROM integration_connections WHERE id = ${literal(connectionId)};`);
    expect(markedAt, "the refusal was not recorded").toBeTruthy();
    expect(scalar(`SELECT auth_error_refresh_fingerprint = encode(sha256(convert_to(refresh_token, 'UTF8')), 'hex') FROM integration_connections WHERE id = ${literal(connectionId)};`)).toBe("t");

    // …so a Retry gets the same reason straight from the record, without another renewal attempt.
    const commentId = scalar(`SELECT id FROM integration_ticket_comments WHERE generation_request_id = ${literal(taskId)};`);
    const retried = await (await asOwner.post(url(`/tasks/${taskId}/ticket-comments/${commentId}/retry`), { failOnStatusCode: false })).json();
    expect(retried.status).toBe("failed");
    expect(retried.reason).toMatch(/different Atlassian OAuth app/);
    expect(scalar(`SELECT auth_error_at::text FROM integration_connections WHERE id = ${literal(connectionId)};`)).toBe(markedAt);

    const status = await jiraStatus();
    expect(status).toMatchObject({ connected: true, needsReconnect: true });
  });

  test("ZYR-AC-30 a recorded refusal heals itself when the refresh token changes (reconnect, or another deployment renewed it)", async () => {
    const connectionId = seedForeignAppConnection({ expired: false });
    // A refusal recorded for an OLDER refresh token than the one the row holds now.
    exec(
      `UPDATE integration_connections SET auth_error = 'Jira needs to be reconnected: old refusal', auth_error_at = now(), ` +
        `auth_error_refresh_fingerprint = encode(sha256(convert_to('some-older-refresh-token', 'UTF8')), 'hex') WHERE id = ${literal(connectionId)};`,
    );
    const status = await jiraStatus();
    // Still flagged — but for the app mismatch, which is true of the CURRENT token, not the stale record.
    expect(status.authError).not.toContain("old refusal");
    expect(status.authError).toMatch(/different Atlassian OAuth app/);
  });
});

/*
 * Zyra with "Access to Knowledge Base" OFF, and the chat page's background (non-blocking) send.
 *
 * The reported symptom: with KB access disabled, a Zyra prompt ended in "Failed to fetch
 * (api-app-stage.tesbo.io)". Two separate defects sat under it:
 *
 *  1. The toggle only HID knowledge-base results from the prompt — buildZyraChatDecision still ran
 *     the recency snapshot, the folder match, the semantic search (spending an embeddings call on the
 *     user's message) and the bug lookup on every turn, and only filtered afterwards. "Disabled" has
 *     to mean no KB access at all. The fake provider logs /embeddings calls separately, so "was a KB
 *     search attempted" is observable: only the KB search ever embeds the user's own message.
 *  2. The request itself: a turn is one POST held open until the reply exists, and generation turns
 *     run for minutes. Stage sits behind Cloudflare, which drops an origin request at 100 s with a
 *     CORS-less 524 — the browser reports "Failed to fetch" while the backend goes on to save the
 *     reply. The failing stage turn was simply a KB-off turn that ran 234 s. The chat page now sends
 *     `background: true`: the POST returns once the message is recorded, and the page polls for the
 *     turn, whose user message stays `processing` until the reply row exists. Callers that don't opt
 *     in (MCP, API tokens) keep the synchronous response — ZYR-A-100/101 drive that form.
 */
test.describe("zyra chat — knowledge-base gate and background send (fake provider)", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let ai: FakeAiServer;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("zyra-kb-gate");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    ai = await startFakeAiServer();
  });

  test.afterAll(async () => {
    if (tenant) purge();
    await asOwner?.dispose();
    await ai?.close();
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
    if (tenant) purge();
    // One server instance for the whole block — see FakeAiServer.reset().
    ai?.reset();
  });

  test.afterEach(() => {
    if (tenant) purge();
  });

  function purge(): void {
    const project = literal(tenant!.mainProjectId);
    const org = literal(tenant!.organizationId);
    exec(`DELETE FROM zyra_chat_messages WHERE project_id = ${project};`);
    // ai_generation_requests.chat_session_id is ON DELETE RESTRICT (V116) — before sessions.
    exec(`DELETE FROM ai_generation_requests WHERE project_id = ${project};`);
    exec(`DELETE FROM zyra_chat_sessions WHERE project_id = ${project};`);
    exec(`DELETE FROM testcases WHERE project_id = ${project};`);
    exec(`DELETE FROM suites WHERE project_id = ${project};`);
    exec(`DELETE FROM bugs WHERE project_id = ${project};`);
    exec(`DELETE FROM knowledge_documents WHERE project_id = ${project};`);
    exec(`DELETE FROM project_ai_key_allocations WHERE project_id = ${project};`);
    exec(`DELETE FROM workspace_ai_keys WHERE organization_id = ${org};`);
    // The capability lives on the project row; dropping the key restores every default (all ON).
    exec(`UPDATE projects SET settings = COALESCE(settings, '{}'::jsonb) - 'zyraAgent' WHERE id = ${project};`);
  }

  function url(suffix: string): string {
    return `/api/projects/${tenant!.mainProjectId}/agents/zyra${suffix}`;
  }

  // provider "openai", deliberately — unlike the citations block's custom gateway. An
  // embeddings-capable key is what makes the KB search embed the user's message, which is the
  // observable these tests assert on. fake-ai-server keeps those calls off the chat reply queue.
  async function allocateFakeAiKey(): Promise<void> {
    const keyRes = await asOwner.post("/api/workspace/ai-keys", {
      data: { name: `E2E kb-gate fake ai ${Date.now()}${Math.floor(Math.random() * 1000)}`, provider: "openai", apiKey: "sk-e2e-fake", baseUrl: ai.baseUrl, defaultModel: "gpt-4o-mini" },
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

  async function setKnowledgeBaseAccess(enabled: boolean): Promise<void> {
    const res = await asOwner.patch(url("/settings"), { data: { capabilities: { knowledgeBase: enabled } }, failOnStatusCode: false });
    expect(res.status(), `saving the KB capability — ${await res.text()}`).toBeLessThan(300);
    expect((await res.json()).capabilities.knowledgeBase).toBe(enabled);
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

  /** One KB doc and one bug, each carrying a unique marker word the message below also uses. */
  async function seedKnowledge(marker: string): Promise<void> {
    const kbRes = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/knowledge-base/documents`, {
      data: { folderId: rootFolderId(), documentType: "general", title: `${marker} seat policy`, contentText: `${marker}: a booking allows at most 10 seats.` },
      failOnStatusCode: false,
    });
    expect(kbRes.status(), `seeding the KB doc — ${await kbRes.text()}`).toBe(201);
    const bugRes = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/bugs`, {
      data: { title: `${marker} seat picker freezes`, description: `The ${marker} seat picker freezes on the 11th seat.` },
      failOnStatusCode: false,
    });
    expect(bugRes.status(), `seeding the bug — ${await bugRes.text()}`).toBe(201);
  }

  async function newSession(title: string): Promise<string> {
    const res = await asOwner.post(url("/chat/sessions"), { data: { title }, failOnStatusCode: false });
    expect(res.status(), `creating a chat session — ${await res.text()}`).toBeLessThan(300);
    return (await res.json()).id;
  }

  async function sessionMessages(sessionId: string): Promise<Array<Record<string, unknown>>> {
    const res = await asOwner.get(url(`/chat/sessions/${sessionId}`), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    return (await res.json()).messages;
  }

  /** Polls until the background turn behind `userMessageId` settles, returning the session's messages. */
  async function waitForTurn(sessionId: string, userMessageId: string): Promise<Array<Record<string, unknown>>> {
    let messages: Array<Record<string, unknown>> = [];
    await expect
      .poll(
        async () => {
          messages = await sessionMessages(sessionId);
          return messages.find((m) => m.id === userMessageId)?.status;
        },
        { message: "the background turn never settled its user message", timeout: 60_000, intervals: [500, 1000, 2000] },
      )
      .not.toBe("processing");
    return messages;
  }

  function queueAnswer(reply: string): void {
    ai.queueReply({ reply, reasoningSummary: "Answered directly.", action: "answer", actionType: "answer", operations: [], testcases: [] });
  }

  function routerPrompt(): string {
    expect(ai.requests.length, "the router call never reached the provider").toBeGreaterThan(0);
    return JSON.stringify(ai.requests[0].messages);
  }

  // Creating a KB document also queues a background embedding job that reaches this server, but it
  // embeds the document, never the chat message — so filtering on the message isolates the KB search.
  function kbSearchesFor(message: string): number {
    return ai.embeddingRequests.filter((r) => r.input.some((text) => text.includes(message))).length;
  }

  test("ZYR-A-100 KB access OFF: an ordinary question is answered, and no knowledge-base or bug lookup runs", async () => {
    await allocateFakeAiKey();
    const marker = `Zorblax${Date.now() % 100000}`;
    await seedKnowledge(marker);
    await setKnowledgeBaseAccess(false);
    const sessionId = await newSession("E2E kb off answer");
    const message = `How many seats can a ${marker} booking hold?`;
    queueAnswer("Knowledge-base access is off in this project, so I cannot confirm the seat limit.");

    // The synchronous form (no background flag) — what MCP and API-token callers use.
    const res = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), { data: { message }, failOnStatusCode: false });
    expect(res.status(), `sending the message — ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.message.role).toBe("assistant");
    expect(body.message.content).toContain("Knowledge-base access is off");

    const prompt = routerPrompt();
    expect(prompt).toContain("Knowledge base access is disabled for Zyra in this project");
    expect(prompt, "the KB document reached the model with KB access OFF").not.toContain(`${marker}: a booking allows`);
    expect(prompt, "the related bug reached the model with KB access OFF").not.toContain(`${marker} seat picker freezes`);
    // The regression proper: before the fix the toggle only filtered results, so the semantic search
    // still embedded the user's message on every KB-off turn.
    expect(kbSearchesFor(message), "a knowledge-base search ran with KB access OFF").toBe(0);

    const messages = await sessionMessages(sessionId);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[0].status).toBe("sent");
  });

  test("ZYR-A-101 KB access ON (default): the same question still searches the knowledge base and grounds the answer in it", async () => {
    await allocateFakeAiKey();
    const marker = `Zorblax${Date.now() % 100000}`;
    await seedKnowledge(marker);
    const sessionId = await newSession("E2E kb on answer");
    const message = `How many seats can a ${marker} booking hold?`;
    queueAnswer("A booking allows at most 10 seats.");

    const res = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), { data: { message }, failOnStatusCode: false });
    expect(res.status(), `sending the message — ${await res.text()}`).toBe(201);
    expect((await res.json()).message.content).toBe("A booking allows at most 10 seats.");

    const prompt = routerPrompt();
    expect(prompt).not.toContain("Knowledge base access is disabled");
    expect(prompt, "the KB document must still reach the model with KB access ON").toContain(`${marker}: a booking allows at most 10 seats.`);
    expect(prompt, "the related bug must still reach the model with KB access ON").toContain(`${marker} seat picker freezes`);
    expect(kbSearchesFor(message), "the semantic KB search must still run with KB access ON").toBeGreaterThan(0);
  });

  test("ZYR-A-102 KB access OFF: a generation turn sent in the background still drafts test cases, from no KB context", async () => {
    await allocateFakeAiKey();
    const marker = `Zorblax${Date.now() % 100000}`;
    await seedKnowledge(marker);
    await setKnowledgeBaseAccess(false);
    const sessionId = await newSession("E2E kb off generate");
    const message = `Generate 1 smoke test case for the ${marker} seat picker.`;
    ai.queueReply({ reply: "", reasoningSummary: "Creating one case.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: 1, exhaustive: false });
    ai.queueReply({
      drafts: [{
        title: `${marker} seat picker opens`,
        preconditions: "A show with free seats exists.",
        stepsJson: JSON.stringify([{ stepNumber: 1, action: "Open the seat picker", expectedResult: "The seat map renders" }]),
        testData: "",
        expectedSummary: "The seat map renders.",
        priority: "P1",
        tags: ["zyra"],
        sourceRefs: [],
      }],
    });

    const res = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), { data: { message, background: true }, failOnStatusCode: false });
    expect(res.status(), `starting the turn — ${await res.text()}`).toBe(201);
    const { userMessageId } = await res.json();

    const messages = await waitForTurn(sessionId, userMessageId);
    expect(messages.find((m) => m.id === userMessageId)?.status).toBe("sent");
    const reply = messages.find((m) => m.role === "assistant");
    expect(reply, "no assistant reply was written").toBeTruthy();
    const testcases = reply!.testcases as Array<Record<string, unknown>>;
    expect(testcases.map((tc) => tc.title)).toContain(`${marker} seat picker opens`);
    // The reply says plainly that KB access is off and the cases were written in general — not the
    // "nothing in your knowledge base, add it and ask again" note, which is wrong when it was never read.
    const content = String(reply!.content);
    expect(content).toContain("I don't have access to the Knowledge Base");
    expect(content).toContain("I've created 1 test case(s) in general");
    expect(content).not.toContain("I don't have anything about this in the project's knowledge base");

    // Neither the router nor the drafting call was shown the KB doc or the bug.
    const everyPrompt = JSON.stringify(ai.requests.map((r) => r.messages));
    expect(everyPrompt).not.toContain(`${marker}: a booking allows`);
    expect(everyPrompt).not.toContain(`${marker} seat picker freezes`);
    expect(kbSearchesFor(message), "a knowledge-base search ran with KB access OFF").toBe(0);
  });

  test("ZYR-A-108 KB access ON: a generation turn does not show the KB-off message and keeps its existing wording", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E kb on generate");
    // Nothing seeded, so the turn is ungrounded — the case whose note the KB-off message replaces.
    ai.queueReply({ reply: "", reasoningSummary: "Creating one case.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: 1, exhaustive: false });
    ai.queueReply({
      drafts: [{
        title: "Seat picker opens",
        preconditions: "A show with free seats exists.",
        stepsJson: JSON.stringify([{ stepNumber: 1, action: "Open the seat picker", expectedResult: "The seat map renders" }]),
        testData: "",
        expectedSummary: "The seat map renders.",
        priority: "P1",
        tags: ["zyra"],
        sourceRefs: [],
      }],
    });

    const res = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), { data: { message: "Generate 1 smoke test case for the seat picker.", background: true }, failOnStatusCode: false });
    expect(res.status(), `starting the turn — ${await res.text()}`).toBe(201);
    const messages = await waitForTurn(sessionId, (await res.json()).userMessageId);
    const content = String(messages.find((m) => m.role === "assistant")?.content);
    expect(content).not.toContain("I don't have access to the Knowledge Base");
    expect(content).toContain("I don't have anything about this in the project's knowledge base");
  });

  test("ZYR-A-103 a background send returns before the turn finishes, and the reply lands once it does", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E background send");
    // Held longer than the POST is allowed to take: a request that waits for the turn cannot pass.
    ai.delayNextReplyMs(8_000);
    queueAnswer("This project currently has 0 test cases.");

    const startedAt = Date.now();
    const res = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), {
      data: { message: "How many test cases exist?", background: true },
      failOnStatusCode: false,
    });
    const elapsedMs = Date.now() - startedAt;
    expect(res.status(), `starting the turn — ${await res.text()}`).toBe(201);
    expect(elapsedMs, "the POST waited for the turn instead of returning once the message was recorded").toBeLessThan(5_000);

    const body = await res.json();
    expect(body.accepted).toBe(true);
    expect(body.userMessageId).toEqual(expect.any(String));
    const atStart = body.session.messages as Array<Record<string, unknown>>;
    expect(atStart.map((m) => [m.role, m.status])).toEqual([["user", "processing"]]);

    const messages = await waitForTurn(sessionId, body.userMessageId);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[0].status).toBe("sent");
    expect(messages[1].content).toBe("This project currently has 0 test cases.");
    // The session claim is released once the turn settles — the next message is accepted.
    queueAnswer("Still 0.");
    const next = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), { data: { message: "And now?", background: true }, failOnStatusCode: false });
    expect(next.status(), `the follow-up was refused — ${await next.text()}`).toBe(201);
    await waitForTurn(sessionId, (await next.json()).userMessageId);
  });

  test("ZYR-A-104 background mode still refuses bad input, a busy session, and other callers synchronously", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E background refusals");
    const send = (data: Record<string, unknown>, target = sessionId) =>
      asOwner.post(url(`/chat/sessions/${target}/messages`), { data: { background: true, ...data }, failOnStatusCode: false });

    expect((await send({ message: "   " })).status(), "a whitespace-only message").toBe(400);
    expect((await send({ message: "hi" }, "00000000-0000-4000-8000-000000000000")).status(), "an unknown session").toBe(404);
    expect((await send({ message: "hi" }, "not-a-uuid")).status(), "a malformed session id").toBe(404);

    // A second message while the first turn is still running is refused, not queued behind it.
    ai.delayNextReplyMs(6_000);
    queueAnswer("First answer.");
    const first = await send({ message: "First question" });
    expect(first.status()).toBe(201);
    const second = await send({ message: "Second question" });
    expect(second.status(), `a concurrent send was accepted — ${await second.text()}`).toBe(409);
    await waitForTurn(sessionId, (await first.json()).userMessageId);
    const contents = (await sessionMessages(sessionId)).filter((m) => m.role === "user").map((m) => m.content);
    expect(contents, "the refused message must not be persisted").toEqual(["First question"]);

    const anonymous = await anonymousContext();
    try {
      const res = await anonymous.post(url(`/chat/sessions/${sessionId}/messages`), { data: { message: "hi", background: true }, failOnStatusCode: false });
      // requireUser answers 400 "Authentication required" (not 401) on every legacy route, with or
      // without `background` — the same refusal ZYR-A-01's expectRefused already accepts.
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toBe("Authentication required");
    } finally {
      await anonymous.dispose();
    }
    const otherTenant = await provisionRbacTenant("zyra-citations");
    test.skip(otherTenant === null, rbacSuiteSkipReason(otherTenant) ?? "");
    const asOther = await loginAs(otherTenant!.owner);
    try {
      const res = await asOther.post(url(`/chat/sessions/${sessionId}/messages`), { data: { message: "hi", background: true }, failOnStatusCode: false });
      expect([403, 404], `another workspace reached this session: ${res.status()}`).toContain(res.status());
    } finally {
      await asOther.dispose();
    }
    expect((await sessionMessages(sessionId)).filter((m) => m.role === "user")).toHaveLength(1);
  });

  test("ZYR-A-105 a background turn whose provider call fails still settles, and frees the session", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E background provider failure");
    ai.failNextWith(500, "provider exploded");

    const res = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), { data: { message: "How many test cases exist?", background: true }, failOnStatusCode: false });
    expect(res.status()).toBe(201);
    const messages = await waitForTurn(sessionId, (await res.json()).userMessageId);
    // Either the turn produced a reply explaining the failure (`sent` + an assistant row) or it threw
    // (`failed`) — never stuck in `processing`, which would leave the page waiting forever.
    const user = messages.find((m) => m.role === "user")!;
    expect(["sent", "failed"]).toContain(user.status);
    if (user.status === "sent") expect(messages.some((m) => m.role === "assistant")).toBe(true);

    queueAnswer("Recovered.");
    const next = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), { data: { message: "Try again", background: true }, failOnStatusCode: false });
    expect(next.status(), `the session stayed locked after a failed turn — ${await next.text()}`).toBe(201);
    const after = await waitForTurn(sessionId, (await next.json()).userMessageId);
    expect(after[after.length - 1].content).toBe("Recovered.");
  });

  test("ZYR-A-106 a message left `processing` by a turn whose process died is closed out by the next send", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E orphaned processing");
    // What a backend restart mid-turn leaves behind: the user row, still processing, and no claim.
    exec(
      "INSERT INTO zyra_chat_messages (session_id, project_id, user_id, role, content, status) VALUES " +
        `(${literal(sessionId)}, ${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'user', 'Orphaned question', 'processing');`,
    );
    queueAnswer("Fresh answer.");

    const res = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), { data: { message: "Fresh question", background: true }, failOnStatusCode: false });
    expect(res.status()).toBe(201);
    const messages = await waitForTurn(sessionId, (await res.json()).userMessageId);
    expect(messages.find((m) => m.content === "Orphaned question")?.status, "the orphan would keep a polling page waiting forever").toBe("failed");
    expect(messages.find((m) => m.content === "Fresh question")?.status).toBe("sent");
  });

  test("ZYR-A-107 a background turn's progress stream ends with a complete event carrying the persisted reply", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E background progress");
    const turnId = `33333333-3333-4333-8333-${String(Date.now()).slice(-12).padStart(12, "0")}`;
    ai.delayNextReplyMs(1_500);
    queueAnswer("Streamed answer.");

    // POST first so it registers the turn before the stream attaches — same order as the page.
    const post = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), {
      data: { message: "How many test cases exist?", background: true, turnId },
      failOnStatusCode: false,
    });
    expect(post.status()).toBe(201);
    const sse = await asOwner.get(url(`/chat/sessions/${sessionId}/turns/${turnId}/events`), { failOnStatusCode: false });
    expect(sse.status()).toBe(200);
    const events = parseSseEvents(await sse.text()) as Array<Record<string, unknown>>;
    const terminal = events[events.length - 1];
    expect(terminal?.kind, `stream did not end in a complete event — ${JSON.stringify(events)}`).toBe("complete");

    const messages = await waitForTurn(sessionId, (await post.json()).userMessageId);
    const persisted = messages.find((m) => m.role === "assistant")!;
    expect(((terminal.payload as Record<string, unknown>).message as Record<string, unknown>).id).toBe(persisted.id);
    expect(persisted.content).toBe("Streamed answer.");
  });
});

/*
 * [Zyra] Knowledge Base exact-value/requirement grounding.
 *
 * The defect: the KB stated a concrete requirement ("sessions expire after 20 minutes of
 * inactivity") and Zyra still wrote "verify the session times out". Three causes stacked, all in
 * the keyword-search path that every workspace runs today (no workspace has an embeddings key, so
 * semantic search never runs):
 *   1. plainto_tsquery ANDed every word of the request — "Generate test cases for session timeout"
 *      required a document to contain "generate", "test" and "cases" too, so it matched nothing;
 *   2. a matched (or explicitly chosen) document contributed only its first 1500 characters, so a
 *      requirement stated further down never reached the model;
 *   3. a keyword-only match was graded confidence "none", and the drafting prompt's last line then
 *      told the model to write "from general practice", overriding the exact-value rule.
 *
 * Every document below states its requirement PAST character 1500 (asserted), and every request is
 * phrased the way a user types it, not built from the document's own words. Each test fails on the
 * pre-fix code for cause 1 or 2 and asserts the cause-3 note is gone.
 *
 * What these can and cannot prove: the provider is fake (utils/fake-ai-server.ts), so they prove the
 * exact value reaches the model, labelled and citable, with an instruction to use it verbatim — not
 * that a real model then writes it. The drafts it returns are canned.
 *
 * The provider is a custom gateway — not embeddings-capable (see the relevance block's
 * allocateFakeAiKey) — so only keyword retrieval runs: the production state this bug lives in.
 */
test.describe("zyra — exact KB requirement grounding (fake provider)", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let ai: FakeAiServer;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("zyra-exact-values");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    ai = await startFakeAiServer();
  });

  test.afterAll(async () => {
    if (tenant) purge();
    await asOwner?.dispose();
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
    const org = literal(tenant!.organizationId);
    exec(`DELETE FROM zyra_chat_messages WHERE project_id = ${project};`);
    // ai_generation_requests.chat_session_id is ON DELETE RESTRICT (V116) — before sessions.
    exec(`DELETE FROM ai_generation_requests WHERE project_id = ${project};`);
    exec(`DELETE FROM zyra_chat_sessions WHERE project_id = ${project};`);
    exec(`DELETE FROM testcases WHERE project_id = ${project};`);
    exec(`DELETE FROM suites WHERE project_id = ${project};`);
    exec(`DELETE FROM knowledge_documents WHERE project_id = ${project};`);
    exec(`DELETE FROM knowledge_folders WHERE project_id = ${project} AND is_root = false;`);
    exec(`DELETE FROM project_ai_key_allocations WHERE project_id = ${project};`);
    exec(`DELETE FROM workspace_ai_keys WHERE organization_id = ${org};`);
  }

  function url(suffix: string): string {
    return `/api/projects/${tenant!.mainProjectId}/agents/zyra${suffix}`;
  }

  async function allocateFakeAiKey(): Promise<void> {
    const keyRes = await asOwner.post("/api/workspace/ai-keys", {
      data: { name: `E2E exact-values fake ai ${Date.now()}${Math.floor(Math.random() * 1000)}`, provider: "e2e-fake-gateway", apiKey: "sk-e2e-fake", baseUrl: ai.baseUrl, defaultModel: "gpt-4o-mini" },
      failOnStatusCode: false,
    });
    expect(keyRes.status(), `creating the fake-provider AI key — ${await keyRes.text()}`).toBe(201);
    const allocRes = await asOwner.post("/api/workspace/ai-keys/allocations", {
      data: { projectId: tenant!.mainProjectId, workspaceAiKeyId: (await keyRes.json()).id },
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

  // Deliberately free of every term the requests below use, so no filler passage can outrank the
  // requirement's own — and long enough that the requirement starts past character 1500.
  const FILLER = "This handbook part collects team conventions and general onboarding context for new joiners. ".repeat(9);

  /** A document whose one concrete requirement sits under its own heading, after ~1700 chars of filler. */
  function longDoc(heading: string, requirement: string): string {
    const text = ["# Overview", FILLER, "# Background", FILLER, `# ${heading}`, requirement, "# Change log", FILLER.slice(0, 300)].join("\n\n");
    expect(text.indexOf(requirement), "the requirement must start past the old 1500-character cut").toBeGreaterThan(1500);
    return text;
  }

  async function createDoc(title: string, contentText: string, folderId = rootFolderId()): Promise<string> {
    const res = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/knowledge-base/documents`, {
      data: { folderId, documentType: "general", title, contentText },
      failOnStatusCode: false,
    });
    expect(res.status(), `seeding "${title}" — ${await res.text()}`).toBe(201);
    return (await res.json()).id;
  }

  function draftReply(title: string): Record<string, unknown> {
    return {
      drafts: [{
        title,
        preconditions: "The feature is available.",
        stepsJson: JSON.stringify([{ stepNumber: 1, action: "Exercise the rule", expectedResult: "The rule holds" }]),
        testData: "",
        expectedSummary: "The rule holds.",
        priority: "P1",
        tags: ["zyra"],
        // "KB 1" is the only KB label in these prompts; the backend resolves it against the sources it
        // actually showed, so it round-trips to the seeded document's id only if that doc was KB 1.
        sourceRefs: ["KB 1"],
      }],
    };
  }

  /** The drafting call — the one carrying zyraStaticSourcePrompt — as opposed to the router or memory calls. */
  function draftingPrompt(): string {
    const call = ai.requests.find((r) => JSON.stringify(r.messages).includes("Static project sources for prompt caching"));
    expect(call, "the drafting call never reached the provider").toBeTruthy();
    return JSON.stringify(call!.messages);
  }

  // JSON.stringify escapes quotes and newlines, so compare against the same encoding.
  const encoded = (text: string) => JSON.stringify(text).slice(1, -1);

  function expectGroundedOn(prompt: string, requirement: string): void {
    expect(prompt, "the exact requirement must reach the drafting model").toContain(encoded(requirement));
    // Cause 3: a keyword match is a real (loose) match, never "nothing found — write from general practice".
    expect(prompt).not.toContain("were not matched to this request by search");
    expect(prompt).not.toContain("did not clear the relevance bar");
    expect(prompt, "the model must be told to use a stated value verbatim").toContain("use it exactly as stated");
  }

  async function newSession(title: string): Promise<string> {
    const res = await asOwner.post(url("/chat/sessions"), { data: { title }, failOnStatusCode: false });
    expect(res.status(), `creating a chat session — ${await res.text()}`).toBeLessThan(300);
    return (await res.json()).id;
  }

  /** Sends a generation turn in the background and waits for it, returning the assistant's reply row. */
  async function generateInChat(message: string, draftTitle: string): Promise<Record<string, unknown>> {
    const sessionId = await newSession(`E2E exact values ${Date.now()}`);
    ai.queueReply({ reply: "", reasoningSummary: "Creating one case.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: 1, exhaustive: false });
    ai.queueReply(draftReply(draftTitle));
    const res = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), { data: { message, background: true }, failOnStatusCode: false });
    expect(res.status(), `starting the turn — ${await res.text()}`).toBe(201);
    const { userMessageId } = await res.json();
    let messages: Array<Record<string, unknown>> = [];
    await expect
      .poll(
        async () => {
          const got = await asOwner.get(url(`/chat/sessions/${sessionId}`), { failOnStatusCode: false });
          messages = (await got.json()).messages;
          return messages.find((m) => m.id === userMessageId)?.status;
        },
        { message: "the background turn never settled its user message", timeout: 60_000, intervals: [500, 1000, 2000] },
      )
      .not.toBe("processing");
    const reply = messages.find((m) => m.role === "assistant");
    expect(reply, "no assistant reply was written").toBeTruthy();
    return reply!;
  }

  function citedIds(reply: Record<string, unknown>): string[] {
    const rows = (reply.testcases as Array<Record<string, unknown>>) || [];
    return rows.flatMap((row) => ((row.sourceRefs as Array<Record<string, unknown>>) || []).map((ref) => String(ref.id)));
  }

  /*
   * One requirement type per row. Each request is phrased the way a user asks for it — with the
   * request words ("generate", "test cases") that sank the old AND query — and none of them contains
   * the value being checked, so the value can only have come from the knowledge base.
   */
  const REQUIREMENTS = [
    { id: "ZYR-A-109", kind: "a duration", title: "Portal session policy", heading: "Session policy",
      requirement: "An authenticated session expires after 20 minutes of inactivity and the user is returned to the sign-in page.",
      request: "Generate test cases for session timeout" },
    { id: "ZYR-A-110", kind: "a min/max character limit", title: "Profile field rules", heading: "Display name",
      requirement: "Display names must be between 3 and 30 characters long; leading and trailing spaces are trimmed first.",
      request: "Write test cases for display name validation" },
    { id: "ZYR-A-111", kind: "a numeric range", title: "Order quantity limits", heading: "Quantity per order",
      requirement: "A single order may contain between 1 and 99 units of any one product.",
      request: "Create tests for order quantity limits" },
    { id: "ZYR-A-112", kind: "a date constraint", title: "Delivery scheduling", heading: "Allowed delivery window",
      requirement: "Delivery dates can be scheduled no earlier than 2 business days and no later than 60 days after the order date.",
      request: "Generate test cases for delivery date scheduling" },
    { id: "ZYR-A-113", kind: "allowed and disallowed values", title: "Avatar uploads", heading: "Accepted formats",
      requirement: "Accepted avatar formats are PNG, JPEG and WebP; GIF and SVG uploads are rejected.",
      request: "Write test cases for avatar upload formats" },
    { id: "ZYR-A-114", kind: "an error code and message", title: "Coupon redemption", heading: "Expired coupons",
      requirement: "When a coupon has expired the API responds 410 with error code CPN-EXPIRED and the message 'This coupon is no longer valid.'",
      request: "Generate tests for expired coupon handling" },
    { id: "ZYR-A-115", kind: "a lockout threshold", title: "Login lockout", heading: "Lockout rule",
      requirement: "After 5 consecutive failed login attempts the account is locked for 15 minutes.",
      request: "Write test cases for the failed login lockout" },
  ];

  for (const row of REQUIREMENTS) {
    test(`${row.id} chat generation grounds on ${row.kind} stated deep in a KB document, from a naturally phrased request`, async () => {
      await allocateFakeAiKey();
      const docId = await createDoc(row.title, longDoc(row.heading, row.requirement));

      const reply = await generateInChat(row.request, `${row.title} rule holds`);

      expectGroundedOn(draftingPrompt(), row.requirement);
      // The heading travels with the passage — it's what tells the model what a bare value is about.
      expect(draftingPrompt()).toContain(encoded(`${row.heading}\n${row.requirement}`));
      // Persisted state: the draft's "KB 1" citation resolved to this very document.
      expect(citedIds(reply)).toContain(docId);
    });
  }

  test("ZYR-A-116 only the relevant passage is sent: the document's unrelated opening is not, and the passage stays bounded", async () => {
    await allocateFakeAiKey();
    const requirement = REQUIREMENTS[0].requirement;
    await createDoc("Portal session policy", longDoc("Session policy", requirement));

    await generateInChat("Generate test cases for session timeout", "Session expires after inactivity");

    const prompt = draftingPrompt();
    expectGroundedOn(prompt, requirement);
    // The opening that used to be all the model saw is gone — the budget went to the requirement.
    expect(prompt).not.toContain("# Overview");
    expect(prompt.split("This handbook part collects").length - 1, "filler passages crowded out the requirement").toBeLessThanOrEqual(1);
  });

  test("ZYR-A-117 an unrelated request does not pull in a document that only shares a common word", async () => {
    await allocateFakeAiKey();
    const requirement = REQUIREMENTS[0].requirement;
    // Shares "page" with the request below ("…returned to the sign-in page") — one of three content
    // terms, under the coverage floor. Matching on it would ground a checkout test in session policy.
    await createDoc("Portal session policy", longDoc("Session policy", requirement));

    await generateInChat("Generate test cases for the checkout page layout", "Checkout layout renders");

    const prompt = draftingPrompt();
    expect(prompt, "a one-shared-word document was treated as relevant").not.toContain(encoded(requirement));
    // Nothing matched, so the recency fallback is shown — and honestly labelled as not matched.
    expect(prompt).toContain("were not matched to this request by search");
  });

  /** Waits for a task-board generation to leave todo/in_progress. */
  async function waitForTaskSettled(taskId: string): Promise<string> {
    for (let i = 0; i < 80; i++) {
      const status = scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`);
      if (status !== "todo" && status !== "in_progress") return status ?? "";
      await new Promise((r) => setTimeout(r, 250));
    }
    return scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(taskId)};`) ?? "";
  }

  async function generateOnTaskBoard(data: Record<string, unknown>): Promise<void> {
    ai.queueReply(draftReply("Session expires after inactivity"));
    // rememberZyraTurn's summarization call, made after every successful generation.
    ai.queueReply("- Generated a session-timeout test case.");
    const res = await asOwner.post(url("/tasks"), { data, failOnStatusCode: false });
    expect(res.status(), `creating the task — ${await res.text()}`).toBe(201);
    expect(await waitForTaskSettled((await res.json()).generationRequestId), "generation must complete, not fail").toBe("in_review");
  }

  test("ZYR-A-118 task-board generation grounds on the requirement from a naturally phrased story (not one built from the doc's words)", async () => {
    await allocateFakeAiKey();
    const requirement = REQUIREMENTS[0].requirement;
    await createDoc("Portal session policy", longDoc("Session policy", requirement));

    // ZYR-A-91 had to hand-craft its story from only the words its document contained, because the
    // old AND query dropped the document otherwise. This is the story a user actually writes.
    await generateOnTaskBoard({ userStory: "Write test cases for session timeout" });

    expectGroundedOn(draftingPrompt(), requirement);
  });

  test("ZYR-A-119 an explicitly selected KB document shows the passage the story is about, not just its opening", async () => {
    await allocateFakeAiKey();
    const requirement = REQUIREMENTS[0].requirement;
    const docId = await createDoc("Portal session policy", longDoc("Session policy", requirement));

    await generateOnTaskBoard({ userStory: "Write test cases for session timeout", knowledgeItemIds: [docId] });

    const prompt = draftingPrompt();
    expect(prompt, "the picked document's requirement must reach the model").toContain(encoded(requirement));
    expect(prompt).toContain("Portal session policy");
  });

  test("ZYR-A-120 a document in a folder the message names shows its relevant passage, not just its opening", async () => {
    await allocateFakeAiKey();
    const requirement = REQUIREMENTS[0].requirement;
    const folderName = `Aurora Policies ${Date.now() % 100000}`;
    const folderRes = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/knowledge-base/folders`, { data: { name: folderName }, failOnStatusCode: false });
    expect(folderRes.status(), `creating the folder — ${await folderRes.text()}`).toBe(201);
    await createDoc("Portal session policy", longDoc("Session policy", requirement), (await folderRes.json()).id);

    await generateInChat(`Generate test cases for session timeout from the '${folderName}' folder`, "Session expires after inactivity");

    // Folder items are listed first: KB 1 is the folder banner, KB 2 the folder's document. Checking
    // KB 2 specifically isolates the folder path from keyword search, which would find the doc too.
    const prompt = draftingPrompt();
    expect(prompt).toContain(encoded(`KB 1: Knowledge base folder: ${folderName}`));
    const kb2 = prompt.split("KB 2: ")[1]?.split("KB 3: ")[0] ?? "";
    expect(kb2, "the folder's own copy of the document must carry the requirement").toContain(encoded(requirement));
  });
});

/*
 * [Zyra] The per-request trace, and the session-claim / resume lifecycle it rides on.
 *
 * The trace (src/legacy/zyra-turn-trace.ts) is opened step by step at the real branch points of a
 * turn and persisted on the user message that asked for it (or on an assistant message that answers
 * no user message of its own — a plan batch, a resumed turn, a Stop/Resume). These tests assert on
 * that persisted trace through the ordinary session read, for each shape of request: a step appears
 * only when its work ran, carries what that work found, and records how it ended.
 *
 * The lifecycle half pins the stuck-session fixes that shipped alongside it: a live turn keeps its
 * claim past the old 5-minute window (heartbeat), a turn whose claim was taken over cannot release
 * the newer turn's claim (owner token), and work whose process died reads as failed/timed out
 * instead of leaving the page waiting forever. Stale state is arranged through Postgres — the same
 * "arrange through the database" rule the resume tests above use, since killing the backend
 * mid-turn is not something this suite does.
 */
test.describe("zyra chat — request trace and turn lifecycle (fake provider)", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let ai: FakeAiServer;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("zyra-trace");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    ai = await startFakeAiServer();
  });

  test.afterAll(async () => {
    if (tenant) purge();
    await asOwner?.dispose();
    await ai?.close();
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
    if (tenant) purge();
    // One server instance for the whole block — see FakeAiServer.reset().
    ai?.reset();
  });

  test.afterEach(() => {
    if (tenant) purge();
  });

  type TraceStep = { stage: string; attempt: number; status: string; meta?: Record<string, unknown>; startedAt: string; endedAt: string | null };
  type Trace = { version: number; outcome: string; startedAt: string; endedAt: string | null; steps: TraceStep[] };
  type Message = Record<string, unknown> & { id: string; role: string; status: string; content: string; trace?: Trace | null };

  function purge(): void {
    const project = literal(tenant!.mainProjectId);
    const org = literal(tenant!.organizationId);
    exec(`DELETE FROM zyra_chat_messages WHERE project_id = ${project};`);
    exec(`DELETE FROM ai_generation_requests WHERE project_id = ${project};`);
    exec(`DELETE FROM zyra_chat_sessions WHERE project_id = ${project};`);
    exec(`DELETE FROM testcases WHERE project_id = ${project};`);
    exec(`DELETE FROM suites WHERE project_id = ${project};`);
    exec(`DELETE FROM bugs WHERE project_id = ${project};`);
    exec(`DELETE FROM knowledge_documents WHERE project_id = ${project};`);
    exec(`DELETE FROM project_ai_key_allocations WHERE project_id = ${project};`);
    exec(`DELETE FROM workspace_ai_keys WHERE organization_id = ${org};`);
    exec(`UPDATE projects SET settings = COALESCE(settings, '{}'::jsonb) - 'zyraAgent' WHERE id = ${project};`);
  }

  function url(suffix: string): string {
    return `/api/projects/${tenant!.mainProjectId}/agents/zyra${suffix}`;
  }

  async function allocateFakeAiKey(): Promise<void> {
    const keyRes = await asOwner.post("/api/workspace/ai-keys", {
      data: { name: `E2E trace fake ai ${Date.now()}${Math.floor(Math.random() * 1000)}`, provider: "openai", apiKey: "sk-e2e-fake", baseUrl: ai.baseUrl, defaultModel: "gpt-4o-mini" },
      failOnStatusCode: false,
    });
    expect(keyRes.status(), `creating the fake-provider AI key — ${await keyRes.text()}`).toBe(201);
    const allocRes = await asOwner.post("/api/workspace/ai-keys/allocations", {
      data: { projectId: tenant!.mainProjectId, workspaceAiKeyId: (await keyRes.json()).id },
      failOnStatusCode: false,
    });
    expect(allocRes.status(), `allocating the fake-provider key — ${await allocRes.text()}`).toBe(201);
  }

  async function setCapabilities(capabilities: Record<string, boolean>): Promise<void> {
    const res = await asOwner.patch(url("/settings"), { data: { capabilities }, failOnStatusCode: false });
    expect(res.status(), `saving capabilities — ${await res.text()}`).toBeLessThan(300);
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

  /** One KB doc and one bug, each carrying a unique marker word the message also uses. */
  async function seedKnowledge(marker: string): Promise<void> {
    const kbRes = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/knowledge-base/documents`, {
      data: { folderId: rootFolderId(), documentType: "general", title: `${marker} seat policy`, contentText: `${marker}: a booking allows at most 10 seats.` },
      failOnStatusCode: false,
    });
    expect(kbRes.status(), `seeding the KB doc — ${await kbRes.text()}`).toBe(201);
    const bugRes = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/bugs`, {
      data: { title: `${marker} seat picker freezes`, description: `The ${marker} seat picker freezes on the 11th seat.` },
      failOnStatusCode: false,
    });
    expect(bugRes.status(), `seeding the bug — ${await bugRes.text()}`).toBe(201);
  }

  async function newSession(title: string): Promise<string> {
    const res = await asOwner.post(url("/chat/sessions"), { data: { title }, failOnStatusCode: false });
    expect(res.status(), `creating a chat session — ${await res.text()}`).toBeLessThan(300);
    return (await res.json()).id;
  }

  async function sessionMessages(sessionId: string, as: APIRequestContext = asOwner): Promise<Message[]> {
    const res = await as.get(url(`/chat/sessions/${sessionId}`), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    return (await res.json()).messages;
  }

  function send(sessionId: string, message: string, extra: Record<string, unknown> = { background: true }): Promise<APIResponse> {
    return asOwner.post(url(`/chat/sessions/${sessionId}/messages`), { data: { message, ...extra }, failOnStatusCode: false });
  }

  /** Polls until the background turn behind `userMessageId` settles, returning the session's messages. */
  async function waitForTurn(sessionId: string, userMessageId: string, timeout = 60_000): Promise<Message[]> {
    let messages: Message[] = [];
    await expect
      .poll(
        async () => {
          messages = await sessionMessages(sessionId);
          return messages.find((m) => m.id === userMessageId)?.status;
        },
        { message: "the background turn never settled its user message", timeout, intervals: [500, 1000, 2000] },
      )
      .not.toBe("processing");
    return messages;
  }

  function queueAnswer(reply: string): void {
    ai.queueReply({ reply, reasoningSummary: "Answered directly.", action: "answer", actionType: "answer", operations: [], testcases: [] });
  }

  function queueCreateTurn(title: string): void {
    ai.queueReply({ reply: "", reasoningSummary: "Creating one case.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: 1, exhaustive: false });
    ai.queueReply({ drafts: [draft(title)] });
  }

  function draft(title: string): Record<string, unknown> {
    return {
      title,
      preconditions: "A show with free seats exists.",
      stepsJson: JSON.stringify([{ stepNumber: 1, action: "Open the seat picker", expectedResult: "The seat map renders" }]),
      testData: "",
      expectedSummary: "The seat map renders.",
      priority: "P1",
      tags: ["zyra"],
      sourceRefs: [],
    };
  }

  function stages(trace: Trace | null | undefined): string[] {
    return (trace?.steps || []).map((s) => (s.attempt > 1 ? `${s.stage}#${s.attempt}` : s.stage));
  }

  function step(trace: Trace | null | undefined, stage: string, attempt = 1): TraceStep {
    const found = trace?.steps.find((s) => s.stage === stage && s.attempt === attempt);
    expect(found, `no '${stage}' (attempt ${attempt}) step in ${JSON.stringify(stages(trace))}`).toBeTruthy();
    return found!;
  }

  function seedRunningPlan(sessionId: string, status: "running" | "paused" = "running"): void {
    const plan = JSON.stringify({ planId: `e2e-plan-${Date.now()}`, status, remainingScenarios: ["Seat limit", "Seat release"], batchSize: 5, doneCount: 3, totalCount: 5, originalMessage: "Generate all possible cases" });
    exec(`UPDATE zyra_chat_sessions SET active_plan = ${literal(plan)}::jsonb WHERE id = ${literal(sessionId)};`);
  }

  test("ZYR-A-121 an answer turn's trace lists exactly what it read and decided — no generation or staging step it never ran", async () => {
    await allocateFakeAiKey();
    const marker = `Quillon${Date.now() % 100000}`;
    await seedKnowledge(marker);
    const sessionId = await newSession("E2E trace answer");
    queueAnswer("A booking allows at most 10 seats.");

    // The synchronous form — an API/MCP caller with no turnId still gets a persisted trace.
    const res = await send(sessionId, `How many seats can a ${marker} booking hold?`, {});
    expect(res.status(), `sending the message — ${await res.text()}`).toBe(201);

    const [user, reply] = await sessionMessages(sessionId);
    expect(reply.role).toBe("assistant");
    expect(reply.trace ?? null, "an ordinary reply carries no trace of its own — the request's is on the user message").toBeNull();
    const trace = user.trace!;
    expect(trace.version).toBe(1);
    expect(trace.outcome).toBe("completed");
    expect(trace.endedAt).toEqual(expect.any(String));
    expect(stages(trace)).toEqual(["received", "context:knowledge", "context:jira", "context:testcases", "context:bugs", "routing", "finalizing"]);
    expect(trace.steps.every((s) => s.status !== "active" && s.endedAt), "every step of a finished request is closed").toBe(true);

    const knowledge = step(trace, "context:knowledge");
    expect(knowledge.status).toBe("ok");
    expect((knowledge.meta!.items as Array<{ title: string }>).map((i) => i.title)).toContain(`${marker} seat policy`);
    const bugs = step(trace, "context:bugs");
    expect((bugs.meta!.items as Array<{ title: string }>).map((i) => i.title)).toContain(`${marker} seat picker freezes`);
    expect(step(trace, "context:jira").status, "no Jira is synced for this tenant, and the trace says so").toBe("empty");
    expect(step(trace, "routing").meta).toMatchObject({ action: "answer", operationCount: 0 });
    expect(step(trace, "finalizing").meta).toMatchObject({ savedCount: 0, proposedCount: 0 });
  });

  test("ZYR-A-122 a generation turn's trace records the routed action, the drafts produced, what was staged, and what was proposed", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E trace create");
    queueCreateTurn("Seat picker opens");

    const res = await send(sessionId, "Generate 1 smoke test case for the seat picker.");
    expect(res.status()).toBe(201);
    const { userMessageId } = await res.json();
    const messages = await waitForTurn(sessionId, userMessageId);
    const trace = messages.find((m) => m.id === userMessageId)!.trace!;

    expect(trace.outcome).toBe("completed");
    expect(stages(trace)).toEqual(["received", "context:knowledge", "context:jira", "context:testcases", "context:bugs", "routing", "generating", "staging", "finalizing"]);
    expect(step(trace, "routing").meta).toMatchObject({ action: "create" });
    expect(step(trace, "generating").meta).toMatchObject({ requestedCount: 1, draftedCount: 1 });
    expect(step(trace, "staging").meta).toMatchObject({ operationCounts: { create: 1 } });
    expect(step(trace, "finalizing").meta).toMatchObject({ savedCount: 0, proposedCount: 1 });
  });

  test("ZYR-A-123 with KB access off, the knowledge and bug steps are recorded as skipped with the reason — never as found", async () => {
    await allocateFakeAiKey();
    const marker = `Quillon${Date.now() % 100000}`;
    await seedKnowledge(marker);
    await setCapabilities({ knowledgeBase: false });
    const sessionId = await newSession("E2E trace kb off");
    queueAnswer("Knowledge-base access is off.");

    const res = await send(sessionId, `How many seats can a ${marker} booking hold?`);
    const messages = await waitForTurn(sessionId, (await res.json()).userMessageId);
    const trace = messages[0].trace!;
    for (const stage of ["context:knowledge", "context:bugs"]) {
      const s = step(trace, stage);
      expect(s.status, stage).toBe("skipped");
      expect(s.meta).toMatchObject({ skipped: true, reason: "Knowledge base access is off for this project" });
      expect(s.meta!.items, `${stage} must not list what it was never allowed to read`).toBeUndefined();
    }
  });

  test("ZYR-A-124 a request refused by a capability gate is recorded as blocked on the routing step, with no generation step", async () => {
    await allocateFakeAiKey();
    await setCapabilities({ generation: false });
    const sessionId = await newSession("E2E trace blocked");
    ai.queueReply({ reply: "", reasoningSummary: "Creating.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: 1, exhaustive: false });

    const res = await send(sessionId, "Generate 1 test case for the seat picker.");
    const messages = await waitForTurn(sessionId, (await res.json()).userMessageId);
    const trace = messages[0].trace!;
    expect(stages(trace)).not.toContain("generating");
    expect(step(trace, "routing")).toMatchObject({ status: "blocked", meta: { action: "create", reason: "Test case generation is off for this project" } });
    expect(trace.outcome, "a gate doing its job is not an error").toBe("completed");
    expect(messages[1].content).toContain("disabled");
  });

  test("ZYR-A-125 with no AI key, the context that was gathered is still shown and the decision step says why it was blocked", async () => {
    const sessionId = await newSession("E2E trace no key");
    const res = await send(sessionId, "How many test cases exist?");
    const messages = await waitForTurn(sessionId, (await res.json()).userMessageId);
    const trace = messages[0].trace!;
    expect(stages(trace)).toEqual(["received", "context:knowledge", "context:jira", "context:testcases", "context:bugs", "routing", "finalizing"]);
    const routing = step(trace, "routing");
    expect(routing.status).toBe("blocked");
    expect(String(routing.meta!.reason)).not.toBe("");
    expect(ai.requests.length, "nothing reached a provider").toBe(0);
  });

  test("ZYR-A-126 a provider error on the decision call is recorded as a failed step, and the turn as completed with errors", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E trace provider error");
    ai.failNextWith(500, "provider exploded");

    const res = await send(sessionId, "How many test cases exist?");
    const messages = await waitForTurn(sessionId, (await res.json()).userMessageId);
    const trace = messages[0].trace!;
    expect(step(trace, "routing").status).toBe("failed");
    expect(String(step(trace, "routing").meta!.reason)).not.toBe("");
    expect(trace.outcome).toBe("completed_with_errors");
    expect(messages[0].status, "the degraded reply was still written").toBe("sent");
  });

  test("ZYR-A-127 a generation that fails and is retried at a smaller batch shows both attempts — the failed one and the one that produced the drafts", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E trace generation retry");
    ai.queueReply({ reply: "", reasoningSummary: "Creating.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: 1, exhaustive: false });
    // Unparseable drafting output — the failure the narrowed retry exists for.
    ai.queueReply("this is not json at all");
    ai.queueReply({ drafts: [draft("Seat picker opens (retry)")] });

    const res = await send(sessionId, "Generate 1 test case for the seat picker.");
    const messages = await waitForTurn(sessionId, (await res.json()).userMessageId);
    const trace = messages[0].trace!;
    expect(stages(trace)).toEqual(expect.arrayContaining(["generating", "generating#2"]));
    expect(step(trace, "generating", 1)).toMatchObject({ status: "failed" });
    expect(step(trace, "generating", 2)).toMatchObject({ status: "ok", meta: { retry: true, draftedCount: 1 } });
    expect(trace.outcome).toBe("completed_with_errors");
  });

  test("ZYR-A-128 a Jira coverage question records the tool run and its summarizing call as their own steps", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E trace jira tool");
    ai.queueReply({ reply: "", reasoningSummary: "Counting coverage.", action: "jira_pending_testcases", actionType: "answer", operations: [], testcases: [] });
    ai.queueReply({ reply: "No Jira tickets are synced yet.", reasoningSummary: "From the tool result.", action: "answer", actionType: "answer", operations: [], testcases: [] });

    const res = await send(sessionId, "How many Jira tickets still need test cases?");
    const messages = await waitForTurn(sessionId, (await res.json()).userMessageId);
    const trace = messages[0].trace!;
    expect(stages(trace)).toEqual(["received", "context:knowledge", "context:jira", "context:testcases", "context:bugs", "routing", "tool:jira_coverage", "summarizing", "finalizing"]);
    expect(step(trace, "routing").meta).toMatchObject({ action: "jira_pending_testcases" });
  });

  test("ZYR-A-129 a confirmation the first pass ignored is retried under its own step, and the retry's own context and decision are recorded as attempt 2", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E trace confirmation retry");
    // The previous turn: a create PROPOSAL that staged nothing — what a bare "yes" confirms.
    exec(
      "INSERT INTO zyra_chat_messages (session_id, project_id, user_id, role, content, action_type, status) VALUES " +
        `(${literal(sessionId)}, ${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'assistant', 'I can draft a seat picker test case. Shall I?', 'create', 'completed');`,
    );
    queueAnswer("Sure, I could do that.");
    queueCreateTurn("Seat picker opens (confirmed)");

    const res = await send(sessionId, "yes");
    const { userMessageId } = await res.json();
    const messages = await waitForTurn(sessionId, userMessageId);
    const trace = messages.find((m) => m.id === userMessageId)!.trace!;
    expect(stages(trace)).toEqual(expect.arrayContaining(["routing", "retrying", "context:knowledge#2", "routing#2", "generating"]));
    expect(step(trace, "routing", 1).meta).toMatchObject({ action: "answer" });
    expect(step(trace, "retrying").meta).toMatchObject({ reason: "confirmation", fired: true });
    expect(step(trace, "routing", 2).meta).toMatchObject({ action: "create" });
  });

  test("ZYR-A-130 the live progress stream narrates the same steps the persisted trace records, including the outcome updates", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E trace stream parity");
    const turnId = `44444444-4444-4444-8444-${String(Date.now()).slice(-12).padStart(12, "0")}`;
    ai.delayNextReplyMs(1_500);
    queueAnswer("Streamed answer.");

    const post = await send(sessionId, "How many test cases exist?", { background: true, turnId });
    expect(post.status()).toBe(201);
    const sse = await asOwner.get(url(`/chat/sessions/${sessionId}/turns/${turnId}/events`), { failOnStatusCode: false });
    const events = parseSseEvents(await sse.text()) as Array<Record<string, unknown>>;
    const messages = await waitForTurn(sessionId, (await post.json()).userMessageId);

    const streamed = events.filter((e) => e.kind === "stage").map((e) => e.stage);
    expect(streamed).toEqual(stages(messages[0].trace));
    const routingUpdate = events.find((e) => e.kind === "update" && e.stage === "routing");
    expect(routingUpdate?.meta, "the routing decision reaches the live stream as an update").toMatchObject({ action: "answer" });
  });

  test("ZYR-A-131 a turn still running shows its trace so far on the session read — a reload mid-turn is not a blank", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E trace mid-turn");
    ai.delayNextReplyMs(6_000);
    queueAnswer("Eventually.");

    const res = await send(sessionId, "How many test cases exist?");
    const { userMessageId } = await res.json();
    await expect.poll(() => ai.requests.length, { message: "the decision call never reached the provider", timeout: 30_000 }).toBeGreaterThan(0);
    await expect
      .poll(async () => {
        const user = (await sessionMessages(sessionId)).find((m) => m.id === userMessageId)!;
        const last = user.trace?.steps[user.trace.steps.length - 1];
        return [user.status, user.trace?.outcome, last?.stage, last?.status].join("|");
      }, { message: "the in-flight trace never showed the routing step running", timeout: 10_000 })
      .toBe("processing|running|routing|active");
    await waitForTurn(sessionId, userMessageId);
  });

  test("ZYR-A-132 a message left processing by a dead turn reads as failed on the next session read — without waiting for another send", async () => {
    const sessionId = await newSession("E2E trace orphan read");
    exec(
      "INSERT INTO zyra_chat_messages (session_id, project_id, user_id, role, content, status) VALUES " +
        `(${literal(sessionId)}, ${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'user', 'Orphaned question', 'processing');`,
    );
    // No claim on the session: nothing is running. The page disables its composer while any message
    // is processing, so a row nobody will ever settle used to lock the conversation for good.
    expect((await sessionMessages(sessionId))[0].status).toBe("failed");

    // A live claim means a turn really is running — then it must still read as processing.
    exec(`UPDATE zyra_chat_sessions SET processing_since = now() WHERE id = ${literal(sessionId)};`);
    expect((await sessionMessages(sessionId))[0].status).toBe("processing");
    // A claim past the staleness window is a dead one again.
    exec(`UPDATE zyra_chat_sessions SET processing_since = now() - interval '10 minutes' WHERE id = ${literal(sessionId)};`);
    expect((await sessionMessages(sessionId))[0].status).toBe("failed");
    // The read never wrote anything — the row itself is only rewritten by the next claim.
    expect(scalar(`SELECT status FROM zyra_chat_messages WHERE session_id = ${literal(sessionId)};`)).toBe("processing");
  });

  test("ZYR-A-133 a live turn keeps its session claim past the staleness window, so a second message is still refused", async () => {
    test.setTimeout(180_000);
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E trace heartbeat");
    ai.queueReply({ reply: "", reasoningSummary: "Creating.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: 1, exhaustive: false });
    ai.queueReply({ drafts: [draft("Seat picker opens (slow)")] });

    const res = await send(sessionId, "Generate 1 test case for the seat picker.");
    const { userMessageId } = await res.json();
    await expect.poll(() => ai.requests.length, { timeout: 30_000 }).toBe(1);
    // Hold the drafting call well past one heartbeat interval (60s), inside the generate timeout.
    ai.delayNextReplyMs(80_000);
    // Make the claim look as old as a turn that started before the 5-minute window — what every
    // generation longer than that looked like before the heartbeat.
    exec(`UPDATE zyra_chat_sessions SET processing_since = now() - interval '10 minutes' WHERE id = ${literal(sessionId)};`);

    await expect
      .poll(() => scalar(`SELECT (processing_since > now() - interval '2 minutes')::text FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`), {
        message: "the running turn never refreshed its claim",
        timeout: 75_000,
        intervals: [2_000],
      })
      .toBe("true");
    const second = await send(sessionId, "A second question");
    expect(second.status(), `a second turn took over a live turn's session — ${await second.text()}`).toBe(409);
    await waitForTurn(sessionId, userMessageId, 120_000);
  });

  test("ZYR-A-134 a turn whose claim was taken over cannot release the claim of the turn that took it", async () => {
    test.setTimeout(120_000);
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E trace owner release");
    ai.delayNextReplyMs(4_000);
    queueAnswer("First.");
    const first = await send(sessionId, "First question");
    expect(first.status()).toBe(201);
    await expect.poll(() => ai.requests.length, { timeout: 30_000 }).toBe(1);
    // The first turn now looks dead (its claim is past the window), so a second may take the session.
    exec(`UPDATE zyra_chat_sessions SET processing_since = now() - interval '10 minutes' WHERE id = ${literal(sessionId)};`);
    ai.delayNextReplyMs(15_000);
    queueAnswer("Second.");
    const second = await send(sessionId, "Second question");
    expect(second.status(), `taking over a stale claim — ${await second.text()}`).toBe(201);

    // The first turn finishes while the second is still held at the provider.
    await expect
      .poll(async () => (await sessionMessages(sessionId)).some((m) => m.role === "assistant" && m.content === "First."), { timeout: 30_000 })
      .toBe(true);
    // Its release runs right after its reply is written; give it that moment.
    await new Promise((r) => setTimeout(r, 1_500));
    const third = await send(sessionId, "Third question");
    expect(third.status(), `the first turn's exit released the second turn's claim — ${await third.text()}`).toBe(409);
    await waitForTurn(sessionId, (await second.json()).userMessageId);
  });

  test("ZYR-A-135 two sessions run their turns independently — a slow turn in one never blocks or leaks into the other", async () => {
    await allocateFakeAiKey();
    const slowSession = await newSession("E2E trace isolation slow");
    const fastSession = await newSession("E2E trace isolation fast");
    ai.delayNextReplyMs(10_000);
    queueAnswer("Slow answer.");
    queueAnswer("Fast answer.");

    const slow = await send(slowSession, "Slow question");
    await expect.poll(() => ai.requests.length, { timeout: 30_000 }).toBe(1);
    const fast = await send(fastSession, "Fast question");
    expect(fast.status(), "a turn in another session was refused").toBe(201);
    const fastMessages = await waitForTurn(fastSession, (await fast.json()).userMessageId);
    expect(fastMessages[1].content).toBe("Fast answer.");
    const slowNow = (await sessionMessages(slowSession))[0];
    expect(slowNow.status, "the fast session finished while the slow one was still running").toBe("processing");
    expect(slowNow.trace?.outcome).toBe("running");
    expect(fastMessages[0].trace?.outcome).toBe("completed");
    await waitForTurn(slowSession, (await slow.json()).userMessageId);
  });

  test("ZYR-A-136 a resumed turn carries its own trace, starting with the resume, and the resumed message falls back to its first attempt", async () => {
    // No AI key: the resume resolves quickly through the degraded path (same as ZYR-A-86).
    const sessionId = await newSession("E2E trace resume");
    const checkpoint = JSON.stringify({ stage: "generate", userMessageId: "", message: "Write me some test cases", routedSuite: null, routedCount: { requestedCount: 10, exhaustive: false } });
    exec(
      "INSERT INTO zyra_chat_messages (session_id, project_id, user_id, role, content, status, resume_checkpoint) VALUES " +
        `(${literal(sessionId)}, ${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'assistant', 'Timed out.', 'timed_out', ${literal(checkpoint)}::jsonb);`,
    );
    const messageId = scalar(`SELECT id FROM zyra_chat_messages WHERE session_id = ${literal(sessionId)};`);
    const res = await asOwner.post(url(`/chat/sessions/${sessionId}/messages/${messageId}/continue`), { failOnStatusCode: false });
    expect((await res.json()).accepted).toBe(true);

    let messages: Message[] = [];
    await expect.poll(async () => { messages = await sessionMessages(sessionId); return messages.find((m) => m.id === messageId)?.status; }, { timeout: 30_000 }).toBe("resumed");
    const original = messages.find((m) => m.id === messageId)!;
    const resumed = messages.find((m) => m.id !== messageId)!;
    expect(original.trace ?? null, "the live resume trace is moved off the original once the new reply carries it").toBeNull();
    expect(stages(resumed.trace)[0]).toBe("resuming");
    expect(step(resumed.trace, "resuming").meta).toMatchObject({ attempt: 1, fromStage: "generate", requestedCount: 10 });
    expect(stages(resumed.trace)).toEqual(expect.arrayContaining(["context:testcases", "routing", "finalizing"]));
    expect(resumed.trace!.outcome).toBe("completed");
  });

  test("ZYR-A-137 a resume whose heartbeat lapsed reads as timed out and can be continued again; a live one cannot", async () => {
    const sessionId = await newSession("E2E trace stale resume");
    const checkpoint = JSON.stringify({ stage: "generate", userMessageId: "", message: "Write me some test cases", routedSuite: null, routedCount: { requestedCount: 10, exhaustive: false } });
    const seed = (since: string) => {
      exec(
        "INSERT INTO zyra_chat_messages (session_id, project_id, user_id, role, content, status, resume_checkpoint, resuming_since) VALUES " +
          `(${literal(sessionId)}, ${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'assistant', 'Timed out.', 'resuming', ${literal(checkpoint)}::jsonb, ${since});`,
      );
      return scalar(`SELECT id FROM zyra_chat_messages WHERE session_id = ${literal(sessionId)} ORDER BY created_at DESC LIMIT 1;`);
    };
    const live = seed("now()");
    const dead = seed("now() - interval '10 minutes'");

    const read = await sessionMessages(sessionId);
    expect(read.find((m) => m.id === live)?.status).toBe("resuming");
    expect(read.find((m) => m.id === dead)?.status, "a resume nobody is running must offer Continue again").toBe("timed_out");

    const liveContinue = await asOwner.post(url(`/chat/sessions/${sessionId}/messages/${live}/continue`), { failOnStatusCode: false });
    expect((await liveContinue.json()).accepted, "a live resume must not be claimed twice").toBe(false);
    const deadContinue = await asOwner.post(url(`/chat/sessions/${sessionId}/messages/${dead}/continue`), { failOnStatusCode: false });
    expect((await deadContinue.json()).accepted, "a dead resume must be claimable again").toBe(true);
    await expect.poll(() => scalar(`SELECT status FROM zyra_chat_messages WHERE id = ${literal(dead)};`), { timeout: 30_000 }).toBe("resumed");
  });

  test("ZYR-A-138 a new message that cancels a running plan records that in its trace", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E trace supersede");
    seedRunningPlan(sessionId);
    queueAnswer("Moving on.");

    const res = await send(sessionId, "What does the seat picker do?");
    const messages = await waitForTurn(sessionId, (await res.json()).userMessageId);
    expect(step(messages[0].trace, "plan:superseded").meta).toMatchObject({ planStatus: "running", doneCount: 3, totalCount: 5 });
    expect(scalar(`SELECT active_plan::text FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`) || null).toBeNull();
  });

  test("ZYR-A-139 Stop and Resume on a plan each post a message with its own trace, and a batch refused for want of a key records why", async () => {
    // No AI key: Resume launches the batch loop, whose first batch is refused and says so.
    const sessionId = await newSession("E2E trace plan stop resume");
    seedRunningPlan(sessionId);

    const stop = await asOwner.post(url(`/chat/sessions/${sessionId}/stop-plan`), { failOnStatusCode: false });
    expect(stop.status()).toBeLessThan(300);
    const stopped = (await sessionMessages(sessionId)).filter((m) => m.role === "assistant");
    expect(stopped).toHaveLength(1);
    expect(stages(stopped[0].trace)).toEqual(["plan:stop"]);
    expect(step(stopped[0].trace, "plan:stop").meta).toMatchObject({ doneCount: 3, totalCount: 5, remainingCount: 2 });

    const resume = await asOwner.post(url(`/chat/sessions/${sessionId}/resume-plan`), { failOnStatusCode: false });
    expect(resume.status()).toBeLessThan(300);
    let assistants: Message[] = [];
    await expect
      .poll(async () => { assistants = (await sessionMessages(sessionId)).filter((m) => m.role === "assistant"); return assistants.length; }, { timeout: 30_000 })
      .toBe(3);
    expect(stages(assistants[1].trace)).toEqual(["plan:resume"]);
    expect(step(assistants[1].trace, "plan:resume").meta).toMatchObject({ doneCount: 3, totalCount: 5, remainingCount: 2 });
    const batch = assistants[2].trace!;
    expect(stages(batch)).toEqual(["plan:batch"]);
    expect(step(batch, "plan:batch")).toMatchObject({ status: "blocked", meta: { fromScenario: 4, toScenario: 5, totalCount: 5 } });
  });

  test("ZYR-A-140 a request's trace is only readable by those who can read its session", async () => {
    const sessionId = await newSession("E2E trace access");
    const res = await send(sessionId, "How many test cases exist?");
    await waitForTurn(sessionId, (await res.json()).userMessageId);

    const otherTenant = await provisionRbacTenant("zyra-citations");
    test.skip(otherTenant === null, rbacSuiteSkipReason(otherTenant) ?? "");
    const asOther = await loginAs(otherTenant!.owner);
    const anonymous = await anonymousContext();
    try {
      const foreign = await asOther.get(url(`/chat/sessions/${sessionId}`), { failOnStatusCode: false });
      expect([403, 404], `another workspace read this session's trace: ${foreign.status()}`).toContain(foreign.status());
      expect(await foreign.text()).not.toContain("context:testcases");
      const anon = await anonymous.get(url(`/chat/sessions/${sessionId}`), { failOnStatusCode: false });
      expect(anon.status()).toBeGreaterThanOrEqual(400);
      expect(await anon.text()).not.toContain("context:testcases");
    } finally {
      await asOther.dispose();
      await anonymous.dispose();
    }
  });

  test("ZYR-A-141 a decision call that never answers is recorded as timed out on its step, and the turn as timed out", async () => {
    test.setTimeout(150_000);
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E trace router timeout");
    // Past ZYRA_ROUTER_TIMEOUT_MS (60s): the backend aborts the call, the fake server never answers in time.
    ai.delayNextReplyMs(70_000);
    queueAnswer("Too late.");

    const res = await send(sessionId, "How many test cases exist?");
    const messages = await waitForTurn(sessionId, (await res.json()).userMessageId, 120_000);
    const trace = messages[0].trace!;
    expect(step(trace, "routing")).toMatchObject({ status: "timed_out", meta: { timeoutMs: 60_000 } });
    expect(trace.outcome).toBe("timed_out");
    expect(messages.find((m) => m.role === "assistant")?.status).toBe("timed_out");
  });
});
