"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import {
  authMe,
  getTestRun,
  updateTestRun,
  listCycleExecutions,
  updateExecution,
  addTestCasesToRun,
  removeTestCaseFromRun,
  listTestCases,
  listSuites,
  toggleTestRunShare,
  createBug,
  type TestRunDetail,
  type ExecutionItem,
  type TestCaseListItem,
  type SuiteNode,
} from "@/lib/api";
import { Button, StatusChip, Input, Select, Textarea } from "@/components/ui";
import Modal from "@/components/ui/Modal";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7000";

/* ───── Constants ───── */
const EXEC_STATUSES = ["Untested", "Passed", "Failed", "Skipped", "Blocked", "Retest"] as const;

/* ───── Status tone helpers ───── */
function statusToTone(status: string) {
  const map: Record<string, "success" | "error" | "warning" | "info" | "neutral"> = {
    Passed: "success",
    Failed: "error",
    Skipped: "warning",
    Blocked: "warning",
    Retest: "info",
    Untested: "neutral",
  };
  return map[status] ?? "neutral";
}

function runStatusToTone(status: string) {
  const map: Record<string, "success" | "info" | "warning" | "neutral"> = {
    Completed: "success",
    "In Progress": "info",
    Planning: "warning",
  };
  return map[status] ?? "neutral";
}

/* ───── Donut chart (pure SVG) ───── */
function DonutChart({
  data,
  size = 180,
}: {
  data: { label: string; value: number; color: string }[];
  size?: number;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) {
    return (
      <svg width={size} height={size} viewBox="0 0 36 36">
        <circle cx="18" cy="18" r="15.915" fill="none" stroke="#e4e4e7" strokeWidth="3" />
        <text x="18" y="19.5" textAnchor="middle" className="text-[3.5px] fill-[var(--muted-soft)] font-medium">
          No data
        </text>
      </svg>
    );
  }
  const radius = 15.915;
  const circumference = 2 * Math.PI * radius;

  return (
    <svg width={size} height={size} viewBox="0 0 36 36" className="drop-shadow-sm">
      {data.map((d, index) => {
        const pct = d.value / total;
        const cumulative = data
          .slice(0, index)
          .reduce((sum, segment) => sum + segment.value / total, 0);
        const dashArray = `${pct * circumference} ${circumference}`;
        const dashOffset = circumference - cumulative * circumference;
        return (
          <circle
            key={d.label}
            cx="18"
            cy="18"
            r={radius}
            fill="none"
            stroke={d.color}
            strokeWidth="3.5"
            strokeDasharray={dashArray}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            transform="rotate(-90 18 18)"
          />
        );
      })}
      <text x="18" y="17" textAnchor="middle" className="text-[5px] font-bold fill-[var(--foreground)]">
        {total}
      </text>
      <text x="18" y="21" textAnchor="middle" className="text-[2.5px] fill-[var(--muted-soft)] font-medium">
        Total
      </text>
    </svg>
  );
}

/* ───── Card metric ───── */
function MetricCard({
  label,
  value,
  color,
  icon,
}: {
  label: string;
  value: number;
  color: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 flex items-center gap-3">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${color}`}>
        {icon}
      </div>
      <div>
        <p className="text-2xl font-bold text-[var(--foreground)]">{value}</p>
        <p className="text-xs text-[var(--muted)]">{label}</p>
      </div>
    </div>
  );
}

