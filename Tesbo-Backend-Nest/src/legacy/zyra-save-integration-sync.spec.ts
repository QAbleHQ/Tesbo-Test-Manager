import { LegacyService } from "./legacy.service";
import type { DatabaseService } from "../database/database.service";
import type { EmailService } from "../auth/email.service";
import type { PasswordService } from "../auth/password.service";
import type { AppConfigService } from "../config/app-config.service";
import type { StorageService } from "../storage/storage.service";
import type { RagIngestionService } from "../rag/rag-ingestion.service";
import type { RagRetrievalService } from "../rag/rag-retrieval.service";
import type { IntegrationSyncService } from "../integration-sync/integration-sync.service";
import type { ApiTokenService } from "../auth/api-token.service";
import type { PlanLimitsService } from "../plan-limits/plan-limits.service";
import type { CustomFieldsService } from "../custom-fields/custom-fields.service";
import type { CustomTagsService } from "../custom-tags/custom-tags.service";
import type { RequestCacheService } from "../request-cache/request-cache.service";
import type { ProjectLookupService } from "../request-cache/project-lookup.service";
import type { KbExtractionRunnerService } from "./kb-extraction-runner.service";
import type { SuitesCacheService } from "../cache/suites-cache.service";
import type { TestcasesListCacheService } from "../cache/testcases-list-cache.service";
import type { ProjectOverviewCacheService } from "../cache/project-overview-cache.service";

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/*
 * zyraSave()'s post-commit ticket auto-comment (queueZyraTicketComments and deliverZyraTicketComment
 * in legacy.service.ts): the setting gate, the connection check, the idempotency claim in
 * integration_ticket_comments, and the background delivery.
 *
 * zyraSaveAttempt() itself (the transaction) is mocked at its result, as before — this file tests
 * what zyraSave does with an already-committed save, not the save. db.query is answered by SQL so
 * the claim INSERT and the status UPDATEs are observable; the provider calls are mocked at
 * jiraPostComment/linearPostComment, the boundary where Tesbo stops and Jira/Linear begin.
 */

type Body = Record<string, any>;
type Call = { sql: string; params: unknown[] };

function makeLegacy(options: { claimTaken?: boolean } = {}): { svc: LegacyService; calls: Call[] } {
  const calls: Call[] = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/INSERT INTO integration_ticket_comments/.test(sql)) {
      return { rows: options.claimTaken ? [] : [{ id: `claim-${calls.length}` }] };
    }
    return { rows: [] };
  });
  const db = { query } as unknown as DatabaseService;
  const ragIngestion = { enqueueTestcaseEmbedding: jest.fn().mockResolvedValue(undefined) } as unknown as RagIngestionService;
  const svc = new LegacyService(
    db,
    {} as unknown as EmailService,
    {} as unknown as PasswordService,
    { frontendUrl: "https://app.example.com" } as unknown as AppConfigService,
    {} as unknown as StorageService,
    ragIngestion,
    {} as unknown as RagRetrievalService,
    {} as unknown as IntegrationSyncService,
    {} as unknown as ApiTokenService,
    {} as unknown as PlanLimitsService,
    {} as unknown as RequestCacheService,
    {} as unknown as ProjectLookupService,
    {} as unknown as KbExtractionRunnerService,
    { invalidate: jest.fn().mockResolvedValue(undefined) } as unknown as SuitesCacheService,
    { invalidate: jest.fn().mockResolvedValue(undefined) } as unknown as TestcasesListCacheService,
    {} as unknown as ProjectOverviewCacheService,
    {} as unknown as CustomFieldsService,
    {} as unknown as CustomTagsService
  );
  // zyraSave() authorizes before anything this file is about — bypassed, as before; auth has its own coverage.
  jest.spyOn(svc as unknown as { requireProjectAccess: (...a: unknown[]) => Promise<unknown> }, "requireProjectAccess").mockResolvedValue({});
  return { svc, calls };
}

type Internals = {
  zyraSaveAttempt: (...a: unknown[]) => Promise<Body>;
  getJiraConnection: (...a: unknown[]) => Promise<Body | null>;
  getIntegrationConnection: (...a: unknown[]) => Promise<Body | null>;
  projectOrganizationId: (...a: unknown[]) => Promise<string>;
  jiraPostComment: (...a: unknown[]) => Promise<string | null>;
  linearPostComment: (...a: unknown[]) => Promise<string | null>;
};

