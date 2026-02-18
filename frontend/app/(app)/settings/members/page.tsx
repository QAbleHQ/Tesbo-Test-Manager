"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  authMe,
  getWorkspace,
  listWorkspaceMembers,
  addWorkspaceMember,
  removeWorkspaceMember,
} from "@/lib/api";
import type { WorkspaceMember as WorkspaceMemberType } from "@/lib/api";

export default function WorkspaceMembersPage() {
  const router = useRouter();
  const [workspace, setWorkspace] = useState<{ name: string } | null>(null);
  const [members, setMembers] = useState<WorkspaceMemberType[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState("member");
  const [error, setError] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);

  function load() {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      Promise.all([getWorkspace(), listWorkspaceMembers()])
        .then(([ws, list]) => {
          setWorkspace(ws);
          setMembers(list);
        })
        .catch((e) => {
          const msg = e.message || "";
          if (msg.includes("No workspace") || msg.includes("404")) router.replace("/onboarding");
          else setError(msg || "Failed to load");
        })
        .finally(() => setLoading(false));
    });
  }

  useEffect(() => {
    load();
  }, [router]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!newEmail.trim()) {
      setError("Enter an email address");
      return;
    }
    setAdding(true);
    try {
      await addWorkspaceMember({ email: newEmail.trim(), role: newRole });
      setNewEmail("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add member");
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(userId: string) {
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
            <option value="admin">Admin</option>
            <option value="owner">Owner</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={adding}
          className="rounded-lg bg-blue-600 text-white py-2 px-4 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {adding ? "Adding…" : "Add member"}
        </button>
      </form>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        They must have signed in at least once. Allocate them to specific projects from each project’s Members page.
      </p>

      {error && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      <ul className="mt-6 divide-y divide-zinc-200 dark:divide-zinc-700">
        {members.map((m) => (
          <li
            key={m.userId}
            className="py-3 flex items-center justify-between gap-4"
          >
            <div>
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                {m.name || m.email}
              </span>
              <span className="ml-2 text-sm text-zinc-500 dark:text-zinc-400">
                {m.email}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-zinc-500 dark:text-zinc-400 capitalize">
                {m.role}
              </span>
              <button
                type="button"
                onClick={() => handleRemove(m.userId)}
                disabled={removingId === m.userId}
                className="text-sm text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
              >
                {removingId === m.userId ? "Removing…" : "Remove"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
