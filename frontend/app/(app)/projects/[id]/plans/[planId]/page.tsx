"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  authMe,
  getPlan,
  updatePlan,
  deletePlan,
  listPlanItems,
  listPlanRuns,
  getPlanProgress,
  listTestRuns,
  createCycleFromPlan,
  associateRunWithPlan,
  dissociateRunFromPlan,
  type PlanRunItem,
  type PlanProgress,
  type TestRunListItem,
} from "@/lib/api";

/* ───── Shared UI components ───── */

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    Passed: "bg-emerald-500",
    Failed: "bg-red-500",
    Blocked: "bg-amber-500",
    Skipped: "bg-slate-400",
    Untested: "bg-zinc-300 dark:bg-zinc-600",
  };
  return <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${colors[status] || "bg-zinc-400"}`} />;
}

function ProgressBar({ passed, failed, blocked, skipped, total }: { passed: number; failed: number; blocked: number; skipped: number; total: number }) {
  if (total === 0) return <div className="h-3 rounded-full bg-zinc-200 dark:bg-zinc-700 w-full" />;
  const segments = [
    { value: passed, color: "bg-emerald-500" },
    { value: failed, color: "bg-red-500" },
    { value: blocked, color: "bg-amber-500" },
    { value: skipped, color: "bg-slate-400" },
  ];
  const remaining = total - passed - failed - blocked - skipped;
  return (
    <div className="h-3 rounded-full bg-zinc-200 dark:bg-zinc-700 w-full overflow-hidden flex">
      {segments.map(({ value, color }, i) =>
        value > 0 ? <div key={i} className={`${color} h-full transition-all duration-500`} style={{ width: `${(value / total) * 100}%` }} /> : null
      )}
      {remaining > 0 && <div className="bg-zinc-300 dark:bg-zinc-600 h-full transition-all duration-500" style={{ width: `${(remaining / total) * 100}%` }} />}
    </div>
  );
}

function StatCard({ label, value, color, icon }: { label: string; value: number; color: string; icon: React.ReactNode }) {
  return (
    <div className={`rounded-xl border p-4 ${color}`}>
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-xs font-medium uppercase tracking-wide opacity-70">{label}</span>
      </div>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    Planning: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    "In Progress": "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
    Completed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status] || styles.Planning}`}>
      {status}
    </span>
  );
}

/* ───── Main Page ───── */