function arrange(svc: LegacyService, fields: { result: Body; settings?: Body; jiraConnected?: boolean; linearConnected?: boolean }) {
  const s = svc as unknown as Internals;
  jest.spyOn(s, "zyraSaveAttempt").mockResolvedValue(fields.result);
  jest.spyOn(svc, "getProject").mockResolvedValue({ id: PROJECT_ID, settings: fields.settings ?? {} } as never);
  jest.spyOn(s, "getJiraConnection").mockResolvedValue(fields.jiraConnected === false ? null : { id: "conn-jira" });
  jest.spyOn(s, "projectOrganizationId").mockResolvedValue("org-1");
  jest.spyOn(s, "getIntegrationConnection").mockResolvedValue(fields.linearConnected === false ? null : { id: "conn-linear" });
  const jiraPost = jest.spyOn(s, "jiraPostComment").mockResolvedValue("10001");
  const linearPost = jest.spyOn(s, "linearPostComment").mockResolvedValue("lin-1");
  return { jiraPost, linearPost };
}

/** Lets the background delivery (fire-and-forget after the claim) run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

function claims(calls: Call[]): Call[] {
  return calls.filter((c) => /INSERT INTO integration_ticket_comments/.test(c.sql));
}

function statusUpdates(calls: Call[]): Call[] {
  return calls.filter((c) => /UPDATE integration_ticket_comments/.test(c.sql));
}

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const TASK_ID = "00000000-0000-4000-8000-000000000002";
const SAVE_EVENT_ID = "00000000-0000-4000-8000-000000000003";

const CREATED_ROW = { id: "tc-new", externalId: "EAD-TC-1", title: "New login test", jiraIssueKey: "EAD-11215", linearIssueKey: null };
const UPDATED_ROW = { id: "tc-1", externalId: "EAD-TC-2", title: "Updated login test", jiraIssueKey: "EAD-11215", linearIssueKey: null };
const NO_LINK_ROW = { id: "tc-3", externalId: "EAD-TC-4", title: "Unlinked test", jiraIssueKey: null, linearIssueKey: null };
const LINEAR_ROW = { id: "tc-4", externalId: "EAD-TC-5", title: "Linear-linked test", jiraIssueKey: null, linearIssueKey: "ENG-42" };

function saved(testcases: Body[], touchedActions: string[]): Body {
  return { savedCount: testcases.length, suiteId: null, testcases, touchedActions, saveEventId: SAVE_EVENT_ID, remaining: 0 };
}

describe("zyraSave — ticket auto-comment", () => {
  afterEach(() => jest.restoreAllMocks());

  it("setting on + connected: claims once and posts ONE comment listing exactly this save's rows for the ticket", async () => {
    const { svc, calls } = makeLegacy();
    const { jiraPost } = arrange(svc, {
      result: saved([CREATED_ROW, UPDATED_ROW, NO_LINK_ROW], ["add", "update", "add"]),
      settings: { jiraAutoComment: true }
    });

    await svc.zyraSave(PROJECT_ID, "u1", TASK_ID, {});
    await settle();

    expect(claims(calls)).toHaveLength(1);
    const [projectId, taskId, saveEventId, provider, issueKey, testcaseIds, status, commentText, postedBy] = claims(calls)[0].params as string[];
    expect([projectId, taskId, saveEventId, provider, issueKey, status, postedBy]).toEqual([PROJECT_ID, TASK_ID, SAVE_EVENT_ID, "jira", "EAD-11215", "pending", "u1"]);
    expect(JSON.parse(testcaseIds)).toEqual(["tc-new", "tc-1"]);
    expect(commentText).toContain("Generated by Tesbo Test Manager");
    expect(commentText).toContain(CREATED_ROW.title);
    expect(commentText).toContain(UPDATED_ROW.title);
    expect(commentText).not.toContain(NO_LINK_ROW.title);

    expect(jiraPost).toHaveBeenCalledTimes(1);
    expect(jiraPost.mock.calls[0][1]).toBe("EAD-11215");
    expect(jiraPost.mock.calls[0][2]).toMatchObject({ type: "doc", version: 1 });
    const updates = statusUpdates(calls);
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain("status = 'posted'");
    expect(updates[0].params[1]).toBe("10001");
  });

  it("setting off: the save completes and the ledger says skipped_disabled — nothing is posted", async () => {
    const { svc, calls } = makeLegacy();
    const { jiraPost } = arrange(svc, { result: saved([CREATED_ROW], ["add"]), settings: { jiraAutoComment: false } });

    const result = await svc.zyraSave(PROJECT_ID, "u1", TASK_ID, {});
    await settle();

    expect(result.savedCount).toBe(1);
    expect(claims(calls).map((c) => c.params[6])).toEqual(["skipped_disabled"]);
    expect(jiraPost).not.toHaveBeenCalled();
  });

  it("the setting has to be literally true — a missing key means off", async () => {
    const { svc, calls } = makeLegacy();
    const { jiraPost } = arrange(svc, { result: saved([CREATED_ROW], ["add"]), settings: {} });

    await svc.zyraSave(PROJECT_ID, "u1", TASK_ID, {});
    await settle();

    expect(claims(calls).map((c) => c.params[6])).toEqual(["skipped_disabled"]);
    expect(jiraPost).not.toHaveBeenCalled();
  });

  it("setting on but Jira not connected: skipped_not_connected, nothing posted", async () => {
    const { svc, calls } = makeLegacy();
    const { jiraPost } = arrange(svc, { result: saved([CREATED_ROW], ["add"]), settings: { jiraAutoComment: true }, jiraConnected: false });

    await svc.zyraSave(PROJECT_ID, "u1", TASK_ID, {});
    await settle();

    expect(claims(calls).map((c) => c.params[6])).toEqual(["skipped_not_connected"]);
    expect(jiraPost).not.toHaveBeenCalled();
  });

  it("a save with no ticket-linked row records nothing and posts nothing", async () => {
    const { svc, calls } = makeLegacy();
    const { jiraPost, linearPost } = arrange(svc, { result: saved([NO_LINK_ROW], ["add"]), settings: { jiraAutoComment: true, linearAutoComment: true } });

    await svc.zyraSave(PROJECT_ID, "u1", TASK_ID, {});
    await settle();

    expect(claims(calls)).toHaveLength(0);
    expect(jiraPost).not.toHaveBeenCalled();
    expect(linearPost).not.toHaveBeenCalled();
  });

  it("an empty save (no saveEventId) never reaches the auto-comment", async () => {
    const { svc, calls } = makeLegacy();
    arrange(svc, { result: { savedCount: 0, suiteId: null, testcases: [] }, settings: { jiraAutoComment: true } });

    await svc.zyraSave(PROJECT_ID, "u1", TASK_ID, {});
    await settle();

    expect(claims(calls)).toHaveLength(0);
  });

  it("idempotent: when the claim for this save is already taken, nothing is posted again", async () => {
    const { svc, calls } = makeLegacy({ claimTaken: true });
    const { jiraPost } = arrange(svc, { result: saved([CREATED_ROW], ["add"]), settings: { jiraAutoComment: true } });

    await svc.zyraSave(PROJECT_ID, "u1", TASK_ID, {});
    await settle();

    expect(claims(calls)).toHaveLength(1);
    expect(claims(calls)[0].sql).toContain("ON CONFLICT (generation_request_id, save_event_id, provider, issue_key) DO NOTHING");
    expect(jiraPost).not.toHaveBeenCalled();
    expect(statusUpdates(calls)).toHaveLength(0);
  });

  it("a provider failure is recorded as failed with its reason, and the save still succeeds", async () => {
    const { svc, calls } = makeLegacy();
    const { jiraPost } = arrange(svc, { result: saved([UPDATED_ROW], ["update"]), settings: { jiraAutoComment: true } });
    jiraPost.mockRejectedValue(new Error("Jira request failed (403)."));

    const result = await svc.zyraSave(PROJECT_ID, "u1", TASK_ID, {});
    await settle();

    expect(result).toMatchObject({ savedCount: 1, remaining: 0 });
    const updates = statusUpdates(calls);
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain("status = 'failed'");
    expect(updates[0].params[1]).toBe("Jira request failed (403).");
  });

  it("an unexpected failure before the claim (project lookup) never reaches zyraSave's caller", async () => {
    const { svc } = makeLegacy();
    arrange(svc, { result: saved([CREATED_ROW], ["add"]), settings: { jiraAutoComment: true } });
    jest.spyOn(svc, "getProject").mockRejectedValue(new Error("db down"));

    const result = await svc.zyraSave(PROJECT_ID, "u1", TASK_ID, {});

    expect(result).toMatchObject({ savedCount: 1, remaining: 0 });
    expect(result.testcases).toEqual([CREATED_ROW]);
  });

  it("Linear follows the same rules, gated by linearAutoComment and posting markdown", async () => {
    const { svc, calls } = makeLegacy();
    const { linearPost, jiraPost } = arrange(svc, {
      result: saved([LINEAR_ROW, CREATED_ROW], ["add", "add"]),
      settings: { linearAutoComment: true, jiraAutoComment: false }
    });

    await svc.zyraSave(PROJECT_ID, "u1", TASK_ID, {});
    await settle();

    const byProvider = Object.fromEntries(claims(calls).map((c) => [c.params[3], c.params[6]]));
    expect(byProvider).toEqual({ linear: "pending", jira: "skipped_disabled" });
    expect(linearPost).toHaveBeenCalledTimes(1);
    expect(linearPost.mock.calls[0][1]).toBe("ENG-42");
    expect(String(linearPost.mock.calls[0][2])).toMatch(/^\*\*Generated by Tesbo Test Manager\*\*/);
    expect(String(linearPost.mock.calls[0][2])).toContain(LINEAR_ROW.title);
    expect(jiraPost).not.toHaveBeenCalled();
  });

  it("Linear off: skipped_disabled even when connected", async () => {
    const { svc, calls } = makeLegacy();
    const { linearPost } = arrange(svc, { result: saved([LINEAR_ROW], ["add"]), settings: { jiraAutoComment: true } });

    await svc.zyraSave(PROJECT_ID, "u1", TASK_ID, {});
    await settle();

    expect(claims(calls).map((c) => c.params[6])).toEqual(["skipped_disabled"]);
    expect(linearPost).not.toHaveBeenCalled();
  });

  it("strips touchedActions and saveEventId from the returned result — internal bookkeeping never reaches the API response", async () => {
    const { svc } = makeLegacy();
    arrange(svc, { result: saved([UPDATED_ROW], ["update"]), settings: {} });

    const result = await svc.zyraSave(PROJECT_ID, "u1", TASK_ID, {});

    expect(result).not.toHaveProperty("touchedActions");
    expect(result).not.toHaveProperty("saveEventId");
  });
});

