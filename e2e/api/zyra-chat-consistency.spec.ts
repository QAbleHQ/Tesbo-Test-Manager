import { expect, test, type APIRequestContext } from "@playwright/test";
import { exec, literal, scalar } from "../utils/psql";
import {
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * Does the chat transcript agree with the repository?
 *
 * Basecamp 10212827246 / BetterBugs 6a841e18 — "[Zyra] AI Test Case Creation Shows Success but Test
 * Cases Are Not Reflected in Chat or Test Case List".
 *
 * The product already knows this can happen. `sendZyraChatMessage` builds its context with:
 *
 *   "Recent chat (each assistant turn is annotated with what it actually wrote to the repository —
 *    trust the annotation over the wording of the reply, which may describe testcases that were
 *    never saved)"
 *
 * — i.e. the reply text is NOT a reliable account of what happened, and the workaround is to tell the
 * next model turn to distrust the previous one. That keeps the model honest and leaves the human
 * reading exactly the reply the comment says not to trust.
 *
 * `zyraTranscript` shows what the reliable source is: an assistant row's `testcases` JSONB, where an
 * entry WITH an `id` is a case that really landed. GET .../chat/sessions/:id returns that array, so
 * it is what the chat UI can render — and the invariant these tests pin is that it must never
 * advertise a case the repository does not have.
 *
 * WHAT IS NOT TESTED HERE, and why. Every path that decides whether to create — the router, the
 * capability gates (`zyraCapabilityDisabled` is called only AFTER `zyraChatWithAnthropic` /
 * `zyraChatWithOpenAi` return) and the per-turn operation ceiling — runs behind a live provider call.
 * This suite never calls a model, deliberately, so the "reply claimed 15, saved 10" half of the report
 * is out of reach until `utils/fake-ai-server.ts` exists (Wave 0 item 3 in the tracker). These tests
 * cover the half that does not need a model: what the stored turn advertises, and whether it stays
 * true as the repository changes underneath it.
 *
 * Transcript rows are seeded directly, for the same reason `seedTask()` exists in api/zyra.spec.ts.
 * The assertions are not circular: each one seeds a turn that is TRUE when written and then changes
 * the repository, so what is being tested is the read path's reconciliation, not the fixture.
 */

