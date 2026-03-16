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
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  return (
    <main className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        Workspace members
      </h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        {workspace?.name
          ? `Team members in ${workspace.name}. Only workspace members can be allocated to projects.`
          : "Manage who has access to your workspace."}
      </p>
      <div className="mt-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/50 p-3 text-xs text-zinc-600 dark:text-zinc-300 space-y-1">
        <p><strong>Owner:</strong> Full workspace access and can add admins.</p>
        <p><strong>Admin:</strong> Similar to owner, but cannot add/remove owners or admins.</p>
        <p><strong>Manager:</strong> Can create projects and invite members.</p>
        <p><strong>Member:</strong> Cannot invite or create projects, but can work inside assigned projects.</p>
      </div>

      <form onSubmit={handleAdd} className="mt-6 flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[200px]">
          <label htmlFor="email" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
            Add by email
          </label>
          <input
            id="email"
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="teammate@example.com"
            className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-zinc-900 dark:text-zinc-100"
            disabled={adding}
          />
        </div>
        <div className="w-32">
          <label htmlFor="role" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
            Role
          </label>
          <select
            id="role"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-zinc-900 dark:text-zinc-100"
            disabled={adding}
          >
            <option value="member">Member</option>
            <option value="manager">Manager</option>
            <option value="admin">Admin</option>
            <option value="owner">Owner</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={adding}
          className="rounded-lg bg-blue-600 text-white py-2 px-4 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {adding ? "Sending…" : "Add member / Send invite"}
        </button>
      </form>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Existing users are added immediately. New emails receive an invite link to join this workspace.
      </p>

      {message && (
        <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">{message}</p>
      )}
      {error && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Pending invitations</h2>
        {invitations.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">No pending invitations.</p>
        ) : (
          <ul className="mt-3 divide-y divide-zinc-200 dark:divide-zinc-700">
            {invitations.map((inv) => (
              <li key={inv.id} className="py-3 flex items-center justify-between gap-4">
                <div>
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{inv.email}</span>
                  <span className="ml-2 text-sm text-zinc-500 dark:text-zinc-400">{roleLabel(inv.role)}</span>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Expires {new Date(inv.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleRevokeInvitation(inv.id)}
                  disabled={revokingInviteId === inv.id}
                  className="text-sm text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
                >
                  {revokingInviteId === inv.id ? "Revoking…" : "Revoke"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-6 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-800/60">
              <tr className="text-left text-zinc-600 dark:text-zinc-300">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const editable = canChangeWsRole(m);
                return (
                  <tr key={m.userId} className="border-t border-zinc-200 dark:border-zinc-700">
                    <td className="px-4 py-3 text-zinc-900 dark:text-zinc-100">
                      {m.name || "—"}
                      {m.userId === currentUserId && (
                        <span className="ml-1.5 text-xs text-zinc-400">(you)</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">{m.email}</td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">
                      {editable ? (
                        <select
                          value={normalizeWsRole(m.role)}
                          onChange={(e) => handleChangeWsRole(m.userId, e.target.value)}
                          disabled={changingRoleId === m.userId}
                          className="rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2 py-1 text-sm text-zinc-900 dark:text-zinc-100 disabled:opacity-50"
                        >
                          {wsAssignableRoles().map((r) => (
                            <option key={r.value} value={r.value}>{r.label}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="inline-flex items-center rounded-md bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                          {roleLabel(m.role)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canManage && m.userId !== currentUserId && normalizeWsRole(m.role) !== "owner" && (
                        <button
                          type="button"
                          onClick={() => handleRemove(m.userId)}
                          disabled={removingId === m.userId}
                          className="text-sm text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
                        >
                          {removingId === m.userId ? "Removing…" : "Remove"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {members.length === 0 && !loading && (
                <tr className="border-t border-zinc-200 dark:border-zinc-700">
                  <td colSpan={4} className="px-4 py-6 text-center text-zinc-500 dark:text-zinc-400">
                    No members in this workspace yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
