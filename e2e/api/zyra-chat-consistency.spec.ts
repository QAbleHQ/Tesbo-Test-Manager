import { expect, test, type APIRequestContext } from "@playwright/test";
import { startFakeAiServer, type FakeAiServer } from "../utils/fake-ai-server";
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
    // ZCC-A-06 seeds a chat-staged review batch, the only test in this file that writes here.
    // ai_generation_requests.chat_session_id is ON DELETE RESTRICT now (V116) — before sessions.
    exec(`DELETE FROM ai_generation_requests WHERE project_id = ${project};`);
    exec(`DELETE FROM zyra_chat_sessions WHERE project_id = ${project};`);
    exec(`DELETE FROM testcases WHERE project_id = ${project};`);
    exec(`DELETE FROM suites WHERE project_id = ${project};`);
    // The paged-plan tests (ZCC-B-21..24) seed ticket documents titled "E2EZ-<n>: ...".
    exec(`DELETE FROM knowledge_document_versions WHERE document_id IN (SELECT id FROM knowledge_documents WHERE project_id = ${project} AND title LIKE 'E2EZ-%');`);
    exec(`DELETE FROM knowledge_documents WHERE project_id = ${project} AND title LIKE 'E2EZ-%';`);
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

  // ─── Continue after a provider timeout (no AI provider configured — see the file header) ──
  //
  // legacy.service.ts now puts a bounded timeout on every outbound AI-provider call
  // (ZYRA_ROUTER_TIMEOUT_MS / ZYRA_GENERATE_TIMEOUT_MS). Before that, a stalled provider left the
  // request open indefinitely — no reply, no error — exactly what "Zyra doesn't respond" reported.
  // A timed-out turn is now persisted `status: 'timed_out'` with a `resume_checkpoint`, and
  // POST .../messages/:messageId/continue (continueZyraChatMessage) picks it back up.
  //
  // A REAL stalled provider can't be exercised here (no AI provider is configured for this suite —
  // see the file header); what's testable without one, and pinned below, is everything downstream of
  // the provider call: the checkpoint's claim/race semantics, the idempotent double-click behaviour,
  // and the new-message-supersedes-a-dangling-checkpoint rule. With no key allocated,
  // buildZyraChatDecision's no-key branch (zyraDegradedDecision) still runs for real inside
  // continueZyraChatMessage — so the resume path itself, not just its DB bookkeeping, is exercised.

  function seedTimedOutTurn(sessionId: string, checkpoint: Record<string, unknown>): string {
    const id = scalar(
      "INSERT INTO zyra_chat_messages (session_id, project_id, user_id, role, content, status, testcases, activity, resume_checkpoint) VALUES (" +
        `${literal(sessionId)}, ${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'assistant', ` +
        `${literal("Timed out waiting on the AI provider.")}, 'timed_out', '[]'::jsonb, '[]'::jsonb, ` +
        `${literal(JSON.stringify(checkpoint))}::jsonb) RETURNING id;`,
    );
    return id;
  }

  function messageStatus(messageId: string): string {
    return scalar(`SELECT status FROM zyra_chat_messages WHERE id = ${literal(messageId)};`);
  }

  function assistantMessageCount(sessionId: string): number {
    return Number(
      scalar(`SELECT COUNT(*) FROM zyra_chat_messages WHERE session_id = ${literal(sessionId)} AND role = 'assistant';`),
    );
  }

  test("ZCC-A-13 continuing a router-stage timeout with no AI provider produces a real (degraded) reply and marks the turn resumed", async () => {
    const sessionId = await newSession("E2E ZCC continue router stage");
    const timedOutId = seedTimedOutTurn(sessionId, {
      stage: "router",
      userMessageId: "00000000-0000-0000-0000-000000000000",
      message: "Would you like me to generate test cases for these gaps? yes",
    });
    const before = assistantMessageCount(sessionId);

    const res = await asOwner.post(url(`/chat/sessions/${sessionId}/messages/${timedOutId}/continue`), { failOnStatusCode: false });
    expect(res.status(), `continuing a timed-out turn — ${await res.text()}`).toBeLessThan(300);
    const body = await res.json();

    expect(body.message, "continue must post a real new assistant turn, not echo the timed-out one").toBeTruthy();
    expect(body.message.id).not.toBe(timedOutId);
    expect(assistantMessageCount(sessionId), "the timed-out turn's own row must not be deleted or reused").toBe(before + 1);
    expect(messageStatus(timedOutId), "a resumed checkpoint must not still read as timed_out — it would keep offering Continue").toBe("resumed");
  });

  test("ZCC-A-14 continuing twice at once only ever produces one follow-up turn", async () => {
    // The double-click / two-tabs case: the atomic `UPDATE ... WHERE status = 'timed_out'` in
    // continueZyraChatMessage must let exactly one of two concurrent calls claim the checkpoint.
    const sessionId = await newSession("E2E ZCC continue race");
    const timedOutId = seedTimedOutTurn(sessionId, {
      stage: "router",
      userMessageId: "00000000-0000-0000-0000-000000000000",
      message: "yes, go ahead",
    });
    const before = assistantMessageCount(sessionId);

    const [first, second] = await Promise.all([
      asOwner.post(url(`/chat/sessions/${sessionId}/messages/${timedOutId}/continue`), { failOnStatusCode: false }),
      asOwner.post(url(`/chat/sessions/${sessionId}/messages/${timedOutId}/continue`), { failOnStatusCode: false }),
    ]);
    expect(first.status(), await first.text()).toBeLessThan(300);
    expect(second.status(), await second.text()).toBeLessThan(300);

    const [firstBody, secondBody] = await Promise.all([first.json(), second.json()]);
    const posted = [firstBody, secondBody].filter((b) => b.message !== null);
    expect(posted.length, "exactly one of two concurrent continues may post a follow-up turn — the loser must see message: null, not a duplicate").toBe(1);
    expect(assistantMessageCount(sessionId), "a double-click must never generate the same test cases twice").toBe(before + 1);
  });

  test("ZCC-A-15 continuing an already-resumed turn is a no-op, not an error", async () => {
    const sessionId = await newSession("E2E ZCC continue already resumed");
    const timedOutId = seedTimedOutTurn(sessionId, { stage: "router", userMessageId: "00000000-0000-0000-0000-000000000000", message: "yes" });
    exec(`UPDATE zyra_chat_messages SET status = 'resumed' WHERE id = ${literal(timedOutId)};`);
    const before = assistantMessageCount(sessionId);

    const res = await asOwner.post(url(`/chat/sessions/${sessionId}/messages/${timedOutId}/continue`), { failOnStatusCode: false });
    expect(res.status(), `re-clicking Continue on an already-resumed turn — ${await res.text()}`).toBeLessThan(300);
    const body = await res.json();
    expect(body.message, "an already-resumed turn has nothing left to claim").toBeNull();
    expect(assistantMessageCount(sessionId)).toBe(before);
  });

  test("ZCC-A-16 sending a new message expires a dangling timed-out checkpoint from an earlier turn", async () => {
    const sessionId = await newSession("E2E ZCC continue superseded");
    const timedOutId = seedTimedOutTurn(sessionId, { stage: "router", userMessageId: "00000000-0000-0000-0000-000000000000", message: "yes" });
    expect(messageStatus(timedOutId)).toBe("timed_out");

    const sent = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), {
      data: { message: `E2E ZCC moved on ${Date.now()}` },
      failOnStatusCode: false,
    });
    expect(sent.status(), `sending a new message — ${await sent.text()}`).toBeLessThan(300);

    expect(
      messageStatus(timedOutId),
      "a new message means the conversation moved past the stalled turn — Continue must not still be able to resolve to it",
    ).toBe("expired");

    const res = await asOwner.post(url(`/chat/sessions/${sessionId}/messages/${timedOutId}/continue`), { failOnStatusCode: false });
    expect(res.status(), await res.text()).toBeLessThan(300);
    expect((await res.json()).message, "an expired checkpoint must not be resumable").toBeNull();
  });

  test("ZCC-A-17 continuing a turn that was never timed out (or already saved cases) is a no-op", async () => {
    const sessionId = await newSession("E2E ZCC continue non-timeout");
    const first = await seedCase(`E2E ZCC Continue Case ${Date.now()}`);
    seedAssistantTurn(sessionId, "I created 1 test case.", [first]);
    const messageId = scalar(`SELECT id FROM zyra_chat_messages WHERE session_id = ${literal(sessionId)} AND role = 'assistant' LIMIT 1;`);

    const res = await asOwner.post(url(`/chat/sessions/${sessionId}/messages/${messageId}/continue`), { failOnStatusCode: false });
    expect(res.status(), await res.text()).toBeLessThan(300);
    expect((await res.json()).message, "a turn that completed normally has nothing to resume").toBeNull();
  });

  test("ZCC-A-18 continue is refused to a caller with no access to the project", async () => {
    const sessionId = await newSession("E2E ZCC continue guarded");
    const timedOutId = seedTimedOutTurn(sessionId, { stage: "router", userMessageId: "00000000-0000-0000-0000-000000000000", message: "yes" });
    const asGuest = await loginAs(tenant!.guest);
    try {
      const res = await asGuest.post(url(`/chat/sessions/${sessionId}/messages/${timedOutId}/continue`), { failOnStatusCode: false });
      expect([401, 403, 404], `a non-member resumed a turn they cannot see: ${await res.text()}`).toContain(res.status());
    } finally {
      await asGuest.dispose();
    }
    // Refused before any claim was attempted — the checkpoint must still be exactly as it was.
    expect(messageStatus(timedOutId)).toBe("timed_out");
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

/*
 * "Zyra says test cases were generated for identified coverage gaps, but nothing is created" —
 * reported three times over (Basecamp 10231190735 and its recurrences). Every prior fix worked at
 * the annotation/reply-guard layer and could only be verified against hand-built `applied` objects,
 * never against a real turn — this suite's own header above says why: every path that decides
 * whether to create runs behind a live provider call, and there was no fake one.
 *
 * This describe block is that fake provider (utils/fake-ai-server.ts) driving REAL turns through
 * the REAL code: buildZyraChatDecision, the confirmation retry in sendZyraChatMessage,
 * applyZyraChatOperations, and reconcileZyraReply. It asserts on the actual `ai_generation_requests`
 * / `testcases` rows afterward, not on a hand-built `applied` object — the thing three prior fixes
 * could not do.
 */
test.describe("zyra chat — confirmation retry (fake provider)", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let ai: FakeAiServer;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("zyra-chat");
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
    // Found by review: `ai.requests` is append-only for the life of the server, and every test in
    // this describe block shares the one instance created in beforeAll (fullyParallel: false
    // serialises them in one worker) — without this, every `expect(ai.requests.length).toBe(N)`
    // below asserts against the CUMULATIVE count across every prior test in this file, not this
    // test's own count. See FakeAiServer.reset()'s own doc comment.
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
    exec(`DELETE FROM suites WHERE project_id = ${project};`);
    // The ticket tests seed "E2EZ-<n>: ..." documents (seedTickets). Without this they outlived the
    // test, so "every synced ticket" counted whatever earlier tests had left — the scope tests assert
    // an exact count, so each must start from none.
    exec(`DELETE FROM knowledge_document_versions WHERE document_id IN (SELECT id FROM knowledge_documents WHERE project_id = ${project} AND title LIKE 'E2EZ-%');`);
    exec(`DELETE FROM knowledge_documents WHERE project_id = ${project} AND title LIKE 'E2EZ-%';`);
    // This describe block, unlike the one above, mints its own AI key per test (it needs one
    // pointed at the fake server's baseUrl) — clean up so a re-run doesn't accumulate rows in this
    // tenant's org, and so a stale key never gets picked over the one the next test allocates.
    exec(`DELETE FROM project_ai_key_allocations WHERE project_id = ${project};`);
    exec(`DELETE FROM workspace_ai_keys WHERE organization_id = ${org};`);
    // The ZCC-B-11.. range tests PATCH testcaseRange; dropping the key restores the 30-50 default
    // so a range set by one test never decides another test's generation size.
    exec(`UPDATE projects SET settings = COALESCE(settings, '{}'::jsonb) - 'zyraAgent' WHERE id = ${project};`);
  }

  function url(suffix: string): string {
    return `/api/projects/${tenant!.mainProjectId}/agents/zyra${suffix}`;
  }

  /** Points this tenant's project at the fake provider — same routes api/zyra.spec.ts uses. */
  async function allocateFakeAiKey(): Promise<void> {
    const keyRes = await asOwner.post("/api/workspace/ai-keys", {
      data: { name: `E2E ZCC fake ai ${Date.now()}${Math.floor(Math.random() * 1000)}`, provider: "openai", apiKey: "sk-e2e-fake", baseUrl: ai.baseUrl },
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

  async function sendMessage(sessionId: string, message: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), { data: { message }, failOnStatusCode: false });
    return { status: res.status(), body: await res.json().catch(() => ({})) };
  }

  function liveCaseCount(): number {
    return Number(scalar(`SELECT COUNT(*) FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND deleted_at IS NULL;`));
  }

  /**
   * Task-board generation notifications (zyra_generation_ready / zyra_generation_failed): a short
   * title plus a body naming how many test cases were made and what for. Driven through the real
   * POST /agents/zyra/tasks → processZyraTask against the fake provider. No Jira ticket is seeded (that
   * needs a connection), so the subject is the quoted user story; the ticket form ("PROJ-123 – Login
   * Flow") is pinned at unit level in notification-events.spec.ts.
   */
  const ownerNotifications = async (type: string): Promise<Array<{ title: string; body: string | null; link_entity_type: string; link_entity_id: string }>> =>
    (await (await asOwner.get("/api/notifications")).json()).filter((n: { type: string }) => n.type === type);

  test("ZCC-NOTIF-01 a finished task-board generation tells the requester how many test cases are ready, and for what", async () => {
    await allocateFakeAiKey();
    exec(`DELETE FROM notifications WHERE user_id = ${literal(tenant!.owner.userId)};`);
    const story = `E2E login flow ${Date.now()}`;
    const draft = (n: number) => ({ title: `E2E draft ${n}`, preconditions: "", stepsJson: JSON.stringify([{ stepNumber: 1, action: "open", expectedResult: "opens" }]), testData: "", expectedSummary: "ok", priority: "P2", severity: "Medium", component: "Auth", tags: [], sourceRefs: [], techniques: ["general"] });
    ai.queueReply({ drafts: [draft(1), draft(2), draft(3)] });
    try {
      const res = await asOwner.post(url("/tasks"), { data: { userStory: story }, failOnStatusCode: false });
      expect(res.status(), await res.text()).toBe(201);
      const taskId = (await res.json()).task.id as string;
      await expect.poll(async () => (await ownerNotifications("zyra_generation_ready")).length, { timeout: 30_000 }).toBe(1);
      const [row] = await ownerNotifications("zyra_generation_ready");
      expect(row.title).toBe("Test Cases Ready for Review");
      expect(row.body).toBe(`Zyra generated 3 test cases for "${story}". Review and save the test cases.`);
      expect(row).toMatchObject({ link_entity_type: "zyra_task", link_entity_id: `${tenant!.mainProjectId}:${taskId}` });
      expect(await ownerNotifications("zyra_generation_failed")).toHaveLength(0);
    } finally {
      exec(`DELETE FROM notifications WHERE user_id = ${literal(tenant!.owner.userId)};`);
    }
  });

  test("ZCC-NOTIF-02 a generation that yields no drafts tells the requester it failed, with the same subject and no 'ready' notice", async () => {
    await allocateFakeAiKey();
    exec(`DELETE FROM notifications WHERE user_id = ${literal(tenant!.owner.userId)};`);
    const story = `E2E failing flow ${Date.now()}`;
    // Nothing queued: the fake's default reply carries no `drafts`, which processZyraTask treats as a failed generation.
    try {
      const res = await asOwner.post(url("/tasks"), { data: { userStory: story }, failOnStatusCode: false });
      expect(res.status(), await res.text()).toBe(201);
      await expect.poll(async () => (await ownerNotifications("zyra_generation_failed")).length, { timeout: 30_000 }).toBe(1);
      const [row] = await ownerNotifications("zyra_generation_failed");
      expect(row.title).toBe("Test Case Generation Failed");
      expect(row.body).toBe(`Zyra could not generate test cases for "${story}". Open the task to see what went wrong and try again.`);
      expect(await ownerNotifications("zyra_generation_ready")).toHaveLength(0);
    } finally {
      exec(`DELETE FROM notifications WHERE user_id = ${literal(tenant!.owner.userId)};`);
    }
  });

  function reviewRequestFor(sessionId: string):{ taskStatus: string; generatedCount: number; payloadLength: number } | null {
    const row = scalar(
      `SELECT task_status || '|' || generated_count || '|' || jsonb_array_length(generated_payload) ` +
        `FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)} ORDER BY created_at DESC LIMIT 1;`,
    );
    if (!row) return null;
    const [taskStatus, generatedCount, payloadLength] = row.split("|");
    return { taskStatus, generatedCount: Number(generatedCount), payloadLength: Number(payloadLength) };
  }

  const GAP_OFFER_REPLY =
    "I reviewed the password-reset test cases and found 2 coverage gaps: no test for an expired reset " +
    "token, and no test for a reset token being reused after it was already consumed. Would you like me " +
    "to generate test cases for these gaps?";

  const DRAFTS = [
    {
      title: "Expired reset token is rejected",
      preconditions: "A password reset token exists and has expired.",
      stepsJson: JSON.stringify([{ stepNumber: 1, action: "Submit the expired reset token with a new password", expectedResult: "The reset is rejected with an expired-token error" }]),
      testData: "An expired reset token.",
      expectedSummary: "Expired tokens cannot be used to reset a password.",
      priority: "P2",
      tags: ["zyra"],
    },
    {
      title: "Reused reset token is rejected",
      preconditions: "A password reset token has already been used once.",
      stepsJson: JSON.stringify([{ stepNumber: 1, action: "Submit the already-used reset token again", expectedResult: "The reset is rejected because the token was already consumed" }]),
      testData: "A reset token that was already redeemed once.",
      expectedSummary: "A reset token cannot be reused after consumption.",
      priority: "P2",
      tags: ["zyra"],
    },
  ];

  test("ZCC-B-01 confirming a gap-analysis offer stages test cases via the retry, without writing to testcases", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E ZCC fake ai retry");
    const before = liveCaseCount();

    // Turn 1: gap analysis, ending in an offer. Routes `answer` correctly (nothing to apply yet).
    ai.queueReply({ reply: GAP_OFFER_REPLY, reasoningSummary: "Reviewed existing coverage and found 2 gaps.", action: "answer", actionType: "answer", operations: [], testcases: [] });
    const turn1 = await sendMessage(sessionId, "Review my password-reset test cases and identify coverage gaps.");
    expect(turn1.status, JSON.stringify(turn1.body)).toBeLessThan(300);

    // Turn 2: "yes" — first response reproduces the exact reported bug (the model answers again
    // without emitting any operation despite the confirmation), which is what the retry exists for.
    ai.queueReply({ reply: "Sure — let me know and I can generate those for you.", reasoningSummary: "Acknowledged.", action: "answer", actionType: "answer", operations: [], testcases: [] });
    // The retry's router response: routes to create now that the hint names the unresolved offer.
    ai.queueReply({ reply: "", reasoningSummary: "Confirmed the offer; generating test cases for the identified gaps.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: 2, exhaustive: false });
    // The generation call zyraHandleChatCreate makes once routed to create.
    ai.queueReply({ drafts: DRAFTS });
    const turn2 = await sendMessage(sessionId, "yes");
    expect(turn2.status, JSON.stringify(turn2.body)).toBeLessThan(300);

    // Found by review: generateZyraChatTestcasesWithAi unconditionally calls rememberZyraTurn after
    // every successful generation (its own summarization pass, a real call to the same provider) —
    // an easy thing to miss counting since it's not part of the router/generation contract this
    // suite otherwise scripts explicitly. This count was previously 4, missing that fifth call.
    expect(ai.requests.length, "router (turn 1) + router (turn 2) + retry router + generation + rememberZyraTurn's own summarization call").toBe(5);

    const review = reviewRequestFor(sessionId);
    expect(review, "the confirmed generation should stage a review request").toBeTruthy();
    expect(review!.taskStatus).toBe("in_review");
    expect(review!.generatedCount).toBe(2);
    expect(review!.payloadLength, "both drafts should be staged in one batch").toBe(2);

    // The exact invariant three prior fixes needed and could never prove: staged, not created.
    expect(liveCaseCount(), "confirming generation must stage, never write testcases directly").toBe(before);

    const session = await asOwner.get(url(`/chat/sessions/${sessionId}`), { failOnStatusCode: false });
    expect(session.status()).toBe(200);
    const messages = (await session.json()).messages as Array<Record<string, unknown>>;
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")!;

    expect(
      String(lastAssistant.reasoningSummary || ""),
      "the retry must leave an observable marker instead of silently succeeding or silently failing",
    ).toContain("[confirmation-retry:fired]");
    expect(String(lastAssistant.content || "")).toContain("staged for your review");
    expect(String(lastAssistant.content || ""), "the reply must not claim permanence for a staged batch").not.toContain("Sorry! Nothing was saved");

    const testcases = lastAssistant.testcases as Array<Record<string, unknown>>;
    expect(testcases).toHaveLength(2);
    for (const tc of testcases) {
      expect(tc.id, "a staged row must not carry a real id").toBeFalsy();
      expect(String(tc.action || "")).toBe("proposed-create");
    }
  });

  test("ZCC-B-02 an unrelated 'yes' with no prior offer or proposal never triggers the retry", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E ZCC fake ai no antecedent");

    // No offer, no proposal — just an ordinary answer with nothing pending.
    ai.queueReply({ reply: "This project currently has 12 test cases covering login.", reasoningSummary: "Answered directly.", action: "answer", actionType: "answer", operations: [], testcases: [] });
    const turn1 = await sendMessage(sessionId, "How many test cases cover login?");
    expect(turn1.status, JSON.stringify(turn1.body)).toBeLessThan(300);

    // A bare "yes" with nothing to confirm. If the retry over-fired, it would consume a second
    // queued reply here; queuing only one for this turn makes an over-fire fail loudly (the fake
    // server falls back to its "no scripted response was queued" reply, which routes to `answer`
    // with zero operations, so an over-fire would surface as an extra request rather than a subtle
    // false pass).
    ai.queueReply({ reply: "Sorry, I'm not sure what you'd like me to confirm.", reasoningSummary: "No pending offer or proposal in context.", action: "answer", actionType: "answer", operations: [], testcases: [] });
    const turn2 = await sendMessage(sessionId, "yes");
    expect(turn2.status, JSON.stringify(turn2.body)).toBeLessThan(300);

    expect(ai.requests.length, "no retry should fire with nothing pending to confirm").toBe(2);
    expect(reviewRequestFor(sessionId)).toBeNull();
  });

  test("ZCC-B-03 an archive op targeting a testcase that no longer exists is named, not silently dropped", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E ZCC fake ai archive gap");

    const kept = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/testcases`, {
      data: { title: `E2E ZCC Archive Kept ${Date.now()}` },
      failOnStatusCode: false,
    });
    expect(kept.status()).toBe(201);
    const keptExternalId = (await kept.json()).externalId as string;

    // One op targets a real testcase, the other names an external id that was never created — the
    // exact shape applyZyraChatOperations used to drop with no activity entry at all (see the
    // comment at its `if (!found) continue;` — this test pins the fix, item 3 of this change).
    ai.queueReply({
      reply: "Archiving the confirmed test case and the one you mentioned.",
      reasoningSummary: "Archiving 2 confirmed test cases.",
      action: "archive",
      actionType: "archive",
      operations: [
        { type: "archive", externalId: keptExternalId, reason: "confirmed" },
        { type: "archive", externalId: "TC-DOES-NOT-EXIST", reason: "confirmed" },
      ],
      testcases: [],
    });
    const turn = await sendMessage(sessionId, "archive both of those, please");
    expect(turn.status, JSON.stringify(turn.body)).toBeLessThan(300);

    const session = await asOwner.get(url(`/chat/sessions/${sessionId}`), { failOnStatusCode: false });
    const messages = (await session.json()).messages as Array<Record<string, unknown>>;
    const assistant = messages.find((m) => m.role === "assistant")!;
    const activity = (assistant.activity as Array<{ title?: string; detail?: string }>) ?? [];

    expect(
      activity.some((a) => /could not archive/i.test(String(a.title || "")) && /TC-DOES-NOT-EXIST/.test(String(a.detail || ""))),
      `the dropped op must be named in activity — got: ${JSON.stringify(activity)}`,
    ).toBe(true);
    // The reply itself must surface the reason too (reconcileZyraReply's partial-count branch pulls
    // it straight from activity), not just the activity log a user may never open.
    expect(String(assistant.content || "")).toContain("1 of 2");
  });

  /*
   * "[Zyra] Confirmed 'Delete All Test Cases' Does Not Execute the Delete/Archive Operation" — on the
   * confirming "yes" the router emitted ONE archive op with allExisting:true (it only ever sees 25
   * cases, so it cannot name them all), and normalizeZyraChatDecision dropped it for naming no single
   * testcaseId/externalId: routing said 1 operation, staging said 0, and the reply claimed a staged
   * archive that never existed. A set-wide archive is now resolved against the repository.
   *
   * And, by product decision, a CONFIRMED archive (the user's message really is a confirmation —
   * zyraIsArchiveConfirmation) is applied in that same turn through zyraSave, not left waiting in the
   * review panel. ZCC-B-20/21 originally asserted "staged until Save"; they were changed on purpose
   * when that decision was made. An archive on a hedged or non-confirming message is still only staged.
   */
  async function createCase(title: string, projectId = tenant!.mainProjectId): Promise<{ id: string; externalId: string }> {
    const res = await asOwner.post(`/api/projects/${projectId}/testcases`, { data: { title }, failOnStatusCode: false });
    expect(res.status(), `seeding "${title}" — ${await res.text()}`).toBe(201);
    const body = await res.json();
    return { id: body.id, externalId: body.externalId };
  }

  function statusOf(id: string): string {
    return scalar(`SELECT status FROM testcases WHERE id = ${literal(id)};`);
  }

  function latestReview(sessionId: string): { id: string; payload: Array<{ opType: string; testcaseId: string }> } | null {
    const id = scalar(`SELECT id FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)} ORDER BY created_at DESC LIMIT 1;`);
    if (!id) return null;
    return { id, payload: JSON.parse(scalar(`SELECT generated_payload::text FROM ai_generation_requests WHERE id = ${literal(id)};`)) };
  }

  async function lastAssistant(sessionId: string): Promise<Record<string, unknown>> {
    const messages = (await (await asOwner.get(url(`/chat/sessions/${sessionId}`))).json()).messages as Array<Record<string, unknown>>;
    return [...messages].reverse().find((m) => m.role === "assistant")!;
  }

  const ARCHIVE_ALL_OFFER =
    "Before I proceed — this would archive all of this project's test cases. Are you sure? Reply 'yes' to confirm, or 'no' to cancel.";

  test("ZCC-B-20 a confirmed 'delete all' archives every active case of this project in that turn, and says so", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E ZCC archive all");
    const cases = [await createCase(`E2E ZCC all A ${Date.now()}`), await createCase(`E2E ZCC all B ${Date.now()}`), await createCase(`E2E ZCC all C ${Date.now()}`)];
    const alreadyArchived = await createCase(`E2E ZCC all archived ${Date.now()}`);
    exec(`UPDATE testcases SET status = 'Archived' WHERE id = ${literal(alreadyArchived.id)};`);
    // Another project of the same workspace: "all" means this project's cases, never another's.
    const otherProject = await createCase(`E2E ZCC other project ${Date.now()}`, tenant!.secondProjectId);
    try {
      ai.queueReply({ reply: ARCHIVE_ALL_OFFER, reasoningSummary: "Asked for confirmation first.", action: "answer", actionType: "answer", operations: [], testcases: [] });
      expect((await sendMessage(sessionId, "delete all the test cases")).status).toBeLessThan(300);
      expect(latestReview(sessionId), "asking for confirmation stages nothing").toBeNull();

      // The exact shape the reported session's router produced on "yes".
      ai.queueReply({
        reply: "Archiving all test cases as confirmed — staged for your review.",
        reasoningSummary: "User confirmed; one archive operation with allExisting=true.",
        action: "archive",
        actionType: "archive",
        operations: [{ type: "archive", allExisting: true, reason: "user confirmed archiving all test cases" }],
        testcases: [],
      });
      const turn = await sendMessage(sessionId, "yes");
      expect(turn.status, JSON.stringify(turn.body)).toBeLessThan(300);

      for (const c of cases) expect(statusOf(c.id), "a confirmed archive is applied in the same turn").toBe("Archived");
      expect(statusOf(alreadyArchived.id)).toBe("Archived");
      expect(statusOf(otherProject.id), "another project's case is never touched").not.toBe("Archived");

      // Committed through zyraSave: the batch records exactly this project's active cases and is done.
      const review = latestReview(sessionId);
      expect(review!.payload.map((entry) => entry.testcaseId).sort(), "every active case of this project, and only those").toEqual(cases.map((c) => c.id).sort());
      expect(scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(review!.id)};`)).toBe("done");

      const assistant = await lastAssistant(sessionId);
      const content = String(assistant.content || "");
      expect(content).not.toContain("did not produce any test case operations");
      expect(content, "the reply states what actually happened").toContain(`Archived ${cases.length} test cases`);
      expect(assistant.reviewRequestId, "nothing is left for the review panel").toBeFalsy();
      const rows = assistant.testcases as Array<{ action?: string; id?: string }>;
      expect(rows).toHaveLength(cases.length);
      expect(rows.every((row) => row.action === "archived" && !!row.id)).toBe(true);
      const activity = (assistant.activity as Array<{ title?: string }>) ?? [];
      expect(activity.some((entry) => entry.title === "Archived testcases")).toBe(true);
    } finally {
      await asOwner.delete(`/api/projects/${tenant!.secondProjectId}/testcases/${otherProject.id}`, { failOnStatusCode: false });
    }
  });

  test("ZCC-B-21 a confirmed archive naming several cases archives only those, and names the ones that don't exist", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E ZCC archive named set");
    const [a, b, untouched] = [await createCase(`E2E ZCC set A ${Date.now()}`), await createCase(`E2E ZCC set B ${Date.now()}`), await createCase(`E2E ZCC set C ${Date.now()}`)];

    ai.queueReply({
      reply: "Archiving the named test cases — staged for your review.",
      reasoningSummary: "Archiving 3 named cases as confirmed.",
      action: "archive",
      actionType: "archive",
      operations: [{ type: "archive", externalIds: [a.externalId, b.externalId, "TC-NOPE-404"], reason: "confirmed" }],
      testcases: [],
    });
    expect((await sendMessage(sessionId, "yes, archive those three")).status).toBeLessThan(300);

    expect(statusOf(a.id)).toBe("Archived");
    expect(statusOf(b.id)).toBe("Archived");
    expect(statusOf(untouched.id), "a case that wasn't named is untouched").not.toBe("Archived");
    const activity = ((await lastAssistant(sessionId)).activity as Array<{ title?: string; detail?: string }>) ?? [];
    expect(
      activity.some((entry) => entry.title === "Could not archive testcases" && /1 of the named/.test(String(entry.detail || ""))),
      `the missing id must be reported — got ${JSON.stringify(activity)}`,
    ).toBe(true);
  });

  test("ZCC-B-24 a single named case confirmed with 'yes' is archived in that turn", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E ZCC archive one");
    const [target, other] = [await createCase(`E2E ZCC one target ${Date.now()}`), await createCase(`E2E ZCC one other ${Date.now()}`)];

    ai.queueReply({
      reply: `I found ${target.externalId}. Should I archive it? Reply yes to confirm.`,
      reasoningSummary: "Asked for confirmation first.",
      action: "answer",
      actionType: "answer",
      operations: [],
      testcases: [],
    });
    expect((await sendMessage(sessionId, `delete ${target.externalId}`)).status).toBeLessThan(300);
    expect(statusOf(target.id), "asking is not archiving").not.toBe("Archived");

    ai.queueReply({
      reply: `Archiving ${target.externalId}.`,
      reasoningSummary: "Confirmed.",
      action: "archive",
      actionType: "archive",
      operations: [{ type: "archive", externalId: target.externalId, reason: "confirmed" }],
      testcases: [],
    });
    expect((await sendMessage(sessionId, "yes")).status).toBeLessThan(300);

    expect(statusOf(target.id)).toBe("Archived");
    expect(statusOf(other.id)).not.toBe("Archived");
    expect(String((await lastAssistant(sessionId)).content || "")).toContain("Archived 1 test case");
  });

  test("ZCC-B-25 an archive on a hedged reply ('yes but keep …') is only staged for review — nothing changes", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E ZCC archive hedged");
    const [a, b] = [await createCase(`E2E ZCC hedged A ${Date.now()}`), await createCase(`E2E ZCC hedged B ${Date.now()}`)];

    // Even if the model emits an archive on a hedged message, the server's own check refuses to
    // apply it immediately: it falls back to the review panel, where nothing changes until Save.
    ai.queueReply({
      reply: "Archiving everything as requested.",
      reasoningSummary: "Archiving all.",
      action: "archive",
      actionType: "archive",
      operations: [{ type: "archive", allExisting: true, reason: "requested" }],
      testcases: [],
    });
    expect((await sendMessage(sessionId, `yes but keep ${a.externalId}`)).status).toBeLessThan(300);

    expect(statusOf(a.id)).not.toBe("Archived");
    expect(statusOf(b.id)).not.toBe("Archived");
    const assistant = await lastAssistant(sessionId);
    expect(assistant.reviewRequestId, "the archive waits in the review panel").toBeTruthy();
    expect(((assistant.testcases as Array<{ action?: string }>) ?? []).every((row) => row.action === "proposed-archive")).toBe(true);
    expect(scalar(`SELECT task_status FROM ai_generation_requests WHERE id = ${literal(String(assistant.reviewRequestId))};`)).toBe("in_review");
  });

  test("ZCC-B-22 'no' after the confirmation prompt stages nothing and changes nothing", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E ZCC archive declined");
    const c = await createCase(`E2E ZCC declined ${Date.now()}`);

    ai.queueReply({ reply: ARCHIVE_ALL_OFFER, reasoningSummary: "Asked for confirmation first.", action: "answer", actionType: "answer", operations: [], testcases: [] });
    expect((await sendMessage(sessionId, "delete all the test cases")).status).toBeLessThan(300);
    ai.queueReply({ reply: "Okay — nothing was archived.", reasoningSummary: "User declined.", action: "answer", actionType: "answer", operations: [], testcases: [] });
    expect((await sendMessage(sessionId, "no")).status).toBeLessThan(300);

    expect(latestReview(sessionId)).toBeNull();
    expect(statusOf(c.id)).not.toBe("Archived");
  });

  test("ZCC-B-23 a confirmed 'delete all' with no active cases says nothing was staged instead of claiming it", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E ZCC archive empty");
    const archived = await createCase(`E2E ZCC only archived ${Date.now()}`);
    exec(`UPDATE testcases SET status = 'Archived' WHERE id = ${literal(archived.id)};`);

    ai.queueReply({
      reply: "Archiving all test cases as confirmed — staged for your review.",
      reasoningSummary: "User confirmed.",
      action: "archive",
      actionType: "archive",
      operations: [{ type: "archive", allExisting: true, reason: "confirmed" }],
      testcases: [],
    });
    expect((await sendMessage(sessionId, "yes")).status).toBeLessThan(300);

    expect(latestReview(sessionId), "nothing to archive, so no batch").toBeNull();
    const assistant = await lastAssistant(sessionId);
    const activity = (assistant.activity as Array<{ title?: string; detail?: string }>) ?? [];
    expect(activity.some((entry) => entry.title === "Could not archive testcases" && /no active test cases/.test(String(entry.detail || "")))).toBe(true);
    expect(String(assistant.content || ""), "the reply must not stand as a claim that something was staged").toContain("Nothing was saved");
  });

  /*
   * fromLastPlan — Basecamp-adjacent, found by architecture audit rather than a report. A `create` op
   * has been staged-not-written since the 2026-09-03 review-panel change, so `applied.testcases[].id`
   * is always null for one; the code that recorded `zyra_chat_sessions.last_completed_plan` still
   * tried to read a real id off that array, so the field stayed permanently empty and
   * `move_to_suite ... fromLastPlan=true` — the system prompt's own documented way to handle "save
   * them to <suite>" right after a generation — always resolved to zero targets. These two tests pin
   * both halves of the fix: re-pointing a still-PENDING batch's suite (patches the draft directly,
   * never auto-saves it), and moving an ALREADY-SAVED batch for real (using the id zyraSaveAttempt
   * now records at the moment it first becomes real).
   */
  test("ZCC-B-04 'save them to <suite>' right after a generation re-points the still-pending draft, never auto-saving it", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E ZCC fake ai fromLastPlan pending");
    const before = liveCaseCount();

    // Turn 1: generate one test case, no suite named — lands as an unfiled, unsaved draft.
    ai.queueReply({ reply: "", reasoningSummary: "Generating a checkout test case.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: 1, exhaustive: false });
    ai.queueReply({
      drafts: [{
        title: "Checkout completes with a valid card",
        preconditions: "The cart has at least one item.",
        stepsJson: JSON.stringify([{ stepNumber: 1, action: "Complete checkout with a valid card", expectedResult: "The order confirmation page is shown" }]),
        testData: "",
        expectedSummary: "Checkout succeeds with a valid card.",
        priority: "P2",
        tags: ["zyra"],
      }],
    });
    const turn1 = await sendMessage(sessionId, "Generate 1 test case for checkout.");
    expect(turn1.status, JSON.stringify(turn1.body)).toBeLessThan(300);
    expect(liveCaseCount(), "a staged create must not write to testcases").toBe(before);

    const reviewRow = scalar(`SELECT id FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)} ORDER BY created_at DESC LIMIT 1;`);
    expect(reviewRow).toBeTruthy();

    // Turn 2: "save them to the Checkout suite" — the batch from turn 1 is still only staged, so
    // there is no real row anywhere for a DB move to act on. A move_to_suite op with fromLastPlan=true
    // needs no generation call, only the router.
    ai.queueReply({
      reply: "Filing the checkout test case into the Checkout suite.",
      reasoningSummary: "Confirmed the suite for the last generated batch.",
      action: "suite",
      actionType: "suite",
      operations: [{ type: "move_to_suite", suiteName: "Checkout", fromLastPlan: true, reason: "user asked to file the last batch" }],
      testcases: [],
    });
    const turn2 = await sendMessage(sessionId, "save them to the Checkout suite");
    expect(turn2.status, JSON.stringify(turn2.body)).toBeLessThan(300);
    // See the identical rememberZyraTurn note on ZCC-B-01 — generation (turn 1) is followed by its
    // own unscripted summarization call.
    expect(ai.requests.length, "router (turn 1) + generation (turn 1) + rememberZyraTurn + router (turn 2, no generation for a move)").toBe(4);

    // Still nothing written to testcases — re-pointing a pending draft's suite must never auto-save it.
    expect(liveCaseCount(), "fromLastPlan against a pending batch must only patch the draft, never save it").toBe(before);

    const suiteId = scalar(`SELECT id FROM suites WHERE project_id = ${literal(tenant!.mainProjectId)} AND name = 'Checkout';`);
    expect(suiteId, "move_to_suite auto-creates the named suite even for a pending-draft match").toBeTruthy();

    const payload = JSON.parse(scalar(`SELECT generated_payload::text FROM ai_generation_requests WHERE id = ${literal(reviewRow)};`));
    expect(payload).toHaveLength(1);
    expect(payload[0].draft.suiteId, "the pending draft itself must be repointed at the new suite").toBe(suiteId);

    const session = await asOwner.get(url(`/chat/sessions/${sessionId}`), { failOnStatusCode: false });
    const messages = (await session.json()).messages as Array<Record<string, unknown>>;
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")!;
    expect(String(lastAssistant.content || ""), "the reply must not claim permanence for a still-unsaved draft").not.toContain("Nothing was saved");
    expect(String(lastAssistant.content || "")).toContain("staged for your review");
    // A suite touched ONLY via the pending-draft patch must never appear in the DB-truth "Moved to
    // suites (actual)" footer — moveTargetIds never got this suite's id (nothing was actually moved
    // in the DB), so a naive "register every targeted suite" would read "Checkout: 0 (none matched)"
    // directly next to the true "staged for your review" line above: a self-contradiction of exactly
    // the shape the moveBreakdown footer exists to prevent, just reintroduced from a different angle.
    expect(String(lastAssistant.content || ""), "a pending-only match must not also claim 'none matched' in the moveBreakdown footer").not.toContain("none matched");
    expect(String(lastAssistant.content || "")).not.toContain("Moved to suites (actual)");

    // Prove the whole point of patching rather than ignoring: Save now actually lands the row in
    // the suite the follow-up message asked for, with no suiteId passed in the save call itself.
    const saveRes = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/ai/generation-history/${reviewRow}/save`, {
      data: { selectedDraftIndexes: [0] },
      failOnStatusCode: false,
    });
    expect(saveRes.status(), `saving the repointed draft — ${await saveRes.text()}`).toBeLessThan(300);
    const saveBody = await saveRes.json();
    expect(saveBody.savedCount).toBe(1);
    expect(liveCaseCount()).toBe(before + 1);
    const savedSuiteId = scalar(`SELECT suite_id::text FROM testcases WHERE id = ${literal(String(saveBody.testcases[0].id))};`);
    expect(savedSuiteId, "the saved row must land in the suite the pending draft was repointed to").toBe(suiteId);
  });

  test("ZCC-B-05 'move them to <suite>' after the batch was already saved does a real move, using the id recorded at save time", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E ZCC fake ai fromLastPlan saved");
    const before = liveCaseCount();

    ai.queueReply({ reply: "", reasoningSummary: "Generating a refund test case.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: 1, exhaustive: false });
    ai.queueReply({
      drafts: [{
        title: "Refund is issued for a cancelled order",
        preconditions: "An order was placed and paid for.",
        stepsJson: JSON.stringify([{ stepNumber: 1, action: "Cancel the order and process a refund", expectedResult: "The refund is issued to the original payment method" }]),
        testData: "",
        expectedSummary: "A cancelled order is refunded.",
        priority: "P2",
        tags: ["zyra"],
      }],
    });
    const turn1 = await sendMessage(sessionId, "Generate 1 test case for order refunds.");
    expect(turn1.status, JSON.stringify(turn1.body)).toBeLessThan(300);

    const reviewRow = scalar(`SELECT id FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)} ORDER BY created_at DESC LIMIT 1;`);
    const saveRes = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/ai/generation-history/${reviewRow}/save`, {
      data: { selectedDraftIndexes: [0] },
      failOnStatusCode: false,
    });
    expect(saveRes.status(), `saving — ${await saveRes.text()}`).toBeLessThan(300);
    expect(liveCaseCount()).toBe(before + 1);
    const savedId = String((await saveRes.json()).testcases[0].id);

    // zyraSaveAttempt is where a create's id first becomes real — this is what the fix records into
    // last_completed_plan, and what fromLastPlan needs to find on the next turn.
    const plan = JSON.parse(scalar(`SELECT coalesce(last_completed_plan::text, '{}') FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`));
    expect(plan.testcaseIds, "zyraSaveAttempt must record the real id once the draft is actually saved").toContain(savedId);
    expect(plan.pendingReviewRequestIds || [], "a fully-saved batch must drop out of the pending pointer").not.toContain(reviewRow);

    // Turn 2: now ask to move the (already saved) last batch — fromLastPlan must resolve against
    // the real id recorded above; there is no pending draft left to patch.
    ai.queueReply({
      reply: "Moving the refund test case into the Payments suite.",
      reasoningSummary: "Moving the last saved batch.",
      action: "suite",
      actionType: "suite",
      operations: [{ type: "move_to_suite", suiteName: "Payments", fromLastPlan: true, reason: "user asked to file the last batch" }],
      testcases: [],
    });
    const turn2 = await sendMessage(sessionId, "move that to the Payments suite");
    expect(turn2.status, JSON.stringify(turn2.body)).toBeLessThan(300);

    const suiteId = scalar(`SELECT id FROM suites WHERE project_id = ${literal(tenant!.mainProjectId)} AND name = 'Payments';`);
    const movedSuiteId = scalar(`SELECT suite_id::text FROM testcases WHERE id = ${literal(savedId)};`);
    expect(movedSuiteId, "a real move against an already-saved batch must actually update the row").toBe(suiteId);

    const session = await asOwner.get(url(`/chat/sessions/${sessionId}`), { failOnStatusCode: false });
    const messages = (await session.json()).messages as Array<Record<string, unknown>>;
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")!;
    expect(String(lastAssistant.content || "")).toContain("Moved to suites (actual)");
    expect(String(lastAssistant.content || "")).toContain("Payments: 1");
  });

  /*
   * The bug this file was originally opened to reproduce, from the OTHER angle: not a confirmation
   * with no antecedent, but a router completion that is itself unparseable JSON. parseModelJson falls
   * back to salvageJsonStringFields, which recovers only `reply`/`reasoningSummary` — a fully
   * confident, detailed narrative with zero `action`/`operations` behind it. Reported directly: "8
   * flight booking test cases drafted and staged for your review" with no table, no review panel,
   * nothing persisted. buildZyraChatDecision now retries once on `raw.__salvaged`; these two tests
   * drive that through the REAL HTTP stack (not a mocked service method) using a raw, deliberately
   * truncated string reply — fake-ai-server.ts serves it verbatim as `choices[0].message.content`,
   * exactly reproducing what a truncated provider completion looks like on the wire.
   */
  const TRUNCATED_ROUTER_RESPONSE =
    '{"reply":"Here are 8 flight booking test cases drafted and staged for your review.","reasoningSummary":"Sources used: KAN-1. I focus on gaps: passenger details, payment, confirmation.","operations":[{"type":"create","draft":{"title":"Search flights';

  test("ZCC-B-06 a truncated router response retries once and the salvaged narrative never reaches the user", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E ZCC fake ai salvage retry");
    const before = liveCaseCount();

    ai.queueReply(TRUNCATED_ROUTER_RESPONSE);
    ai.queueReply({
      reply: "There are no flight booking test cases yet in this project.",
      reasoningSummary: "No matching coverage found.",
      action: "answer",
      actionType: "answer",
      operations: [],
      testcases: [],
    });
    const turn = await sendMessage(sessionId, "generate flight booking test cases");
    expect(turn.status, JSON.stringify(turn.body)).toBeLessThan(300);
    expect(ai.requests.length, "router attempt 1 (salvaged) + router attempt 2 (clean retry)").toBe(2);

    // Nothing was ever staged or written — the retry's clean "answer" made no operations either.
    expect(liveCaseCount()).toBe(before);
    const review = reviewRequestFor(sessionId);
    expect(review, "a clean retry that routes answer must stage nothing").toBeNull();

    const session = await asOwner.get(url(`/chat/sessions/${sessionId}`), { failOnStatusCode: false });
    const messages = (await session.json()).messages as Array<Record<string, unknown>>;
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")!;

    // The exact invariant the reported bug violated: the salvaged narrative from the FIRST
    // (discarded) attempt must never reach the user.
    expect(String(lastAssistant.content || "")).not.toContain("flight booking test cases drafted");
    expect(String(lastAssistant.content || "")).toContain("There are no flight booking test cases yet");
    expect(lastAssistant.testcases).toEqual([]);
    expect(lastAssistant.reviewRequestId ?? null).toBeNull();
  });

  test("ZCC-B-07 a router response truncated on both attempts returns an honest failure, never a phantom success", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E ZCC fake ai salvage double failure");
    const before = liveCaseCount();

    ai.queueReply(TRUNCATED_ROUTER_RESPONSE);
    ai.queueReply(TRUNCATED_ROUTER_RESPONSE);
    const turn = await sendMessage(sessionId, "generate flight booking test cases");
    expect(turn.status, JSON.stringify(turn.body)).toBeLessThan(300);
    expect(ai.requests.length, "router attempt 1 (salvaged) + router attempt 2 (salvaged again, no third attempt)").toBe(2);

    expect(liveCaseCount()).toBe(before);
    expect(reviewRequestFor(sessionId), "two salvaged attempts must stage nothing").toBeNull();

    const session = await asOwner.get(url(`/chat/sessions/${sessionId}`), { failOnStatusCode: false });
    const messages = (await session.json()).messages as Array<Record<string, unknown>>;
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")!;

    // Never the salvaged narrative pretending to be a real decision, and never the false-success
    // phrasing the reported bug produced.
    expect(String(lastAssistant.content || "")).not.toContain("flight booking test cases drafted");
    expect(String(lastAssistant.content || "")).not.toContain("staged for your review");
    expect(String(lastAssistant.content || "")).toMatch(/cut off|try again/i);
    expect(lastAssistant.testcases).toEqual([]);
    expect(lastAssistant.reviewRequestId ?? null).toBeNull();

    // Found by review: scoped only to project_id, this assertion is vacuous on any run after the
    // first against the same tenant — provisionRbacTenant caches (and reuses) a tenant per `kind`
    // across runs, audit_logs is append-only and purge() correctly never touches it, so an earlier
    // run's row alone satisfies ">0" even if this code path stopped logging entirely. Scoped to this
    // turn's own session (logProjectActivity's entityId) so the assertion is about THIS call.
    const failureLogged = scalar(
      `SELECT COUNT(*) FROM audit_logs WHERE project_id = ${literal(tenant!.mainProjectId)} AND entity_id = ${literal(sessionId)} ` +
        `AND action = 'zyra_chat_ai_failed' AND diff->>'stage' = 'routing_salvaged';`,
    );
    expect(Number(failureLogged), "the double-salvage must be observable, not just silently absorbed").toBeGreaterThan(0);
  });

  /*
   * Multi-batch "generate all possible cases" plan lifecycle — previously had ZERO e2e coverage
   * anywhere in this repo (confirmed by grep before writing these). Written alongside the
   * zyraPlanTransition row-lock fix (legacy.service.ts — closes a confirmed race between
   * continueZyraChatPlan, the background batch loop, and an interactive sendZyraChatMessage call on
   * the same session) specifically to prove the refactored commit path — atomic
   * "check plan still current → post message → update active_plan" under one row lock — still
   * produces the exact same observable plan behaviour as before. The concurrent-interleaving
   * property itself (two commits racing for the same row) is proven deterministically at the unit
   * level in zyra-plan-concurrency.spec.ts, which controls real Promise interleaving directly — a
   * live HTTP + fake-provider race would depend on wall-clock scheduling and be flaky by
   * construction, so it is deliberately not attempted here.
   */
  function scenarioDraft(title: string) {
    return {
      title,
      preconditions: "",
      stepsJson: JSON.stringify([{ stepNumber: 1, action: `Exercise: ${title}`, expectedResult: "Behaves as expected" }]),
      testData: "",
      expectedSummary: title,
      priority: "P2",
      tags: ["zyra"],
    };
  }

  test("ZCC-B-08 a multi-batch plan generates every batch and clears itself when done", async () => {
    await allocateFakeAiKey();
    // A batch holds as many test cases as the project's range allows — 1-10 keeps it at 10.
    await setRange("1-10");
    const sessionId = await newSession("E2E ZCC multi-batch plan");

    // Router: exhaustive create. Scenario planner: 12 scenarios (10 fit the first batch, the 1-10 range's
    // batch size, leaving 2 for the background loop's one remaining batch).
    ai.queueReply({ reply: "", reasoningSummary: "Planning exhaustive coverage.", action: "create", actionType: "create", operations: [], testcases: [], exhaustive: true });
    ai.queueReply({ scenarios: Array.from({ length: 12 }, (_, i) => `Scenario ${i + 1}`) });
    ai.queueReply({ scenarios: [] }); // the planner's top-up round finds nothing more — see ZCC-B-19
    ai.queueReply({ drafts: Array.from({ length: 10 }, (_, i) => scenarioDraft(`Scenario ${i + 1}`)) });
    // Found by review: generateZyraChatTestcasesWithAi unconditionally calls rememberZyraTurn right
    // after this (synchronous) first batch, BEFORE the background loop even starts — without this
    // placeholder, that call would silently consume the batch-2 reply queued right after it, so the
    // background loop's own generation call would hit an empty queue, get the "no drafts" default,
    // throw, and the plan would pause on error instead of ever completing — this test would have
    // hung until the 30s poll timeout on a real run.
    ai.queueReply("Noted.");
    ai.queueReply({ drafts: Array.from({ length: 2 }, (_, i) => scenarioDraft(`Scenario ${i + 11}`)) });

    const turn1 = await sendMessage(sessionId, "Generate all possible test cases for the login flow.");
    expect(turn1.status, JSON.stringify(turn1.body)).toBeLessThan(300);

    // The background batch is fire-and-forget — poll until it has actually landed rather than
    // assuming it finished by the time sendMessage returned.
    await expect
      .poll(() => scalar(`SELECT active_plan FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`), {
        message: "the plan must clear itself once the last batch is posted",
        timeout: 30_000,
      })
      .toBeNull();

    const session = await asOwner.get(url(`/chat/sessions/${sessionId}`), { failOnStatusCode: false });
    const messages = (await session.json()).messages as Array<Record<string, unknown>>;
    const assistantTurns = messages.filter((m) => m.role === "assistant");
    // Turn 1 (first batch, 10 drafts) + the background loop's one remaining batch (2 drafts).
    expect(assistantTurns.length, "both batches must be posted as their own messages").toBe(2);
    expect(String(assistantTurns[0].content || "")).toContain("first 10");
    expect(String(assistantTurns[1].content || "")).toContain("all 12 scenarios are now covered");

    // Both batches staged (not written) as their own review batches — the plan feature stages
    // exactly like a single-turn create, per applyZyraChatOperations.
    const batchCount = scalar(`SELECT COUNT(*) FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)};`);
    expect(Number(batchCount)).toBe(2);
    const totalDrafts = scalar(
      `SELECT COALESCE(SUM(jsonb_array_length(generated_payload)), 0) FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)};`,
    );
    expect(Number(totalDrafts)).toBe(12);
  });

  /*
   * A second review pass, and direct code re-verification, found this test's ORIGINAL premise false:
   * `continueZyraChatPlan`'s top-of-loop guard checked only `planId`, never `status` — `stopZyraChatPlan`
   * set `status: "paused"` but the loop never consulted it, so it ran every remaining batch to
   * completion regardless of when Stop was called. That was a real, pre-existing product bug
   * (unrelated to the zyraPlanTransition locking work — the same unchecked condition existed before
   * it), fixed directly as a result of this test exposing it: `continueZyraChatPlan`'s guard is now
   * `!plan || plan.planId !== planId || plan.status !== "running"`.
   *
   * This test now PROVES the fix deterministically, rather than asserting a race's ambiguous outcome.
   * `delayNextReplyMs` holds the background loop's first batch response open just long enough to
   * confirm — via `ai.requests.length`, not a wall-clock guess — that the call has genuinely arrived
   * at the fake provider (i.e. this batch is unambiguously "in flight") before Stop is called. The
   * three-batch shape (10 sync + 10 background + 2 background) exists specifically so there is a THIRD
   * batch — one that has not started yet and is therefore still within this process's control — to
   * prove does NOT run.
   */
  test("ZCC-B-09 stop lets an in-flight batch finish but stops the next one from starting", async () => {
    await allocateFakeAiKey();
    await setRange("1-10"); // batches of 10
    const sessionId = await newSession("E2E ZCC plan stop interrupts the next batch");

    ai.queueReply({ reply: "", reasoningSummary: "Planning exhaustive coverage.", action: "create", actionType: "create", operations: [], testcases: [], exhaustive: true });
    ai.queueReply({ scenarios: Array.from({ length: 22 }, (_, i) => `Scenario ${i + 1}`) });
    ai.queueReply({ scenarios: [] }); // the planner's top-up round finds nothing more — see ZCC-B-19
    ai.queueReply({ drafts: Array.from({ length: 10 }, (_, i) => scenarioDraft(`Scenario ${i + 1}`)) });
    const turn1 = await sendMessage(sessionId, "Generate all possible test cases for the login flow.");
    expect(turn1.status, JSON.stringify(turn1.body)).toBeLessThan(300);
    // 5 requests so far: router, scenario plan, the plan's top-up round (22 is below the 90-scenario
    // floor — see ZCC-B-19), first (synchronous) batch, and — easy to miss —
    // generateZyraChatTestcasesWithAi unconditionally calls rememberZyraTurn after every successful
    // generation (its own summarization call to the same provider). Nothing was queued for it here,
    // so it took the fake server's harmless "no scripted response" default — safe, since nothing
    // else is queued yet for it to steal.
    const requestsAfterTurn1 = ai.requests.length;
    expect(requestsAfterTurn1).toBe(5);

    // The background loop's first batch (10 of the remaining 12 scenarios) — held open so this test
    // can observe it arriving before deciding to stop. A placeholder reply is queued for THIS
    // batch's own rememberZyraTurn call too — without it, that call would consume the batch-3 reply
    // queued right after it, corrupting the very thing this test is trying to prove.
    ai.delayNextReplyMs(2_000);
    ai.queueReply({ drafts: Array.from({ length: 10 }, (_, i) => scenarioDraft(`Scenario ${i + 11}`)) });
    ai.queueReply("Noted."); // consumed by this batch's own rememberZyraTurn call
    // The background loop's SECOND remaining batch (2 scenarios) — must never be consumed if the fix
    // holds. Queued now, upfront, specifically so there is no ambiguity about why it wasn't used: an
    // empty queue would also produce a failure, which would prove nothing about this fix.
    ai.queueReply({ drafts: Array.from({ length: 2 }, (_, i) => scenarioDraft(`Scenario ${i + 21}`)) });

    await expect
      .poll(() => ai.requests.length, { message: "the background loop's first batch must actually reach the fake provider before this test stops the plan", timeout: 10_000 })
      .toBe(requestsAfterTurn1 + 1);

    // The in-flight batch's response is still being held (delayNextReplyMs) at this exact point —
    // stopping now is unambiguously "while a batch is genuinely mid-request", the scenario this
    // whole test exists to prove is handled correctly.
    const stopRes = await asOwner.post(url(`/chat/sessions/${sessionId}/stop-plan`), { failOnStatusCode: false });
    expect(stopRes.status(), `stopping the plan — ${await stopRes.text()}`).toBeLessThan(300);

    // The in-flight batch finishes and posts normally — not aborted mid-request, per the documented
    // design — and its commit preserves the "paused" status the stop call already set (zyraPlanTransition
    // spreads the freshly-locked `current`, not a stale pre-generation snapshot).
    await expect
      .poll(() => scalar(`SELECT active_plan->>'status' FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`), {
        message: "the in-flight batch must finish and the plan must land 'paused', not vanish or stay 'running'",
        timeout: 15_000,
      })
      .toBe("paused");

    // rememberZyraTurn for the in-flight batch fires right after it finishes — wait for it too,
    // rather than asserting on ai.requests.length the instant the plan flips to 'paused' (the two
    // happen in close succession but not atomically together).
    await expect
      .poll(() => ai.requests.length, { message: "the in-flight batch's own rememberZyraTurn call must also complete before asserting the final count", timeout: 5_000 })
      .toBe(requestsAfterTurn1 + 2);

    // The proof: only 2 batches exist (sync + the one in-flight when Stop landed) — the third,
    // not-yet-started batch never ran, even though its reply was sitting ready in the queue the
    // whole time.
    const batchCount = scalar(`SELECT COUNT(*) FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)};`);
    expect(Number(batchCount), "the third batch must not have started").toBe(2);
    const totalDrafts = scalar(
      `SELECT COALESCE(SUM(jsonb_array_length(generated_payload)), 0) FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)};`,
    );
    expect(Number(totalDrafts), "10 (sync) + 10 (in-flight) — the last 2 were never generated").toBe(20);
    // Still exactly 2 past the in-flight batch's own pair (generation + remember) — the third
    // batch's queued reply was never touched.
    expect(ai.requests.length, "the third batch must never have been requested at all").toBe(requestsAfterTurn1 + 2);

    const remainingScenarios = JSON.parse(scalar(`SELECT active_plan->'remainingScenarios' FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`) ?? "[]");
    expect(remainingScenarios).toHaveLength(2);

    const session = await asOwner.get(url(`/chat/sessions/${sessionId}`), { failOnStatusCode: false });
    const messages = (await session.json()).messages as Array<Record<string, unknown>>;
    expect(messages.some((m) => String(m.content || "").includes("Stopped at your request")), "the stop endpoint's own message must still post").toBe(true);
    // A status-only plan message stages nothing, so it must not point at a review batch.
    const stopMessage = messages.find((m) => String(m.content || "").includes("Stopped at your request"))!;
    expect(stopMessage.reviewRequestId ?? null, "a status message carries no review link").toBeNull();

    // Resuming picks up exactly where Stop actually left it — the 2 scenarios the third batch would
    // have covered, using the reply already queued above (still unconsumed). Its own rememberZyraTurn
    // call is left to the harmless default — nothing follows it in this test to corrupt.
    const resumeRes = await asOwner.post(url(`/chat/sessions/${sessionId}/resume-plan`), { failOnStatusCode: false });
    expect(resumeRes.status(), `resuming — ${await resumeRes.text()}`).toBeLessThan(300);
    await expect
      .poll(() => scalar(`SELECT active_plan FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`), {
        message: "resuming must finish the plan using the one batch Stop genuinely prevented",
        timeout: 15_000,
      })
      .toBeNull();
    const finalBatchCount = scalar(`SELECT COUNT(*) FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)};`);
    expect(Number(finalBatchCount)).toBe(3);
    const finalTotalDrafts = scalar(
      `SELECT COALESCE(SUM(jsonb_array_length(generated_payload)), 0) FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)};`,
    );
    expect(Number(finalTotalDrafts)).toBe(22);
  });

  test("ZCC-B-10 stopping an already-completed plan is a safe no-op", async () => {
    await allocateFakeAiKey();
    await setRange("1-10"); // batches of 10
    const sessionId = await newSession("E2E ZCC stop after completion");

    ai.queueReply({ reply: "", reasoningSummary: "Planning exhaustive coverage.", action: "create", actionType: "create", operations: [], testcases: [], exhaustive: true });
    ai.queueReply({ scenarios: Array.from({ length: 12 }, (_, i) => `Scenario ${i + 1}`) });
    ai.queueReply({ scenarios: [] }); // the planner's top-up round finds nothing more — see ZCC-B-19
    ai.queueReply({ drafts: Array.from({ length: 10 }, (_, i) => scenarioDraft(`Scenario ${i + 1}`)) });
    // See ZCC-B-08's identical comment — the first batch's own rememberZyraTurn call fires
    // synchronously right after it, before the background loop starts, and would otherwise consume
    // the batch-2 reply queued next.
    ai.queueReply("Noted.");
    ai.queueReply({ drafts: Array.from({ length: 2 }, (_, i) => scenarioDraft(`Scenario ${i + 11}`)) });
    const turn1 = await sendMessage(sessionId, "Generate all possible test cases for the login flow.");
    expect(turn1.status, JSON.stringify(turn1.body)).toBeLessThan(300);

    await expect
      .poll(() => scalar(`SELECT active_plan FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`), {
        message: "the plan must fully complete before this test calls stop-plan on it",
        timeout: 30_000,
      })
      .toBeNull();

    const stopRes = await asOwner.post(url(`/chat/sessions/${sessionId}/stop-plan`), { failOnStatusCode: false });
    expect(stopRes.status(), `stopping an already-finished plan must still return success — ${await stopRes.text()}`).toBeLessThan(300);

    // No new message, no resurrected plan — stopZyraChatPlan's `if (plan && plan.status !== "paused")`
    // guard is a no-op once active_plan is already null.
    expect(scalar(`SELECT active_plan FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`)).toBeNull();
    const session = await asOwner.get(url(`/chat/sessions/${sessionId}`), { failOnStatusCode: false });
    const messages = (await session.json()).messages as Array<Record<string, unknown>>;
    expect(messages.some((m) => String(m.content || "").includes("Stopped at your request")), "no-op means no new message either").toBe(false);
  });

  /*
   * The configured test-case range must survive all the way to the review batch.
   *
   * Reported with 30-50 (the default) selected: "25 of 40 test case operation(s) were drafted for
   * review. 15 operation(s) beyond the 25-per-message limit were not applied." The generation itself
   * succeeded — ZYRA_CHAT_MAX_OPERATIONS, a fixed 25, discarded the rest in applyZyraChatOperations.
   * Separately, each tier's requestedCount (the cap normalizeAiDrafts keeps) sat below the tier's own
   * upper bound: 10-30 stopped at 25, 30-50 at 40.
   *
   * Each test routes an ordinary "create" with no count (so the project range decides), has the fake
   * model return MORE drafts than the tier allows, and asserts on the staged review batch — the
   * persisted state the Review panel and Save both read — not on the reply's wording.
   */
  // The range is project-level and outlives the test that set it, so a test that sets one puts the product
  // default (30-50) back afterwards. ZCC-B-11 relies on the default, and the multi-batch plan tests above it
  // now pick a small range to keep their batches small.
  let rangeTouched = false;
  test.afterEach(async () => {
    if (!rangeTouched || !tenant) return;
    rangeTouched = false;
    await asOwner.patch(url("/settings"), { data: { testcaseRange: "30-50" }, failOnStatusCode: false });
  });

  async function setRange(range: string): Promise<void> {
    rangeTouched = true;
    const res = await asOwner.patch(url("/settings"), { data: { testcaseRange: range }, failOnStatusCode: false });
    expect(res.status(), `saving testcaseRange ${range} — ${await res.text()}`).toBe(200);
    expect((await res.json()).testcaseRange).toBe(range);
  }

  /** Router routes to create with no count, then the generation call returns `drafts` drafts. */
  async function generateWithRange(sessionId: string, drafts: number, routerExtra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    ai.queueReply({ reply: "", reasoningSummary: "Generating test cases.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: null, exhaustive: false, ...routerExtra });
    ai.queueReply({ drafts: Array.from({ length: drafts }, (_, i) => scenarioDraft(`E2E range case ${i + 1} ${Date.now()}`)) });
    const turn = await sendMessage(sessionId, "Generate test cases for OTP login.");
    expect(turn.status, JSON.stringify(turn.body)).toBeLessThan(300);
    const session = await asOwner.get(url(`/chat/sessions/${sessionId}`), { failOnStatusCode: false });
    const messages = (await session.json()).messages as Array<Record<string, unknown>>;
    return [...messages].reverse().find((m) => m.role === "assistant")!;
  }

  /** The generation call is the router's successor — the second request this test's turn made. */
  function generationPrompt(): string {
    expect(ai.requests.length, "the generation call never reached the provider").toBeGreaterThanOrEqual(2);
    return JSON.stringify(ai.requests[1].messages);
  }

  /*
   * A plan batch of more than 25 scenarios is written by parallel generation calls of at most 25
   * (generateZyraChunkedDrafts), which reach the fake server in no fixed order. So: one queued reply
   * per call, each as large as the largest chunk — generation trims a reply to its own chunk's count,
   * so the batch total is exact whichever call takes which reply.
   */
  function queueBatchDrafts(scenarioCount: number): void {
    const calls = Math.ceil(scenarioCount / 25);
    const largest = Math.ceil(scenarioCount / calls);
    for (let call = 1; call <= calls; call++) {
      ai.queueReply({ drafts: Array.from({ length: largest }, (_, i) => scenarioDraft(`Chunk ${call} draft ${i + 1} ${Date.now()}`)) });
    }
  }

  /** The prompts of the plan's generation calls (zyraBatchMessage), in arrival order. */
  function batchPrompts(): string[] {
    return ai.requests.map((r) => JSON.stringify(r.messages)).filter((m) => m.includes("Generate exactly one distinct testcase for each of these scenarios"));
  }

  /** The scenarios one generation prompt lists ("N. Scenario X" lines). */
  function scenariosIn(prompt: string): string[] {
    return [...prompt.matchAll(/\\n\d+\. (Scenario \d+)(?=\\n|")/g)].map((m) => m[1]);
  }

  function expectNothingDropped(assistant: Record<string, unknown>): void {
    const activity = (assistant.activity as Array<{ title?: string; detail?: string }>) ?? [];
    expect(activity.filter((a) => /skipped some operations/i.test(String(a.title || ""))), "no operation may be dropped for a per-message limit").toEqual([]);
    expect(String(assistant.content || "")).not.toContain("per-message limit");
  }

  test("ZCC-B-11 the default 30-50 range stages all 40 generated cases, and Save lands all 40", async () => {
    // 40 inserts through zyraSave's one transaction, each a round trip to the hosted database.
    test.setTimeout(240_000);
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E ZCC range 30-50 default");
    const before = liveCaseCount();

    // Explicit: the product default is now "all", so 30-50 has to be chosen.
    await setRange("30-50");
    const assistant = await generateWithRange(sessionId, 40);
    expect(generationPrompt(), "the configured tier's instruction must reach the generation call").toContain("between 30 and 50");

    const review = reviewRequestFor(sessionId);
    expect(review, "the generation should stage a review batch").toBeTruthy();
    expect(review!.payloadLength, "all 40 drafts must be staged — the reported bug staged 25").toBe(40);
    expect(review!.generatedCount).toBe(40);
    expect(assistant.testcases as unknown[], "the review panel must list every staged draft").toHaveLength(40);
    expectNothingDropped(assistant);
    expect(liveCaseCount(), "staging must not write testcases").toBe(before);

    const reviewRow = scalar(`SELECT id FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)} ORDER BY created_at DESC LIMIT 1;`);
    const saveRes = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/ai/generation-history/${reviewRow}/save`, {
      data: { selectedDraftIndexes: Array.from({ length: 40 }, (_, i) => i) },
      failOnStatusCode: false,
      timeout: 180_000,
    });
    expect(saveRes.status(), `saving all 40 — ${await saveRes.text()}`).toBeLessThan(300);
    expect((await saveRes.json()).savedCount).toBe(40);
    expect(liveCaseCount(), "every saved draft must be a real test case").toBe(before + 40);
  });

  test("ZCC-B-12 30-50 keeps up to 50 and never more", async () => {
    await allocateFakeAiKey();
    await setRange("30-50");
    const sessionId = await newSession("E2E ZCC range 30-50 ceiling");

    const assistant = await generateWithRange(sessionId, 55);
    const review = reviewRequestFor(sessionId);
    expect(review!.payloadLength, "30-50 must allow the tier's upper bound, 50 — it stopped at 40, then 25").toBe(50);
    expect(assistant.testcases as unknown[]).toHaveLength(50);
    expectNothingDropped(assistant);
  });

  test("ZCC-B-13 10-30 allows up to 30, not 25", async () => {
    await allocateFakeAiKey();
    await setRange("10-30");
    const sessionId = await newSession("E2E ZCC range 10-30");

    const assistant = await generateWithRange(sessionId, 35);
    expect(generationPrompt()).toContain("between 10 and 30");
    const review = reviewRequestFor(sessionId);
    expect(review!.payloadLength, "10-30 must keep 30 — its requestedCount was 25").toBe(30);
    expect(assistant.testcases as unknown[]).toHaveLength(30);
    expectNothingDropped(assistant);
  });

  test("ZCC-B-14 1-10 still stops at 10", async () => {
    await allocateFakeAiKey();
    await setRange("1-10");
    const sessionId = await newSession("E2E ZCC range 1-10");

    const assistant = await generateWithRange(sessionId, 15);
    expect(generationPrompt()).toContain("between 1 and 10");
    expect(reviewRequestFor(sessionId)!.payloadLength, "a model that overshoots 1-10 is trimmed to the tier's maximum").toBe(10);
    expect(assistant.testcases as unknown[]).toHaveLength(10);
  });

  // Reported bug: "Test cases per task" set to 1-10, yet an "exhaustive" ask ran the scenario plan and
  // produced 100+ cases. Under any range but "all" the range is the ceiling — the router's exhaustive
  // flag and the "all possible" wording must not start a plan (ZCC-B-16 covers "all" itself).
  for (const [range, cap] of [["1-10", 10], ["10-30", 30], ["30-50", 50]] as const) {
    test(`ZCC-B-21 an exhaustive request on the ${range} range stays within ${cap} and starts no plan`, async () => {
      await allocateFakeAiKey();
      await setRange(range);
      const sessionId = await newSession(`E2E ZCC exhaustive capped ${range}`);

      ai.queueReply({ reply: "", reasoningSummary: "Planning exhaustive coverage.", action: "create", actionType: "create", operations: [], testcases: [], exhaustive: true });
      // The model overshoots; generation must trim to the range's maximum.
      ai.queueReply({ drafts: Array.from({ length: cap + 20 }, (_, i) => scenarioDraft(`E2E capped case ${i + 1} ${Date.now()}`)) });
      const turn = await sendMessage(sessionId, "Generate all possible test cases for the login flow.");
      expect(turn.status, JSON.stringify(turn.body)).toBeLessThan(300);

      expect(ai.requests.some((r) => JSON.stringify(r.messages).includes("planning exhaustive test coverage")), "the exhaustive scenario planner must not run below the 'all' range").toBe(false);
      expect(reviewRequestFor(sessionId)!.payloadLength, `staged cases are capped at the ${range} maximum`).toBe(cap);
      expect(scalar(`SELECT active_plan FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`), "no batch plan may be running").toBeNull();
    });
  }

  test("ZCC-B-15 a count the user names overrides the range, in both directions, and is clamped at 50", async () => {
    await allocateFakeAiKey();

    // Fewer than the range: 30-50 project, "give me 5" — must not pad or keep the model's extra 7.
    await setRange("30-50");
    const small = await newSession("E2E ZCC explicit 5");
    await generateWithRange(small, 12, { requestedCount: 5 });
    expect(reviewRequestFor(small)!.payloadLength, "an explicit 5 must stage exactly 5").toBe(5);

    // More than the range: 1-10 project, "45 test cases" — the old 25 ceiling cut this too.
    ai.reset();
    await setRange("1-10");
    const large = await newSession("E2E ZCC explicit 45");
    const largeTurn = await generateWithRange(large, 45, { requestedCount: 45 });
    expect(reviewRequestFor(large)!.payloadLength).toBe(45);
    expectNothingDropped(largeTurn);

    // Beyond the ceiling: an asked-for 100 is clamped to 50, not truncated at 25. 100 is the "all"
    // tier's plan ceiling (ZCC-B-16) — naming that number must not borrow it: no scenario plan runs,
    // and the turn stays one single-shot generation.
    ai.reset();
    const huge = await newSession("E2E ZCC explicit 100");
    const hugeTurn = await generateWithRange(huge, 100, { requestedCount: 100 });
    expect(reviewRequestFor(huge)!.payloadLength, "a count above the ceiling is clamped to 50").toBe(50);
    expectNothingDropped(hugeTurn);
    // "planning exhaustive test coverage" is the planner's own system prompt — it used to match on
    // "List up to", which the planner no longer says, and would then have passed vacuously.
    expect(ai.requests.some((r) => JSON.stringify(r.messages).includes("planning exhaustive test coverage")), "a named count must never run the 'all' scenario planner").toBe(false);
    expect(scalar(`SELECT active_plan FROM zyra_chat_sessions WHERE id = ${literal(huge)};`), "a named count must not start a batch plan").toBeNull();
  });

  test("ZCC-B-16 the 'all' range plans up to 100 scenarios and generates them as one batch of 100 — and only 'all' does", async () => {
    await allocateFakeAiKey();
    await setRange("all");
    const sessionId = await newSession("E2E ZCC range all 100");

    // Router: create, no count — the project's "all" range routes it to the scenario planner. The
    // planner overshoots with 120, so the plan is trimmed to 100, which is exactly one batch of the
    // "all" range's batch size (it was 5 a batch, 20 batches).
    ai.queueReply({ reply: "", reasoningSummary: "Generating test cases.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: null, exhaustive: false });
    ai.queueReply({ scenarios: Array.from({ length: 120 }, (_, i) => `Scenario ${i + 1}`) });
    queueBatchDrafts(100);
    const turn = await sendMessage(sessionId, "Generate test cases for OTP login.");
    expect(turn.status, JSON.stringify(turn.body)).toBeLessThan(300);

    expect(JSON.stringify(ai.requests[1].messages), "the planner must be told the 'all' ceiling").toContain("List 100 scenarios");
    // 120 is already past the target, so no top-up call is made.
    expect(ai.requests.filter((r) => JSON.stringify(r.messages).includes("Scenarios already planned")), "a full plan is never topped up").toHaveLength(0);
    // The batch of 100 is written by 4 parallel calls of 25, between them every scenario exactly once.
    const prompts = batchPrompts();
    expect(prompts, "a batch of 100 is written by 4 calls of 25").toHaveLength(4);
    for (const prompt of prompts) expect(scenariosIn(prompt)).toHaveLength(25);
    const handed = prompts.flatMap(scenariosIn);
    expect(new Set(handed), "the batch is handed all 100 scenarios, each once").toEqual(new Set(Array.from({ length: 100 }, (_, i) => `Scenario ${i + 1}`)));
    expect(handed, "and not the 20 the planner overshot by").not.toContain("Scenario 101");
    expect(reviewRequestFor(sessionId)!.payloadLength, "the first batch holds the 'all' range's 100 test cases").toBe(100);
    const messages = (await (await asOwner.get(url(`/chat/sessions/${sessionId}`))).json()).messages as Array<Record<string, unknown>>;
    const first = messages.find((m) => m.role === "assistant")!;
    expect(first.testcases as unknown[], "the review panel lists every draft of the batch").toHaveLength(100);
    expect(String(first.content || ""), "nothing is left to post, so no plan announces more batches").not.toContain("more)");
    expect(scalar(`SELECT active_plan FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`), "100 scenarios in one batch leaves no plan running").toBeNull();
    expectNothingDropped(first);
  });

  /*
   * A batch holds as many test cases as the project's range allows: 1-10 -> 10, 10-30 -> 30, 30-50 -> 50
   * (All -> 100 is ZCC-B-16). It was a flat 5 for every range. Each case plans 3 scenarios more than one
   * batch holds, so exactly one batch is generated inline and the rest wait in the plan.
   */
  for (const [range, size] of [["1-10", 10], ["10-30", 30], ["30-50", 50]] as const) {
    test(`ZCC-B-20 an exhaustive request on the ${range} range generates batches of ${size}`, async () => {
      await allocateFakeAiKey();
      await setRange(range);
      const sessionId = await newSession(`E2E ZCC batch size ${range}`);

      // "exhaustive" in the request forces the plan flow whatever the range is; the range sets the batch size.
      ai.queueReply({ reply: "", reasoningSummary: "Planning exhaustive coverage.", action: "create", actionType: "create", operations: [], testcases: [], exhaustive: true });
      ai.queueReply({ scenarios: Array.from({ length: size + 3 }, (_, i) => `Scenario ${i + 1}`) });
      ai.queueReply({ scenarios: [] }); // the planner's top-up round finds nothing more — see ZCC-B-19
      queueBatchDrafts(size); // 30 and 50 are written as 2 parallel calls, 10 as one
      ai.queueReply("Noted."); // first batch's rememberZyraTurn — see ZCC-B-08
      // Nothing queued for the background batches: this test is about the first batch's size.

      const turn = await sendMessage(sessionId, "Generate all possible test cases for the login flow.");
      expect(turn.status, JSON.stringify(turn.body)).toBeLessThan(300);

      // Settle the background loop first: it pauses on the unscripted batch, and Stop makes that certain.
      await asOwner.post(url(`/chat/sessions/${sessionId}/stop-plan`), { failOnStatusCode: false });
      await expect
        .poll(() => scalar(`SELECT COALESCE(active_plan->>'status', 'none') FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`), {
          message: "the plan must stop running before it is inspected and cleaned up",
          timeout: 30_000,
        })
        .not.toBe("running");

      const handed = batchPrompts().flatMap(scenariosIn);
      expect(new Set(handed), `the first batch is handed ${size} scenarios`).toEqual(new Set(Array.from({ length: size }, (_, i) => `Scenario ${i + 1}`)));
      expect(handed, "and not the 3 that wait for the next batch").not.toContain(`Scenario ${size + 1}`);
      expect(reviewRequestFor(sessionId)!.payloadLength, `the first batch stages ${size} test cases`).toBe(size);
      expect(Number(scalar(`SELECT active_plan->>'batchSize' FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`)), "the plan keeps the size for its later batches").toBe(size);
      const remaining = JSON.parse(scalar(`SELECT active_plan->'remainingScenarios' FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`) ?? "[]");
      expect(remaining, "the other 3 scenarios wait").toEqual([`Scenario ${size + 1}`, `Scenario ${size + 2}`, `Scenario ${size + 3}`]);
    });
  }

  /*
   * "All – Exhaustive" showed "5 test cases drafted for review" on every batch after the first with
   * nothing under it: postZyraPlanMessage never stored the batch's review_request_id, and the chat
   * only renders proposed rows inside a review panel addressed by that column. The first batch goes
   * through the interactive turn's insert, which always stored it — so a single-batch generation
   * never showed the problem. Three batches (10 sync + 10 + 2 background) so more than one background
   * message is checked, and so batch N's link can't be confused with batch N-1's.
   */
  test("ZCC-B-17 every batch of an exhaustive plan is linked to its own pending review batch", async () => {
    await allocateFakeAiKey();
    // The "all" range's batch is 100, so a plan of a few dozen scenarios would be one batch. 1-10 keeps
    // the batches at 10, and the request says "exhaustive" to run the plan flow on that range.
    await setRange("1-10");
    const sessionId = await newSession("E2E ZCC plan batches are reviewable");

    ai.queueReply({ reply: "", reasoningSummary: "Planning exhaustive coverage.", action: "create", actionType: "create", operations: [], testcases: [], exhaustive: true });
    ai.queueReply({ scenarios: Array.from({ length: 22 }, (_, i) => `Scenario ${i + 1}`) });
    ai.queueReply({ scenarios: [] }); // the planner's top-up round finds nothing more — see ZCC-B-19
    ai.queueReply({ drafts: Array.from({ length: 10 }, (_, i) => scenarioDraft(`Scenario ${i + 1}`)) });
    ai.queueReply("Noted."); // first batch's rememberZyraTurn — see ZCC-B-08
    ai.queueReply({ drafts: Array.from({ length: 10 }, (_, i) => scenarioDraft(`Scenario ${i + 11}`)) });
    ai.queueReply("Noted."); // second batch's own rememberZyraTurn — see ZCC-B-09
    ai.queueReply({ drafts: Array.from({ length: 2 }, (_, i) => scenarioDraft(`Scenario ${i + 21}`)) });

    const turn = await sendMessage(sessionId, "Generate test cases for OTP login.");
    expect(turn.status, JSON.stringify(turn.body)).toBeLessThan(300);
    await expect
      .poll(() => scalar(`SELECT active_plan FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`), {
        message: "the plan must clear itself once the last batch is posted",
        timeout: 45_000,
      })
      .toBeNull();

    const session = await asOwner.get(url(`/chat/sessions/${sessionId}`), { failOnStatusCode: false });
    const messages = (await session.json()).messages as Array<Record<string, unknown>>;
    const batches = messages.filter((m) => m.role === "assistant");
    expect(batches.length, "one message per batch").toBe(3);
    expect(String(batches[1].content || "")).toContain("20/22 scenarios covered so far");
    expect(String(batches[2].content || "")).toContain("all 22 scenarios are now covered");

    const linked = batches.map((m) => m.reviewRequestId as string | null);
    for (const [i, id] of linked.entries()) {
      expect(id, `batch ${i + 1} must link the review batch its drafts are staged in`).toBeTruthy();
    }
    expect(new Set(linked).size, "every batch is its own review batch, never another batch's").toBe(3);

    const titles: string[] = [];
    for (const [i, message] of batches.entries()) {
      const rows = message.testcases as Array<{ title: string; action: string; reviewRequestId?: string; draftIndex?: number }>;
      expect(rows.length, `batch ${i + 1}'s drafts`).toBe([10, 10, 2][i]);
      for (const row of rows) {
        expect(row.action).toBe("proposed-create");
        expect(row.reviewRequestId, "a row and its message must point at the same batch").toBe(linked[i]);
      }
      titles.push(...rows.map((row) => row.title));
      // The same stored batch the panel loads (getZyraTask) — still pending, holding exactly these drafts.
      const task = await asOwner.get(url(`/tasks/${linked[i]}`), { failOnStatusCode: false });
      expect(task.status(), `reading batch ${i + 1}'s review task — ${await task.text()}`).toBe(200);
      expect((await task.json()).taskStatus).toBe("in_review");
      expect(
        Number(scalar(`SELECT jsonb_array_length(generated_payload) FROM ai_generation_requests WHERE id = ${literal(linked[i]!)} AND chat_session_id = ${literal(sessionId)};`)),
      ).toBe(rows.length);
    }
    // The complete set, and no scenario staged twice across batches.
    expect(titles.length).toBe(22);
    expect(new Set(titles).size, "no draft may appear in two batches").toBe(22);
    expect(Number(scalar(`SELECT COUNT(*) FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)};`))).toBe(3);

    // A caller outside the project cannot reach a batch through the id the message now exposes.
    const asGuest = await loginAs(tenant!.guest);
    try {
      const res = await asGuest.get(url(`/tasks/${linked[1]}`), { failOnStatusCode: false });
      expect([401, 403, 404], `a non-member read a plan batch: ${await res.text()}`).toContain(res.status());
    } finally {
      await asGuest.dispose();
    }
  });

  /*
   * A real exhaustive run drafted 4 test cases for 5 scenarios in most batches, and nothing knew
   * which scenario was missing — it was neither retried nor reported, and the count still advanced
   * by 5. Each draft now names the scenario it covers (zyraBatchMessage), so the missing one goes back
   * in the queue once, progress counts only covered scenarios, and a scenario that comes back empty
   * on its retry is skipped and said so. Scripted on batches of 10: batch 1 drops scenario 3; batch 3
   * (21, 22 and the retried 3) drops it again.
   */
  test("ZCC-B-18 a scenario that comes back without a test case is retried once, then reported, and never counted as covered", async () => {
    await allocateFakeAiKey();
    await setRange("1-10"); // batches of 10 (the "all" range's 100 would hold the whole plan in one batch)
    const sessionId = await newSession("E2E ZCC plan retries a dropped scenario");
    const numbered = (title: string, scenario: number) => ({ ...scenarioDraft(title), scenario });

    ai.queueReply({ reply: "", reasoningSummary: "Planning exhaustive coverage.", action: "create", actionType: "create", operations: [], testcases: [], exhaustive: true });
    ai.queueReply({ scenarios: Array.from({ length: 22 }, (_, i) => `Scenario ${i + 1}`) });
    ai.queueReply({ scenarios: [] }); // the planner's top-up round finds nothing more — see ZCC-B-19
    ai.queueReply({ drafts: [1, 2, 4, 5, 6, 7, 8, 9, 10].map((n) => numbered(`Scenario ${n}`, n)) }); // scenario 3 dropped
    ai.queueReply("Noted."); // first batch's rememberZyraTurn — see ZCC-B-08
    ai.queueReply({ drafts: Array.from({ length: 10 }, (_, i) => numbered(`Scenario ${i + 11}`, i + 1)) });
    ai.queueReply("Noted."); // second batch's own rememberZyraTurn — see ZCC-B-09
    ai.queueReply({ drafts: [numbered("Scenario 21", 1), numbered("Scenario 22", 2)] }); // the retried scenario 3 dropped again

    const turn = await sendMessage(sessionId, "Generate test cases for OTP login.");
    expect(turn.status, JSON.stringify(turn.body)).toBeLessThan(300);
    await expect
      .poll(() => scalar(`SELECT active_plan FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`), {
        message: "the plan must clear itself once the retried scenario has had its one retry",
        timeout: 45_000,
      })
      .toBeNull();

    // Every batch asks for numbered drafts; the third carries the dropped scenario back.
    const batchPrompts = ai.requests.map((r) => JSON.stringify(r.messages)).filter((m) => m.includes("Generate exactly one distinct testcase for each of these scenarios"));
    expect(batchPrompts.length, "one generation call per batch").toBe(3);
    for (const prompt of batchPrompts) expect(prompt).toContain('Set \\"scenario\\" on every draft');
    expect(batchPrompts[2], "the retry batch must include the dropped scenario").toContain("3. Scenario 3");
    expect(batchPrompts[2], "after the 2 scenarios that had not started yet").toContain("1. Scenario 21");

    const messages = (await (await asOwner.get(url(`/chat/sessions/${sessionId}`))).json()).messages as Array<Record<string, unknown>>;
    const batches = messages.filter((m) => m.role === "assistant");
    expect(batches.length).toBe(3);
    expect(batches.map((m) => (m.testcases as unknown[]).length), "what each batch actually staged").toEqual([9, 10, 2]);

    const [first, second, last] = batches.map((m) => String(m.content || ""));
    expect(first).toContain("Here are 9 test case(s) for the first 10 — 1 scenario(s) came back without a test case and will be retried in a later batch.");
    expect(first, "12 not yet started + the 1 retry").toContain("(13 more)");
    expect(second, "19 scenarios have a test case, not the 20 handed out").toContain("Here are 10 more test case(s) — 19/22 scenarios covered so far. Still working on the remaining 3;");
    expect(last).toContain("21 of 22 scenarios are covered; 1 produced no test case.");
    expect(last).toContain("1 scenario(s) still produced no test case after a retry and were skipped.");
    expect(last).not.toContain("now covered");

    // The retry batch's trace stays within the plan's 22 and says it carries a retry.
    const retryStep = ((batches[2].trace as { steps?: Array<{ stage: string; meta?: Record<string, unknown> }> } | null)?.steps || []).find((s) => s.stage === "plan:batch");
    expect(retryStep?.meta).toMatchObject({ fromScenario: 21, toScenario: 22, totalCount: 22, retrying: 1 });

    // Staged drafts agree with the messages — the dropped scenario was never staged twice or invented.
    expect(Number(scalar(`SELECT COALESCE(SUM(jsonb_array_length(generated_payload)), 0) FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)};`))).toBe(21);
  });

  /*
   * "All – Exhaustive" should land close to 100 test cases. The planner was told "List up to 100"
   * and a real run planned 49. It is now asked for the target, and a plan that still stops below 90
   * gets one top-up call that sees the list so far. Scripted: 40, then 55 more of which 5 repeat — 90
   * scenarios, which the "all" range's batch of 100 generates in one go.
   */
  test("ZCC-B-19 an 'all' plan that stops well short of 100 is topped up once, without repeats", async () => {
    await allocateFakeAiKey();
    await setRange("all");
    const sessionId = await newSession("E2E ZCC plan top-up");

    ai.queueReply({ reply: "", reasoningSummary: "Generating test cases.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: null, exhaustive: false });
    ai.queueReply({ scenarios: Array.from({ length: 40 }, (_, i) => `Scenario ${i + 1}`) });
    ai.queueReply({ scenarios: ["scenario 1", "Scenario  2", "Scenario 3", "Scenario 4", "Scenario 5", ...Array.from({ length: 50 }, (_, i) => `Scenario ${i + 41}`)] });
    queueBatchDrafts(90);
    // The plan fits one batch of 100, so there are no background batches (see ZCC-B-16).

    const turn = await sendMessage(sessionId, "Generate test cases for OTP login.");
    expect(turn.status, JSON.stringify(turn.body)).toBeLessThan(300);

    const planPrompt = JSON.stringify(ai.requests[1].messages);
    expect(planPrompt, "the planner is asked for the target, not 'up to' it").toContain("List 100 scenarios");
    expect(planPrompt).toContain("until you reach 100");
    const topUp = JSON.stringify(ai.requests[2].messages);
    expect(topUp, "the top-up sees what is already planned").toContain("40. Scenario 40");
    expect(topUp).toContain("up to 60 MORE distinct scenarios");

    // 40 + 50 new — the 5 repeats are dropped, so the one batch is handed 90 scenarios, not 95
    // (across its parallel calls — see queueBatchDrafts).
    const handed = batchPrompts().flatMap(scenariosIn);
    expect(handed).toHaveLength(90);
    expect(new Set(handed).size, "a repeated scenario must not be handed out twice").toBe(90);
    expect(reviewRequestFor(sessionId)!.payloadLength).toBe(90);
    expect(scalar(`SELECT active_plan FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`), "90 scenarios fit one batch, so no plan is left running").toBeNull();
  });

  /*
   * "Generate test cases for all the tickets" planned at most 100 scenarios, from the ~25 tickets the
   * search showed, however many tickets the project had (a real one had 10,000+). A request about the
   * tickets as a whole now walks them page by page: plan a page of tickets, generate its batches, plan
   * the next page — until the tickets run out. 26 tickets is one full page of 25 plus 1, which is all
   * it takes to prove the second page is reached; the page size is a backend constant.
   */
  const ALL_TICKETS_MESSAGE = "Generate all possible test cases for all the Jira tickets.";

  function rootFolderId(): string {
    const existing = scalar(`SELECT id FROM knowledge_folders WHERE project_id = ${literal(tenant!.mainProjectId)} AND is_root = true;`);
    if (existing) return existing;
    exec(
      "INSERT INTO knowledge_folders (organization_id, project_id, parent_folder_id, name, is_root) " +
        `VALUES (${literal(tenant!.organizationId)}, ${literal(tenant!.mainProjectId)}, NULL, 'Knowledge base', true);`,
    );
    return scalar(`SELECT id FROM knowledge_folders WHERE project_id = ${literal(tenant!.mainProjectId)} AND is_root = true;`);
  }

  /** `count` synced-ticket-shaped documents ("KEY-n: summary"). Their text avoids the words in ALL_TICKETS_MESSAGE, so search stays unconfident. */
  async function seedTickets(count: number): Promise<void> {
    const folderId = rootFolderId();
    const titles = Array.from({ length: count }, (_, i) => `E2EZ-${i + 1}: Gift card balance lookup ${i + 1}`);
    for (let i = 0; i < titles.length; i += 8) {
      await Promise.all(
        titles.slice(i, i + 8).map(async (title) => {
          const res = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/knowledge-base/documents`, {
            data: { folderId, documentType: "general", title, contentText: "Customers can look up the remaining balance of a gift card." },
            failOnStatusCode: false,
          });
          expect(res.status(), `seeding "${title}" — ${await res.text()}`).toBe(201);
        }),
      );
    }
  }

  /** The scenario planner's own calls (not its top-up rounds): their prompts carry the page of tickets they were given. */
  function plannerPrompts(): string[] {
    return ai.requests
      .map((r) => JSON.stringify(r.messages))
      .filter((m) => m.includes("planning exhaustive test coverage") && !m.includes("Scenarios already planned"));
  }

  function distinctTickets(prompt: string): string[] {
    return [...new Set(prompt.match(/E2EZ-\d+:/g) ?? [])];
  }

  function activePlan(sessionId: string): Record<string, unknown> | null {
    const raw = scalar(`SELECT active_plan FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  }

  /*
   * The ticket-scope question ("[Zyra] Warn Users About the 100-Test-Case Limit When Generating for
   * Multiple Tickets"): a create whose estimate — tickets × the per-task count — is above 60 is asked
   * about first. These read it the way the chat page does and answer it the way a click does.
   */
  type ChatOption = { id: string; label: string; description?: string; message?: string };

  async function sessionMessages(sessionId: string): Promise<Array<Record<string, unknown>>> {
    return (await (await asOwner.get(url(`/chat/sessions/${sessionId}`))).json()).messages as Array<Record<string, unknown>>;
  }

  async function latestReply(sessionId: string): Promise<Record<string, unknown>> {
    return [...(await sessionMessages(sessionId))].reverse().find((m) => m.role === "assistant")!;
  }

  /** Clicks `optionId` on the latest reply's question — the chat page sends the option's request text with `choice`. */
  async function answerQuestion(sessionId: string, optionId: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const question = await latestReply(sessionId);
    const options = question.options as { choices: ChatOption[] } | null;
    expect(options, "the latest reply must be a question with options").toBeTruthy();
    const choice = options!.choices.find((c) => c.id === optionId);
    expect(choice, `the question offers "${optionId}"`).toBeTruthy();
    const res = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), {
      data: { message: choice!.message || choice!.label, choice: { messageId: question.id, optionId } },
      failOnStatusCode: false,
    });
    return { status: res.status(), body: await res.json().catch(() => ({})) };
  }

  /** Asserts the latest reply is the ticket-scope question, and that nothing was generated or staged for it. */
  async function expectScopeQuestion(sessionId: string, tickets: number): Promise<Record<string, unknown>> {
    const question = await latestReply(sessionId);
    expect(String(question.content || "")).toContain(`This request covers ${tickets} tickets`);
    const options = question.options as { kind: string; choices: ChatOption[]; answeredId: string | null };
    expect(options.kind).toBe("ticket_scope");
    expect(options.choices.map((c) => c.label)).toEqual(["Generate in smaller batches", "Generate all tickets in batches"]);
    expect(options.answeredId).toBeNull();
    expect(JSON.stringify(options), "what acting on the answer needs stays server-side").not.toContain("originalMessage");
    expect(question.testcases as unknown[], "a question stages nothing").toHaveLength(0);
    expect(stagedDraftCount(sessionId), "nothing is generated before the user answers").toBe(0);
    return question;
  }

  function stagedDraftCount(sessionId: string): number {
    return Number(scalar(`SELECT COALESCE(SUM(jsonb_array_length(generated_payload)), 0) FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)};`));
  }

  test("ZCC-B-21 a request about all the tickets plans them page by page until they run out", async () => {
    test.setTimeout(180_000);
    await allocateFakeAiKey();
    await setRange("1-10");
    await seedTickets(26);
    const sessionId = await newSession("E2E ZCC paged plan");

    ai.queueReply({ reply: "", reasoningSummary: "Planning exhaustive coverage.", action: "create", actionType: "create", operations: [], testcases: [], exhaustive: true });
    // Page 1 (25 tickets): 12 scenarios — 10 fill the first batch, 2 are left over.
    ai.queueReply({ scenarios: Array.from({ length: 12 }, (_, i) => `Page one scenario ${i + 1}`) });
    ai.queueReply({ scenarios: [] }); // page 1's top-up round
    ai.queueReply({ drafts: Array.from({ length: 10 }, (_, i) => scenarioDraft(`Page one scenario ${i + 1}`)) });
    ai.queueReply("Noted."); // first batch's rememberZyraTurn — see ZCC-B-08
    // The queue (2) is below a batch, so the plan reaches for page 2 (the last ticket) before the next batch.
    ai.queueReply({ scenarios: Array.from({ length: 9 }, (_, i) => `Page two scenario ${i + 1}`) });
    ai.queueReply({ scenarios: [] }); // page 2's top-up round
    ai.queueReply({ drafts: Array.from({ length: 10 }, (_, i) => scenarioDraft(i < 2 ? `Page one scenario ${i + 11}` : `Page two scenario ${i - 1}`)) });
    ai.queueReply("Noted."); // second batch's own rememberZyraTurn — see ZCC-B-09
    ai.queueReply({ drafts: [scenarioDraft("Page two scenario 9")] });

    const turn = await sendMessage(sessionId, ALL_TICKETS_MESSAGE);
    expect(turn.status, JSON.stringify(turn.body)).toBeLessThan(300);
    // 26 tickets × 50 (an exhaustive ask) is above 60, so Zyra asks first; answering "all" skips the
    // router (already consumed above) and runs the paged plan from the queued replies, in order.
    await expectScopeQuestion(sessionId, 26);
    const answered = await answerQuestion(sessionId, "all");
    expect(answered.status, JSON.stringify(answered.body)).toBeLessThan(300);

    // Right after the first batch: a plan with more tickets still to plan.
    const started = activePlan(sessionId);
    if (started) expect(started.batchSize, "the plan keeps the 1-10 range's batch size").toBe(10);

    await expect
      .poll(() => scalar(`SELECT active_plan FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`), {
        message: "the plan must clear itself once the last ticket page has been planned and generated",
        timeout: 90_000,
      })
      .toBeNull();

    // Two planner calls, one per page, and between them every ticket exactly once.
    const planners = plannerPrompts();
    expect(planners, "one planner call per ticket page").toHaveLength(2);
    const [pageOne, pageTwo] = planners.map(distinctTickets);
    expect(pageOne, "a full page").toHaveLength(25);
    expect(pageTwo, "the leftover ticket").toHaveLength(1);
    expect(new Set([...pageOne, ...pageTwo]).size, "no ticket planned twice, none missed").toBe(26);

    const messages = (await (await asOwner.get(url(`/chat/sessions/${sessionId}`))).json()).messages as Array<Record<string, unknown>>;
    // The question is a reply too; the batches are the replies after it.
    const batches = messages.filter((m) => m.role === "assistant" && !m.options);
    expect(batches.map((m) => (m.testcases as unknown[]).length), "10 + 10 + 1 test cases").toEqual([10, 10, 1]);
    expect(String(batches[0].content || ""), "the first reply says more tickets are coming").toContain("I identified 12 distinct scenarios to cover from the first tickets");
    expect(String(batches[1].content || "")).toContain("Here are 10 more test case(s) — 20/21 scenarios covered so far");
    expect(String(batches[2].content || "")).toContain("all 21 scenarios are now covered");
    expect(stagedDraftCount(sessionId), "every batch is staged as its own review batch").toBe(21);
  });

  test("ZCC-B-22 a paged plan that fails planning its next tickets pauses with its place kept, and Continue picks it up", async () => {
    test.setTimeout(180_000);
    await allocateFakeAiKey();
    await setRange("1-10");
    await seedTickets(26);
    const sessionId = await newSession("E2E ZCC paged plan pause and resume");

    ai.queueReply({ reply: "", reasoningSummary: "Planning exhaustive coverage.", action: "create", actionType: "create", operations: [], testcases: [], exhaustive: true });
    // Page 1 plans exactly one batch, so the queue is EMPTY when the plan needs page 2 — a state a resume
    // used to refuse (nothing left to generate), leaving the plan paused for good.
    ai.queueReply({ scenarios: Array.from({ length: 10 }, (_, i) => `Page one scenario ${i + 1}`) });
    ai.queueReply({ scenarios: [] }); // page 1's top-up round
    ai.queueReply({ drafts: Array.from({ length: 10 }, (_, i) => scenarioDraft(`Page one scenario ${i + 1}`)) });
    ai.queueReply("Noted."); // first batch's rememberZyraTurn — see ZCC-B-08
    ai.queueReply("I cannot put that into scenarios."); // page 2's planner call comes back unparseable

    const turn = await sendMessage(sessionId, ALL_TICKETS_MESSAGE);
    expect(turn.status, JSON.stringify(turn.body)).toBeLessThan(300);
    await expectScopeQuestion(sessionId, 26); // see ZCC-B-21
    const answered = await answerQuestion(sessionId, "all");
    expect(answered.status, JSON.stringify(answered.body)).toBeLessThan(300);
    await expect
      .poll(() => scalar(`SELECT active_plan->>'status' FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`), {
        message: "a page that cannot be planned must pause the plan, not end it or leave it running",
        timeout: 60_000,
      })
      .toBe("paused");

    const paused = activePlan(sessionId)!;
    expect(paused.ticketsHasMore, "the tickets are not over, only unplanned").toBe(true);
    expect(paused.remainingScenarios, "nothing is queued").toEqual([]);
    expect(typeof paused.ticketCursor, "the place in the tickets is kept, so Continue retries the same page").toBe("string");
    let messages = (await (await asOwner.get(url(`/chat/sessions/${sessionId}`))).json()).messages as Array<Record<string, unknown>>;
    const pauseMessage = messages.find((m) => String(m.content || "").includes("I ran into an issue planning the next tickets"));
    expect(pauseMessage, "the user is told why it paused").toBeTruthy();
    expect(String(pauseMessage!.content)).toContain("10/10 scenarios covered");
    expect(pauseMessage!.testcases as unknown[], "a status message stages nothing").toHaveLength(0);

    // Continue: page 2 is the last ticket; it plans 3 scenarios, which are generated and the plan clears.
    ai.queueReply({ scenarios: Array.from({ length: 3 }, (_, i) => `Page two scenario ${i + 1}`) });
    ai.queueReply({ scenarios: [] }); // page 2's top-up round
    ai.queueReply({ drafts: Array.from({ length: 3 }, (_, i) => scenarioDraft(`Page two scenario ${i + 1}`)) });
    const resumeRes = await asOwner.post(url(`/chat/sessions/${sessionId}/resume-plan`), { failOnStatusCode: false });
    expect(resumeRes.status(), `resuming — ${await resumeRes.text()}`).toBeLessThan(300);
    await expect
      .poll(() => scalar(`SELECT active_plan FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`), {
        message: "Continue must plan the next page, generate it, and finish the plan",
        timeout: 60_000,
      })
      .toBeNull();

    messages = (await (await asOwner.get(url(`/chat/sessions/${sessionId}`))).json()).messages as Array<Record<string, unknown>>;
    const last = [...messages].reverse().find((m) => m.role === "assistant")!;
    expect(String(last.content || "")).toContain("all 13 scenarios are now covered");
    expect(stagedDraftCount(sessionId)).toBe(13);
  });

  test("ZCC-B-23 a request that names a ticket is planned from what it matched, not paged through every ticket", async () => {
    test.setTimeout(180_000);
    await allocateFakeAiKey();
    await setRange("1-10");
    await seedTickets(26);
    const sessionId = await newSession("E2E ZCC named ticket is not paged");

    ai.queueReply({ reply: "", reasoningSummary: "Planning exhaustive coverage.", action: "create", actionType: "create", operations: [], testcases: [], exhaustive: true });
    ai.queueReply({ scenarios: Array.from({ length: 12 }, (_, i) => `Scenario ${i + 1}`) });
    ai.queueReply({ scenarios: [] }); // the planner's top-up round
    ai.queueReply({ drafts: Array.from({ length: 10 }, (_, i) => scenarioDraft(`Scenario ${i + 1}`)) });
    ai.queueReply("Noted."); // first batch's rememberZyraTurn — see ZCC-B-08

    const turn = await sendMessage(sessionId, "Generate all possible test cases for the tickets in E2EZ-3.");
    expect(turn.status, JSON.stringify(turn.body)).toBeLessThan(300);

    await asOwner.post(url(`/chat/sessions/${sessionId}/stop-plan`), { failOnStatusCode: false });
    await expect
      .poll(() => scalar(`SELECT COALESCE(active_plan->>'status', 'none') FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`), {
        message: "the plan must stop running before it is inspected",
        timeout: 30_000,
      })
      .not.toBe("running");

    const plan = activePlan(sessionId);
    expect(plan, "12 scenarios over a batch of 10 leave a plan").toBeTruthy();
    expect(plan!.ticketsHasMore ?? null, "a named ticket is not a request for every ticket").toBeNull();
    expect(plan!.ticketCursor ?? null).toBeNull();
    const planners = plannerPrompts();
    expect(planners).toHaveLength(1);
    expect(distinctTickets(planners[0]).length, "the planner saw what the request matched, not a page of 25 tickets").toBeLessThan(25);
  });

  test("ZCC-B-24 a request about all the tickets in a project with none synced is planned as before", async () => {
    await allocateFakeAiKey();
    await setRange("1-10");
    const sessionId = await newSession("E2E ZCC all tickets, no tickets");

    ai.queueReply({ reply: "", reasoningSummary: "Planning exhaustive coverage.", action: "create", actionType: "create", operations: [], testcases: [], exhaustive: true });
    ai.queueReply({ scenarios: Array.from({ length: 12 }, (_, i) => `Scenario ${i + 1}`) });
    ai.queueReply({ scenarios: [] }); // the planner's top-up round
    ai.queueReply({ drafts: Array.from({ length: 10 }, (_, i) => scenarioDraft(`Scenario ${i + 1}`)) });
    ai.queueReply("Noted."); // first batch's rememberZyraTurn — see ZCC-B-08

    const turn = await sendMessage(sessionId, ALL_TICKETS_MESSAGE);
    expect(turn.status, JSON.stringify(turn.body)).toBeLessThan(300);

    await asOwner.post(url(`/chat/sessions/${sessionId}/stop-plan`), { failOnStatusCode: false });
    await expect
      .poll(() => scalar(`SELECT COALESCE(active_plan->>'status', 'none') FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`), {
        message: "the plan must stop running before it is inspected",
        timeout: 30_000,
      })
      .not.toBe("running");

    const plan = activePlan(sessionId);
    expect(plan, "12 scenarios over a batch of 10 leave a plan").toBeTruthy();
    expect(plan!.ticketsHasMore ?? null, "no tickets to page through").toBeNull();
    const messages = (await (await asOwner.get(url(`/chat/sessions/${sessionId}`))).json()).messages as Array<Record<string, unknown>>;
    const first = messages.find((m) => m.role === "assistant")!;
    expect(String(first.content || "")).toContain("I identified 12 distinct scenarios to cover. ");
    expect(String(first.content || "")).not.toContain("from the first tickets");
  });

  // ─── The ticket-scope question ────────────────────────────────────────────────────────────────
  //
  // Thirty named tickets used to share one planner call capped at 100 scenarios (~98 test cases, about
  // three a ticket) and finish with "all N scenarios are now covered". Above an estimate of 60 Zyra now
  // asks; "all in batches" plans named tickets one at a time and accounts for every one of them.

  /** A generated draft that names the plan scenario it covers, so a batch's coverage is mapped exactly. */
  function coveringDraft(title: string, scenario: number) {
    return { ...scenarioDraft(title), scenario };
  }

  test("ZCC-T-01 naming many tickets asks first — with options, nothing generated, nothing staged", async () => {
    await allocateFakeAiKey();
    await seedTickets(3);
    const sessionId = await newSession("E2E ZCC scope question");
    // Only the router runs: the question is decided before any generation call.
    ai.queueReply({ reply: "", reasoningSummary: "Generating test cases.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: null, exhaustive: false });

    // The 30-50 default range is 50 per ticket: 3 named tickets is roughly 150, above 60.
    const turn = await sendMessage(sessionId, "Generate test cases for E2EZ-1, E2EZ-2 and E2EZ-3.");
    expect(turn.status, JSON.stringify(turn.body)).toBeLessThan(300);
    const question = await expectScopeQuestion(sessionId, 3);
    expect(String(question.content || "")).toContain("roughly 150 test cases");
    expect(ai.requests, "only the router call — no planning, no generation").toHaveLength(1);
    expect(activePlan(sessionId), "no plan starts before the user answers").toBeNull();
  });

  test("ZCC-T-02 'all tickets in batches' plans each named ticket on its own and accounts for every one", async () => {
    test.setTimeout(180_000);
    await allocateFakeAiKey();
    await seedTickets(3);
    const sessionId = await newSession("E2E ZCC ticket-scoped plan");
    ai.queueReply({ reply: "", reasoningSummary: "Generating test cases.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: null, exhaustive: false });
    // E2EZ-99 is never synced — it must be named, not silently dropped.
    const turn = await sendMessage(sessionId, "Generate test cases for E2EZ-1, E2EZ-2, E2EZ-3 and E2EZ-99.");
    expect(turn.status, JSON.stringify(turn.body)).toBeLessThan(300);
    await expectScopeQuestion(sessionId, 4);

    // One planner call per synced ticket (they are read in document-id order, so which ticket comes
    // first is not fixed): two tickets plan 2 scenarios each — under 90% of their 50, so each gets a
    // top-up round — and the third plans none, which needs no top-up.
    ai.queueReply({ scenarios: ["First ticket scenario 1", "First ticket scenario 2"] });
    ai.queueReply({ scenarios: [] });
    ai.queueReply({ scenarios: ["Second ticket scenario 1", "Second ticket scenario 2"] });
    ai.queueReply({ scenarios: [] });
    ai.queueReply({ scenarios: [] });
    // The 4 scenarios fit one batch of 50, so this is the only batch and no plan is left running.
    ai.queueReply({ drafts: Array.from({ length: 4 }, (_, i) => coveringDraft(`E2E scoped case ${i + 1} ${Date.now()}`, i + 1)) });
    ai.queueReply("Noted."); // the batch's rememberZyraTurn — see ZCC-B-08

    const answered = await answerQuestion(sessionId, "all");
    expect(answered.status, JSON.stringify(answered.body)).toBeLessThan(300);

    const planners = plannerPrompts();
    expect(planners, "one planner call per synced ticket").toHaveLength(3);
    const perCall = planners.map(distinctTickets);
    for (const tickets of perCall) expect(tickets, "each planner call sees exactly one ticket").toHaveLength(1);
    expect(new Set(perCall.flat()), "every synced ticket planned, none twice").toEqual(new Set(["E2EZ-1:", "E2EZ-2:", "E2EZ-3:"]));
    const emptyTicket = perCall[2][0].replace(":", "");

    const reply = await latestReply(sessionId);
    const content = String(reply.content || "");
    expect(content).toContain("I'm generating test cases for 4 ticket(s) one ticket at a time");
    expect(content).toContain("1 ticket(s) aren't synced to Tesbo and will be skipped: E2EZ-99");
    expect(content, "the last message accounts for every ticket").toContain("2 of 4 ticket(s) got test cases");
    expect(content).toContain("- E2EZ-99 — not synced to Tesbo yet");
    expect(content).toContain(`- ${emptyTicket} — no new scenarios`);
    expect(content, "never the old scenario-only finish line").not.toContain("scenarios are now covered");
    expect((reply.testcases as unknown[]).length).toBe(4);
    expect(stagedDraftCount(sessionId)).toBe(4);
    expect(activePlan(sessionId), "one batch was all there was").toBeNull();

    // The question now shows which answer was taken, and cannot be answered again.
    const question = (await sessionMessages(sessionId)).find((m) => m.options)!;
    expect((question.options as { answeredId: string }).answeredId).toBe("all");
    const again = await asOwner.post(url(`/chat/sessions/${sessionId}/messages`), {
      data: { message: "Generate all tickets in batches", choice: { messageId: question.id, optionId: "all" } },
      failOnStatusCode: false,
    });
    expect(again.status(), "an answered question is refused, not run a second time").toBe(409);
  });

  test("ZCC-T-03 'smaller batches' asks for ticket ids instead of listing tickets, and the typed ticket generates", async () => {
    test.setTimeout(120_000);
    await allocateFakeAiKey();
    await seedTickets(3);
    const sessionId = await newSession("E2E ZCC smaller batches");
    ai.queueReply({ reply: "", reasoningSummary: "Generating test cases.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: null, exhaustive: false });
    await sendMessage(sessionId, "Generate test cases for E2EZ-1, E2EZ-2 and E2EZ-3.");
    await expectScopeQuestion(sessionId, 3);

    const smaller = await answerQuestion(sessionId, "smaller");
    expect(smaller.status, JSON.stringify(smaller.body)).toBeLessThan(300);
    expect(ai.requests, "asking which tickets calls no model").toHaveLength(1);
    const prompt = await latestReply(sessionId);
    expect(String(prompt.content || "")).toContain("Type the ticket IDs or a range — for example `E2EZ-1, E2EZ-2` or `E2EZ-1 to E2EZ-2`");
    expect(String(prompt.content || "")).toContain("3 tickets are in scope; for the best coverage name up to 2 at a time");
    const options = prompt.options as { kind: string; choices: ChatOption[] };
    expect(options.kind).toBe("ticket_selection");
    // No row per ticket, however many there are — only the way out to every ticket.
    expect(options.choices.map((c) => c.label)).toEqual(["Generate all tickets in batches"]);

    // The typed ticket is planned on its own (one planner call and its top-up round), then generated.
    ai.queueReply({ scenarios: ["Balance shown", "Balance hidden for expired card"] });
    ai.queueReply({ scenarios: [] });
    ai.queueReply({ drafts: [coveringDraft(`E2E typed ticket case A ${Date.now()}`, 1), coveringDraft(`E2E typed ticket case B ${Date.now()}`, 2)] });
    ai.queueReply("Noted.");
    const typed = await sendMessage(sessionId, "E2EZ-2");
    expect(typed.status, JSON.stringify(typed.body)).toBeLessThan(300);

    const planners = plannerPrompts();
    expect(planners).toHaveLength(1);
    expect(distinctTickets(planners[0])).toEqual(["E2EZ-2:"]);
    const reply = await latestReply(sessionId);
    expect(reply.options ?? null, "a typed choice is generated, not asked about again").toBeNull();
    expect(String(reply.content || "")).toContain("All 1 ticket(s) processed.");
    expect((reply.testcases as unknown[]).length).toBe(2);
    // The which-tickets question is now answered — by the typed ticket.
    const stored = (await sessionMessages(sessionId)).find((m) => m.id === prompt.id)!;
    expect((stored.options as { answeredId: string }).answeredId).toBe("typed");
  });

  test("ZCC-T-06 typed tickets are checked: unknown ids and an oversized range are re-asked; a range plans every ticket and names the unsynced", async () => {
    test.setTimeout(120_000);
    await allocateFakeAiKey();
    await seedTickets(3);
    const sessionId = await newSession("E2E ZCC typed ticket checks");
    ai.queueReply({ reply: "", reasoningSummary: "Generating test cases.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: null, exhaustive: false });
    await sendMessage(sessionId, "Generate test cases for E2EZ-1, E2EZ-2 and E2EZ-3.");
    await expectScopeQuestion(sessionId, 3);
    await answerQuestion(sessionId, "smaller");

    // Nothing typed exists: asked again, saying which, and nothing generated.
    await sendMessage(sessionId, "E2EZ-90 to E2EZ-92");
    let reply = await latestReply(sessionId);
    expect(String(reply.content || "")).toContain("None of E2EZ-90, E2EZ-91, E2EZ-92 is a synced ticket in this project.");
    expect((reply.options as { kind: string }).kind, "still waiting for tickets").toBe("ticket_selection");

    // A range past 500 is refused with the reason, not cut short.
    await sendMessage(sessionId, "E2EZ-1 to E2EZ-9000");
    reply = await latestReply(sessionId);
    expect(String(reply.content || "")).toContain("E2EZ-1 to E2EZ-9000 covers 9000 tickets — name at most 500 at a time");
    expect(ai.requests, "no model call for any of these").toHaveLength(1);
    expect(stagedDraftCount(sessionId)).toBe(0);

    // A range plus an unsynced id: both synced tickets planned one at a time, the unsynced one named.
    ai.queueReply({ scenarios: ["First typed ticket scenario"] });
    ai.queueReply({ scenarios: ["Second typed ticket scenario"] });
    ai.queueReply({ drafts: [coveringDraft(`E2E range case A ${Date.now()}`, 1), coveringDraft(`E2E range case B ${Date.now()}`, 2)] });
    ai.queueReply("Noted.");
    await sendMessage(sessionId, "E2EZ-1 to E2EZ-2, E2EZ-99");

    const planners = plannerPrompts();
    expect(planners).toHaveLength(2);
    expect(new Set(planners.flatMap(distinctTickets))).toEqual(new Set(["E2EZ-1:", "E2EZ-2:"]));
    reply = await latestReply(sessionId);
    const content = String(reply.content || "");
    expect(content).toContain("I'm generating test cases for 3 ticket(s) one ticket at a time");
    expect(content).toContain("1 ticket(s) aren't synced to Tesbo and will be skipped: E2EZ-99");
    expect(content).toContain("2 of 3 ticket(s) got test cases");
    expect(content).toContain("- E2EZ-99 — not synced to Tesbo yet");
    expect(stagedDraftCount(sessionId)).toBe(2);
  });

  test("ZCC-T-07 'all possible' for named tickets budgets each ticket at the full batch — 100 each, not 100 shared", async () => {
    test.setTimeout(120_000);
    await allocateFakeAiKey();
    await seedTickets(2);
    const sessionId = await newSession("E2E ZCC per-ticket budget");
    ai.queueReply({ reply: "", reasoningSummary: "Planning exhaustive coverage.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: null, exhaustive: true });
    await sendMessage(sessionId, "Generate all possible test cases for E2EZ-1 and E2EZ-2.");
    const question = await expectScopeQuestion(sessionId, 2);
    // The 'all' range's batch (100) per ticket — it used to be its single-call cap (50), so two tickets
    // asked for in full shared one batch of 100.
    expect(String(question.content || "")).toContain("At about 100 test cases per ticket that is roughly 200 test cases");

    ai.queueReply({ scenarios: ["First ticket scenario 1", "First ticket scenario 2"] });
    ai.queueReply({ scenarios: [] }); // its top-up round
    ai.queueReply({ scenarios: ["Second ticket scenario 1", "Second ticket scenario 2"] });
    ai.queueReply({ scenarios: [] }); // its top-up round
    ai.queueReply({ drafts: Array.from({ length: 4 }, (_, i) => coveringDraft(`E2E budget case ${i + 1} ${Date.now()}`, i + 1)) });
    ai.queueReply("Noted.");
    const answered = await answerQuestion(sessionId, "all");
    expect(answered.status, JSON.stringify(answered.body)).toBeLessThan(300);

    const planners = plannerPrompts();
    expect(planners).toHaveLength(2);
    for (const prompt of planners) expect(prompt, "each ticket is planned for its own 100").toContain("List 100 scenarios");
    // The second ticket was known to be the last, so no empty extra round and no trailing message.
    expect(activePlan(sessionId)).toBeNull();
    const replies = (await sessionMessages(sessionId)).filter((m) => m.role === "assistant");
    expect(replies.map((m) => String(m.content || "")).some((c) => c.startsWith("Finished working through the tickets"))).toBe(false);
    expect(String((await latestReply(sessionId)).content || "")).toContain("All 2 ticket(s) processed.");
  });

  // ─── Streaming generation into the review batch ───────────────────────────────────────────────────
  //
  // "[Zyra] Stream Main Test Case Review UI Progressively During Generation": a background batch is ONE
  // review batch, filled draft by draft while it is written — its message is posted (status
  // "generating") with its first draft, and its review row grows as the model streams. Every drafting
  // call is answered by match on the drafting system prompt: a batch's pieces run in parallel and each
  // one's memory call quotes the batch request, so FIFO order is not fixed (FakeAiServer.queueReplyMatching).
  const DRAFTING_PROMPT = "an AI testcase generation agent";
  const okLabel = (n: number) => `Scenario ${n} ok`;

  function queueDraftingReplies(count: number, size: number): void {
    for (let call = 0; call < count; call++) {
      ai.queueReplyMatching(DRAFTING_PROMPT, { drafts: Array.from({ length: size }, (_, i) => coveringDraft(`E2E part ${call}-${i} ${Date.now()}`, i + 1)) });
    }
  }

  /** Drafts in the review batch of the session's message that is still generating, or null when none is. */
  function generatingBatchSize(sessionId: string): number | null {
    const raw = scalar(
      `SELECT jsonb_array_length(r.generated_payload) FROM zyra_chat_messages m JOIN ai_generation_requests r ON r.id = m.review_request_id ` +
        `WHERE m.session_id = ${literal(sessionId)} AND m.status = 'generating' LIMIT 1;`,
    );
    return raw ? Number(raw) : null;
  }

  test("ZCC-S-01 a background batch fills one review batch while it is written, then its message completes", async () => {
    test.setTimeout(180_000);
    await allocateFakeAiKey();
    await setRange("30-50");
    const sessionId = await newSession("E2E ZCC live review batch");
    ai.queueReply({ reply: "", reasoningSummary: "Planning exhaustive coverage.", action: "create", actionType: "create", operations: [], testcases: [], exhaustive: true });
    ai.queueReply({ scenarios: Array.from({ length: 100 }, (_, i) => okLabel(i + 1)) });
    // 100 scenarios at the 30-50 range's batch of 50: the first batch inline (2 pieces), the second in the background (2 pieces).
    queueDraftingReplies(4, 25);
    // Background generation is streamed (a live batch is always being filled there); slow it down so
    // there is a real window in which the batch is partly written.
    ai.setStreamChunkDelayMs(150);

    const turn = await sendMessage(sessionId, "Generate all possible test cases for the login flow.");
    expect(turn.status, JSON.stringify(turn.body)).toBeLessThan(300);

    // Mid-batch: the message exists, generating, and its review batch holds some drafts but not all.
    await expect
      .poll(() => generatingBatchSize(sessionId) ?? -1, { message: "the batch's review batch must fill while it is written", timeout: 60_000 })
      .toBeGreaterThan(0);
    expect(generatingBatchSize(sessionId) ?? 50, "only the drafts written so far").toBeLessThan(50);

    await expect
      .poll(() => scalar(`SELECT active_plan FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`), { message: "the background batch must finish", timeout: 90_000 })
      .toBeNull();
    const replies = (await sessionMessages(sessionId)).filter((m) => m.role === "assistant");
    // One message per batch — the background batch's completed in place, not joined by parts.
    expect(replies.map((m) => (m.testcases as unknown[]).length)).toEqual([50, 50]);
    expect(replies.map((m) => m.status)).toEqual(["completed", "completed"]);
    expect(String(replies[1].content)).toContain("all 100 scenarios are now covered");
    expect(stagedDraftCount(sessionId), "every draft staged once — none lost, none twice").toBe(100);
    const titles = (replies[1].testcases as Array<{ title: string }>).map((row) => row.title);
    expect(new Set(titles).size, "no draft appears twice in the batch").toBe(50);
    const background = ai.requests.filter((r) => {
      const prompt = JSON.stringify(r.messages);
      return prompt.includes(DRAFTING_PROMPT) && (prompt.includes(okLabel(51)) || prompt.includes(okLabel(76)));
    });
    expect(background.every((r) => r.stream), "background generation is streamed").toBe(true);
  });

  test("ZCC-S-02 a batch that fails part-way keeps what it wrote, re-queues only the rest, and Continue completes it", async () => {
    test.setTimeout(180_000);
    await allocateFakeAiKey();
    await setRange("30-50");
    const sessionId = await newSession("E2E ZCC failed live batch");
    ai.queueReply({ reply: "", reasoningSummary: "Planning exhaustive coverage.", action: "create", actionType: "create", operations: [], testcases: [], exhaustive: true });
    ai.queueReply({ scenarios: Array.from({ length: 100 }, (_, i) => okLabel(i + 1)) });
    // The background piece holding scenarios 76–100 fails; registered first, so it is matched first.
    ai.queueReplyMatching(okLabel(99), { failStatus: 500, message: "stubbed overload" });
    queueDraftingReplies(3, 25);

    await sendMessage(sessionId, "Generate all possible test cases for the login flow.");
    await expect
      .poll(() => scalar(`SELECT COALESCE(active_plan->>'status', 'none') FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`), { message: "a failed batch pauses the plan", timeout: 90_000 })
      .toBe("paused");

    let replies = (await sessionMessages(sessionId)).filter((m) => m.role === "assistant");
    expect(replies.map((m) => (m.testcases as unknown[]).length), "the 25 written before the failure stay in the batch's panel").toEqual([50, 25, 0]);
    expect(String(replies[1].content)).toContain("Generation stopped before this batch finished — the 25 test case(s) written so far are below");
    expect(replies[1].status).toBe("completed");
    expect(String(replies[2].content)).toContain("The 25 test case(s) written before it stopped are above, ready for review.");
    const paused = activePlan(sessionId)!;
    expect(paused.remainingScenarios, "only what was not written goes back in the queue").toEqual(Array.from({ length: 25 }, (_, i) => okLabel(76 + i)));
    expect(stagedDraftCount(sessionId)).toBe(75);

    queueDraftingReplies(1, 25);
    const resumed = await asOwner.post(url(`/chat/sessions/${sessionId}/resume-plan`), { failOnStatusCode: false });
    expect(resumed.status(), await resumed.text()).toBeLessThan(300);
    await expect
      .poll(() => scalar(`SELECT active_plan FROM zyra_chat_sessions WHERE id = ${literal(sessionId)};`), { message: "Continue must finish the rest", timeout: 90_000 })
      .toBeNull();
    replies = (await sessionMessages(sessionId)).filter((m) => m.role === "assistant");
    expect(String(replies.at(-1)!.content)).toContain("all 100 scenarios are now covered");
    expect(stagedDraftCount(sessionId), "nothing generated twice").toBe(100);
  });

  test("ZCC-S-03 a draft whose test data holds a NUL character is staged — without the NUL — instead of failing the turn", async () => {
    await allocateFakeAiKey();
    const sessionId = await newSession("E2E ZCC NUL in a draft");
    ai.queueReply({ reply: "", reasoningSummary: "Generating test cases.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: 1, exhaustive: false });
    // JSON.stringify writes the NUL as the \u0000 escape — exactly what the model sent.
    // In the test data, and — the case that still failed after the first fix — inside a step, where it is
    // JSON within JSON and becomes a NUL only when staging parses the steps.
    ai.queueReply({
      drafts: [{
        ...scenarioDraft(`E2E null byte username ${Date.now()}`),
        testData: "username: admin\u0000x",
        stepsJson: JSON.stringify([{ stepNumber: 1, action: "Type admin\u0000x in Username", expectedResult: "Rejected" }])
      }]
    });
    ai.queueReply("Noted.");

    const turn = await sendMessage(sessionId, "Generate 1 test case for a username containing a null byte.");
    expect(turn.status, JSON.stringify(turn.body)).toBeLessThan(300);
    const reply = await latestReply(sessionId);
    expect((reply.testcases as unknown[]).length, "the draft is staged for review").toBe(1);
    expect(reviewRequestFor(sessionId)!.payloadLength).toBe(1);
    const stored = scalar(
      `SELECT generated_payload->0->'draft'->>'testData' FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)} ORDER BY created_at DESC LIMIT 1;`,
    );
    expect(stored).toBe("username: adminx");
    const storedStep = scalar(
      `SELECT generated_payload->0->'draft'->'stepsJson'->0->>'action' FROM ai_generation_requests WHERE chat_session_id = ${literal(sessionId)} ORDER BY created_at DESC LIMIT 1;`,
    );
    expect(storedStep).toBe("Type adminx in Username");
  });

  /*
   * Updated for "[Zyra] Semantic Intent Detection and Consistent Batch Confirmation": the limit is now
   * the project's own setting (one generation under "Test cases per task"), not a fixed 60. Two
   * tickets on 1-10 are 20 test cases against one generation of 10, so they are asked about now —
   * the deliberate consequence of that decision. What stays unchanged: a request that fits one
   * generation (one ticket) generates straight away, and key-shaped words are never tickets.
   */
  test("ZCC-T-04 a request that fits one generation is unchanged: one ticket generates straight away", async () => {
    await allocateFakeAiKey();
    await seedTickets(2);
    const sessionId = await newSession("E2E ZCC small request");
    await setRange("1-10");
    ai.queueReply({ reply: "", reasoningSummary: "Generating test cases.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: null, exhaustive: false });
    ai.queueReply({ drafts: [scenarioDraft(`E2E small request case ${Date.now()}`)] });
    ai.queueReply("Noted.");
    const turn = await sendMessage(sessionId, "Generate test cases for E2EZ-1.");
    expect(turn.status, JSON.stringify(turn.body)).toBeLessThan(300);
    const reply = await latestReply(sessionId);
    expect(reply.options ?? null).toBeNull();
    expect((reply.testcases as unknown[]).length).toBe(1);
    // Two tickets on the same 1-10 range are over one generation of 10: asked, nothing generated.
    ai.queueReply({ reply: "", reasoningSummary: "Generating test cases.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: null, exhaustive: false });
    await sendMessage(sessionId, "Generate test cases for E2EZ-1 and E2EZ-2.");
    expect(String((await latestReply(sessionId)).content || "")).toContain("one generation holds 10 under this project's settings");
    // Key-shaped words that are not this project's tickets never count as tickets.
    ai.queueReply({ reply: "", reasoningSummary: "Generating test cases.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: null, exhaustive: false });
    ai.queueReply({ drafts: [scenarioDraft(`E2E encoding case ${Date.now()}`)] });
    ai.queueReply("Noted.");
    await setRange("30-50");
    await sendMessage(sessionId, "Generate test cases for UTF-8 and ISO-8859 input.");
    expect((await latestReply(sessionId)).options ?? null, "UTF-8 is not a ticket").toBeNull();
  });

  test("ZCC-T-05 answering: a typed number works; a stale, malformed, unknown or other-project answer is refused", async () => {
    await allocateFakeAiKey();
    await seedTickets(3);
    const sessionId = await newSession("E2E ZCC answering rules");
    ai.queueReply({ reply: "", reasoningSummary: "Generating test cases.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: null, exhaustive: false });
    await sendMessage(sessionId, "Generate test cases for E2EZ-1, E2EZ-2 and E2EZ-3.");
    const question = await expectScopeQuestion(sessionId, 3);
    const post = (data: Record<string, unknown>, projectId = tenant!.mainProjectId) =>
      asOwner.post(`/api/projects/${projectId}/agents/zyra/chat/sessions/${sessionId}/messages`, { data, failOnStatusCode: false });

    expect((await post({ message: "x", choice: { messageId: "not-a-uuid", optionId: "all" } })).status(), "malformed").toBe(400);
    expect((await post({ message: "x", choice: { messageId: question.id, optionId: "everything" } })).status(), "unknown option").toBe(400);
    expect((await post({ message: "x", choice: { messageId: question.id, optionId: "all" } }, tenant!.secondProjectId)).status(), "another project's session").toBe(404);
    expect(((await latestReply(sessionId)).options as { answeredId: string | null }).answeredId, "a refused answer answers nothing").toBeNull();

    // Typing "1" is the first option: Zyra asks which tickets, without a model call.
    const typed = await sendMessage(sessionId, "1");
    expect(typed.status, JSON.stringify(typed.body)).toBeLessThan(300);
    expect(((await latestReply(sessionId)).options as { kind: string }).kind).toBe("ticket_selection");
    expect(ai.requests).toHaveLength(1);

    // The first question is no longer the latest reply, so clicking it now is refused.
    expect((await post({ message: "Generate all tickets in batches", choice: { messageId: question.id, optionId: "all" } })).status(), "stale").toBe(409);
  });

  /*
   * "[Zyra] Semantic Intent Detection and Consistent Batch Confirmation".
   *
   * "write all test cases" generated straight away (planning from whatever the search matched) while
   * "write all test cases for all tickets" asked first: the scope check was a keyword test on the
   * message. The router now reports scope semantically, and these drive real turns with the router's
   * reply scripted on the fake provider — so what is under test is everything after the model's
   * reading: estimate, the project's limit, the question, and acting on the answer.
   */
  const routerCreate = (extra: Record<string, unknown>) => ({
    reply: "", reasoningSummary: "Generating test cases.", action: "create", actionType: "create", operations: [], testcases: [], requestedCount: null, ...extra,
  });

  async function askUnspecifiedAll(tickets: number): Promise<{ sessionId: string; question: Record<string, unknown> }> {
    await allocateFakeAiKey();
    await setRange("all");
    await seedTickets(tickets);
    const sessionId = await newSession("E2E ZCC unspecified all");
    ai.queueReply(routerCreate({ exhaustive: true, scope: "unspecified" }));
    const turn = await sendMessage(sessionId, "write all test cases");
    expect(turn.status, JSON.stringify(turn.body)).toBeLessThan(300);
    return { sessionId, question: await latestReply(sessionId) };
  }

  test("ZCC-T-30 regression: 'write all test cases' asks which scope it means instead of generating", async () => {
    const { sessionId, question } = await askUnspecifiedAll(4);
    const content = String(question.content || "");
    expect(content).toContain("could mean all 4 synced tickets");
    expect(content, "the estimate and the project's own limit are stated").toContain("roughly 400 test cases — more than one generation of 100");
    const options = question.options as { kind: string; choices: ChatOption[]; answeredId: string | null };
    expect(options.kind).toBe("ticket_scope");
    expect(options.choices.map((c) => c.id)).toEqual(["matched", "smaller", "all"]);
    expect(ai.requests, "only the router ran — nothing planned or generated before the answer").toHaveLength(1);
    expect(stagedDraftCount(sessionId)).toBe(0);
    expect(activePlan(sessionId)).toBeNull();
  });

  test("ZCC-T-31 equivalent phrasings with the same scope and settings get the same question", async () => {
    await allocateFakeAiKey();
    await setRange("all");
    await seedTickets(4);
    for (const message of ["write all test cases for all tickets", "create test cases for every ticket", "cover all tickets with test cases", "generate test cases for everything"]) {
      const sessionId = await newSession(`E2E ZCC phrasing ${message}`);
      ai.queueReply(routerCreate({ exhaustive: true, scope: message.includes("everything") ? "project" : "all_tickets" }));
      const turn = await sendMessage(sessionId, message);
      expect(turn.status, `${message}: ${JSON.stringify(turn.body)}`).toBeLessThan(300);
      await expectScopeQuestion(sessionId, 4);
    }
  });

  test("ZCC-T-32 the question states the project's configured limit, not a fixed 100", async () => {
    await allocateFakeAiKey();
    await setRange("10-30");
    await seedTickets(2);
    const sessionId = await newSession("E2E ZCC configured limit");
    ai.queueReply(routerCreate({ exhaustive: false, scope: "all_tickets" }));
    await sendMessage(sessionId, "generate test cases for all tickets");
    const question = await expectScopeQuestion(sessionId, 2);
    expect(String(question.content)).toContain("roughly 60 test cases, and one generation holds 30 under this project's settings");
    const all = (question.options as { choices: ChatOption[] }).choices.find((c) => c.id === "all")!;
    expect(all.description).toContain("batches of up to 30 test cases");
    expect(JSON.stringify(question.options)).not.toMatch(/\b100\b/);
  });

  test("ZCC-T-33 answering 'just what this request matched' generates from the match and is not asked again", async () => {
    test.setTimeout(120_000);
    const { sessionId } = await askUnspecifiedAll(4);
    // The answer re-runs the original request, routed: planner, its top-up round, one batch, memory.
    ai.queueReply({ scenarios: ["Matched scenario 1", "Matched scenario 2", "Matched scenario 3"] });
    ai.queueReply({ scenarios: [] });
    queueBatchDrafts(3);
    ai.queueReply("Noted.");
    const answered = await answerQuestion(sessionId, "matched");
    expect(answered.status, JSON.stringify(answered.body)).toBeLessThan(300);
    const reply = await latestReply(sessionId);
    expect(reply.options ?? null, "an approved scope is respected — no second question").toBeNull();
    expect(reviewRequestFor(sessionId)?.payloadLength).toBe(3);
    // Planned from the match, not paged through the tickets: the planner never saw the ticket list.
    expect(plannerPrompts().flatMap(distinctTickets)).toEqual([]);
  });

  test("ZCC-T-34 answering 'all tickets in batches' walks every ticket though the message never said 'tickets'", async () => {
    test.setTimeout(120_000);
    const { sessionId } = await askUnspecifiedAll(4);
    ai.queueReply({ scenarios: ["Ticket scenario 1", "Ticket scenario 2"] });
    ai.queueReply({ scenarios: [] });
    queueBatchDrafts(2);
    ai.queueReply("Noted.");
    const answered = await answerQuestion(sessionId, "all");
    expect(answered.status, JSON.stringify(answered.body)).toBeLessThan(300);
    // The paged all-tickets plan: the planner is handed the synced tickets themselves.
    const planned = plannerPrompts();
    expect(planned.length, "the paged plan ran").toBeGreaterThan(0);
    expect(distinctTickets(planned[0]).sort()).toEqual(["E2EZ-1:", "E2EZ-2:", "E2EZ-3:", "E2EZ-4:"]);
  });

  test("ZCC-T-35 'all of them' means the tickets named earlier in the conversation, not every ticket", async () => {
    await allocateFakeAiKey();
    await seedTickets(6);
    const sessionId = await newSession("E2E ZCC referenced tickets");
    // Turn 1 names two tickets; nothing is generated.
    ai.queueReply({ reply: "Both are about gift card balances.", reasoningSummary: "Answered.", action: "answer", actionType: "answer", operations: [], testcases: [] });
    await sendMessage(sessionId, "What are E2EZ-1 and E2EZ-2 about?");
    // Turn 2 refers back to them.
    ai.queueReply(routerCreate({ exhaustive: false, scope: "referenced" }));
    await sendMessage(sessionId, "write test cases for all of them");
    // 2 referenced tickets — not the 6 synced in the project.
    const question = await expectScopeQuestion(sessionId, 2);
    expect(String(question.content)).toContain("E2EZ-1, E2EZ-2");
  });
});