/* ═══════════════════ MAIN PAGE ═══════════════════ */
export default function TestRunDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const cycleId = params.cycleId as string;

  const [run, setRun] = useState<TestRunDetail | null>(null);
  const [executions, setExecutions] = useState<ExecutionItem[]>([]);
  const [loading, setLoading] = useState(true);

  /* test case picker state */
  const [showPicker, setShowPicker] = useState(false);
  const [allCases, setAllCases] = useState<TestCaseListItem[]>([]);
  const [suites, setSuites] = useState<SuiteNode[]>([]);
  const [casesLoading, setCasesLoading] = useState(false);
  const [selectedCases, setSelectedCases] = useState<Set<string>>(new Set());
  const [filterSearch, setFilterSearch] = useState("");
  const [filterPriority, setFilterPriority] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterSuiteId, setFilterSuiteId] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [adding, setAdding] = useState(false);

  /* inline status editing */
  const [statusSaving, setStatusSaving] = useState<string | null>(null);

  /* sharing state */
  const [showShare, setShowShare] = useState(false);
  const [shareEnabled, setShareEnabled] = useState(false);
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [shareToggling, setShareToggling] = useState(false);
  const [copied, setCopied] = useState(false);

  /* bug report dialog state (triggered on "Failed") */
  const [showBugDialog, setShowBugDialog] = useState(false);
  const [bugExecution, setBugExecution] = useState<ExecutionItem | null>(null);
  const [bugTitle, setBugTitle] = useState("");
  const [bugDesc, setBugDesc] = useState("");
  const [bugUrl, setBugUrl] = useState("");
  const [bugSaving, setBugSaving] = useState(false);
  const load = useCallback(() => {
    Promise.all([getTestRun(cycleId), listCycleExecutions(cycleId)])
      .then(([r, e]) => {
        setRun(r);
        setExecutions(e);
        setShareEnabled(r.shareEnabled ?? false);
        setShareToken(r.shareToken ?? null);
      })
      .catch(() => router.replace(`/projects/${projectId}/cycles`))
      .finally(() => setLoading(false));
  }, [cycleId, projectId, router]);


  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      load();
      
    });
  }, [router, load]);


  /* ───── Load test cases for picker ───── */
  async function openPicker() {
    setShowPicker(true);
    setCasesLoading(true);
    setSelectedCases(new Set());
    try {
      const [casesResult, suitesResult] = await Promise.all([
        listTestCases(projectId, { limit: 1000 }),
        listSuites(projectId),
      ]);
      setAllCases(casesResult.list);
      setSuites(suitesResult);
    } catch {
      // ignore
    } finally {
      setCasesLoading(false);
    }
  }

  /* already-included case IDs */
  const includedCaseIds = useMemo(
    () => new Set(executions.map((e) => e.testcaseId)),
    [executions]
  );

  /* filtered available cases (not already added) */
  const filteredCases = useMemo(() => {
    return allCases.filter((tc) => {
      if (includedCaseIds.has(tc.id)) return false;
      if (filterSearch && !tc.title.toLowerCase().includes(filterSearch.toLowerCase()) && !tc.externalId.toLowerCase().includes(filterSearch.toLowerCase())) return false;
      if (filterPriority && tc.priority !== filterPriority) return false;
      if (filterType && tc.type !== filterType) return false;
      if (filterSuiteId && tc.suiteId !== filterSuiteId) return false;
      if (filterStatus && tc.status !== filterStatus) return false;
      return true;
    });
  }, [allCases, includedCaseIds, filterSearch, filterPriority, filterType, filterSuiteId, filterStatus]);

  /* selectable = only Approved cases */
  const selectableCases = useMemo(
    () => filteredCases.filter((tc) => tc.status === "Approved"),
    [filteredCases]
  );

  /* toggle selection (only Approved) */
  function toggleCase(id: string) {
    const tc = filteredCases.find((c) => c.id === id);
    if (tc && tc.status !== "Approved") return;
    setSelectedCases((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selectedCases.size === selectableCases.length && selectableCases.length > 0) {
      setSelectedCases(new Set());
    } else {
      setSelectedCases(new Set(selectableCases.map((c) => c.id)));
    }
  }

  async function handleAddCases() {
    if (selectedCases.size === 0) return;
    setAdding(true);
    try {
      await addTestCasesToRun(cycleId, Array.from(selectedCases));
      setShowPicker(false);
      load();
    } finally {
      setAdding(false);
    }
  }

  /* ───── Inline status change ───── */
  async function handleStatusChange(executionId: string, newStatus: string) {
    setStatusSaving(executionId);
    try {
      await updateExecution(cycleId, executionId, { status: newStatus });
      setExecutions((prev) =>
        prev.map((e) => (e.id === executionId ? { ...e, status: newStatus } : e))
      );

      if (newStatus === "Failed") {
        const exec = executions.find((e) => e.id === executionId);
        if (exec) {
          setBugExecution({ ...exec, status: newStatus });
          setBugTitle(`Failed: ${exec.title}`);
          setBugDesc("");
          setBugUrl("");
          setShowBugDialog(true);
        }
      }
    } finally {
      setStatusSaving(null);
    }
  }

  /* ───── Submit bug from dialog ───── */
  async function handleBugSubmit() {
    if (!bugExecution || !bugTitle.trim()) return;
    setBugSaving(true);
    try {
      await createBug(projectId, {
        title: bugTitle.trim(),
        description: bugDesc.trim(),
        externalUrl: bugUrl.trim(),
        executionId: bugExecution.id,
        testcaseId: bugExecution.testcaseId,
        cycleId: cycleId,
      });
      setShowBugDialog(false);
      setBugExecution(null);
    } finally {
      setBugSaving(false);
    }
  }

  function handleBugSkip() {
    setShowBugDialog(false);
    setBugExecution(null);
  }

  /* ───── Remove test case ───── */
  async function handleRemoveCase(testcaseId: string) {
    try {
      await removeTestCaseFromRun(cycleId, testcaseId);
      setExecutions((prev) => prev.filter((e) => e.testcaseId !== testcaseId));
    } catch {
      // ignore
    }
  }

  /* ───── Change run status ───── */
  async function handleRunStatusChange(newStatus: string) {
    if (!run) return;
    try {
      await updateTestRun(cycleId, { status: newStatus });
      setRun({ ...run, status: newStatus });
    } catch {
      // ignore
    }
  }


  /* ───── Share toggle ───── */
  async function handleShareToggle(enabled: boolean) {
    setShareToggling(true);
    try {
      const result = await toggleTestRunShare(cycleId, enabled);
      setShareEnabled(result.shareEnabled);
      setShareToken(result.shareToken || null);
    } catch {
      // ignore
    } finally {
      setShareToggling(false);
    }
  }

  function getShareUrl() {
    if (!shareToken) return "";
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/share/${shareToken}`;
  }

  async function copyShareLink() {
    const url = getShareUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  /* ───── Compute stats ───── */
  const stats = useMemo(() => {
    const total = executions.length;
    const passed = executions.filter((e) => e.status === "Passed").length;
    const failed = executions.filter((e) => e.status === "Failed").length;
    const skipped = executions.filter((e) => e.status === "Skipped").length;
    const blocked = executions.filter((e) => e.status === "Blocked").length;
    const pending = executions.filter((e) => e.status === "Untested" || e.status === "Retest").length;
    return { total, passed, failed, skipped, blocked, pending };
  }, [executions]);

  const chartData = useMemo(
    () => [
      { label: "Passed", value: stats.passed, color: "#22c55e" },
      { label: "Failed", value: stats.failed, color: "#ef4444" },
      { label: "Skipped", value: stats.skipped, color: "#eab308" },
      { label: "Blocked", value: stats.blocked, color: "#f97316" },
      { label: "Pending", value: stats.pending, color: "#a1a1aa" },
    ],
    [stats]
  );


  if (loading || !run) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-[var(--muted)]">Loading…</p>
      </div>
    );
  }

  const isInProgress = run.status === "In Progress";
  const isPlanning = run.status === "Planning";
  const isCompleted = run.status === "Completed";

  return (
    <div className="min-h-screen bg-[var(--background)]">
      {/* ───── Breadcrumb ───── */}
      <header className="border-b border-[var(--border)] bg-[var(--surface)] px-6 py-3">
        <div className="flex items-center gap-2 text-sm">
          <Link href={`/projects/${projectId}/cycles`} className="text-[var(--muted)] hover:text-[var(--foreground)]">
            Test Runs
          </Link>
          <span className="text-[var(--muted-soft)]">/</span>
          <span className="text-[var(--foreground)] font-medium">{run.name}</span>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6">
        {/* ───── Title + Status + Actions ───── */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-[var(--foreground)]">
                {run.name}
              </h1>
              <StatusChip tone={runStatusToTone(run.status)}>{run.status}</StatusChip>
            </div>
            {run.description && (
              <p className="mt-1 text-sm text-[var(--muted)]">{run.description}</p>
            )}
            <div className="flex items-center gap-4 mt-2 text-xs text-[var(--muted-soft)]">
              {run.environment && <span>Env: {run.environment}</span>}
              {run.buildVersion && <span>Build: {run.buildVersion}</span>}
              <span>Created {new Date(run.createdAt).toLocaleDateString()}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isPlanning && (
              <Button onClick={() => handleRunStatusChange("In Progress")}>
                Start Execution
              </Button>
            )}
            {isInProgress && (
              <Button variant="primary" onClick={() => handleRunStatusChange("Completed")}>
                Mark Completed
              </Button>
            )}
            {isCompleted && (
              <Button variant="secondary" onClick={() => handleRunStatusChange("In Progress")}>
                Reopen
              </Button>
            )}
            {!isCompleted && (
              <Button variant="secondary" onClick={openPicker}>
                + Add Test Cases
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => setShowShare(true)}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
              Share
            </Button>
            <a
              href={`${API_BASE}/api/cycles/${cycleId}/export/csv`}
              className="rounded-lg border border-[var(--border)] text-[var(--foreground)] px-4 py-2 text-sm font-medium hover:bg-[var(--surface-secondary)]"
              target="_blank"
              rel="noreferrer"
            >
              Export CSV
            </a>
          </div>
        </div>

        {/* ───── Dashboard: Metric Cards + Donut Chart ───── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          {/* Metric cards (left 2 cols) */}
          <div className="lg:col-span-2 grid grid-cols-2 sm:grid-cols-3 gap-3">
            <MetricCard
              label="Total Cases"
              value={stats.total}
              color="bg-blue-50 text-blue-600"
              icon={
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
              }
            />
            <MetricCard
              label="Passed"
              value={stats.passed}
              color="bg-green-50 text-green-600"
              icon={
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              }
            />
            <MetricCard
              label="Failed"
              value={stats.failed}
              color="bg-red-50 text-red-600"
              icon={
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              }
            />
            <MetricCard
              label="Skipped"
              value={stats.skipped}
              color="bg-yellow-50 text-yellow-600"
              icon={
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                </svg>
              }
            />
            <MetricCard
              label="Pending"
              value={stats.pending}
              color="bg-[var(--surface-secondary)] text-[var(--muted)]"
              icon={
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
            />
          </div>

          {/* Donut chart (right col) */}
          <div className="flex flex-col items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <DonutChart data={chartData} size={160} />
            <div className="flex flex-wrap justify-center gap-3 mt-3">
              {chartData
                .filter((d) => d.value > 0)
                .map((d) => (
                  <div key={d.label} className="flex items-center gap-1.5 text-xs">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: d.color }} />
                    <span className="text-[var(--muted)]">
                      {d.label} ({d.value})
                    </span>
                  </div>
                ))}
            </div>
          </div>
        </div>

        {/* ───── Executions Table ───── */}
        <div className="rounded-xl border border-[var(--border)] overflow-hidden bg-[var(--surface)]">
          <div className="px-5 py-3 border-b border-[var(--border)] flex items-center justify-between">
            <h2 className="font-semibold text-[var(--foreground)]">
              Test Cases ({executions.length})
            </h2>
          </div>
          {executions.length === 0 ? (
            <div className="text-center py-12 text-[var(--muted-soft)] text-sm">
              No test cases added yet. Click &quot;+ Add Test Cases&quot; to get started.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)] uppercase tracking-wider">
                    <th className="px-5 py-3 font-medium">ID</th>
                    <th className="px-5 py-3 font-medium">Test Case</th>
                    <th className="px-5 py-3 font-medium">Priority</th>
                    <th className="px-5 py-3 font-medium">Type</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                    {!isCompleted && <th className="px-5 py-3 font-medium w-8"></th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-subtle)]">
                  {executions.map((e) => (
                    <tr key={e.id} className="hover:bg-[var(--surface-secondary)]">
                      <td className="px-5 py-3 text-xs text-[var(--muted-soft)] font-mono whitespace-nowrap">
                        {e.externalId || "—"}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/projects/${projectId}/cycles/${cycleId}/execute/${e.id}`}
                            className="text-sm text-[var(--brand-primary)] hover:text-[var(--brand-hover)] hover:underline"
                          >
                            {e.title}
                          </Link>
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        <span className="text-xs text-[var(--muted)]">{e.priority || "—"}</span>
                      </td>
                      <td className="px-5 py-3">
                        <span className="text-xs text-[var(--muted)]">{e.type || "—"}</span>
                      </td>
                      <td className="px-5 py-3">
                        {isInProgress ? (
                          <select
                            value={e.status}
                            onChange={(ev) => handleStatusChange(e.id, ev.target.value)}
                            disabled={statusSaving === e.id}
                            className={`text-xs font-medium rounded-lg border px-2 py-1 cursor-pointer ${
                              e.status === "Passed"
                                ? "border-green-200 bg-green-50 text-green-800"
                                : e.status === "Failed"
                                ? "border-red-200 bg-red-50 text-red-800"
                                : e.status === "Skipped"
                                ? "border-yellow-200 bg-yellow-50 text-yellow-800"
                                : "border-[var(--border)] bg-[var(--surface-secondary)] text-[var(--muted)]"
                            }`}
                          >
                            {EXEC_STATUSES.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <StatusChip tone={statusToTone(e.status)}>{e.status}</StatusChip>
                        )}
                      </td>
                      {!isCompleted && (
                        <td className="px-5 py-3">
                          <button
                            onClick={() => handleRemoveCase(e.testcaseId)}
                            className="text-[var(--muted-soft)] hover:text-[var(--error)]"
                            title="Remove from test run"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>

      {/* ───── Test Case Picker Modal ───── */}
      <Modal
        open={showPicker}
        onClose={() => setShowPicker(false)}
        title="Add Test Cases to Run"
        className="!max-w-4xl"
      >
        {/* Filters */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
          <Input
            type="text"
            placeholder="Search by title or ID…"
            value={filterSearch}
            onChange={(e) => setFilterSearch(e.target.value)}
            className="col-span-2 sm:col-span-2"
          />
          <Select
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value)}
          >
            <option value="">All Priorities</option>
            <option value="P0">P0 - Critical</option>
            <option value="P1">P1 - High</option>
            <option value="P2">P2 - Medium</option>
            <option value="P3">P3 - Low</option>
          </Select>
          <Select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
          >
            <option value="">All Types</option>
            <option value="Functional">Functional</option>
            <option value="Regression">Regression</option>
            <option value="Smoke">Smoke</option>
            <option value="Integration">Integration</option>
            <option value="Performance">Performance</option>
            <option value="Security">Security</option>
            <option value="Usability">Usability</option>
            <option value="Other">Other</option>
          </Select>
          <Select
            value={filterSuiteId}
            onChange={(e) => setFilterSuiteId(e.target.value)}
          >
            <option value="">All Suites</option>
            {suites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
          >
            <option value="">All Statuses</option>
            <option value="Approved">Approved</option>
            <option value="Draft">Draft</option>
            <option value="In Review">In Review</option>
          </Select>
        </div>

        {/* Info note */}
        <div className="flex items-center gap-2 mb-4 rounded-lg bg-blue-50 border border-blue-200 px-3 py-2">
          <svg className="w-4 h-4 text-blue-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-xs text-blue-700">
            Only <span className="font-semibold">Approved</span> test cases can be added to a test run. Draft, In Review, or other status cases are shown but cannot be selected.
          </p>
        </div>

        {/* Case list */}
        {casesLoading ? (
          <div className="text-center py-8 text-[var(--muted-soft)] text-sm">Loading test cases…</div>
        ) : filteredCases.length === 0 ? (
          <div className="text-center py-8 text-[var(--muted-soft)] text-sm">
            {allCases.length === 0
              ? "No test cases in this project."
              : "No matching test cases found (all may already be added)."}
          </div>
        ) : (
          <>
            <div className="max-h-80 overflow-y-auto rounded-lg border border-[var(--border)]">
              <table className="w-full">
                <thead className="sticky top-0 bg-[var(--surface-secondary)]">
                  <tr className="text-left text-xs text-[var(--muted)] uppercase tracking-wider">
                    <th className="px-3 py-2 w-8">
                      <input
                        type="checkbox"
                        checked={selectedCases.size === selectableCases.length && selectableCases.length > 0}
                        onChange={toggleAll}
                        className="rounded"
                        disabled={selectableCases.length === 0}
                      />
                    </th>
                    <th className="px-3 py-2 font-medium">ID</th>
                    <th className="px-3 py-2 font-medium">Title</th>
                    <th className="px-3 py-2 font-medium">Priority</th>
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-subtle)]">
                  {filteredCases.map((tc) => {
                    const isApproved = tc.status === "Approved";
                    return (
                      <tr
                        key={tc.id}
                        className={`${
                          isApproved
                            ? `cursor-pointer hover:bg-[var(--surface-secondary)] ${
                                selectedCases.has(tc.id) ? "bg-blue-50/50" : ""
                              }`
                            : "opacity-50 cursor-not-allowed"
                        }`}
                        onClick={() => isApproved && toggleCase(tc.id)}
                        title={!isApproved ? `Only Approved test cases can be added to a test run. This case is "${tc.status}" — please approve it first.` : undefined}
                      >
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={selectedCases.has(tc.id)}
                            onChange={() => toggleCase(tc.id)}
                            className={`rounded ${!isApproved ? "cursor-not-allowed" : ""}`}
                            onClick={(e) => e.stopPropagation()}
                            disabled={!isApproved}
                            title={!isApproved ? `Only Approved test cases can be added. This case is "${tc.status}".` : undefined}
                          />
                        </td>
                        <td className="px-3 py-2 text-xs text-[var(--muted-soft)] font-mono whitespace-nowrap">
                          {tc.externalId}
                        </td>
                        <td className="px-3 py-2 text-sm text-[var(--foreground)] truncate max-w-xs">
                          {tc.title}
                        </td>
                        <td className="px-3 py-2 text-xs text-[var(--muted)]">{tc.priority}</td>
                        <td className="px-3 py-2 text-xs text-[var(--muted)]">{tc.type}</td>
                        <td className="px-3 py-2">
                          <span className={`text-xs ${
                            isApproved
                              ? "text-[var(--success)] font-medium"
                              : "text-[var(--muted)]"
                          }`}>
                            {tc.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm text-[var(--muted)]">
                {selectedCases.size} of {selectableCases.length} selectable selected
                {selectableCases.length < filteredCases.length && (
                  <span className="text-[var(--muted-soft)] ml-1">
                    ({filteredCases.length - selectableCases.length} non-approved)
                  </span>
                )}
              </p>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setShowPicker(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleAddCases}
                  disabled={adding || selectedCases.size === 0}
                >
                  {adding ? "Adding…" : `Add ${selectedCases.size} Case${selectedCases.size !== 1 ? "s" : ""}`}
                </Button>
              </div>
            </div>
          </>
        )}
      </Modal>

      {/* ───── Bug Report Modal (triggered on Failed) ───── */}
      <Modal
        open={showBugDialog}
        onClose={handleBugSkip}
        title="Report a Bug"
      >
        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-lg bg-red-50 border border-red-200 p-3">
            <svg className="w-5 h-5 text-red-500 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-red-800">Test case marked as Failed</p>
              <p className="text-xs text-red-600 mt-0.5">
                {bugExecution?.externalId && <span className="font-mono mr-1">{bugExecution.externalId}</span>}
                {bugExecution?.title}
              </p>
            </div>
          </div>
          <p className="text-sm text-[var(--muted)]">
            Would you like to file a bug report? You can add details now or skip and report later from the Bugs section.
          </p>
          <div>
            <label className="block text-sm font-medium text-[var(--muted)] mb-1">
              Bug Title <span className="text-[var(--error)]">*</span>
            </label>
            <Input
              type="text"
              value={bugTitle}
              onChange={(e) => setBugTitle(e.target.value)}
              placeholder="Brief summary of the bug…"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--muted)] mb-1">
              Description
            </label>
            <Textarea
              value={bugDesc}
              onChange={(e) => setBugDesc(e.target.value)}
              rows={3}
              placeholder="Steps to reproduce, expected vs actual behavior…"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--muted)] mb-1">
              Bug Link (external tracker URL)
            </label>
            <Input
              type="url"
              value={bugUrl}
              onChange={(e) => setBugUrl(e.target.value)}
              placeholder="https://jira.example.com/browse/BUG-123"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={handleBugSkip}>
              Skip
            </Button>
            <Button
              variant="destructive"
              onClick={handleBugSubmit}
              disabled={bugSaving || !bugTitle.trim()}
            >
              {bugSaving ? (
                "Filing…"
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                  File Bug
                </>
              )}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ───── Share Modal ───── */}
      <Modal
        open={showShare}
        onClose={() => setShowShare(false)}
        title="Share Test Run"
      >
        <div className="space-y-5">
          <p className="text-sm text-[var(--muted)]">
            Create a public link to share this test run&apos;s results with anyone &mdash; no login required.
          </p>

          {/* Toggle */}
          <div className="flex items-center justify-between rounded-lg border border-[var(--border)] p-4">
            <div>
              <p className="text-sm font-medium text-[var(--foreground)]">
                Public sharing
              </p>
              <p className="text-xs text-[var(--muted)] mt-0.5">
                {shareEnabled
                  ? "Anyone with the link can view this test run"
                  : "Sharing is currently disabled"}
              </p>
            </div>
            <button
              onClick={() => handleShareToggle(!shareEnabled)}
              disabled={shareToggling}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)] focus:ring-offset-2 ${
                shareEnabled
                  ? "bg-[var(--brand-primary)]"
                  : "bg-[var(--surface-tertiary)]"
              } ${shareToggling ? "opacity-50" : ""}`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  shareEnabled ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {/* Link display + copy */}
          {shareEnabled && shareToken && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  readOnly
                  value={getShareUrl()}
                  className="flex-1 bg-[var(--surface-secondary)] font-mono truncate"
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                />
                <Button
                  onClick={copyShareLink}
                  className={copied ? "!bg-green-600" : ""}
                >
                  {copied ? (
                    <span className="flex items-center gap-1">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Copied
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                      </svg>
                      Copy Link
                    </span>
                  )}
                </Button>
              </div>
              <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 p-3">
                <svg className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <p className="text-xs text-amber-800">
                  This link is publicly accessible. Anyone with it can view the test run results, execution statuses, and test case details. You can disable sharing at any time.
                </p>
              </div>
            </div>
          )}

          <div className="flex justify-end pt-2">
            <Button variant="secondary" onClick={() => setShowShare(false)}>
              Done
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
