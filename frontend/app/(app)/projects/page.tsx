"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { authMe, listProjects, listTestCases, listSuites, createProject, getWorkspace } from "@/lib/api";
import type { ProjectSummary } from "@/lib/api";
import type { SuiteNode } from "@/lib/api";

type ProjectWithStats = ProjectSummary & {
  testCaseCount: number;
  suites: SuiteNode[];
};

function ProjectsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [projects, setProjects] = useState<ProjectWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createKey, setCreateKey] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState("");
  const [workspaceRole, setWorkspaceRole] = useState<string>("");
  const canCreateProject = workspaceRole === "owner" || workspaceRole === "manager";

  useEffect(() => {
    if (canCreateProject && searchParams.get("create") === "1") {
      setCreateOpen(true);
    }
  }, [canCreateProject, searchParams]);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      Promise.all([getWorkspace(), listProjects()])
        .then(async ([workspace, list]) => {
          setWorkspaceRole((workspace.role || "").toLowerCase());
          const withStats = await Promise.all(
            list.map(async (p) => {
              const [tcRes, suites] = await Promise.all([
                listTestCases(p.id, { limit: 1 }),
                listSuites(p.id),
              ]);
              return {
                ...p,
                testCaseCount: tcRes.total,
                suites,
              };
            })
          );
          setProjects(withStats);
        })
        .finally(() => setLoading(false));
    });
  }, [router]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError("");
    if (!canCreateProject) {
      setCreateError("Only workspace owner or manager can create projects.");
      return;
    }
    if (!createName.trim()) {
      setCreateError("Project name is required");
      return;
    }
    setCreateLoading(true);
    try {
      const created = await createProject({
        name: createName.trim(),
        key: createKey.trim() || undefined,
        description: createDescription.trim() || undefined,
      });
      setCreateOpen(false);
      setCreateName("");
      setCreateKey("");
      setCreateDescription("");
      router.push(`/projects/${created.id}/dashboard`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setCreateLoading(false);
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
    <main className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
          Projects
        </h1>
        {canCreateProject ? (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="rounded-lg bg-blue-600 text-white py-2 px-4 text-sm font-medium hover:bg-blue-700"
          >
            {projects.length === 0 ? "Create your first project" : "Create project"}
          </button>
        ) : null}
      </div>
      {projects.length === 0 ? (
        <div className="mt-6 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50/50 dark:bg-zinc-800/30 p-8 text-center">
          <p className="text-zinc-500">
            {canCreateProject
              ? "No projects yet. Create your first project to complete onboarding."
              : "You do not have any project access yet. Your project manager will assign a project to you."}
          </p>
          {canCreateProject ? (
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="mt-4 inline-block rounded-lg bg-blue-600 text-white py-2 px-4 text-sm font-medium hover:bg-blue-700"
            >
              Create first project
            </button>
          ) : null}
        </div>
      ) : null}

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => !createLoading && setCreateOpen(false)}>
          <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Create project</h2>
            <form onSubmit={handleCreate} className="mt-4 space-y-4">
              <div>
                <label htmlFor="create-name" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Name *</label>
                <input
                  id="create-name"
                  type="text"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="My Project"
                  className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-zinc-900 dark:text-zinc-100"
                  disabled={createLoading}
                  autoFocus
                />
              </div>
              <div>
                <label htmlFor="create-key" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Key (optional)</label>
                <input
                  id="create-key"
                  type="text"
                  value={createKey}
                  onChange={(e) => setCreateKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                  placeholder="PROJ"
                  className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 font-mono text-zinc-900 dark:text-zinc-100"
                  disabled={createLoading}
                />
                <p className="mt-1 text-xs text-zinc-500">Short code; derived from name if blank.</p>
              </div>
              <div>
                <label htmlFor="create-desc" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Description (optional)</label>
                <textarea
                  id="create-desc"
                  value={createDescription}
                  onChange={(e) => setCreateDescription(e.target.value)}
                  rows={2}
                  className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-zinc-900 dark:text-zinc-100"
                  disabled={createLoading}
                />
              </div>
              {createError && <p className="text-sm text-red-600 dark:text-red-400">{createError}</p>}
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => !createLoading && setCreateOpen(false)}
                  className="rounded-lg border border-zinc-300 dark:border-zinc-600 py-2 px-4 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createLoading}
                  className="rounded-lg bg-blue-600 text-white py-2 px-4 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  {createLoading ? "Creating…" : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {projects.length > 0 ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.id}/dashboard`}
              className="group flex flex-col rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5 shadow-sm transition-all hover:border-zinc-300 dark:hover:border-zinc-600 hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 group-hover:text-blue-600 dark:group-hover:text-blue-400">
                  {p.name}
                </h2>
                <span className="shrink-0 rounded bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                  {p.key}
                </span>
              </div>
              {p.description ? (
                <p className="mt-1 line-clamp-2 text-sm text-zinc-500 dark:text-zinc-400">
                  {p.description}
                </p>
              ) : null}
              <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-zinc-600 dark:text-zinc-400">
                <span className="flex items-center gap-1">
                  <span className="font-medium text-zinc-900 dark:text-zinc-200">
                    {p.testCaseCount}
                  </span>
                  <span>test cases</span>
                </span>
                <span className="text-zinc-300 dark:text-zinc-600">·</span>
                <span className="flex items-center gap-1">
                  <span className="font-medium text-zinc-900 dark:text-zinc-200">
                    {p.suites.length}
                  </span>
                  <span>suites</span>
                </span>
              </div>
              {p.suites.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {p.suites.slice(0, 4).map((s) => (
                    <span
                      key={s.id}
                      className="rounded-md bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-xs text-zinc-600 dark:text-zinc-400"
                    >
                      {s.name}
                    </span>
                  ))}
                  {p.suites.length > 4 ? (
                    <span className="text-xs text-zinc-400 dark:text-zinc-500">
                      +{p.suites.length - 4} more
                    </span>
                  ) : null}
                </div>
              ) : null}
            </Link>
          ))}
        </div>
      ) : null}
    </main>
  );
}

export default function ProjectsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <p className="text-zinc-500">Loading…</p>
        </div>
      }
    >
      <ProjectsPageContent />
    </Suspense>
  );
}
