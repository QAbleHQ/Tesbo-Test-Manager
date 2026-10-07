import { LegacyService } from "./legacy.service";
import { clipNotificationTitle, NOTIFICATION_PRIORITY, notificationLinks, notificationMessages, runLabel } from "./notification-events";
import type { DatabaseService } from "../database/database.service";

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const ACTOR = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const THIRD = "00000000-0000-4000-8000-0000000000a3";
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";

function makeLegacy(): { svc: LegacyService; dbQuery: jest.Mock } {
  const dbQuery = jest.fn();
  const db = { query: dbQuery } as unknown as DatabaseService;
  // Only `db` is touched by notifyUsers; every other collaborator is irrelevant here.
  const none = {} as never;
  const svc = new LegacyService(db, none, none, none, none, none, none, none, none, none, none, none, none, none, none, none, none, none);
  return { svc, dbQuery };
}

describe("notification matrix wording (exact messages from the product matrix)", () => {
  it("renders every Phase 1 message", () => {
    expect(notificationMessages.workspaceInvitation("Acme")).toBe("You've been invited to join Acme.");
    expect(notificationMessages.workspaceInvitationAccepted("Ann", "Acme")).toBe("Ann accepted your invitation to Acme.");
    expect(notificationMessages.workspaceRoleChanged("Acme", "qa_engineer")).toBe("Your role in Acme has been changed to QA Engineer.");
    expect(notificationMessages.workspaceRemoved("Acme")).toBe("You have been removed from Acme.");
    expect(notificationMessages.projectInvitation("Apollo")).toBe("You've been invited to join Apollo.");
    expect(notificationMessages.projectInvitationAccepted("Ann", "Apollo")).toBe("Ann accepted your invitation to Apollo.");
    expect(notificationMessages.projectRemoved("Apollo")).toBe("You have been removed from Apollo.");
    expect(notificationMessages.projectRoleChanged("Apollo", "manager")).toBe("Your role in Apollo has been changed to Manager.");
    expect(notificationMessages.testRunAssigned("Sprint 4")).toBe("You've been assigned to test run Sprint 4.");
    expect(notificationMessages.testCaseFailed("TC-7", "Sprint 4")).toBe("TC-7 failed in test run Sprint 4.");
    expect(notificationMessages.testCaseBlocked("TC-7", "Sprint 4")).toBe("TC-7 is blocked in test run Sprint 4.");
    expect(notificationMessages.testCaseStatusChanged("TC-7", "Passed", "Sprint 4")).toBe("TC-7 status changed to Passed in test run Sprint 4.");
    expect(notificationMessages.testCasesStatusChangedBulk(3, "Passed", "Sprint 4")).toBe("3 of your test cases in test run Sprint 4 were marked Passed.");
    expect(notificationMessages.commentReplied("Ann")).toBe("Ann replied to your comment.");
    expect(notificationLinks.knowledgeDocument(PROJECT_ID, "d1")).toEqual({ linkEntityType: "knowledge_document", linkEntityId: `${PROJECT_ID}:d1` });
    expect(notificationMessages.bugAssigned("BUG-3")).toBe("Bug BUG-3 has been assigned to you.");
    expect(notificationMessages.bugReassigned("BUG-3")).toBe("Bug BUG-3 has been reassigned to you.");
    expect(notificationMessages.bugStatusChanged("BUG-3", "Closed")).toBe("Bug BUG-3 status changed to Closed.");
    expect(notificationMessages.bugMentioned("Ann", "BUG-3")).toBe("Ann mentioned you on bug BUG-3.");
  });

  it("names a run by its ID when it has one, and by name alone when it does not", () => {
    expect(runLabel("Sprint 4", "TR-12")).toBe("TR-12 (Sprint 4)");
    expect(runLabel("Sprint 4", null)).toBe("Sprint 4");
    expect(runLabel("Sprint 4", "  ")).toBe("Sprint 4");
    expect(runLabel("Sprint 4")).toBe("Sprint 4");
    expect(notificationMessages.testRunAssigned(runLabel("Sprint 4", "TR-12"))).toBe("You've been assigned to test run TR-12 (Sprint 4).");
    expect(notificationMessages.testCaseFailed("TC-7", runLabel("Sprint 4", "TR-12"))).toBe("TC-7 failed in test run TR-12 (Sprint 4).");
  });

  it("keeps the matrix priorities as metadata", () => {
    expect(NOTIFICATION_PRIORITY.workspace_invitation_accepted).toBe("Medium");
    expect(NOTIFICATION_PRIORITY.project_invitation_accepted).toBe("Medium");
    expect(NOTIFICATION_PRIORITY.bug_status_changed).toBe("Medium");
    expect(NOTIFICATION_PRIORITY.bug_assigned).toBe("High");
    expect(NOTIFICATION_PRIORITY.test_case_failed).toBe("High");
  });

  it("clips a title to the VARCHAR(255) column", () => {
    expect(clipNotificationTitle("short")).toBe("short");
    const clipped = clipNotificationTitle("x".repeat(400));
    expect(clipped).toHaveLength(255);
    expect(clipped.endsWith("…")).toBe(true);
  });

  it("encodes project-scoped links as <projectId>:<entityId>", () => {
    expect(notificationLinks.bug(PROJECT_ID, "b1")).toEqual({ linkEntityType: "bug", linkEntityId: `${PROJECT_ID}:b1` });
    expect(notificationLinks.testRun(PROJECT_ID, "c1")).toEqual({ linkEntityType: "test_run", linkEntityId: `${PROJECT_ID}:c1` });
    expect(notificationLinks.project(PROJECT_ID).linkEntityType).toBe("project");
  });
});