export default function PlanDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const planId = params.planId as string;

  const [plan, setPlan] = useState<Record<string, unknown> | null>(null);
  const [items, setItems] = useState<{ id: string; suiteId: string | null; testcaseId: string | null }[]>([]);
  const [runs, setRuns] = useState<PlanRunItem[]>([]);
  const [progress, setProgress] = useState<PlanProgress | null>(null);
  const [loading, setLoading] = useState(true);

  // Create cycle from plan
  const [creatingCycle, setCreatingCycle] = useState(false);
  const [newCycleName, setNewCycleName] = useState("");
  const [showCreateCycle, setShowCreateCycle] = useState(false);

  // Associate existing run
  const [showAssociate, setShowAssociate] = useState(false);
  const [allRuns, setAllRuns] = useState<TestRunListItem[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [associating, setAssociating] = useState<string | null>(null);

  // Edit plan
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editRelease, setEditRelease] = useState("");

  // Tab state
  const [activeTab, setActiveTab] = useState<"runs" | "items">("runs");

  const loadData = useCallback(async () => {
    try {
      const [p, i, r, pg] = await Promise.all([
        getPlan(planId),
        listPlanItems(planId),
        listPlanRuns(planId),
        getPlanProgress(planId),
      ]);
      setPlan(p);
      setItems(i);
      setRuns(r);
      setProgress(pg);
    } catch {
      router.replace("/projects");
    }
  }, [planId, router]);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      loadData().finally(() => setLoading(false));
    });
  }, [loadData, router]);

  async function handleCreateCycle(e: React.FormEvent) {
    e.preventDefault();
    const name = newCycleName.trim() || (plan?.name as string) || "Test Run";
    setCreatingCycle(true);
    try {
      const c = await createCycleFromPlan(projectId, { planId, name });
      setShowCreateCycle(false);
      setNewCycleName("");
      await loadData();
    } finally {
      setCreatingCycle(false);
    }
  }

  async function handleOpenAssociate() {
    setShowAssociate(true);
    setLoadingRuns(true);
    try {
      const all = await listTestRuns(projectId);
      // Filter out runs already associated with this plan
      const associatedIds = new Set(runs.map((r) => r.id));
      setAllRuns(all.filter((r) => !associatedIds.has(r.id)));
    } finally {
      setLoadingRuns(false);
    }
  }

  async function handleAssociate(cycleId: string) {
    setAssociating(cycleId);
    try {
      await associateRunWithPlan(cycleId, planId);
      setShowAssociate(false);
      await loadData();
    } finally {
      setAssociating(null);
    }
  }

  async function handleDissociate(cycleId: string) {
    if (!confirm("Remove this run from the plan?")) return;
    await dissociateRunFromPlan(cycleId);
    await loadData();
  }

  async function handleSaveEdit() {
    await updatePlan(planId, {
      name: editName || undefined,
      description: editDesc,
      targetRelease: editRelease,
    });
    setEditing(false);
    await loadData();
  }

  async function handleDelete() {
    if (!confirm("Delete this test plan? Associated runs will not be deleted but will be unlinked.")) return;
    await deletePlan(planId);
    router.push(`/projects/${projectId}/plans`);
  }

  if (loading || !plan) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-zinc-500 text-sm">Loading plan...</p>
        </div>
      </div>
    );
  }

  const total = progress?.totalCases || 0;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* Header */}
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-4">
        <div className="max-w-6xl mx-auto">
          {/* Breadcrumb */}
          <nav className="flex items-center gap-2 text-sm text-zinc-500 mb-3">
            <Link href={`/projects/${projectId}/plans`} className="hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors">
              Test Plans
            </Link>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
            <span className="text-zinc-700 dark:text-zinc-300 font-medium">{plan.name as string}</span>
          </nav>

          <div className="flex items-start justify-between">
            <div className="flex-1">
              {editing ? (
                <div className="space-y-3 max-w-lg">
                  <input value={editName} onChange={(e) => setEditName(e.target.value)} className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-lg font-semibold" />
                  <input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="Description" className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm" />
                  <input value={editRelease} onChange={(e) => setEditRelease(e.target.value)} placeholder="Target release" className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm" />
                  <div className="flex gap-2">
                    <button onClick={handleSaveEdit} className="rounded-lg bg-blue-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-blue-700">Save</button>
                    <button onClick={() => setEditing(false)} className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-4 py-1.5 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800">Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{plan.name as string}</h1>
                    {plan.targetRelease && (
                      <span className="inline-flex items-center rounded-full bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 px-3 py-0.5 text-xs font-medium">
                        {plan.targetRelease as string}
                      </span>
                    )}
                  </div>
                  {plan.description && <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{plan.description as string}</p>}
                </>
              )}
            </div>
            {!editing && (
              <div className="flex items-center gap-2 ml-4">
                <button
                  onClick={() => { setEditName(plan.name as string); setEditDesc((plan.description as string) || ""); setEditRelease((plan.targetRelease as string) || ""); setEditing(true); }}
                  className="rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 py-2 px-3 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={handleDelete}
                  className="rounded-lg border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 py-2 px-3 text-sm hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        {/* Progress Dashboard */}
        {progress && total > 0 && (
          <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Overall Progress</h2>
              <span className={`text-2xl font-bold ${progress.completionPercent === 100 ? "text-emerald-600" : progress.completionPercent > 0 ? "text-blue-600" : "text-zinc-400"}`}>
                {progress.completionPercent}%
              </span>
            </div>

            <ProgressBar passed={progress.passed} failed={progress.failed} blocked={progress.blocked} skipped={progress.skipped} total={total} />

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mt-5">
              <StatCard
                label="Total"
                value={total}
                color="border-zinc-200 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100"
                icon={<svg className="w-4 h-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>}
              />
              <StatCard
                label="Passed"
                value={progress.passed}
                color="border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/20"
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>}
              />
              <StatCard
                label="Failed"
                value={progress.failed}
                color="border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/20"
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>}
              />
              <StatCard
                label="Blocked"
                value={progress.blocked}
                color="border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/20"
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>}
              />
              <StatCard
                label="Skipped"
                value={progress.skipped}
                color="border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-900/20"
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" /></svg>}
              />
              <StatCard
                label="Untested"
                value={progress.untested}
                color="border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400"
                icon={<svg className="w-4 h-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
              />
            </div>
          </section>
        )}

        {/* No progress state */}
        {progress && total === 0 && (
          <section className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-8 text-center">
            <svg className="mx-auto w-10 h-10 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">No test runs associated with this plan yet. Create a new run or link an existing one to start tracking progress.</p>
          </section>
        )}

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-zinc-200 dark:border-zinc-700">
          <button
            onClick={() => setActiveTab("runs")}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "runs"
                ? "border-blue-600 text-blue-600 dark:text-blue-400"
                : "border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            }`}
          >
            Test Runs ({runs.length})
          </button>
          <button
            onClick={() => setActiveTab("items")}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "items"
                ? "border-blue-600 text-blue-600 dark:text-blue-400"
                : "border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            }`}
          >
            Plan Items ({items.length})
          </button>
        </div>

        {/* Runs Tab */}
        {activeTab === "runs" && (
          <section>
            {/* Actions */}
            <div className="flex items-center gap-2 mb-4">
              <button
                onClick={() => setShowCreateCycle(!showCreateCycle)}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white py-2 px-4 text-sm font-medium transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                New Run from Plan
              </button>
              <button
                onClick={handleOpenAssociate}
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 py-2 px-4 text-sm font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                Link Existing Run
              </button>
            </div>

            {/* Create new cycle form */}
            {showCreateCycle && (
              <form onSubmit={handleCreateCycle} className="mb-4 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 flex items-end gap-3">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">Run Name</label>
                  <input
                    value={newCycleName}
                    onChange={(e) => setNewCycleName(e.target.value)}
                    placeholder={(plan.name as string) || "Test Run"}
                    className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
                    autoFocus
                  />
                </div>
                <button type="submit" disabled={creatingCycle} className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white py-2 px-4 text-sm font-medium transition-colors shrink-0">
                  {creatingCycle ? "Creating..." : "Create"}
                </button>
                <button type="button" onClick={() => setShowCreateCycle(false)} className="rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 py-2 px-3 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors shrink-0">
                  Cancel
                </button>
              </form>
            )}

            {/* Associate existing run modal */}
            {showAssociate && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
                <div className="w-full max-w-lg rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-2xl">
                  <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 dark:border-zinc-700">
                    <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Link Existing Test Run</h3>
                    <button onClick={() => setShowAssociate(false)} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                  <div className="p-5 max-h-80 overflow-y-auto">
                    {loadingRuns ? (
                      <div className="flex items-center justify-center py-8">
                        <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                      </div>
                    ) : allRuns.length === 0 ? (
                      <p className="text-sm text-zinc-500 text-center py-8">No unlinked test runs available.</p>
                    ) : (
                      <ul className="space-y-2">
                        {allRuns.map((run) => (
                          <li key={run.id} className="flex items-center justify-between rounded-lg border border-zinc-200 dark:border-zinc-700 p-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">{run.name}</p>
                              <div className="flex items-center gap-2 mt-0.5">
                                <RunStatusBadge status={run.status} />
                                <span className="text-xs text-zinc-500">{run.totalCases} cases</span>
                              </div>
                            </div>
                            <button
                              onClick={() => handleAssociate(run.id)}
                              disabled={associating === run.id}
                              className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white py-1.5 px-3 text-xs font-medium transition-colors shrink-0 ml-3"
                            >
                              {associating === run.id ? "Linking..." : "Link"}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Runs list */}
            {runs.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-8 text-center">
                <p className="text-sm text-zinc-500">No runs associated with this plan. Create a new run or link an existing one.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {runs.map((run) => {
                  const runTotal = run.totalCases;
                  const runExecuted = runTotal - run.untested;
                  const runPercent = runTotal > 0 ? Math.round((runExecuted / runTotal) * 100) : 0;
                  return (
                    <div key={run.id} className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 hover:border-blue-200 dark:hover:border-blue-700 transition-all">
                      <div className="flex items-start justify-between">
                        <Link href={`/projects/${projectId}/cycles/${run.id}`} className="flex-1 min-w-0 group">
                          <div className="flex items-center gap-3">
                            <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors truncate">
                              {run.name}
                            </h4>
                            <RunStatusBadge status={run.status} />
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-xs text-zinc-500">
                            {run.environment && <span>Env: {run.environment}</span>}
                            {run.buildVersion && <span>Build: {run.buildVersion}</span>}
                            <span>{new Date(run.createdAt).toLocaleDateString()}</span>
                          </div>
                        </Link>
                        <div className="flex items-center gap-2 ml-4 shrink-0">
                          <span className={`text-sm font-bold ${runPercent === 100 ? "text-emerald-600" : "text-zinc-500"}`}>
                            {runPercent}%
                          </span>
                          <button
                            onClick={() => handleDissociate(run.id)}
                            title="Unlink from plan"
                            className="rounded-lg p-1.5 text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                          </button>
                        </div>
                      </div>

                      {/* Per-run progress bar */}
                      {runTotal > 0 && (
                        <div className="mt-3">
                          <ProgressBar passed={run.passed} failed={run.failed} blocked={run.blocked} skipped={run.skipped} total={runTotal} />
                          <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                            <span className="text-xs text-zinc-500">{runTotal} cases</span>
                            {run.passed > 0 && <span className="flex items-center gap-1 text-xs"><StatusDot status="Passed" />{run.passed} passed</span>}
                            {run.failed > 0 && <span className="flex items-center gap-1 text-xs"><StatusDot status="Failed" />{run.failed} failed</span>}
                            {run.blocked > 0 && <span className="flex items-center gap-1 text-xs"><StatusDot status="Blocked" />{run.blocked} blocked</span>}
                            {run.skipped > 0 && <span className="flex items-center gap-1 text-xs"><StatusDot status="Skipped" />{run.skipped} skipped</span>}
                            {run.untested > 0 && <span className="flex items-center gap-1 text-xs"><StatusDot status="Untested" />{run.untested} untested</span>}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* Items Tab */}
        {activeTab === "items" && (
          <section>
            {items.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-8 text-center">
                <p className="text-sm text-zinc-500">No items in this plan. Items are suites or test cases that define the scope of the plan.</p>
              </div>
            ) : (
              <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50">
                      <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">#</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Type</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, i) => (
                      <tr key={item.id} className="border-b border-zinc-100 dark:border-zinc-800 last:border-0">
                        <td className="px-4 py-3 text-zinc-500">{i + 1}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                            item.suiteId ? "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300" : "bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300"
                          }`}>
                            {item.suiteId ? "Suite" : "Test Case"}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400 font-mono text-xs">
                          {item.suiteId || item.testcaseId}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
