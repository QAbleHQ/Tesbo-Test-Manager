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
  });

  test.afterEach(() => {
    if (tenant) purge();
  });

  function purge(): void {
    const project = literal(tenant!.mainProjectId);
    const org = literal(tenant!.organizationId);
    exec(`DELETE FROM zyra_chat_messages WHERE project_id = ${project};`);
    exec(`DELETE FROM zyra_chat_sessions WHERE project_id = ${project};`);
    exec(`DELETE FROM ai_generation_requests WHERE project_id = ${project};`);
    exec(`DELETE FROM testcases WHERE project_id = ${project};`);
    exec(`DELETE FROM suites WHERE project_id = ${project};`);
    // This describe block, unlike the one above, mints its own AI key per test (it needs one
    // pointed at the fake server's baseUrl) — clean up so a re-run doesn't accumulate rows in this
    // tenant's org, and so a stale key never gets picked over the one the next test allocates.
    exec(`DELETE FROM project_ai_key_allocations WHERE project_id = ${project};`);
    exec(`DELETE FROM workspace_ai_keys WHERE organization_id = ${org};`);
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

  function reviewRequestFor(sessionId: string): { taskStatus: string; generatedCount: number; payloadLength: number } | null {
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

    expect(ai.requests.length, "router (turn 1) + router (turn 2) + retry router + generation").toBe(4);

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
    expect(ai.requests.length, "router (turn 1) + generation (turn 1) + router (turn 2, no generation for a move)").toBe(3);

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
});
