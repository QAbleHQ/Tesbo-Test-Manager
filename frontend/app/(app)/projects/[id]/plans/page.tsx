"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { authMe, listPlans, createPlan, getProject, type PlanListItem } from "@/lib/api";

function StatusBadge({ count, label, color }: { count: number; label: string; color: string }) {
  if (count === 0) return null;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${color}`}>
      <span className="w-2 h-2 rounded-full bg-current" />
      {count} {label}
    </span>
  );
}

function ProgressBar({ passed, failed, untested, total }: { passed: number; failed: number; untested: number; total: number }) {
  if (total === 0) return <div className="h-2 rounded-full bg-zinc-200 dark:bg-zinc-700 w-full" />;
  const pPassed = (passed / total) * 100;
  const pFailed = (failed / total) * 100;
  const other = 100 - pPassed - pFailed;
  return (
    <div className="h-2 rounded-full bg-zinc-200 dark:bg-zinc-700 w-full overflow-hidden flex">
      {pPassed > 0 && <div className="bg-emerald-500 h-full transition-all" style={{ width: `${pPassed}%` }} />}
      {pFailed > 0 && <div className="bg-red-500 h-full transition-all" style={{ width: `${pFailed}%` }} />}
      {other > 0 && <div className="bg-zinc-300 dark:bg-zinc-600 h-full transition-all" style={{ width: `${other}%` }} />}
    </div>
  );
}

export default function PlansPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const [plans, setPlans] = useState<PlanListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newRelease, setNewRelease] = useState("");
  const [canManagePlans, setCanManagePlans] = useState(false);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      Promise.all([
        listPlans(projectId),
        getProject(projectId),
      ])
        .then(([plansData, projectData]) => {
          setPlans(plansData as unknown as PlanListItem[]);
          const myRole = (projectData.myRole as string ?? "").toLowerCase();
          setCanManagePlans(["owner", "admin", "manager"].includes(myRole));
        })
        .catch(() => router.replace("/projects"))
        .finally(() => setLoading(false));
    });
  }, [projectId, router]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const p = await createPlan(projectId, {
        name: newName.trim(),
        description: newDesc.trim() || undefined,
        targetRelease: newRelease.trim() || undefined,
      });
      router.push(`/projects/${projectId}/plans/${p.id}`);
      router.refresh();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create test plan.");
    } finally {
      setCreating(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-zinc-500 text-sm">Loading test plans...</p>
        </div>
      </div>
    );
  }

  return (
    <main className="max-w-5xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Test Plans</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
            Organize test runs and track overall testing progress
          </p>
        </div>
        {canManagePlans && (
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white py-2 px-4 text-sm font-medium transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Plan
          </button>
        )}
      </div>

      {/* Create form */}
      {showCreate && (
        <form onSubmit={handleCreate} className="mb-6 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">Create Test Plan</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">Plan Name *</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Sprint 12 Regression"
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">Description</label>
              <input
                type="text"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="Optional description"
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">Target Release</label>
              <input
                type="text"
                value={newRelease}
                onChange={(e) => setNewRelease(e.target.value)}
                placeholder="e.g. v2.1.0"
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
              />
            </div>
          </div>
          {createError && (
            <p className="mt-3 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {createError}
            </p>
          )}
          <div className="flex items-center gap-3 mt-4">
            <button type="submit" disabled={creating || !newName.trim()} className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white py-2 px-4 text-sm font-medium transition-colors">
              {creating ? "Creating..." : "Create Plan"}
            </button>
            <button type="button" onClick={() => { setShowCreate(false); setNewName(""); setNewDesc(""); setNewRelease(""); setCreateError(null); }} className="rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 py-2 px-4 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors">
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Plans list */}
      {plans.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center">
          <svg className="mx-auto w-12 h-12 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
          <h3 className="mt-4 text-sm font-semibold text-zinc-900 dark:text-zinc-100">No test plans yet</h3>
          <p className="mt-1 text-sm text-zinc-500">
            {canManagePlans
              ? "Create your first test plan to organize test runs and track progress."
              : "No test plans have been created for this project yet."}
          </p>
          {canManagePlans && (
            <button
              onClick={() => setShowCreate(true)}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white py-2 px-4 text-sm font-medium transition-colors"
            >
              Create Test Plan
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {plans.map((plan) => {
            const total = plan.totalCases || 0;
            return (
              <Link
                key={plan.id}
                href={`/projects/${projectId}/plans/${plan.id}`}
                className="block rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5 hover:border-blue-300 dark:hover:border-blue-600 hover:shadow-md transition-all group"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3">
                      <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors truncate">
                        {plan.name}
                      </h3>
                      {plan.targetRelease && (
                        <span className="inline-flex items-center rounded-full bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 px-2.5 py-0.5 text-xs font-medium shrink-0">
                          {plan.targetRelease}
                        </span>
                      )}
                    </div>
                    {plan.description && (
                      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400 line-clamp-1">{plan.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 ml-4 shrink-0">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                      {plan.runCount} {plan.runCount === 1 ? "run" : "runs"}
                    </span>
                    {total > 0 && (
                      <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-bold ${
                        plan.completionPercent === 100
                          ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
                          : plan.completionPercent > 0
                          ? "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                          : "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
                      }`}>
                        {plan.completionPercent}%
                      </span>
                    )}
                  </div>
                </div>

                {/* Progress bar & stats */}
                {total > 0 && (
                  <div className="mt-4">
                    <ProgressBar passed={plan.passed} failed={plan.failed} untested={plan.untested} total={total} />
                    <div className="flex items-center gap-4 mt-2">
                      <span className="text-xs text-zinc-500">{total} total cases</span>
                      <StatusBadge count={plan.passed} label="passed" color="text-emerald-600 dark:text-emerald-400" />
                      <StatusBadge count={plan.failed} label="failed" color="text-red-600 dark:text-red-400" />
                      <StatusBadge count={plan.untested} label="untested" color="text-zinc-500 dark:text-zinc-400" />
                    </div>
                  </div>
                )}

                {total === 0 && (
                  <p className="mt-3 text-xs text-zinc-400 dark:text-zinc-500">No runs associated yet</p>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
