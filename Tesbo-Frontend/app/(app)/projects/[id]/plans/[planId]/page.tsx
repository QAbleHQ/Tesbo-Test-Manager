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
  getProject,
  type PlanRunItem,
  type PlanProgress,
  type TestRunListItem,
  type TestEnvironmentSetting,
} from "@/lib/api";
import { Button, StatusChip, Input, Select } from "@/components/ui";
import Modal from "@/components/ui/Modal";

/* ───── Shared UI components ───── */

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    Passed: "bg-emerald-500",
    Failed: "bg-red-500",
    Blocked: "bg-amber-500",
    Skipped: "bg-slate-400",
    Untested: "bg-[var(--surface-tertiary)]",
  };
  return <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${colors[status] || "bg-[var(--muted-soft)]"}`} />;
}

function ProgressBar({ passed, failed, blocked, skipped, total }: { passed: number; failed: number; blocked: number; skipped: number; total: number }) {
  if (total === 0) return <div className="h-3 rounded-full bg-[var(--surface-tertiary)] w-full" />;
  const segments = [
    { value: passed, color: "bg-emerald-500" },
    { value: failed, color: "bg-red-500" },
    { value: blocked, color: "bg-amber-500" },
    { value: skipped, color: "bg-slate-400" },
  ];
  const remaining = total - passed - failed - blocked - skipped;
  return (
    <div className="h-3 rounded-full bg-[var(--surface-tertiary)] w-full overflow-hidden flex">
      {segments.map(({ value, color }, i) =>
        value > 0 ? <div key={i} className={`${color} h-full transition-all duration-500`} style={{ width: `${(value / total) * 100}%` }} /> : null
      )}
      {remaining > 0 && <div className="bg-[var(--surface-tertiary)] h-full transition-all duration-500" style={{ width: `${(remaining / total) * 100}%` }} />}
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

function runStatusToTone(status: string) {
  const map: Record<string, "success" | "info" | "warning" | "neutral"> = {
    Completed: "success",
    "In Progress": "info",
    Planning: "neutral",
  };
  return map[status] ?? "neutral";
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
  const [environmentOptions, setEnvironmentOptions] = useState<TestEnvironmentSetting[]>([]);
  const [selectedEnvironment, setSelectedEnvironment] = useState("");

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

  function parseProjectSettings(raw: unknown): { testRunEnvironments?: Array<{ name?: string; url?: string }> } {
    if (typeof raw !== "string" || !raw.trim()) return {};
    try {
      const parsed = JSON.parse(raw) as { testRunEnvironments?: Array<{ name?: string; url?: string }> };
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function normalizeTestRunEnvironments(raw: unknown): TestEnvironmentSetting[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => {
        const candidate = item as { name?: unknown; url?: unknown };
        const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
        const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
        if (!name || !url) return null;
        return { name, url };
      })
      .filter((item): item is TestEnvironmentSetting => item !== null);
  }

  const loadData = useCallback(async () => {
    try {
      const [p, i, r, pg, project] = await Promise.all([
        getPlan(planId),
        listPlanItems(planId),
        listPlanRuns(planId),
        getPlanProgress(planId),
        getProject(projectId),
      ]);
      setPlan(p);
      setItems(i);
      setRuns(r);
      setProgress(pg);
      const parsedSettings = parseProjectSettings(project.settings);
      const environments = normalizeTestRunEnvironments(parsedSettings.testRunEnvironments);
      setEnvironmentOptions(environments);
      setSelectedEnvironment((prev) => {
        if (prev && environments.some((item) => item.name === prev)) return prev;
        return environments[0]?.name ?? "";
      });
    } catch {
      router.replace("/projects");
    }
  }, [planId, projectId, router]);

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
    if (!selectedEnvironment.trim()) return;
    const name = newCycleName.trim() || planName || "Test Run";
    setCreatingCycle(true);
    try {
      await createCycleFromPlan(projectId, { planId, name, environment: selectedEnvironment });
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
          <div className="w-8 h-8 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin" />
          <p className="text-[var(--muted)] text-sm">Loading plan...</p>
        </div>
      </div>
    );
  }

  const total = progress?.totalCases || 0;
  const planName = typeof plan.name === "string" ? plan.name : "";
  const planDescription = typeof plan.description === "string" ? plan.description : "";
  const planTargetRelease = typeof plan.targetRelease === "string" ? plan.targetRelease : "";

  return (
    <div className="min-h-screen bg-[var(--background)]">
      {/* Header */}
      <header className="border-b border-[var(--border)] bg-[var(--surface)] px-6 py-4">
        <div className="max-w-6xl mx-auto">
          {/* Breadcrumb */}
          <nav className="flex items-center gap-2 text-sm text-[var(--muted)] mb-3">
            <Link href={`/projects/${projectId}/plans`} className="hover:text-[var(--foreground)] transition-colors">
              Test Plans
            </Link>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
            <span className="text-[var(--foreground)] font-medium">{planName}</span>
          </nav>

          <div className="flex items-start justify-between">
            <div className="flex-1">
              {editing ? (
                <div className="space-y-3 max-w-lg">
                  <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="text-lg font-semibold" />
                  <Input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="Description" />
                  <Input value={editRelease} onChange={(e) => setEditRelease(e.target.value)} placeholder="Target release" />
                  <div className="flex gap-2">
                    <Button onClick={handleSaveEdit}>Save</Button>
                    <Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <h1 className="text-2xl font-bold text-[var(--foreground)]">{planName}</h1>
                    {planTargetRelease && (
                      <span className="inline-flex items-center rounded-full bg-violet-100 text-violet-700 px-3 py-0.5 text-xs font-medium">
                        {planTargetRelease}
                      </span>
                    )}
                  </div>
                  {planDescription && <p className="mt-1 text-sm text-[var(--muted)]">{planDescription}</p>}
                </>
              )}
            </div>
            {!editing && (
              <div className="flex items-center gap-2 ml-4">
                <Button
                  variant="secondary"
                  onClick={() => { setEditName(planName); setEditDesc(planDescription); setEditRelease(planTargetRelease); setEditing(true); }}
                >
                  Edit
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleDelete}
                >
                  Delete
                </Button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        {/* Progress Dashboard */}
        {progress && total > 0 && (
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-[var(--foreground)]">Overall Progress</h2>
              <span className={`text-2xl font-bold ${progress.completionPercent === 100 ? "text-emerald-600" : progress.completionPercent > 0 ? "text-[var(--brand-primary)]" : "text-[var(--muted-soft)]"}`}>
                {progress.completionPercent}%
              </span>
            </div>

            <ProgressBar passed={progress.passed} failed={progress.failed} blocked={progress.blocked} skipped={progress.skipped} total={total} />

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mt-5">
              <StatCard
                label="Total"
                value={total}
                color="border-[var(--border)] text-[var(--foreground)]"
                icon={<svg className="w-4 h-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>}
              />
              <StatCard
                label="Passed"
                value={progress.passed}
                color="border-emerald-200 text-emerald-700 bg-emerald-50"
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>}
              />
              <StatCard
                label="Failed"
                value={progress.failed}
                color="border-red-200 text-red-700 bg-red-50"
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>}
              />
              <StatCard
                label="Blocked"
                value={progress.blocked}
                color="border-amber-200 text-amber-700 bg-amber-50"
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>}
              />
              <StatCard
                label="Skipped"
                value={progress.skipped}
                color="border-slate-200 text-slate-600 bg-slate-50"
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" /></svg>}
              />
              <StatCard
                label="Untested"
                value={progress.untested}
                color="border-[var(--border)] text-[var(--muted)]"
                icon={<svg className="w-4 h-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
              />
            </div>
          </section>
        )}

        {/* No progress state */}
        {progress && total === 0 && (
          <section className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-8 text-center">
            <svg className="mx-auto w-10 h-10 text-[var(--muted-soft)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            <p className="mt-3 text-sm text-[var(--muted)]">No test runs associated with this plan yet. Create a new run or link an existing one to start tracking progress.</p>
          </section>
        )}

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-[var(--border)]">
          <button
            onClick={() => setActiveTab("runs")}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "runs"
                ? "border-[var(--brand-primary)] text-[var(--brand-primary)]"
                : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
            }`}
          >
            Test Runs ({runs.length})
          </button>
          <button
            onClick={() => setActiveTab("items")}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "items"
                ? "border-[var(--brand-primary)] text-[var(--brand-primary)]"
                : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
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
              <Button onClick={() => setShowCreateCycle(!showCreateCycle)}>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                New Run from Plan
              </Button>
              <Button variant="secondary" onClick={handleOpenAssociate}>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                Link Existing Run
              </Button>
            </div>

            {/* Create new cycle form */}
            {showCreateCycle && (
              <form onSubmit={handleCreateCycle} className="mb-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
                <div>
                  <label className="block text-xs font-medium text-[var(--muted)] mb-1">Run Name</label>
                  <Input
                    value={newCycleName}
                    onChange={(e) => setNewCycleName(e.target.value)}
                    placeholder={planName || "Test Run"}
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--muted)] mb-1">
                    Environment <span className="text-[var(--error)]">*</span>
                  </label>
                  <Select
                    value={selectedEnvironment}
                    onChange={(e) => setSelectedEnvironment(e.target.value)}
                    required
                  >
                    <option value="">Select environment</option>
                    {environmentOptions.map((env) => (
                      <option key={env.name} value={env.name}>
                        {env.name}
                      </option>
                    ))}
                  </Select>
                  {selectedEnvironment && (
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      URL: {environmentOptions.find((item) => item.name === selectedEnvironment)?.url ?? "Not available"}
                    </p>
                  )}
                  {environmentOptions.length === 0 && (
                    <p className="mt-1 text-xs text-amber-600">
                      No environments configured in project settings.
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="submit"
                    disabled={creatingCycle || !selectedEnvironment.trim() || environmentOptions.length === 0}
                  >
                    {creatingCycle ? "Creating..." : "Create"}
                  </Button>
                  <Button variant="secondary" type="button" onClick={() => setShowCreateCycle(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}

            {/* Associate existing run modal */}
            <Modal open={showAssociate} onClose={() => setShowAssociate(false)} title="Link Existing Test Run">
              <div className="max-h-80 overflow-y-auto">
                {loadingRuns ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="w-6 h-6 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : allRuns.length === 0 ? (
                  <p className="text-sm text-[var(--muted)] text-center py-8">No unlinked test runs available.</p>
                ) : (
                  <ul className="space-y-2">
                    {allRuns.map((run) => (
                      <li key={run.id} className="flex items-center justify-between rounded-lg border border-[var(--border)] p-3 hover:bg-[var(--surface-secondary)] transition-colors">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-[var(--foreground)] truncate">{run.name}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <StatusChip tone={runStatusToTone(run.status)}>{run.status}</StatusChip>
                            <span className="text-xs text-[var(--muted)]">{run.totalCases} cases</span>
                          </div>
                        </div>
                        <Button
                          size="sm"
                          onClick={() => handleAssociate(run.id)}
                          disabled={associating === run.id}
                          className="shrink-0 ml-3"
                        >
                          {associating === run.id ? "Linking..." : "Link"}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Modal>

            {/* Runs list */}
            {runs.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--border)] p-8 text-center">
                <p className="text-sm text-[var(--muted)]">No runs associated with this plan. Create a new run or link an existing one.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {runs.map((run) => {
                  const runTotal = run.totalCases;
                  const runExecuted = runTotal - run.untested;
                  const runPercent = runTotal > 0 ? Math.round((runExecuted / runTotal) * 100) : 0;
                  return (
                    <div key={run.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 hover:border-[var(--brand-primary)] transition-all">
                      <div className="flex items-start justify-between">
                        <Link href={`/projects/${projectId}/cycles/${run.id}`} className="flex-1 min-w-0 group">
                          <div className="flex items-center gap-3">
                            <h4 className="text-sm font-semibold text-[var(--foreground)] group-hover:text-[var(--brand-primary)] transition-colors truncate">
                              {run.name}
                            </h4>
                            <StatusChip tone={runStatusToTone(run.status)}>{run.status}</StatusChip>
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-xs text-[var(--muted)]">
                            {run.environment && <span>Env: {run.environment}</span>}
                            {run.buildVersion && <span>Build: {run.buildVersion}</span>}
                            <span>{new Date(run.createdAt).toLocaleDateString()}</span>
                          </div>
                        </Link>
                        <div className="flex items-center gap-2 ml-4 shrink-0">
                          <span className={`text-sm font-bold ${runPercent === 100 ? "text-emerald-600" : "text-[var(--muted)]"}`}>
                            {runPercent}%
                          </span>
                          <button
                            onClick={() => handleDissociate(run.id)}
                            title="Unlink from plan"
                            className="rounded-lg p-1.5 text-[var(--muted-soft)] hover:text-[var(--error)] hover:bg-red-50 transition-colors"
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
                            <span className="text-xs text-[var(--muted)]">{runTotal} cases</span>
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
              <div className="rounded-xl border border-dashed border-[var(--border)] p-8 text-center">
                <p className="text-sm text-[var(--muted)]">No items in this plan. Items are suites or test cases that define the scope of the plan.</p>
              </div>
            ) : (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--border)] bg-[var(--surface-secondary)]">
                      <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">#</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Type</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, i) => (
                      <tr key={item.id} className="border-b border-[var(--border-subtle)] last:border-0">
                        <td className="px-4 py-3 text-[var(--muted)]">{i + 1}</td>
                        <td className="px-4 py-3">
                          <StatusChip tone={item.suiteId ? "info" : "brand"}>
                            {item.suiteId ? "Suite" : "Test Case"}
                          </StatusChip>
                        </td>
                        <td className="px-4 py-3 text-[var(--muted)] font-mono text-xs">
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
