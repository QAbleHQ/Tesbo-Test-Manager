"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useMemo, useCallback } from "react";
import Link from "next/link";
import {
  authMe,
  getExecutionReport,
  getRequirementMatrix,
  getRepositorySummary,
  listPlans,
  listTestRuns,
  listSuites,
  listProjectMembers,
  type ExecutionReportRow,
  type RequirementMatrixRow,
  type RepositorySummary,
  type SuiteNode,
} from "@/lib/api";

/* ═══════════════════ CONSTANTS ═══════════════════ */
const TABS = ["Execution Report", "Requirement Matrix", "Repository Summary"] as const;
type Tab = (typeof TABS)[number];

const FILTER_OPTIONS = [
  { value: "overall", label: "Overall (by Test Run)" },
  { value: "person", label: "By Person" },
  { value: "plan", label: "By Test Plan" },
  { value: "run", label: "By Test Run" },
  { value: "suite", label: "By Test Suite" },
  { value: "tags", label: "By Tags" },
  { value: "priority", label: "By Priority" },
] as const;

const STATUS_COLORS: Record<string, string> = {
  Passed: "#22c55e",
  Failed: "#ef4444",
  Blocked: "#f97316",
  Skipped: "#eab308",
  Untested: "#a1a1aa",
  Retest: "#a855f7",
};

const STATUS_KEYS = ["Passed", "Failed", "Blocked", "Skipped", "Untested", "Retest"] as const;

const PRIORITY_COLORS: Record<string, string> = {
  P0: "#ef4444",
  P1: "#f97316",
  P2: "#3b82f6",
  P3: "#a1a1aa",
};

