import type { WorkspaceRole } from "./api";

// Which roles a workspace member may invite someone as — the one definition shared by every invite
// surface (Settings › Members, onboarding's "Invite your team" step). Mirrors createInvitation's
// server-side checks in legacy.service.ts, which remain the enforcement: owners can't be invited,
// and a manager may only invite QA Engineers.
export function invitableRoleOptions(callerRole: WorkspaceRole): Array<{ value: WorkspaceRole; label: string }> {
  return callerRole === "owner"
    ? [
        { value: "manager", label: "Manager" },
        { value: "qa_engineer", label: "QA Engineer" },
      ]
    : [{ value: "qa_engineer", label: "QA Engineer" }];
}

// The default pre-selected in an invite role picker.
export const DEFAULT_INVITE_ROLE: WorkspaceRole = "qa_engineer";

export function inviteRoleDescription(role: string): string {
  return role === "manager"
    ? "Can create projects, invite QA Engineers, and manage assigned projects."
    : "Can work inside assigned projects.";
}
