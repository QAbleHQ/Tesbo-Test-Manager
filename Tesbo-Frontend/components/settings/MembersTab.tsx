"use client";

import { IconMail, IconPlus, IconTrash, IconRefresh, IconX } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import {
  changeWorkspaceMemberRole,
  listWorkspaceMembers,
  listWorkspaceInvitations,
  createWorkspaceInvitation,
  cancelWorkspaceInvitation,
  resendWorkspaceInvitation,
  removeWorkspaceMember,
  type WorkspaceMember,
  type WorkspaceInvitation,
  type ProjectSummary,
} from "@/lib/api";
import {
  Button,
  Input,
  Select,
  Field,
  FieldLabel,
  FieldError,
  Card,
  Modal,
  PageLoader,
  ConfirmModal,
} from "@/components/ui";
import { useAppData } from "@/components/app/AppDataProvider";
import { inviteRoleDescription, invitableRoleOptions } from "@/lib/workspaceRoles";
import { formatDate } from "@/lib/date";

// ─── Role helpers ─────────────────────────────────────────────────────────────

function normalizeRole(role: string): "owner" | "manager" | "qa_engineer" {
  const n = (role ?? "").trim().toLowerCase().replace(/-/g, "_").replace(/ /g, "_");
  if (n === "owner") return "owner";
  if (["manager", "admin", "test_manager"].includes(n)) return "manager";
  return "qa_engineer";
}

function roleLabel(role: string): string {
  const n = normalizeRole(role);
  if (n === "owner") return "Owner";
  if (n === "manager") return "Manager";
  return "QA Engineer";
}

function roleBadgeClass(role: string): string {
  const n = normalizeRole(role);
  if (n === "owner") return "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-[#E8EFF8] text-[#1D3F6E]";
  if (n === "manager") return "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-[#FFF0E8] text-[#8B3200]";
  return "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-[#EFF0F3] text-[#3E4456]";
}

function statusBadgeClass(status: string): string {
  if (status === "active") return "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-[#EAF7EE] text-[#1A6B35]";
  if (status === "pending") return "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-[#FFF7E6] text-[#7A4A0A]";
  if (status === "expired") return "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-[#EFF0F3] text-[#3E4456]";
  if (status === "cancelled") return "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-[#FDEAEA] text-[#8B1F1F]";
  return "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-[#EFF0F3] text-[#3E4456]";
}

// ─── Invite modal ─────────────────────────────────────────────────────────────

interface InviteModalProps {
  open: boolean;
  onClose: () => void;
  onInvited: () => void;
  callerRole: "owner" | "manager" | "qa_engineer";
  projects: ProjectSummary[];
}

