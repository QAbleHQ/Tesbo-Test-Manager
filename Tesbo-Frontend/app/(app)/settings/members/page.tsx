"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  authMe,
  getWorkspace,
  listWorkspaceMembers,
  listWorkspaceInvitations,
  addWorkspaceMember,
  removeWorkspaceMember,
  revokeWorkspaceInvitation,
} from "@/lib/api";
import type { WorkspaceInvitation, WorkspaceMember as WorkspaceMemberType } from "@/lib/api";
import {
  Button,
  Input,
  Select,
  Field,
  FieldLabel,
  FieldHint,
  FieldError,
  Card,
  StatusChip,
} from "@/components/ui";
import { StandardPageLayout, PageHeader } from "@/components/workflows";

const PLATFORM_ROLES = [
  { value: "owner", label: "Owner" },
  { value: "admin", label: "Admin" },
  { value: "manager", label: "Manager" },
  { value: "member", label: "Member" },
] as const;

function roleLabel(role: string): string {
  const normalized = role.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (normalized === "project_admin") return "Admin";
  if (normalized === "test_manager") return "Manager";
  if (normalized === "qa_member" || normalized === "viewer") return "Member";
  const match = PLATFORM_ROLES.find((item) => item.value === normalized);
  return match?.label ?? "Member";
}

function normalizeWsRole(role: string): string {
  const n = role.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (n === "project_admin") return "admin";
  if (n === "test_manager") return "manager";
  if (n === "qa_member" || n === "viewer") return "member";
  if (["owner", "admin", "manager", "member"].includes(n)) return n;
  return "member";
}

