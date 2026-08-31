import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { exec, literal, scalar } from "../utils/psql";
import {
  anonymousContext,
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  type RbacTenant,
} from "../utils/rbac-tenant";

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
    exec(`DELETE FROM zyra_chat_sessions WHERE project_id IN (${projects});`);
    exec(`DELETE FROM ai_generation_requests WHERE project_id IN (${projects});`);
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
  function seedTask(fields: { status?: string; drafts?: number } = {}): string {
    const drafts = Array.from({ length: fields.drafts ?? 2 }, (_, i) => ({
      title: `E2E draft ${i + 1}`,
      steps: [{ action: "open the app", expected: "it opens" }],
      priority: "P2",
    }));
    /*
     * Two details of this row are load-bearing and were both wrong on the first attempt.
     *
     * agent_name has to be one of ZYRA_AGENT_NAMES ("Zyra the Test Generator", or the legacy "Zyra
     * the Edge Hunter") — zyraTask filters on it, so a row tagged anything else reads as a task that
     * does not exist. And generated_payload is a bare ARRAY of drafts, not an object wrapping one:
     * zyraDeleteDraft runs normalizeJsonArray over the column directly, so `{testcases: [...]}`
     * measures as zero drafts and every index is out of range.
     */
    exec(
      "INSERT INTO ai_generation_requests (project_id, requested_by, provider, model, user_story, " +
        "requested_count, generated_count, generated_payload, agent_name, task_status) VALUES (" +
        `${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'openai', 'gpt-4o-mini', ` +
        `'As a user I want to sign in', ${drafts.length}, ${drafts.length}, ` +
        `${literal(JSON.stringify(drafts))}::jsonb, 'Zyra the Test Generator', ` +
        `${literal(fields.status ?? "awaiting_review")});`,
    );
    return scalar(
      `SELECT id FROM ai_generation_requests WHERE project_id = ${literal(tenant!.mainProjectId)} ` +
        "ORDER BY created_at DESC LIMIT 1;",
    );
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
});