describe("ticket comment failure reasons — 401 and 403 need different fixes", () => {
  afterEach(() => jest.restoreAllMocks());

  function authError(svc: LegacyService, status: number): Error {
    return (svc as unknown as { cleanAuthErrorOrNull: (p: string, s: number) => Error }).cleanAuthErrorOrNull("Jira", status);
  }

  it("a 403 is recorded as a permission problem, not as \"reconnect\"", async () => {
    const { svc, calls } = makeLegacy();
    const { jiraPost } = arrange(svc, { result: saved([CREATED_ROW], ["add"]), settings: { jiraAutoComment: true } });
    jiraPost.mockRejectedValue(authError(svc, 403));

    await svc.zyraSave(PROJECT_ID, "u1", TASK_ID, {});
    await settle();

    const reason = String(statusUpdates(calls)[0].params[1]);
    expect(reason).toContain("403");
    expect(reason).toMatch(/permission to comment/);
    expect(reason).not.toMatch(/expired/);
  });

  it("a 401 is recorded as expired or revoked credentials, with reconnect as the fix", async () => {
    const { svc, calls } = makeLegacy();
    const { jiraPost } = arrange(svc, { result: saved([CREATED_ROW], ["add"]), settings: { jiraAutoComment: true } });
    jiraPost.mockRejectedValue(authError(svc, 401));

    await svc.zyraSave(PROJECT_ID, "u1", TASK_ID, {});
    await settle();

    const reason = String(statusUpdates(calls)[0].params[1]);
    expect(reason).toContain("401");
    expect(reason).toMatch(/expired or been revoked/);
    expect(reason).toMatch(/Reconnect Jira/);
  });

  it("the status never leaks into an HTTP response body — every other Jira route keeps its message", () => {
    const { svc } = makeLegacy();
    const err = authError(svc, 403) as unknown as { getResponse: () => unknown; providerStatus: number };
    expect(err.providerStatus).toBe(403);
    expect(err.getResponse()).toEqual({ error: "Jira access needs to be reconnected — the authorization may have been revoked or expired." });
    expect(Object.keys(err)).not.toContain("providerStatus");
  });
});

