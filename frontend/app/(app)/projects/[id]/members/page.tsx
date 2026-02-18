"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  authMe,
  listProjectMembers,
  listWorkspaceMembers,
  addProjectMember,
  removeProjectMember,
} from "@/lib/api";

type ProjectMember = { userId: string; email: string; name: string; role: string; joinedAt: string };
type WorkspaceMember = { userId: string; email: string; name: string; role: string; joinedAt: string };

export default function ProjectMembersPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [addUserId, setAddUserId] = useState("");
  const [addRole, setAddRole] = useState("qa_member");
  const [error, setError] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);

  function load() {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      Promise.all([
        listProjectMembers(projectId),
        listWorkspaceMembers().catch(() => []),
      ])
        .then(([projectList, workspaceList]) => {
          setMembers(projectList);
          setWorkspaceMembers(workspaceList);
        })
        .catch(() => router.replace("/projects"))
        .finally(() => setLoading(false));
    });
  }

  useEffect(() => {
    load();
  }, [projectId, router]);

  const memberIds = new Set(members.map((m) => m.userId));
  const availableToAdd = workspaceMembers.filter((w) => !memberIds.has(w.userId));

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!addUserId) {
      setError("Select a workspace member");
      return;
    }
    setAdding(true);
    try {
      await addProjectMember(projectId, { userId: addUserId, role: addRole });
      setAddUserId("");
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
      await removeProjectMember(projectId, userId);
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
        Project members
      </h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Only workspace team members can be allocated here. Manage your workspace team in{" "}
        <a href="/settings/members" className="text-blue-600 dark:text-blue-400 hover:underline">
          Workspace settings → Members
        </a>
        .
      </p>

      {availableToAdd.length > 0 && (
        <form onSubmit={handleAdd} className="mt-6 flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[200px]">
            <label htmlFor="add-user" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Add workspace member
            </label>
            <select
              id="add-user"
              value={addUserId}
              onChange={(e) => setAddUserId(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-zinc-900 dark:text-zinc-100"
              disabled={adding}
            >
              <option value="">Select member…</option>
              {availableToAdd.map((w) => (
                <option key={w.userId} value={w.userId}>
                  {w.name || w.email} ({w.email})
                </option>
              ))}
            </select>
          </div>
          <div className="w-32">
            <label htmlFor="add-role" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Role
            </label>
            <select
              id="add-role"
              value={addRole}
              onChange={(e) => setAddRole(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-zinc-900 dark:text-zinc-100"
              disabled={adding}
            >
              <option value="viewer">Viewer</option>
              <option value="qa_member">QA member</option>
              <option value="test_manager">Test manager</option>
              <option value="project_admin">Project admin</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={adding || !addUserId}
            className="rounded-lg bg-blue-600 text-white py-2 px-4 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {adding ? "Adding…" : "Add to project"}
          </button>
        </form>
      )}
      {availableToAdd.length === 0 && workspaceMembers.length > 0 && (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
          All workspace members are already allocated to this project.
        </p>
      )}
      {workspaceMembers.length === 0 && (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
          Add team members in Workspace settings first, then allocate them to this project here.
        </p>
      )}

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
                {m.role.replace("_", " ")}
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