/* ═══════════════════ DONUT CHART ═══════════════════ */
function DonutChart({
  data,
  size = 180,
  label,
}: {
  data: { label: string; value: number; color: string }[];
  size?: number;
  label?: string;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) {
    return (
      <svg width={size} height={size} viewBox="0 0 36 36">
        <circle cx="18" cy="18" r="15.915" fill="none" stroke="#e4e4e7" strokeWidth="3" />
        <text x="18" y="19.5" textAnchor="middle" className="text-[3.5px] fill-zinc-400 font-medium">
          No data
        </text>
      </svg>
    );
  }
  let cumulative = 0;
  const radius = 15.915;
  const circumference = 2 * Math.PI * radius;

  return (
    <svg width={size} height={size} viewBox="0 0 36 36" className="drop-shadow-sm">
      {data.map((d) => {
        const pct = d.value / total;
        const dashArray = `${pct * circumference} ${circumference}`;
        const dashOffset = circumference - cumulative * circumference;
        cumulative += pct;
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
      <text x="18" y="17" textAnchor="middle" className="text-[5px] font-bold fill-zinc-900 dark:fill-zinc-100">
        {total}
      </text>
      <text x="18" y="21" textAnchor="middle" className="text-[2.5px] fill-zinc-400 font-medium">
        {label || "Total"}
      </text>
    </svg>
  );
}

/* ═══════════════════ BAR CHART ═══════════════════ */
function HorizontalBarChart({
  data,
}: {
  data: { label: string; value: number; color: string }[];
}) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="space-y-2">
      {data.map((d) => (
        <div key={d.label} className="flex items-center gap-3">
          <span className="w-24 text-xs text-zinc-500 dark:text-zinc-400 text-right truncate">{d.label}</span>
          <div className="flex-1 h-6 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${(d.value / max) * 100}%`, backgroundColor: d.color, minWidth: d.value > 0 ? "8px" : "0px" }}
            />
          </div>
          <span className="w-10 text-xs font-medium text-zinc-700 dark:text-zinc-300">{d.value}</span>
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════ STACKED BAR CHART ═══════════════════ */
function StackedBarChart({ rows }: { rows: ExecutionReportRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-zinc-400 text-center py-8">No data available</p>;
  const maxTotal = Math.max(...rows.map((r) => r.total), 1);

  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div key={row.groupId} className="flex items-center gap-3">
          <span className="w-36 text-xs text-zinc-600 dark:text-zinc-400 text-right truncate" title={row.groupName}>
            {row.groupName}
          </span>
          <div className="flex-1 h-7 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden flex">
            {STATUS_KEYS.map((status) => {
              const val = row[status] || 0;
              if (val === 0) return null;
              const pct = (val / maxTotal) * 100;
              return (
                <div
                  key={status}
                  className="h-full transition-all duration-500 first:rounded-l-full last:rounded-r-full"
                  style={{ width: `${pct}%`, backgroundColor: STATUS_COLORS[status], minWidth: "4px" }}
                  title={`${status}: ${val}`}
                />
              );
            })}
          </div>
          <span className="w-10 text-xs font-medium text-zinc-700 dark:text-zinc-300">{row.total}</span>
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════ SPARKLINE (area chart for added-by-date) ═══════════════════ */
function AreaSparkline({
  data,
  width = 600,
  height = 160,
}: {
  data: { date: string; count: number }[];
  width?: number;
  height?: number;
}) {
  if (data.length === 0) return <p className="text-sm text-zinc-400 text-center py-8">No data in last 30 days</p>;
  const max = Math.max(...data.map((d) => d.count), 1);
  const padX = 40;
  const padY = 20;
  const w = width - padX * 2;
  const h = height - padY * 2;

  const points = data.map((d, i) => ({
    x: padX + (i / Math.max(data.length - 1, 1)) * w,
    y: padY + h - (d.count / max) * h,
  }));
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const area = `${line} L${points[points.length - 1].x},${padY + h} L${points[0].x},${padY + h} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ maxHeight: height }}>
      <defs>
        <linearGradient id="areaGrad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map((pct) => (
        <g key={pct}>
          <line
            x1={padX}
            y1={padY + h - pct * h}
            x2={width - padX}
            y2={padY + h - pct * h}
            stroke="#e4e4e7"
            strokeWidth="0.5"
          />
          <text
            x={padX - 6}
            y={padY + h - pct * h + 3}
            textAnchor="end"
            className="text-[9px] fill-zinc-400"
          >
            {Math.round(pct * max)}
          </text>
        </g>
      ))}
      <path d={area} fill="url(#areaGrad)" />
      <path d={line} fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r="3" fill="#3b82f6" />
          {data.length <= 15 && (
            <text x={p.x} y={padY + h + 14} textAnchor="middle" className="text-[7px] fill-zinc-400">
              {data[i].date.slice(5)}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

/* ═══════════════════ STATUS BADGE ═══════════════════ */
function StatusBadge({ status, type }: { status: string | null; type?: "exec" | "bug" | "tc" | "run" }) {
  if (!status) return <span className="text-xs text-zinc-300">—</span>;
  const colorMap: Record<string, string> = {
    Passed: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    Failed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
    Skipped: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
    Blocked: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
    Retest: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
    Untested: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
    Open: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
    Closed: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    "In Progress": "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
    Planning: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    Completed: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    Draft: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
    Approved: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    "In Review": "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
    Deprecated: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500",
  };
  const cls = colorMap[status] || "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${cls}`}>
      {status}
    </span>
  );
}

/* ═══════════════════ METRIC CARD ═══════════════════ */
function MetricCard({ label, value, sub, color }: { label: string; value: number | string; sub?: string; color: string }) {
  return (
    <div className={`rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5`}>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className={`text-3xl font-bold mt-1 ${color}`}>{value}</p>
      {sub && <p className="text-xs text-zinc-400 mt-1">{sub}</p>}
    </div>
  );
}

/* ═══════════════════ RESIZABLE TABLE HEADER ═══════════════════ */
const MATRIX_COLUMNS = [
  { key: "tcId", label: "Test Case ID", defaultWidth: 120, minWidth: 80 },
  { key: "title", label: "Title", defaultWidth: 280, minWidth: 140 },
  { key: "priority", label: "Priority", defaultWidth: 80, minWidth: 60 },
  { key: "tcStatus", label: "TC Status", defaultWidth: 100, minWidth: 70 },
  { key: "suite", label: "Suite", defaultWidth: 130, minWidth: 70 },
  { key: "run", label: "Test Run", defaultWidth: 160, minWidth: 90 },
  { key: "runStatus", label: "Run Status", defaultWidth: 100, minWidth: 70 },
  { key: "execResult", label: "Exec Result", defaultWidth: 100, minWidth: 70 },
  { key: "executedAt", label: "Executed At", defaultWidth: 110, minWidth: 80 },
  { key: "bug", label: "Bug", defaultWidth: 180, minWidth: 80 },
  { key: "bugStatus", label: "Bug Status", defaultWidth: 100, minWidth: 70 },
] as const;

function useResizableColumns(columns: readonly { key: string; defaultWidth: number; minWidth: number }[]) {
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    const w: Record<string, number> = {};
    columns.forEach((c) => { w[c.key] = c.defaultWidth; });
    return w;
  });
  const onMouseDown = useCallback(
    (key: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const minW = columns.find((c) => c.key === key)?.minWidth ?? 50;

      const dragKey = key;
      const startX = e.clientX;
      const startW = widths[key];

      const onMouseMove = (ev: MouseEvent) => {
        const diff = ev.clientX - startX;
        const newW = Math.max(minW, startW + diff);
        setWidths((prev) => ({ ...prev, [dragKey]: newW }));
      };
      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [widths, columns]
  );

  return { widths, onMouseDown };
}

/* ═══════════════════ MAIN PAGE ═══════════════════ */
export default function ReportsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const [auth, setAuth] = useState<{ userId: string } | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("Execution Report");

  // Resizable columns for the matrix table
  const { widths: matrixColWidths, onMouseDown: onColResize } = useResizableColumns(MATRIX_COLUMNS);

  // Execution Report state
  const [execFilterBy, setExecFilterBy] = useState("overall");
  const [execFilterValue, setExecFilterValue] = useState("");
  const [execRows, setExecRows] = useState<ExecutionReportRow[]>([]);
  const [execLoading, setExecLoading] = useState(false);
  const [execView, setExecView] = useState<"chart" | "table">("chart");

  // Filter option data
  const [plans, setPlans] = useState<{ id: string; name: string }[]>([]);
  const [runs, setRuns] = useState<{ id: string; name: string }[]>([]);
  const [suites, setSuites] = useState<SuiteNode[]>([]);
  const [members, setMembers] = useState<{ userId: string; name: string; email: string }[]>([]);

  // Requirement Matrix state
  const [matrixRows, setMatrixRows] = useState<RequirementMatrixRow[]>([]);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [matrixSearch, setMatrixSearch] = useState("");

  // Repository Summary state
  const [repoSummary, setRepoSummary] = useState<RepositorySummary | null>(null);
  const [repoLoading, setRepoLoading] = useState(false);

  useEffect(() => {
    authMe().then((me) => {
      setAuth(me);
      if (!me) router.replace("/login");
    });
  }, [router]);

  // Load filter options once
  useEffect(() => {
    if (!auth) return;
    Promise.all([
      listPlans(projectId),
      listTestRuns(projectId),
      listSuites(projectId),
      listProjectMembers(projectId),
    ]).then(([pl, rn, su, mb]) => {
      setPlans(Array.isArray(pl) ? pl.map((p: Record<string, unknown>) => ({ id: String(p.id ?? ""), name: String(p.name ?? "") })) : []);
      setRuns(Array.isArray(rn) ? rn.map((r) => ({ id: r.id, name: r.name })) : []);
      setSuites(su);
      setMembers(mb);
    }).catch(() => {});
  }, [auth, projectId]);

  // Load execution report
  const loadExecReport = useCallback(() => {
    setExecLoading(true);
    const p: { filterBy?: string; filterValue?: string } = {};
    if (execFilterBy !== "overall") p.filterBy = execFilterBy;
    if (execFilterValue) p.filterValue = execFilterValue;
    getExecutionReport(projectId, p)
      .then((res) => setExecRows(res.rows))
      .catch(() => setExecRows([]))
      .finally(() => setExecLoading(false));
  }, [projectId, execFilterBy, execFilterValue]);

  useEffect(() => {
    if (auth && activeTab === "Execution Report") loadExecReport();
  }, [auth, activeTab, loadExecReport]);

  // Load requirement matrix
  useEffect(() => {
    if (auth && activeTab === "Requirement Matrix") {
      setMatrixLoading(true);
      getRequirementMatrix(projectId)
        .then((res) => setMatrixRows(res.rows))
        .catch(() => setMatrixRows([]))
        .finally(() => setMatrixLoading(false));
    }
  }, [auth, activeTab, projectId]);

  // Load repository summary
  useEffect(() => {
    if (auth && activeTab === "Repository Summary") {
      setRepoLoading(true);
      getRepositorySummary(projectId)
        .then((res) => setRepoSummary(res))
        .catch(() => setRepoSummary(null))
        .finally(() => setRepoLoading(false));
    }
  }, [auth, activeTab, projectId]);

  // Compute aggregated execution totals
  const execTotals = useMemo(() => {
    const t = { Passed: 0, Failed: 0, Blocked: 0, Skipped: 0, Untested: 0, Retest: 0, total: 0 };
    execRows.forEach((r) => {
      STATUS_KEYS.forEach((s) => { t[s] += r[s] || 0; });
      t.total += r.total;
    });
    return t;
  }, [execRows]);

  // Filtered matrix rows
  const filteredMatrixRows = useMemo(() => {
    if (!matrixSearch) return matrixRows;
    const q = matrixSearch.toLowerCase();
    return matrixRows.filter(
      (r) =>
        r.externalId?.toLowerCase().includes(q) ||
        r.testcaseTitle?.toLowerCase().includes(q) ||
        r.runName?.toLowerCase().includes(q) ||
        r.bugTitle?.toLowerCase().includes(q)
    );
  }, [matrixRows, matrixSearch]);

  // Group matrix rows by test case for merged row display
  const groupedMatrixRows = useMemo(() => {
    const groups: { testcaseId: string; externalId: string; testcaseTitle: string; priority: string; testcaseStatus: string; suiteName: string | null; runs: RequirementMatrixRow[] }[] = [];
    const map = new Map<string, typeof groups[number]>();
    for (const row of filteredMatrixRows) {
      let group = map.get(row.testcaseId);
      if (!group) {
        group = {
          testcaseId: row.testcaseId,
          externalId: row.externalId,
          testcaseTitle: row.testcaseTitle,
          priority: row.priority,
          testcaseStatus: row.testcaseStatus,
          suiteName: row.suiteName,
          runs: [],
        };
        map.set(row.testcaseId, group);
        groups.push(group);
      }
      group.runs.push(row);
    }
    return groups;
  }, [filteredMatrixRows]);

  if (!auth) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* Header */}
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-3">
        <div className="flex items-center gap-2 text-sm">
          <Link href={`/projects/${projectId}/dashboard`} className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
            Project
          </Link>
          <span className="text-zinc-300 dark:text-zinc-600">/</span>
          <span className="text-zinc-900 dark:text-zinc-100 font-medium">Reports</span>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mb-1">Reports</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6">
          Test execution reports, requirement traceability, and repository analytics.
        </p>

        {/* Tab Navigation */}
        <div className="flex gap-1 mb-6 border-b border-zinc-200 dark:border-zinc-700">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? "border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400"
                  : "border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* ═══════════════════ TAB: Execution Report ═══════════════════ */}
        {activeTab === "Execution Report" && (
          <div>
            {/* Filter Bar */}
            <div className="flex flex-wrap items-center gap-3 mb-6">
              <div className="flex items-center gap-2">
                <label className="text-sm text-zinc-500 dark:text-zinc-400 font-medium">Group By:</label>
                <select
                  value={execFilterBy}
                  onChange={(e) => { setExecFilterBy(e.target.value); setExecFilterValue(""); }}
                  className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300"
                >
                  {FILTER_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              {/* Specific filter value selector */}
              {execFilterBy === "plan" && plans.length > 0 && (
                <select
                  value={execFilterValue}
                  onChange={(e) => setExecFilterValue(e.target.value)}
                  className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
                >
                  <option value="">All Plans</option>
                  {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              )}
              {execFilterBy === "run" && runs.length > 0 && (
                <select
                  value={execFilterValue}
                  onChange={(e) => setExecFilterValue(e.target.value)}
                  className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
                >
                  <option value="">All Runs</option>
                  {runs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              )}
              {execFilterBy === "suite" && suites.length > 0 && (
                <select
                  value={execFilterValue}
                  onChange={(e) => setExecFilterValue(e.target.value)}
                  className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
                >
                  <option value="">All Suites</option>
                  {suites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              )}
              {execFilterBy === "person" && members.length > 0 && (
                <select
                  value={execFilterValue}
                  onChange={(e) => setExecFilterValue(e.target.value)}
                  className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
                >
                  <option value="">All Members</option>
                  {members.map((m) => <option key={m.userId} value={m.userId}>{m.name || m.email}</option>)}
                </select>
              )}
              {execFilterBy === "priority" && (
                <select
                  value={execFilterValue}
                  onChange={(e) => setExecFilterValue(e.target.value)}
                  className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
                >
                  <option value="">All Priorities</option>
                  <option value="P0">P0 - Critical</option>
                  <option value="P1">P1 - High</option>
                  <option value="P2">P2 - Medium</option>
                  <option value="P3">P3 - Low</option>
                </select>
              )}
              {execFilterBy === "tags" && (
                <input
                  type="text"
                  value={execFilterValue}
                  onChange={(e) => setExecFilterValue(e.target.value)}
                  placeholder="Enter tag to filter…"
                  className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm w-48"
                />
              )}

              <div className="ml-auto flex items-center rounded-lg border border-zinc-300 dark:border-zinc-600 overflow-hidden">
                <button
                  onClick={() => setExecView("chart")}
                  className={`px-3 py-2 text-sm font-medium flex items-center gap-1.5 ${
                    execView === "chart"
                      ? "bg-blue-600 text-white"
                      : "bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-700"
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                  Chart
                </button>
                <button
                  onClick={() => setExecView("table")}
                  className={`px-3 py-2 text-sm font-medium flex items-center gap-1.5 ${
                    execView === "table"
                      ? "bg-blue-600 text-white"
                      : "bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-700"
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  Table
                </button>
              </div>
            </div>

            {execLoading ? (
              <div className="flex items-center justify-center py-16">
                <p className="text-zinc-400 text-sm">Loading report…</p>
              </div>
            ) : (
              <>
                {/* Summary Cards */}
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
                  <MetricCard label="Total" value={execTotals.total} color="text-zinc-900 dark:text-zinc-100" />
                  {STATUS_KEYS.map((s) => (
                    <MetricCard
                      key={s}
                      label={s}
                      value={execTotals[s]}
                      color={
                        s === "Passed" ? "text-green-600" :
                        s === "Failed" ? "text-red-600" :
                        s === "Blocked" ? "text-orange-600" :
                        s === "Skipped" ? "text-yellow-600" :
                        s === "Retest" ? "text-purple-600" :
                        "text-zinc-500"
                      }
                    />
                  ))}
                </div>

                {/* Chart or Table View */}
                {execView === "chart" ? (
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Stacked bar chart */}
                    <div className="lg:col-span-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5">
                      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">
                        Execution Status by {FILTER_OPTIONS.find((o) => o.value === execFilterBy)?.label.replace("By ", "").replace("Overall (by Test Run)", "Test Run")}
                      </h3>
                      <StackedBarChart rows={execRows} />
                      {/* Legend */}
                      <div className="flex flex-wrap gap-4 mt-4 pt-4 border-t border-zinc-100 dark:border-zinc-800">
                        {STATUS_KEYS.map((s) => (
                          <div key={s} className="flex items-center gap-1.5 text-xs">
                            <span className="w-3 h-3 rounded" style={{ backgroundColor: STATUS_COLORS[s] }} />
                            <span className="text-zinc-500 dark:text-zinc-400">{s}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Donut summary */}
                    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5 flex flex-col items-center justify-center">
                      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">Overall Distribution</h3>
                      <DonutChart
                        data={STATUS_KEYS.map((s) => ({
                          label: s,
                          value: execTotals[s],
                          color: STATUS_COLORS[s],
                        }))}
                        size={180}
                      />
                      <div className="flex flex-wrap justify-center gap-3 mt-4">
                        {STATUS_KEYS.filter((s) => execTotals[s] > 0).map((s) => (
                          <div key={s} className="flex items-center gap-1.5 text-xs">
                            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: STATUS_COLORS[s] }} />
                            <span className="text-zinc-600 dark:text-zinc-400">{s} ({execTotals[s]})</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  /* Table View */
                  <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden bg-white dark:bg-zinc-900">
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead>
                          <tr className="border-b border-zinc-200 dark:border-zinc-700 text-left text-xs text-zinc-500 uppercase tracking-wider">
                            <th className="px-5 py-3 font-medium">Group</th>
                            {STATUS_KEYS.map((s) => (
                              <th key={s} className="px-4 py-3 font-medium text-center">{s}</th>
                            ))}
                            <th className="px-4 py-3 font-medium text-center">Total</th>
                            <th className="px-4 py-3 font-medium text-center">Pass Rate</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                          {execRows.length === 0 ? (
                            <tr>
                              <td colSpan={9} className="px-5 py-8 text-center text-sm text-zinc-400">No data available</td>
                            </tr>
                          ) : (
                            <>
                              {execRows.map((row) => {
                                const passRate = row.total > 0 ? ((row.Passed / row.total) * 100).toFixed(1) : "0.0";
                                return (
                                  <tr key={row.groupId} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                                    <td className="px-5 py-3 text-sm text-zinc-900 dark:text-zinc-100 font-medium">
                                      {row.groupName}
                                    </td>
                                    {STATUS_KEYS.map((s) => (
                                      <td key={s} className="px-4 py-3 text-center text-sm">
                                        <span className={`inline-flex items-center justify-center w-8 h-8 rounded-lg text-xs font-semibold ${
                                          (row[s] || 0) > 0
                                            ? s === "Passed" ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                                              : s === "Failed" ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                                              : s === "Blocked" ? "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300"
                                              : s === "Skipped" ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300"
                                              : s === "Retest" ? "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300"
                                              : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                                            : "text-zinc-300 dark:text-zinc-600"
                                        }`}>
                                          {row[s] || 0}
                                        </span>
                                      </td>
                                    ))}
                                    <td className="px-4 py-3 text-center text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                                      {row.total}
                                    </td>
                                    <td className="px-4 py-3 text-center">
                                      <span className={`text-sm font-semibold ${
                                        Number(passRate) >= 80 ? "text-green-600" :
                                        Number(passRate) >= 50 ? "text-yellow-600" :
                                        "text-red-600"
                                      }`}>
                                        {passRate}%
                                      </span>
                                    </td>
                                  </tr>
                                );
                              })}
                              {/* Totals row */}
                              <tr className="bg-zinc-50 dark:bg-zinc-800/50 font-semibold">
                                <td className="px-5 py-3 text-sm text-zinc-900 dark:text-zinc-100">Total</td>
                                {STATUS_KEYS.map((s) => (
                                  <td key={s} className="px-4 py-3 text-center text-sm text-zinc-700 dark:text-zinc-300">
                                    {execTotals[s]}
                                  </td>
                                ))}
                                <td className="px-4 py-3 text-center text-sm text-zinc-900 dark:text-zinc-100">{execTotals.total}</td>
                                <td className="px-4 py-3 text-center text-sm">
                                  {execTotals.total > 0
                                    ? `${((execTotals.Passed / execTotals.total) * 100).toFixed(1)}%`
                                    : "0.0%"}
                                </td>
                              </tr>
                            </>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ═══════════════════ TAB: Requirement Matrix ═══════════════════ */}
        {activeTab === "Requirement Matrix" && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Traceability matrix linking test cases to test runs, execution results, and bugs.
              </p>
              <input
                type="text"
                value={matrixSearch}
                onChange={(e) => setMatrixSearch(e.target.value)}
                placeholder="Search by ID, title, run, or bug…"
                className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm w-64"
              />
            </div>

            {matrixLoading ? (
              <div className="flex items-center justify-center py-16">
                <p className="text-zinc-400 text-sm">Loading matrix…</p>
              </div>
            ) : (
              <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden bg-white dark:bg-zinc-900">
                <div className="overflow-x-auto">
                  <table className="border-collapse" style={{ minWidth: "100%", tableLayout: "fixed", width: Object.values(matrixColWidths).reduce((a, b) => a + b, 0) }}>
                    <colgroup>
                      {MATRIX_COLUMNS.map((col) => (
                        <col key={col.key} style={{ width: matrixColWidths[col.key] }} />
                      ))}
                    </colgroup>
                    <thead>
                      <tr className="border-b border-zinc-200 dark:border-zinc-700 text-left text-xs text-zinc-500 uppercase tracking-wider">
                        {MATRIX_COLUMNS.map((col) => (
                          <th
                            key={col.key}
                            className="px-4 py-3 font-medium relative select-none"
                            style={{ width: matrixColWidths[col.key] }}
                          >
                            <span>{col.label}</span>
                            {/* Drag handle */}
                            <span
                              onMouseDown={(e) => onColResize(col.key, e)}
                              className="absolute top-0 right-0 w-2 h-full cursor-col-resize hover:bg-blue-400/30 active:bg-blue-500/40 z-10"
                              style={{ touchAction: "none" }}
                            />
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {groupedMatrixRows.length === 0 ? (
                        <tr>
                          <td colSpan={11} className="px-4 py-8 text-center text-sm text-zinc-400">
                            {matrixSearch ? "No matching rows found." : "No test case data available."}
                          </td>
                        </tr>
                      ) : (
                        groupedMatrixRows.map((group) => {
                          const rowCount = group.runs.length;
                          return group.runs.map((row, ri) => (
                            <tr
                              key={`${row.testcaseId}-${row.runId}-${row.bugId}-${ri}`}
                              className={`hover:bg-zinc-50 dark:hover:bg-zinc-800/50 ${
                                ri < rowCount - 1
                                  ? ""
                                  : "border-b border-zinc-200 dark:border-zinc-700"
                              }`}
                            >
                              {/* Merged test case columns — only render on the first row of each group */}
                              {ri === 0 && (
                                <>
                                  <td
                                    rowSpan={rowCount}
                                    className="px-4 py-3 text-xs text-zinc-500 font-mono whitespace-nowrap align-top border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
                                  >
                                    {group.externalId}
                                  </td>
                                  <td
                                    rowSpan={rowCount}
                                    className="px-4 py-3 text-sm text-zinc-900 dark:text-zinc-100 align-top border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
                                  >
                                    <span className="whitespace-normal break-words">{group.testcaseTitle}</span>
                                  </td>
                                  <td
                                    rowSpan={rowCount}
                                    className="px-4 py-3 align-top border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
                                  >
                                    <span className="text-xs font-medium" style={{ color: PRIORITY_COLORS[group.priority] || "#71717a" }}>
                                      {group.priority}
                                    </span>
                                  </td>
                                  <td
                                    rowSpan={rowCount}
                                    className="px-4 py-3 align-top border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
                                  >
                                    <StatusBadge status={group.testcaseStatus} type="tc" />
                                  </td>
                                  <td
                                    rowSpan={rowCount}
                                    className="px-4 py-3 text-xs text-zinc-500 align-top border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
                                  >
                                    <span className="whitespace-normal break-words">{group.suiteName || "—"}</span>
                                  </td>
                                </>
                              )}
                              {/* Run / execution / bug columns — rendered for every row */}
                              <td className={`px-4 py-2.5 text-sm text-zinc-700 dark:text-zinc-300 ${ri > 0 ? "border-t border-dashed border-zinc-100 dark:border-zinc-800" : ""}`}>
                                <span className="whitespace-normal break-words">{row.runName || "—"}</span>
                              </td>
                              <td className={`px-4 py-2.5 ${ri > 0 ? "border-t border-dashed border-zinc-100 dark:border-zinc-800" : ""}`}>
                                <StatusBadge status={row.runStatus} type="run" />
                              </td>
                              <td className={`px-4 py-2.5 ${ri > 0 ? "border-t border-dashed border-zinc-100 dark:border-zinc-800" : ""}`}>
                                <StatusBadge status={row.executionStatus} type="exec" />
                              </td>
                              <td className={`px-4 py-2.5 text-xs text-zinc-400 whitespace-nowrap ${ri > 0 ? "border-t border-dashed border-zinc-100 dark:border-zinc-800" : ""}`}>
                                {row.executedAt ? new Date(row.executedAt).toLocaleDateString() : "—"}
                              </td>
                              <td className={`px-4 py-2.5 text-sm ${ri > 0 ? "border-t border-dashed border-zinc-100 dark:border-zinc-800" : ""}`}>
                                {row.bugTitle ? (
                                  row.bugUrl ? (
                                    <a href={row.bugUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline text-xs break-words">
                                      {row.bugTitle}
                                    </a>
                                  ) : (
                                    <span className="text-xs text-zinc-700 dark:text-zinc-300 break-words">{row.bugTitle}</span>
                                  )
                                ) : (
                                  <span className="text-xs text-zinc-300 dark:text-zinc-600">—</span>
                                )}
                              </td>
                              <td className={`px-4 py-2.5 ${ri > 0 ? "border-t border-dashed border-zinc-100 dark:border-zinc-800" : ""}`}>
                                <StatusBadge status={row.bugStatus} type="bug" />
                              </td>
                            </tr>
                          ));
                        })
                      )}
                    </tbody>
                  </table>
                </div>
                {groupedMatrixRows.length > 0 && (
                  <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-700 text-xs text-zinc-400">
                    {groupedMatrixRows.length} test case{groupedMatrixRows.length !== 1 ? "s" : ""} across {filteredMatrixRows.length} row{filteredMatrixRows.length !== 1 ? "s" : ""}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════ TAB: Repository Summary ═══════════════════ */}
        {activeTab === "Repository Summary" && (
          <div>
            {repoLoading ? (
              <div className="flex items-center justify-center py-16">
                <p className="text-zinc-400 text-sm">Loading summary…</p>
              </div>
            ) : repoSummary ? (
              <>
                {/* Top metric cards */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
                  <MetricCard
                    label="Total Test Cases"
                    value={repoSummary.totalTestCases}
                    color="text-blue-600"
                  />
                  <MetricCard
                    label="Updated Today"
                    value={repoSummary.updatedToday}
                    color="text-green-600"
                    sub="Last 24h"
                  />
                  <MetricCard
                    label="Updated This Week"
                    value={repoSummary.updatedThisWeek}
                    color="text-amber-600"
                    sub="Since Monday"
                  />
                  <MetricCard
                    label="Updated This Month"
                    value={repoSummary.updatedThisMonth}
                    color="text-purple-600"
                    sub={`Since ${new Date().toLocaleString("default", { month: "long" })} 1`}
                  />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
                  {/* Test cases by suite */}
                  <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5">
                    <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">
                      Test Cases by Suite
                    </h3>
                    <HorizontalBarChart
                      data={repoSummary.bySuite.map((s, i) => ({
                        label: s.name,
                        value: s.count,
                        color: ["#3b82f6", "#8b5cf6", "#06b6d4", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#6366f1"][i % 8],
                      }))}
                    />
                  </div>

                  {/* Test cases by status */}
                  <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5">
                    <div className="flex items-start justify-between mb-4">
                      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        Test Cases by Status
                      </h3>
                    </div>
                    <div className="flex items-center justify-center">
                      <DonutChart
                        data={repoSummary.byStatus.map((s) => ({
                          label: s.name,
                          value: s.count,
                          color: s.name === "Draft" ? "#a1a1aa"
                            : s.name === "Approved" ? "#22c55e"
                            : s.name === "In Review" ? "#3b82f6"
                            : s.name === "Deprecated" ? "#71717a"
                            : "#6366f1",
                        }))}
                        size={180}
                        label="Cases"
                      />
                    </div>
                    <div className="flex flex-wrap justify-center gap-3 mt-4">
                      {repoSummary.byStatus.map((s) => (
                        <div key={s.name} className="flex items-center gap-1.5 text-xs">
                          <span className="w-2.5 h-2.5 rounded-full" style={{
                            backgroundColor: s.name === "Draft" ? "#a1a1aa"
                              : s.name === "Approved" ? "#22c55e"
                              : s.name === "In Review" ? "#3b82f6"
                              : s.name === "Deprecated" ? "#71717a"
                              : "#6366f1",
                          }} />
                          <span className="text-zinc-600 dark:text-zinc-400">{s.name} ({s.count})</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Test cases added by date (area chart) */}
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5 mb-8">
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">
                    Test Cases Added (Last 30 Days)
                  </h3>
                  <AreaSparkline data={repoSummary.addedByDate} />
                </div>

                {/* Test cases by priority */}
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5">
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">
                    Test Cases by Priority
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    {repoSummary.byPriority.map((p) => (
                      <div
                        key={p.name}
                        className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-4 text-center"
                      >
                        <p
                          className="text-2xl font-bold"
                          style={{ color: PRIORITY_COLORS[p.name] || "#71717a" }}
                        >
                          {p.count}
                        </p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 font-medium">
                          {p.name === "P0" ? "P0 - Critical" :
                           p.name === "P1" ? "P1 - High" :
                           p.name === "P2" ? "P2 - Medium" :
                           p.name === "P3" ? "P3 - Low" :
                           p.name}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center py-16">
                <p className="text-zinc-400 text-sm">No data available.</p>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