describe("zyraRetryTicketComment — re-sending a failed comment", () => {
  afterEach(() => jest.restoreAllMocks());

  const COMMENT_ID = "00000000-0000-4000-8000-0000000000c1";
  const TC_ID = "00000000-0000-4000-8000-0000000000a1";
  const UPDATED_TC_ID = "00000000-0000-4000-8000-0000000000a2";

  function makeRetryLegacy(options: { claimed: boolean; existingStatus?: string; testcases?: Body[] }) {
    const calls: Call[] = [];
    const failedRow = {
      id: COMMENT_ID, provider: "jira", issue_key: "KAN-4", status: "pending", testcase_ids: [TC_ID, UPDATED_TC_ID],
      comment_text: `**Generated by Tesbo Test Manager**

**Added (1)**
- [T-1](https://app.example.com/projects/p/testcases/${TC_ID}) — Old

**Updated (1)**
- [T-2](https://app.example.com/projects/p/testcases/${UPDATED_TC_ID}) — Old 2`,
      reason: null, posted_at: null, created_at: "2026-09-24T00:00:00Z", updated_at: "2026-09-24T00:00:00Z"
    };
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/SET status = 'pending'/.test(sql)) return { rows: options.claimed ? [failedRow] : [] };
      if (/SELECT status FROM integration_ticket_comments/.test(sql)) return { rows: options.existingStatus ? [{ status: options.existingStatus }] : [] };
      if (/FROM testcases WHERE project_id/.test(sql)) return { rows: options.testcases ?? [] };
      if (sql.startsWith("SELECT * FROM integration_ticket_comments")) return { rows: [{ ...failedRow, status: "posted" }] };
      return { rows: [] };
    });
    const { svc } = makeLegacy();
    (svc as unknown as { db: unknown }).db = { query };
    const jiraPost = jest.spyOn(svc as unknown as Internals, "jiraPostComment").mockResolvedValue("10002");
    return { svc, calls, jiraPost };
  }

  it("claims only a failed row (failed -> pending), then posts the rebuilt comment with current titles and original sections", async () => {
    const { svc, calls, jiraPost } = makeRetryLegacy({
      claimed: true,
      testcases: [
        { id: TC_ID, external_id: "T-1", title: "Renamed since the save" },
        { id: UPDATED_TC_ID, external_id: "T-2", title: "Second case" }
      ]
    });

    const result = await svc.zyraRetryTicketComment(PROJECT_ID, "u2", TASK_ID, COMMENT_ID);

    const claim = calls.find((c) => /SET status = 'pending'/.test(c.sql))!;
    expect(claim.sql).toContain("AND status = 'failed'");
    expect(claim.params).toEqual([COMMENT_ID, PROJECT_ID, TASK_ID, "u2"]);
    expect(jiraPost).toHaveBeenCalledTimes(1);
    const text = JSON.stringify(jiraPost.mock.calls[0][2]);
    expect(text).toContain("Renamed since the save");
    expect(text).toContain("Added (1)");
    expect(text).toContain("Updated (1)");
    expect(result.status).toBe("posted");
  });

  it("a comment that is not failed is refused with 409 and nothing is posted", async () => {
    const { svc, jiraPost } = makeRetryLegacy({ claimed: false, existingStatus: "posted" });
    await expect(svc.zyraRetryTicketComment(PROJECT_ID, "u2", TASK_ID, COMMENT_ID)).rejects.toMatchObject({ status: 409 });
    expect(jiraPost).not.toHaveBeenCalled();
  });

  it("an unknown comment id is a 404", async () => {
    const { svc } = makeRetryLegacy({ claimed: false });
    await expect(svc.zyraRetryTicketComment(PROJECT_ID, "u2", TASK_ID, COMMENT_ID)).rejects.toMatchObject({ status: 404 });
    await expect(svc.zyraRetryTicketComment(PROJECT_ID, "u2", TASK_ID, "not-a-uuid")).rejects.toMatchObject({ status: 404 });
  });

  it("when every listed test case has been deleted, it fails again with that reason instead of posting an empty comment", async () => {
    const { svc, calls, jiraPost } = makeRetryLegacy({ claimed: true, testcases: [] });

    await svc.zyraRetryTicketComment(PROJECT_ID, "u2", TASK_ID, COMMENT_ID);

    expect(jiraPost).not.toHaveBeenCalled();
    const failed = calls.find((c) => /SET status = 'failed'/.test(c.sql))!;
    expect(String(failed.params[1])).toMatch(/None of the test cases/);
  });
});
