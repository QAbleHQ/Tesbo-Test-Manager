"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  authMe,
  getWorkspaceProjectAccess,
  removeWorkspaceProjectAccess,
  setWorkspaceProjectAccess,
  type WorkspaceProjectAccessMatrix,
} from "@/lib/api";

const PROJECT_ROLES = [
  { value: "viewer", label: "Viewer" },
  { value: "qa_member", label: "QA member" },
  { value: "test_manager", label: "Test manager" },
  { value: "project_admin", label: "Project admin" },
] as const;

export default function WorkspaceProjectAccessPage() {
  const router = useRouter();
  const [data, setData] = useState<WorkspaceProjectAccessMatrix | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [draftRoles, setDraftRoles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [savingUserId, setSavingUserId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function load() {
    setError("");
    setLoading(true);
    try {
      const me = await authMe();
      if (!me) {
        router.replace("/login");
        return;
      }
      const matrix = await getWorkspaceProjectAccess();
      setData(matrix);
      if (!selectedProjectId && matrix.projects.length > 0) {
        setSelectedProjectId(matrix.projects[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load project access settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  const selectedProject = useMemo(
    () => data?.projects.find((p) => p.id === selectedProjectId) ?? null,
    [data, selectedProjectId]
  );

  async function grantOrUpdate(userId: string, role: string) {
    if (!selectedProjectId) return;
    setSavingUserId(userId);
    setError("");
    setMessage("");
    try {
      await setWorkspaceProjectAccess({ projectId: selectedProjectId, userId, role });
      setMessage("Project access updated.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update project access");
    } finally {
      setSavingUserId(null);
    }
  }

  async function removeAccess(userId: string) {
    if (!selectedProjectId) return;
    setSavingUserId(userId);
    setError("");
    setMessage("");
    try {
      await removeWorkspaceProjectAccess({ projectId: selectedProjectId, userId });
      setMessage("Project access removed.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove project access");
    } finally {
      setSavingUserId(null);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  if (!data) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-8">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Project access</h1>
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error || "Unable to load data."}</p>
      </main>
    );
  }

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Project access</h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Choose a project and assign access roles for workspace members.
      </p>

      {data.projects.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
          Create at least one project to manage project access.
        </p>
      ) : (
        <>
          <div className="mt-5">
            <label htmlFor="project" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Project
            </label>
            <select
              id="project"
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
              className="w-full max-w-md rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-zinc-900 dark:text-zinc-100"
            >
              {data.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.key} - {project.name}
                </option>
              ))}
            </select>
          </div>

          {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
          {message && <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">{message}</p>}

          <ul className="mt-6 divide-y divide-zinc-200 dark:divide-zinc-700">
            {data.members.map((member) => {
              const currentRole = selectedProjectId ? member.projectRoles[selectedProjectId] : undefined;
              const selectedRole = draftRoles[member.userId] || currentRole || "viewer";
              const busy = savingUserId === member.userId;
              return (
                <li key={member.userId} className="py-4 flex flex-wrap items-center gap-3 justify-between">
                  <div className="min-w-[220px]">
                    <p className="font-medium text-zinc-900 dark:text-zinc-100">{member.name || member.email}</p>
                    <p className="text-sm text-zinc-500 dark:text-zinc-400">
                      {member.email} · workspace role: {member.workspaceRole}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={selectedRole}
                      onChange={(e) =>
                        setDraftRoles((prev) => ({
                          ...prev,
                          [member.userId]: e.target.value,
                        }))
                      }
                      className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100"
                      disabled={!selectedProject || busy}
                    >
                      {PROJECT_ROLES.map((role) => (
                        <option key={role.value} value={role.value}>
                          {role.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => grantOrUpdate(member.userId, selectedRole)}
                      disabled={!selectedProject || busy}
                      className="rounded-lg bg-blue-600 text-white py-2 px-3 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                    >
                      {busy ? "Saving…" : currentRole ? "Update" : "Grant access"}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeAccess(member.userId)}
                      disabled={!selectedProject || !currentRole || busy}
                      className="text-sm text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </main>
  );
}