function InviteModal({ open, onClose, onInvited, callerRole, projects }: InviteModalProps) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("qa_engineer");
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [formError, setFormError] = useState("");

  useEffect(() => {
    if (open) {
      setEmail("");
      setRole("qa_engineer");
      setSelectedProjectIds([]);
      setEmailError("");
      setFormError("");
    }
  }, [open]);

  const roleOptions = invitableRoleOptions(callerRole);

  function toggleProject(id: string) {
    setSelectedProjectIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setEmailError("");
    setFormError("");
    if (!email.trim()) {
      setEmailError("Email is required");
      return;
    }
    setSubmitting(true);
    try {
      await createWorkspaceInvitation({
        email: email.trim(),
        role,
        projectIds: selectedProjectIds,
      });
      onInvited();
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to send invite");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Invite team member">
      <form onSubmit={handleSubmit} className="space-y-4 pt-1">
        <Field>
          <FieldLabel htmlFor="invite-email">Email address</FieldLabel>
          <Input
            id="invite-email"
            type="email"
            autoFocus
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (emailError) setEmailError("");
            }}
            placeholder="teammate@example.com"
            disabled={submitting}
            aria-invalid={Boolean(emailError)}
          />
          {emailError && <FieldError>{emailError}</FieldError>}
        </Field>

        <Field>
          <FieldLabel htmlFor="invite-role">Role</FieldLabel>
          <Select
            id="invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            disabled={submitting || roleOptions.length === 1}
          >
            {roleOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-[var(--ink-400)]">
            {inviteRoleDescription(role)}
          </p>
        </Field>

        {projects.length > 0 && (
          <Field>
            <FieldLabel>Project access (optional)</FieldLabel>
            <div className="mt-1.5 max-h-40 overflow-y-auto rounded-[var(--radius-control)] border border-[var(--ink-200)] divide-y divide-[var(--ink-200)]">
              {projects.map((p) => (
                <label
                  key={p.id}
                  className="flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-[var(--ink-100)]"
                >
                  <input
                    type="checkbox"
                    checked={selectedProjectIds.includes(p.id)}
                    onChange={() => toggleProject(p.id)}
                    disabled={submitting}
                    className="accent-[var(--denim)]"
                  />
                  <span className="text-sm text-[var(--foreground)]">{p.name}</span>
                  <span className="ml-auto font-mono text-xs text-[var(--ink-400)]">{p.key}</span>
                </label>
              ))}
            </div>
            {selectedProjectIds.length > 0 && (
              <p className="mt-1 text-xs text-[var(--ink-400)]">
                {selectedProjectIds.length} project{selectedProjectIds.length > 1 ? "s" : ""} selected
              </p>
            )}
          </Field>
        )}

        {formError && <FieldError>{formError}</FieldError>}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Sending…" : "Send invite"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Tab ────────────────────────────────────────────────────────────────────

export default function MembersTab() {
  // currentUser/workspace/projects come from AppDataProvider (app/(app)/layout.tsx), which fetches
  // them once for the whole app shell — this tab used to independently re-fetch all three itself,
  // one of several duplicate authMe()/getWorkspace()/listProjects() calls that made this page slow
  // to load (Sidebar and TopBar each had their own copies too).
  const { currentUser, workspace, projects } = useAppData();
  const currentUserId = currentUser?.userId ?? null;
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [actionId, setActionId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<{ userId: string; label: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [memberList, inviteList] = await Promise.all([
        listWorkspaceMembers(),
        listWorkspaceInvitations().catch(() => []),
      ]);
      setMembers(memberList);
      setInvitations(inviteList);
    } catch (e) {
      setError((e as Error).message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  }

  const myMember = members.find((m) => m.userId === currentUserId);
  const myRole = normalizeRole(myMember?.role ?? "qa_engineer");
  const canManage = myRole === "owner" || myRole === "manager";

  async function handleRemoveMember(userId: string) {
    setActionId(userId);
    setError("");
    try {
      await removeWorkspaceMember(userId);
      showToast("Team member removed");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove member");
    } finally {
      setActionId(null);
      setPendingRemoval(null);
    }
  }

  async function handleChangeRole(userId: string, newRole: string) {
    setActionId(userId);
    setError("");
    try {
      await changeWorkspaceMemberRole(userId, newRole);
      showToast("Role updated");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change role");
    } finally {
      setActionId(null);
    }
  }

  async function handleCancelInvite(id: string) {
    setActionId(id);
    setError("");
    try {
      await cancelWorkspaceInvitation(id);
      showToast("Invitation cancelled");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel invitation");
    } finally {
      setActionId(null);
    }
  }

  async function handleResendInvite(id: string) {
    setActionId(id);
    setError("");
    try {
      await resendWorkspaceInvitation(id);
      showToast("Invitation resent");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resend invitation");
    } finally {
      setActionId(null);
    }
  }

  if (loading) {
    return <PageLoader />;
  }

  const pendingInvites = invitations.filter((i) => i.status === "pending" || i.status === "expired");

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--foreground)]">Team</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Manage who has access to {workspace?.name ?? "this workspace"}.
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setInviteOpen(true)}>
            <IconPlus size={16} className="mr-1.5" />
            Invite member
          </Button>
        )}
      </div>

      {error && <FieldError>{error}</FieldError>}

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 rounded-[var(--radius-control)] bg-[var(--toast-surface)] px-4 py-2.5 text-sm text-[var(--toast-foreground)] shadow-lg">
          {toast}
        </div>
      )}

      {/* ── Active members ── */}
      <section>
        <h3 className="mb-3 text-sm font-medium text-[var(--ink-600)]">
          Members <span className="ml-1 text-[var(--ink-400)]">({members.length})</span>
        </h3>
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="tesbo-table min-w-full text-sm">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Joined</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const memberRole = normalizeRole(m.role);
                  const isSelf = m.userId === currentUserId;
                  const isOwner = memberRole === "owner";
                  const canChangeRole = myRole === "owner" && !isSelf && !isOwner;
                  const canRemove = myRole === "owner" && !isSelf && !isOwner;

                  return (
                    <tr key={m.userId}>
                      <td className="font-medium text-[var(--foreground)]">
                        {m.name || "—"}
                        {isSelf && (
                          <span className="ml-1.5 text-xs text-[var(--ink-400)]">(you)</span>
                        )}
                      </td>
                      <td className="text-[var(--ink-400)]">{m.email}</td>
                      <td>
                        {canChangeRole ? (
                          <Select
                            value={memberRole}
                            onChange={(e) => handleChangeRole(m.userId, e.target.value)}
                            disabled={actionId === m.userId}
                            className="h-7 w-28 min-w-0 py-0 text-xs"
                          >
                            <option value="manager">Manager</option>
                            <option value="qa_engineer">QA Engineer</option>
                          </Select>
                        ) : (
                          <span className={roleBadgeClass(memberRole)}>{roleLabel(memberRole)}</span>
                        )}
                      </td>
                      <td className="text-[var(--ink-400)]">
                        {m.joinedAt ? formatDate(m.joinedAt) : "—"}
                      </td>
                      <td className="text-right">
                        {canRemove && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setPendingRemoval({ userId: m.userId, label: m.name || m.email })}
                            disabled={actionId === m.userId}
                            title="Remove from team"
                            className="text-[var(--error-foreground)] hover:bg-[var(--error-soft)]"
                          >
                            <IconTrash size={15} />
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {members.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-[var(--ink-400)]">
                      No members yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </section>

      {/* ── Pending invitations ── */}
      {canManage && (
        <section>
          <h3 className="mb-3 text-sm font-medium text-[var(--ink-600)]">
            Invitations
            {pendingInvites.length > 0 && (
              <span className="ml-1 text-[var(--ink-400)]">({pendingInvites.length})</span>
            )}
          </h3>
          {pendingInvites.length === 0 ? (
            <p className="flex items-center gap-2 rounded-[var(--radius-card)] border border-dashed border-[var(--ink-200)] px-4 py-6 text-sm text-[var(--ink-400)]">
              <IconMail size={16} />
              No pending invitations. Use the Invite member button to add someone.
            </p>
          ) : (
            <Card className="overflow-hidden p-0">
              <div className="overflow-x-auto">
                <table className="tesbo-table min-w-full text-sm">
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Projects</th>
                      <th>Invited by</th>
                      <th>Sent</th>
                      <th>Expires</th>
                      <th>Status</th>
                      <th className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingInvites.map((inv) => {
                      const canAct =
                        myRole === "owner" ||
                        inv.invitedByEmail ===
                          members.find((m) => m.userId === currentUserId)?.email;
                      return (
                        <tr key={inv.id}>
                          <td className="font-medium text-[var(--foreground)]">{inv.email}</td>
                          <td>
                            <span className={roleBadgeClass(inv.role)}>{roleLabel(inv.role)}</span>
                          </td>
                          <td className="text-[var(--ink-400)]">
                            {inv.projects.length > 0
                              ? inv.projects.map((p) => p.name).join(", ")
                              : <span className="text-[var(--ink-300)]">—</span>}
                          </td>
                          <td className="text-[var(--ink-400)]">
                            {inv.invitedByName || inv.invitedByEmail || "—"}
                          </td>
                          <td className="text-[var(--ink-400)]">
                            {formatDate(inv.createdAt)}
                          </td>
                          <td className="text-[var(--ink-400)]">
                            {formatDate(inv.expiresAt)}
                          </td>
                          <td>
                            <span className={statusBadgeClass(inv.status)}>
                              {inv.status.charAt(0).toUpperCase() + inv.status.slice(1)}
                            </span>
                          </td>
                          <td className="text-right">
                            {canAct && inv.status === "pending" && (
                              <div className="flex items-center justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleResendInvite(inv.id)}
                                  disabled={actionId === inv.id}
                                  title="Resend invite"
                                >
                                  <IconRefresh size={14} />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleCancelInvite(inv.id)}
                                  disabled={actionId === inv.id}
                                  title="Cancel invite"
                                >
                                  <IconX size={14} />
                                </Button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </section>
      )}

      {/* ── Role legend ── */}
      <section>
        <Card className="p-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.06em] text-[var(--ink-300)]">Role guide</p>
          <div className="space-y-1 text-xs text-[var(--ink-400)]">
            <p><strong className="text-[var(--foreground)]">Owner</strong> — Full workspace access. Manages team, roles, and all projects.</p>
            <p><strong className="text-[var(--foreground)]">Manager</strong> — Can create projects, invite QA Engineers, and manage assigned projects.</p>
            <p><strong className="text-[var(--foreground)]">QA Engineer</strong> — Works inside assigned projects. Cannot invite or create projects.</p>
          </div>
        </Card>
      </section>

      <InviteModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onInvited={() => { showToast("Invite sent successfully"); load(); }}
        callerRole={myRole}
        projects={projects}
      />

      <ConfirmModal
        open={pendingRemoval !== null}
        title="Remove team member"
        message={
          pendingRemoval
            ? `Remove ${pendingRemoval.label} from this workspace? They will lose access to every project here.`
            : ""
        }
        confirmLabel="Remove member"
        loading={pendingRemoval !== null && actionId === pendingRemoval.userId}
        onConfirm={() => pendingRemoval && handleRemoveMember(pendingRemoval.userId)}
        onCancel={() => setPendingRemoval(null)}
      />
    </div>
  );
}