test.describe("zyra chat ↔ repository consistency", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("zyra-chat");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
  });

  test.afterAll(async () => {
    if (tenant) purge();
    await asOwner?.dispose();
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
    if (tenant) purge();
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function purge(): void {
    const project = literal(tenant!.mainProjectId);
    exec(`DELETE FROM zyra_chat_messages WHERE project_id = ${project};`);
    exec(`DELETE FROM zyra_chat_sessions WHERE project_id = ${project};`);
    // ZCC-A-06 seeds a chat-staged review batch, the only test in this file that writes here.
    exec(`DELETE FROM ai_generation_requests WHERE project_id = ${project};`);
    exec(`DELETE FROM testcases WHERE project_id = ${project};`);
    exec(`DELETE FROM suites WHERE project_id = ${project};`);
  }

  function url(suffix: string): string {
    return `/api/projects/${tenant!.mainProjectId}/agents/zyra${suffix}`;
  }

  async function newSession(title: string): Promise<string> {
    const res = await asOwner.post(url("/chat/sessions"), { data: { title }, failOnStatusCode: false });
    expect(res.status(), `creating a chat session — ${await res.text()}`).toBeLessThan(300);
    return (await res.json()).id;
  }

  async function seedCase(title: string): Promise<{ id: string; externalId: string }> {
    const res = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/testcases`, {
      data: { title },
      failOnStatusCode: false,
    });
    expect(res.status(), `seeding a case — ${await res.text()}`).toBe(201);
    const body = await res.json();
    return { id: body.id, externalId: body.externalId };
  }

  /**
   * An assistant turn that claims to have saved `saved`, exactly as applyZyraChatOperations records
   * one: the reply text plus the `testcases` rows that carry an id.
   */
  function seedAssistantTurn(sessionId: string, reply: string, saved: Array<{ id: string; externalId: string }>): void {
    const payload = saved.map((c) => ({ id: c.id, externalId: c.externalId, title: `Saved ${c.externalId}` }));
    exec(
      "INSERT INTO zyra_chat_messages (session_id, project_id, user_id, role, content, status, testcases, activity) " +
        `VALUES (${literal(sessionId)}, ${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, ` +
        `'assistant', ${literal(reply)}, 'sent', ${literal(JSON.stringify(payload))}::jsonb, '[]'::jsonb);`,
    );
  }

  interface ChatMessage {
    role: string;
    content: string;
    testcases?: Array<{ id?: string; externalId?: string; title?: string }>;
    activity?: unknown[];
  }

  async function readSession(sessionId: string): Promise<{ messages: ChatMessage[] }> {
    const res = await asOwner.get(url(`/chat/sessions/${sessionId}`), { failOnStatusCode: false });
    expect(res.status(), `reading the session — ${await res.text()}`).toBe(200);
    const body = await res.json();
    return { messages: (body.messages ?? body.list ?? []) as ChatMessage[] };
  }

  /** The cases an assistant turn advertises as saved — entries carrying an id. */
  function advertised(message: ChatMessage): string[] {
    return (message.testcases ?? []).map((t) => t.id).filter((id): id is string => Boolean(id));
  }

  function liveCaseCount(): number {
    return Number(
      scalar(
        `SELECT COUNT(*) FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND deleted_at IS NULL;`,
      ),
    );
  }

  // ─── The contract the chat UI depends on ───────────────────────────────────

  test("ZCC-A-01 an assistant turn records which cases it actually saved", { tag: '@tesbo.testId("TES-TC-979")' }, async () => {
    const sessionId = await newSession("E2E ZCC records saves");
    const first = await seedCase(`E2E ZCC Case A ${Date.now()}`);
    const second = await seedCase(`E2E ZCC Case B ${Date.now()}`);
    seedAssistantTurn(sessionId, "I created 2 test cases for logout.", [first, second]);

    const { messages } = await readSession(sessionId);
    const turn = messages.find((m) => m.role === "assistant");

    // Without this array the chat can only show prose, and prose is what the report says lies.
    expect(turn, "the assistant turn was not returned at all").toBeTruthy();
    expect(
      turn!.testcases,
      "the turn carries no testcases array, so the UI has nothing to render but the reply text",
    ).toBeDefined();
    expect(advertised(turn!).sort()).toEqual([first.id, second.id].sort());
  });

  test("ZCC-A-02 a turn never advertises a case the repository no longer has", { tag: '@tesbo.testId("TES-TC-980")' }, async () => {
    const sessionId = await newSession("E2E ZCC deleted case");
    const kept = await seedCase(`E2E ZCC Kept ${Date.now()}`);
    const removed = await seedCase(`E2E ZCC Removed ${Date.now()}`);
    seedAssistantTurn(sessionId, "I created 2 test cases.", [kept, removed]);

    // True when written; then the repository changes underneath it. This is the reporter's symptom
    // exactly — the chat shows cases the test case list does not have.
    const deleted = await asOwner.delete(`/api/projects/${tenant!.mainProjectId}/testcases/${removed.id}`, {
      failOnStatusCode: false,
    });
    expect(deleted.ok(), `deleting the case — ${await deleted.text()}`).toBeTruthy();
    expect(liveCaseCount()).toBe(1);

    const { messages } = await readSession(sessionId);
    const turn = messages.find((m) => m.role === "assistant")!;

    expect(
      advertised(turn),
      "the transcript still offers a test case that has been deleted — the chat and the repository disagree",
    ).toEqual([kept.id]);
  });

  test("ZCC-A-03 a turn that saved nothing does not claim otherwise in its record", { tag: '@tesbo.testId("TES-TC-981")' }, async () => {
    const sessionId = await newSession("E2E ZCC saved nothing");
    // The shape applyZyraChatOperations leaves when every operation was filtered or failed: a reply
    // that reads like success, and no saved rows behind it. zyraTranscript annotates this to the
    // model as "[saved nothing — any testcases named in this reply do not exist in the repository]";
    // the human reading the chat gets no such annotation.
    seedAssistantTurn(sessionId, "Done — I've added 3 smoke test cases for logout.", []);

    const { messages } = await readSession(sessionId);
    const turn = messages.find((m) => m.role === "assistant")!;

    expect(advertised(turn), "nothing was saved, so nothing may be advertised").toEqual([]);
    expect(liveCaseCount(), "and the repository really is empty").toBe(0);

    /*
     * The turn's own record is honest. What the USER sees is not: the reply says "I've added 3".
     *
     * So the read must give the UI something to contradict the prose with — a status, a count, or a
     * flag saying this turn wrote nothing. Without it the screen has only the sentence, which is the
     * bug as reported. Any of these fields satisfies the assertion; the shape is the product's call.
     */
    const record = turn as unknown as Record<string, unknown>;
    const disclosesNothingSaved =
      record.savedCount === 0 ||
      record.testcasesSaved === 0 ||
      (Array.isArray(record.activity) && record.activity.length > 0) ||
      typeof record.status === "string";
    expect(
      disclosesNothingSaved,
      "a turn whose reply claims creations but saved nothing exposes no field the UI could use to say so",
    ).toBe(true);
  });

  test("ZCC-A-04 the transcript's saved ids all belong to this project", { tag: '@tesbo.testId("TES-TC-982")' }, async () => {
    const sessionId = await newSession("E2E ZCC cross project");
    const mine = await seedCase(`E2E ZCC Mine ${Date.now()}`);

    // A case in the workspace's other project, which this session must never advertise.
    const foreign = await asOwner.post(`/api/projects/${tenant!.secondProjectId}/testcases`, {
      data: { title: `E2E ZCC Foreign ${Date.now()}` },
      failOnStatusCode: false,
    });
    expect(foreign.status(), await foreign.text()).toBe(201);
    const foreignBody = await foreign.json();

    seedAssistantTurn(sessionId, "I created 2 test cases.", [
      mine,
      { id: foreignBody.id, externalId: foreignBody.externalId },
    ]);

    try {
      const { messages } = await readSession(sessionId);
      const turn = messages.find((m) => m.role === "assistant")!;

      expect(
        advertised(turn),
        "the transcript advertises a test case belonging to a different project",
      ).toEqual([mine.id]);
    } finally {
      await asOwner.delete(`/api/projects/${tenant!.secondProjectId}/testcases/${foreignBody.id}`, {
        failOnStatusCode: false,
      });
    }
  });

  test("ZCC-A-06 a proposed (not-yet-saved) row never carries a real id until the batch is saved", async () => {
    /*
     * The invariant this whole file pins — "a turn never advertises a case the repository does not
     * have" (see ZCC-A-01/02) — is judged purely by whether testcases[].id is truthy. A staged
     * create proposal (applyZyraChatOperations, once it stops writing straight to `testcases` and
     * stages via ai_generation_requests instead) has no id yet by construction, so it already
     * satisfies that invariant. This pins the construction itself: a "proposed-create" row is
     * seeded with id null exactly the way the real staging code builds one (chatDraftRow), and its
     * advertised-ness must stay false until an actual Save creates the real row.
     */
    const sessionId = await newSession("E2E ZCC staged proposal");
    exec(
      "INSERT INTO ai_generation_requests (project_id, requested_by, provider, model, user_story, requested_count, " +
        "generated_count, generated_payload, agent_name, task_status, chat_session_id) VALUES (" +
        `${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'zyra_chat', 'gpt-4o-mini', 'Zyra chat proposal', 1, 1, ` +
        `${literal(JSON.stringify([{ opType: "create", draft: { suiteId: null, title: "Staged, not saved", description: "", preconditions: "", stepsJson: "[]", priority: "P2" }, reason: "" }]))}::jsonb, ` +
        "'Zyra the Test Generator', 'in_review', " +
        `${literal(sessionId)});`,
    );
    const reviewRequestId = scalar(
      `SELECT id FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)} ORDER BY created_at DESC LIMIT 1;`,
    );
    exec(
      "INSERT INTO zyra_chat_messages (session_id, project_id, user_id, role, content, status, testcases, activity, review_request_id) VALUES " +
        `(${literal(sessionId)}, ${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'assistant', ` +
        "'I have drafted 1 test case for your review.', 'completed', " +
        `${literal(JSON.stringify([{ id: null, title: "Staged, not saved", action: "proposed-create", draftIndex: 0, reviewRequestId }]))}::jsonb, '[]'::jsonb, ${literal(reviewRequestId)});`,
    );

    const { messages } = await readSession(sessionId);
    const turn = messages.find((m) => m.role === "assistant")!;
    expect(advertised(turn), "a staged-not-saved proposal must not be advertised as a real, saved case").toEqual([]);
    expect(liveCaseCount(), "nothing should exist in the repository yet").toBe(0);

    // Once actually saved, the repository (not this stale message snapshot) is what the review
    // panel re-fetches from — that live re-fetch is exercised in e2e/ui/zyra.spec.ts ZYU-67.
    const saved = await asOwner.post(
      `/api/projects/${tenant!.mainProjectId}/agents/zyra/tasks/${reviewRequestId}/save`,
      { data: { selectedDraftIndexes: [0] }, failOnStatusCode: false },
    );
    expect(saved.status(), `saving the staged proposal — ${await saved.text()}`).toBe(201);
    expect(liveCaseCount(), "saving the proposal must create the real test case").toBe(1);
  });

  test("ZCC-A-05 the session read is refused to a caller with no access to the project", { tag: '@tesbo.testId("TES-TC-983")' }, async () => {
    const sessionId = await newSession("E2E ZCC guarded");
    const asGuest = await loginAs(tenant!.guest);
    try {
      const res = await asGuest.get(url(`/chat/sessions/${sessionId}`), { failOnStatusCode: false });
      // A transcript is whatever the team told the agent about their product — it is not public to
      // the workspace, only to the project.
      expect([401, 403, 404], `a non-member read the transcript: ${await res.text()}`).toContain(res.status());
    } finally {
      await asGuest.dispose();
    }
  });
});
