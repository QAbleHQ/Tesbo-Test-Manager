/**
 * The Phase 1 notification matrix: one entry per scenario, with the exact message wording from the
 * product's notification matrix and its High/Medium/Low priority.
 *
 * Priority is business metadata only. There is deliberately no `priority` column on `notifications`
 * (no migration was wanted for it), so it lives here, next to the wording it belongs to, and is
 * not persisted or returned by the API.
 */

export type NotificationPriority = "High" | "Medium" | "Low";

export type NotificationType =
  | "workspace_invitation"
  | "workspace_invitation_accepted"
  | "workspace_role_changed"
  | "workspace_removed"
  | "project_invitation"
  | "project_invitation_accepted"
  | "project_removed"
  | "project_role_changed"
  | "test_run_assigned"
  | "test_case_failed"
  | "test_case_blocked"
  | "test_case_status_changed"
  | "bug_assigned"
  | "bug_reassigned"
  | "bug_status_changed"
  | "bug_mentioned"
  | "comment_reply";

/**
 * Not implemented — the extension point for the integration notifications (connected, disconnected,
 * authentication expired, sync completed / failed, issue or page linked). They are provider-generic
 * on purpose: Jira, Linear and Notion all share the one set of event types and differ only in the
 * `provider` that fills the message, so adding Notion (as V133 added it to the integration tables)
 * is a new member of this union, not a new notification system. When they are built they add types
 * to NotificationType and message/link entries below, and go through LegacyService.notifyUsers like
 * every Phase 1 scenario; recipients are "connecting user / project admins", resolved at the call site.
 */
export type IntegrationProvider = "jira" | "linear" | "notion";

export const NOTIFICATION_PRIORITY: Record<NotificationType, NotificationPriority> = {
  workspace_invitation: "High",
  workspace_invitation_accepted: "Medium",
  workspace_role_changed: "High",
  workspace_removed: "High",
  project_invitation: "High",
  project_invitation_accepted: "Medium",
  project_removed: "High",
  project_role_changed: "High",
  test_run_assigned: "High",
  test_case_failed: "High",
  test_case_blocked: "High",
  // Not a row of the original matrix (which only names Failed / Blocked): added on request so an
  // assignee hears about any other status change on their case. Priority follows bug_status_changed.
  test_case_status_changed: "Medium",
  bug_assigned: "High",
  bug_reassigned: "High",
  bug_status_changed: "Medium",
  bug_mentioned: "High",
  // The matrix's Collaboration "Reply to comment" row.
  comment_reply: "Medium"
};

/** `notifications.title` is VARCHAR(255). */
const TITLE_MAX = 255;

export function clipNotificationTitle(message: string): string {
  return message.length <= TITLE_MAX ? message : `${message.slice(0, TITLE_MAX - 1)}…`;
}

const ROLE_LABELS: Record<string, string> = { owner: "Owner", manager: "Manager", qa_engineer: "QA Engineer" };

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

/**
 * How a test run is named in a message: "TR-12 (Sprint 4)" when it has an ID, just "Sprint 4" when
 * it does not. `cycles.external_id` is only set for runs created by automation ingest — a run made
 * in the UI has none — so the ID is shown where it exists rather than invented here.
 */
export function runLabel(name: string, externalId?: string | null): string {
  const id = (externalId ?? "").trim();
  return id ? `${id} (${name})` : name;
}

export const notificationMessages = {
  workspaceInvitation: (workspaceName: string) => `You've been invited to join ${workspaceName}.`,
  workspaceInvitationAccepted: (userName: string, workspaceName: string) => `${userName} accepted your invitation to ${workspaceName}.`,
  workspaceRoleChanged: (workspaceName: string, role: string) => `Your role in ${workspaceName} has been changed to ${roleLabel(role)}.`,
  workspaceRemoved: (workspaceName: string) => `You have been removed from ${workspaceName}.`,
  projectInvitation: (projectName: string) => `You've been invited to join ${projectName}.`,
  projectInvitationAccepted: (userName: string, projectName: string) => `${userName} accepted your invitation to ${projectName}.`,
  projectRemoved: (projectName: string) => `You have been removed from ${projectName}.`,
  projectRoleChanged: (projectName: string, role: string) => `Your role in ${projectName} has been changed to ${roleLabel(role)}.`,
  testRunAssigned: (runName: string) => `You've been assigned to test run ${runName}.`,
  testCaseFailed: (tcId: string, runName: string) => `${tcId} failed in test run ${runName}.`,
  testCaseBlocked: (tcId: string, runName: string) => `${tcId} is blocked in test run ${runName}.`,
  testCaseStatusChanged: (tcId: string, status: string, runName: string) => `${tcId} status changed to ${status} in test run ${runName}.`,
  /** One bulk status change, however many of the assignee's cases it covered. */
  testCasesStatusChangedBulk: (count: number, status: string, runName: string) =>
    `${count} of your test cases in test run ${runName} were marked ${status}.`,
  bugAssigned: (bugId: string) => `Bug ${bugId} has been assigned to you.`,
  bugReassigned: (bugId: string) => `Bug ${bugId} has been reassigned to you.`,
  bugStatusChanged: (bugId: string, status: string) => `Bug ${bugId} status changed to ${status}.`,
  bugMentioned: (userName: string, bugId: string) => `${userName} mentioned you on bug ${bugId}.`,
  commentReplied: (userName: string) => `${userName} replied to your comment.`
};

/**
 * What a notification points at. `link_entity_id` is a single VARCHAR(255) column, so entities that
 * only resolve inside a project are stored as `<projectId>:<entityId>` — the frontend's
 * `resolveNotificationHref` is the one reader and splits on the first colon (uuids contain none).
 * A removal, or an invitation not yet accepted, has no page of its own (the recipient cannot open
 * the thing), so those point at the project list. A link is still needed: the bell renders a
 * notification without one as inert text, and inert text can never be marked read — it would sit in
 * the unread badge forever.
 */
export type NotificationLink = { linkEntityType: string; linkEntityId: string };

export const notificationLinks = {
  /**
   * A pending invitation opens the same accept page the invitation email links to (`/invite/<token>`),
   * so the token is the link id. It goes only to the invitee — the one person the email already went
   * to — and is rewritten on resend, which rotates the token (see resendInvitation).
   */
  invitation: (rawToken: string): NotificationLink => ({ linkEntityType: "invitation", linkEntityId: rawToken }),
  projectsList: (scopeId: string): NotificationLink => ({ linkEntityType: "projects_list", linkEntityId: scopeId }),
  workspaceMembers: (organizationId: string): NotificationLink => ({ linkEntityType: "workspace_members", linkEntityId: organizationId }),
  project: (projectId: string): NotificationLink => ({ linkEntityType: "project", linkEntityId: projectId }),
  projectMembers: (projectId: string): NotificationLink => ({ linkEntityType: "project_members", linkEntityId: projectId }),
  testRun: (projectId: string, cycleId: string): NotificationLink => ({ linkEntityType: "test_run", linkEntityId: `${projectId}:${cycleId}` }),
  knowledgeDocument: (projectId: string, documentId: string): NotificationLink => ({ linkEntityType: "knowledge_document", linkEntityId: `${projectId}:${documentId}` }),
  bug: (projectId: string, bugId: string): NotificationLink => ({ linkEntityType: "bug", linkEntityId: `${projectId}:${bugId}` })
};
