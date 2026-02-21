"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { authMe, createOrgAndProject, getWorkspace } from "@/lib/api";

export default function OnboardingPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [orgName, setOrgName] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    async function guardOnboardingAccess() {
      const me = await authMe();
      if (!me) {
        setChecking(false);
        router.replace("/login");
        return;
      }

      try {
        await getWorkspace();
        router.replace("/projects");
        return;
      } catch {
        // No workspace yet; user should continue onboarding.
      }

      setChecking(false);
    }

    guardOnboardingAccess();
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!orgName.trim() || !projectKey.trim() || !projectName.trim()) {
      setError("Workspace name, project key, and project name are required");
      return;
    }
    setLoading(true);
    try {
      const res = await createOrgAndProject({
        orgName: orgName.trim(),
        projectKey: projectKey.trim(),
        projectName: projectName.trim(),
        projectDescription: projectDescription.trim() || undefined,
      });
      router.push(`/projects/${res.projectId}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--background)] dark:bg-zinc-950">
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--background)] dark:bg-zinc-950 px-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-[var(--foreground)] dark:text-zinc-100">Create your workspace</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">Your workspace will contain your team and projects. We’ll create your first project inside it.</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="orgName" className="block text-sm font-medium text-[var(--muted)] dark:text-zinc-300 mb-1">
              Workspace name
            </label>
            <input
              id="orgName"
              type="text"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="My Team"
              className="w-full rounded-lg border border-[var(--border)] dark:border-zinc-600 bg-[var(--surface)] dark:bg-zinc-900 px-3 py-2 text-[var(--foreground)] dark:text-zinc-100"
              disabled={loading}
            />
          </div>
          <div>
            <label htmlFor="projectKey" className="block text-sm font-medium text-[var(--muted)] dark:text-zinc-300 mb-1">
              Project key
            </label>
            <input
              id="projectKey"
              type="text"
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
              placeholder="PROJ"
              className="w-full rounded-lg border border-[var(--border)] dark:border-zinc-600 bg-[var(--surface)] dark:bg-zinc-900 px-3 py-2 text-[var(--foreground)] dark:text-zinc-100 font-mono"
              disabled={loading}
            />
            <p className="mt-1 text-xs text-[var(--muted)]">Short code for this project (e.g. PROJ, QA)</p>
          </div>
          <div>
            <label htmlFor="projectName" className="block text-sm font-medium text-[var(--muted)] dark:text-zinc-300 mb-1">
              Project name
            </label>
            <input
              id="projectName"
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="My Test Project"
              className="w-full rounded-lg border border-[var(--border)] dark:border-zinc-600 bg-[var(--surface)] dark:bg-zinc-900 px-3 py-2 text-[var(--foreground)] dark:text-zinc-100"
              disabled={loading}
            />
          </div>
          <div>
            <label htmlFor="projectDescription" className="block text-sm font-medium text-[var(--muted)] dark:text-zinc-300 mb-1">
              Description (optional)
            </label>
            <textarea
              id="projectDescription"
              value={projectDescription}
              onChange={(e) => setProjectDescription(e.target.value)}
              rows={2}
              className="w-full rounded-lg border border-[var(--border)] dark:border-zinc-600 bg-[var(--surface)] dark:bg-zinc-900 px-3 py-2 text-[var(--foreground)] dark:text-zinc-100"
              disabled={loading}
            />
          </div>
          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-[var(--primary)] text-white py-2 px-4 font-medium hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "Creating…" : "Create workspace"}
          </button>
        </form>
      </div>
    </div>
  );
}