export default function WorkspaceMembersPage() {
  const router = useRouter();
  const [workspace, setWorkspace] = useState<{ name: string } | null>(null);
  const [members, setMembers] = useState<WorkspaceMemberType[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState("member");
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [revokingInviteId, setRevokingInviteId] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [changingRoleId, setChangingRoleId] = useState<string | null>(null);

  const load = useCallback(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      setCurrentUserId(me.userId);
      Promise.all([getWorkspace(), listWorkspaceMembers()])
        .then(async ([ws, list]) => {
          setWorkspace(ws);
          setMembers(list);
          const pendingInvites = await listWorkspaceInvitations().catch(() => []);
          setInvitations(pendingInvites);
        })
        .catch((e) => {
          const msg = e.message || "";
          if (msg.includes("No workspace") || msg.includes("404")) router.replace("/onboarding");
          else setError(msg || "Failed to load");
        })
        .finally(() => setLoading(false));
    });
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setMessage("");
    setError("");
    if (!newEmail.trim()) {
      setError("Enter an email address");
      return;
    }
    setAdding(true);
    try {
      await addWorkspaceMember({ email: newEmail.trim(), role: newRole });
      setNewEmail("");
      setMessage("Member added or invitation sent.");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add member");
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(userId: string) {
    setMessage("");
    setRemovingId(userId);
    try {
      await removeWorkspaceMember(userId);
      setMembers((prev) => prev.filter((m) => m.userId !== userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove");
    } finally {
      setRemovingId(null);
    }
  }

  const myWsRole = currentUserId
    ? normalizeWsRole(members.find((m) => m.userId === currentUserId)?.role ?? "member")
    : "member";
  const canManage = myWsRole === "owner" || myWsRole === "admin" || myWsRole === "manager";

  function wsAssignableRoles(): { value: string; label: string }[] {
    if (myWsRole === "owner") return [{ value: "owner", label: "Owner" }, { value: "admin", label: "Admin" }, { value: "manager", label: "Manager" }, { value: "member", label: "Member" }];
    if (myWsRole === "admin") return [{ value: "manager", label: "Manager" }, { value: "member", label: "Member" }];
    if (myWsRole === "manager") return [{ value: "member", label: "Member" }];
    return [];
  }

  function canChangeWsRole(member: WorkspaceMemberType): boolean {
    if (!canManage) return false;
    if (member.userId === currentUserId) return false;
    const targetRole = normalizeWsRole(member.role);
    if (targetRole === "owner") return false;
    if (myWsRole === "manager" && (targetRole === "admin" || targetRole === "owner")) return false;
    if (myWsRole === "admin" && (targetRole === "admin" || targetRole === "owner")) return false;
    return true;
  }

  async function handleChangeWsRole(userId: string, newRoleValue: string) {
    setChangingRoleId(userId);
    setMessage("");
    setError("");
    try {
      await addWorkspaceMember({ userId, role: newRoleValue });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change role");
    } finally {
      setChangingRoleId(null);
    }
  }

  async function handleRevokeInvitation(invitationId: string) {
    setMessage("");
    setRevokingInviteId(invitationId);
    try {
      await revokeWorkspaceInvitation(invitationId);
      setInvitations((prev) => prev.filter((inv) => inv.id !== invitationId));
      setMessage("Invitation revoked.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke invitation");
    } finally {
      setRevokingInviteId(null);
    }
  }

  if (loading) {
    return (
      <StandardPageLayout header={<PageHeader title="Workspace members" />}>
        <div className="flex min-h-[200px] items-center justify-center">
          <p className="text-[var(--muted)]">Loading…</p>
        </div>
      </StandardPageLayout>
    );
  }

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Workspace members"
          subtitle={
            workspace?.name
              ? `Team members in ${workspace.name}. Only workspace members can be allocated to projects.`
              : "Manage who has access to your workspace."
          }
        />
      }
    >
      <Card className="p-4">
        <div className="space-y-1 text-xs text-[var(--muted)]">
          <p><strong>Owner:</strong> Full workspace access and can add admins.</p>
          <p><strong>Admin:</strong> Similar to owner, but cannot add/remove owners or admins.</p>
          <p><strong>Manager:</strong> Can create projects and invite members.</p>
          <p><strong>Member:</strong> Cannot invite or create projects, but can work inside assigned projects.</p>
        </div>
      </Card>

      <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-3">
        <Field className="min-w-[200px] flex-1">
          <FieldLabel htmlFor="email">Add by email</FieldLabel>
          <Input
            id="email"
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="teammate@example.com"
            disabled={adding}
          />
        </Field>
        <Field className="w-32">
          <FieldLabel htmlFor="role">Role</FieldLabel>
          <Select
            id="role"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            disabled={adding}
          >
            <option value="member">Member</option>
            <option value="manager">Manager</option>
            <option value="admin">Admin</option>
            <option value="owner">Owner</option>
          </Select>
        </Field>
        <Button type="submit" disabled={adding}>
          {adding ? "Sending…" : "Add member / Send invite"}
        </Button>
      </form>
      <FieldHint>
        Existing users are added immediately. New emails receive an invite link to join this workspace.
      </FieldHint>

      {message && (
        <p className="text-sm text-[var(--success)]">{message}</p>
      )}
      {error && <FieldError>{error}</FieldError>}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-[var(--foreground)]">Pending invitations</h2>
        {invitations.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No pending invitations.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {invitations.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-4 py-3">
                <div>
                  <span className="font-medium text-[var(--foreground)]">{inv.email}</span>
                  <span className="ml-2 text-sm text-[var(--muted)]">{roleLabel(inv.role)}</span>
                  <p className="text-xs text-[var(--muted)]">
                    Expires {new Date(inv.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => handleRevokeInvitation(inv.id)}
                  disabled={revokingInviteId === inv.id}
                >
                  {revokingInviteId === inv.id ? "Revoking…" : "Revoke"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="tesbo-table min-w-full text-sm">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th className="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const editable = canChangeWsRole(m);
                return (
                  <tr key={m.userId}>
                    <td>
                      {m.name || "—"}
                      {m.userId === currentUserId && (
                        <span className="ml-1.5 text-xs text-[var(--muted-soft)]">(you)</span>
                      )}
                    </td>
                    <td className="text-[var(--muted)]">{m.email}</td>
                    <td>
                      {editable ? (
                        <Select
                          value={normalizeWsRole(m.role)}
                          onChange={(e) => handleChangeWsRole(m.userId, e.target.value)}
                          disabled={changingRoleId === m.userId}
                          className="h-8 w-24 min-w-0 py-1 text-sm"
                        >
                          {wsAssignableRoles().map((r) => (
                            <option key={r.value} value={r.value}>{r.label}</option>
                          ))}
                        </Select>
                      ) : (
                        <StatusChip tone="neutral">{roleLabel(m.role)}</StatusChip>
                      )}
                    </td>
                    <td className="text-right">
                      {canManage && m.userId !== currentUserId && normalizeWsRole(m.role) !== "owner" && (
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => handleRemove(m.userId)}
                          disabled={removingId === m.userId}
                        >
                          {removingId === m.userId ? "Removing…" : "Remove"}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {members.length === 0 && !loading && (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-[var(--muted)]">
                    No members in this workspace yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </StandardPageLayout>
  );
}