describe("notifyUsers", () => {
  it("never notifies the actor, de-duplicates, and drops null / non-uuid ids", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [{ id: "n1" }] });
    const rows = await svc.notifyUsers([ACTOR, OTHER, OTHER, null, undefined, "not-a-uuid"], {
      type: "bug_assigned",
      title: "Bug BUG-1 has been assigned to you.",
      actorId: ACTOR
    });
    expect(rows).toBe(1);
    expect(dbQuery.mock.calls[0][1][0]).toEqual([OTHER]);
  });

  it("writes nothing (and does not query) when the actor is the only recipient", async () => {
    const { svc, dbQuery } = makeLegacy();
    expect(await svc.notifyUsers([ACTOR], { type: "bug_assigned", title: "t", actorId: ACTOR })).toBe(0);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("scopes recipients to the workspace / project and reuses the dedupe index", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [] });
    await svc.notifyUsers([OTHER, THIRD], {
      type: "test_case_failed",
      title: "t",
      dedupeKey: "k1",
      memberOf: { organizationId: ORG_ID, projectId: PROJECT_ID }
    });
    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toContain("organization_members");
    expect(sql).toContain("project_members");
    expect(sql).toContain("ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING");
    expect(params).toContain(ORG_ID);
    expect(params).toContain(PROJECT_ID);
    expect(params).toContain("k1");
  });

  it("omits the membership clauses when no scope is given (removal / invitation)", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [{ id: "n1" }] });
    await svc.notifyUsers([OTHER], { type: "project_removed", title: "t" });
    expect(dbQuery.mock.calls[0][0]).not.toContain("organization_members");
    expect(dbQuery.mock.calls[0][0]).not.toContain("project_members");
  });

  it("swallows a database failure so the triggering action is never broken", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockRejectedValueOnce(new Error("connection lost"));
    await expect(svc.notifyUsers([OTHER], { type: "bug_assigned", title: "t" })).resolves.toBe(0);
  });
});

describe("Phase 2 wording (Zyra, Knowledge Base, integrations)", () => {
  it("renders the matrix messages", () => {
    expect(notificationMessages.zyraGenerationReady()).toBe("Zyra-generated test cases are ready for your review.");
    expect(notificationMessages.zyraGenerationFailed()).toBe("Zyra could not generate the requested test cases.");
    expect(notificationMessages.zyraTaskFailed()).toBe("Zyra task failed. Please retry or review the details.");
    expect(notificationMessages.zyraReviewCompleted()).toBe("Review completed for Zyra-generated test cases.");
    expect(notificationMessages.kbDocumentReady("Spec.pdf")).toBe("Spec.pdf is ready to use with Zyra.");
    expect(notificationMessages.kbDocumentFailed("Spec.pdf")).toBe("We couldn't process Spec.pdf.");
    expect(notificationMessages.kbDocumentUpdated("Spec")).toBe("Spec has been updated.");
    expect(notificationMessages.kbDocumentDeleted("Spec")).toBe("Spec has been deleted from the Knowledge Base.");
    expect(notificationMessages.integrationConnected("jira")).toBe("Jira has been connected successfully.");
    expect(notificationMessages.integrationDisconnected("linear")).toBe("Linear has been disconnected.");
    expect(notificationMessages.integrationAuthExpired("notion")).toBe("Your Notion connection needs to be reconnected.");
    expect(notificationMessages.integrationSyncCompleted("jira", "Project 1")).toBe("Jira sync completed successfully for Project 1.");
    expect(notificationMessages.integrationSyncFailed("linear", "Project 1")).toBe("Linear sync failed for Project 1. Please review the connection.");
    expect(notificationMessages.integrationIssueLinked("PRJ-12")).toBe("PRJ-12 has been linked successfully.");
  });

  it("keeps the matrix priorities for the new types", () => {
    expect(NOTIFICATION_PRIORITY.kb_document_updated).toBe("Low");
    expect(NOTIFICATION_PRIORITY.integration_sync_completed).toBe("Low");
    expect(NOTIFICATION_PRIORITY.integration_sync_failed).toBe("High");
    expect(NOTIFICATION_PRIORITY.zyra_generation_ready).toBe("High");
    expect(NOTIFICATION_PRIORITY.integration_connected).toBe("Medium");
  });
});

describe("notifyZyraTask", () => {
  const notifyZyraTask = (svc: LegacyService, ...args: unknown[]) =>
    (svc as unknown as { notifyZyraTask: (...a: unknown[]) => Promise<void> }).notifyZyraTask(...args);

  it("tells the requester, with the matching type and a link to the task", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [{ requested_by: OTHER }] }).mockResolvedValueOnce({ rows: [{ id: "n1" }] });
    await notifyZyraTask(svc, PROJECT_ID, "task-1", "failed");
    const [, params] = dbQuery.mock.calls[1];
    expect(params[0]).toEqual([OTHER]);
    expect(params[1]).toBe("zyra_generation_failed");
    expect(params[2]).toBe("Zyra could not generate the requested test cases.");
    expect(params[4]).toBe(`${PROJECT_ID}:task-1`);
  });

  it("notifies nobody for a task with no requester (the archive sweep's rows)", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [{ requested_by: null }] });
    await notifyZyraTask(svc, PROJECT_ID, "task-1", "ready");
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it("does not tell the reviewer about their own review", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [{ requested_by: ACTOR }] });
    await notifyZyraTask(svc, PROJECT_ID, "task-1", "reviewed", ACTOR);
    expect(dbQuery).toHaveBeenCalledTimes(1); // the requester lookup only; the insert is skipped
  });
});
