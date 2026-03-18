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
import { Button, Input, Select, StatusChip, Card } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

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
        <text x="18" y="19.5" textAnchor="middle" className="text-[3.5px] fill-[var(--muted-soft)] font-medium">
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
      <text x="18" y="17" textAnchor="middle" className="text-[5px] font-bold fill-[var(--foreground)]">
        {total}
      </text>
      <text x="18" y="21" textAnchor="middle" className="text-[2.5px] fill-[var(--muted-soft)] font-medium">
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
          <span className="w-24 text-xs text-[var(--muted)] text-right truncate">{d.label}</span>
          <div className="flex-1 h-6 bg-[var(--surface-tertiary)] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${(d.value / max) * 100}%`, backgroundColor: d.color, minWidth: d.value > 0 ? "8px" : "0px" }}
            />
          </div>
          <span className="w-10 text-xs font-medium text-[var(--muted)]">{d.value}</span>
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════ STACKED BAR CHART ═══════════════════ */
function StackedBarChart({ rows }: { rows: ExecutionReportRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-[var(--muted-soft)] text-center py-8">No data available</p>;
  const maxTotal = Math.max(...rows.map((r) => r.total), 1);

  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div key={row.groupId} className="flex items-center gap-3">
          <span className="w-36 text-xs text-[var(--muted)] text-right truncate" title={row.groupName}>
            {row.groupName}
          </span>
          <div className="flex-1 h-7 bg-[var(--surface-tertiary)] rounded-full overflow-hidden flex">
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
          <span className="w-10 text-xs font-medium text-[var(--muted)]">{row.total}</span>
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
  if (data.length === 0) return <p className="text-sm text-[var(--muted-soft)] text-center py-8">No data in last 30 days</p>;
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
            className="text-[9px] fill-[var(--muted-soft)]"
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
            <text x={p.x} y={padY + h + 14} textAnchor="middle" className="text-[7px] fill-[var(--muted-soft)]">
              {data[i].date.slice(5)}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

/* ───── Status badge tone mapping ───── */
function statusTone(s: string | null): "neutral" | "brand" | "ai" | "success" | "warning" | "error" | "info" {
  if (!s) return "neutral";
  const map: Record<string, "success" | "error" | "warning" | "info" | "neutral"> = {
    Passed: "success", Failed: "error", Skipped: "warning", Blocked: "warning", Retest: "info",
    Untested: "neutral", Open: "error", Closed: "success", "In Progress": "info", Planning: "warning",
    Completed: "success", Draft: "neutral", Approved: "success", "In Review": "info", Deprecated: "neutral",
  };
  return (map[s] ?? "neutral") as "neutral" | "success" | "warning" | "error" | "info";
}

/* ───── Metric Card ───── */
function MetricCard({ label, value, sub, color }: { label: string; value: number | string; sub?: string; color: string }) {
  return (
    <Card className="p-5">
      <p className="text-sm text-[var(--muted)]">{label}</p>
      <p className={`text-3xl font-bold mt-1 ${color}`}>{value}</p>
      {sub && <p className="text-xs text-[var(--muted-soft)] mt-1">{sub}</p>}
    </Card>
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
        <p className="text-[var(--muted)]">Loading…</p>
      </div>
    );
  }

  const breadcrumb = (
    <>
      <Link href={`/projects/${projectId}/dashboard`} className="text-[var(--muted)] hover:text-[var(--foreground)]">
        Project
      </Link>
      <span className="text-[var(--muted-soft)]">/</span>
      <span className="text-[var(--foreground)] font-medium">Reports</span>
    </>
  );

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Reports"
          subtitle="Test execution reports, requirement traceability, and repository analytics."
          breadcrumb={breadcrumb}
        />
      }
    >
      <main className="space-y-6">

        {/* Tab Navigation */}
        <div className="flex gap-1 mb-6 border-b border-[var(--border)]">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? "border-[var(--brand-primary)] text-[var(--brand-primary)]"
                  : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
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
                <label className="text-sm text-[var(--muted)] font-medium">Group By:</label>
                <Select
                  value={execFilterBy}
                  onChange={(e) => { setExecFilterBy(e.target.value); setExecFilterValue(""); }}
                  className="w-auto min-w-[140px]"
                >
                  {FILTER_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </Select>
              </div>

              {/* Specific filter value selector */}
              {execFilterBy === "plan" && plans.length > 0 && (
                <Select
                  value={execFilterValue}
                  onChange={(e) => setExecFilterValue(e.target.value)}
                  className="min-w-[140px]"
                >
                  <option value="">All Plans</option>
                  {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              )}
              {execFilterBy === "run" && runs.length > 0 && (
                <Select
                  value={execFilterValue}
                  onChange={(e) => setExecFilterValue(e.target.value)}
                  className="min-w-[140px]"
                >
                  <option value="">All Runs</option>
                  {runs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </Select>
              )}
              {execFilterBy === "suite" && suites.length > 0 && (
                <Select
                  value={execFilterValue}
                  onChange={(e) => setExecFilterValue(e.target.value)}
                  className="min-w-[140px]"
                >
                  <option value="">All Suites</option>
                  {suites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              )}
              {execFilterBy === "person" && members.length > 0 && (
                <Select
                  value={execFilterValue}
                  onChange={(e) => setExecFilterValue(e.target.value)}
                  className="min-w-[140px]"
                >
                  <option value="">All Members</option>
                  {members.map((m) => <option key={m.userId} value={m.userId}>{m.name || m.email}</option>)}
                </Select>
              )}
              {execFilterBy === "priority" && (
                <Select
                  value={execFilterValue}
                  onChange={(e) => setExecFilterValue(e.target.value)}
                  className="min-w-[140px]"
                >
                  <option value="">All Priorities</option>
                  <option value="P0">P0 - Critical</option>
                  <option value="P1">P1 - High</option>
                  <option value="P2">P2 - Medium</option>
                  <option value="P3">P3 - Low</option>
                </Select>
              )}
              {execFilterBy === "tags" && (
                <Input
                  type="text"
                  value={execFilterValue}
                  onChange={(e) => setExecFilterValue(e.target.value)}
                  placeholder="Enter tag to filter…"
                  className="w-48"
                />
              )}

              <div className="ml-auto flex items-center rounded-lg border border-[var(--border)] overflow-hidden">
                <button
                  onClick={() => setExecView("chart")}
                  className={`px-3 py-2 text-sm font-medium flex items-center gap-1.5 ${
                    execView === "chart"
                      ? "bg-[var(--brand-primary)] text-white"
                      : "bg-[var(--surface)] text-[var(--muted)] hover:bg-[var(--surface-secondary)]"
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
                      ? "bg-[var(--brand-primary)] text-white"
                      : "bg-[var(--surface)] text-[var(--muted)] hover:bg-[var(--surface-secondary)]"
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
                <p className="text-[var(--muted-soft)] text-sm">Loading report…</p>
              </div>
            ) : (
              <>
                {/* Summary Cards */}
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
                  <MetricCard label="Total" value={execTotals.total} color="text-[var(--foreground)]" />
                  {STATUS_KEYS.map((s) => (
                    <MetricCard
                      key={s}
                      label={s}
                      value={execTotals[s]}
                      color={
                        s === "Passed" ? "text-[var(--success)]" :
                        s === "Failed" ? "text-[var(--error)]" :
                        s === "Blocked" ? "text-[var(--warning)]" :
                        s === "Skipped" ? "text-[var(--warning)]" :
                        s === "Retest" ? "text-[var(--info)]" :
                        "text-[var(--muted)]"
                      }
                    />
                  ))}
                </div>

                {/* Chart or Table View */}
                {execView === "chart" ? (
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Stacked bar chart */}
                    <div className="lg:col-span-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
                      <h3 className="text-sm font-semibold text-[var(--foreground)] mb-4">
                        Execution Status by {FILTER_OPTIONS.find((o) => o.value === execFilterBy)?.label.replace("By ", "").replace("Overall (by Test Run)", "Test Run")}
                      </h3>
                      <StackedBarChart rows={execRows} />
                      {/* Legend */}
                      <div className="flex flex-wrap gap-4 mt-4 pt-4 border-t border-[var(--border-subtle)]">
                        {STATUS_KEYS.map((s) => (
                          <div key={s} className="flex items-center gap-1.5 text-xs">
                            <span className="w-3 h-3 rounded" style={{ backgroundColor: STATUS_COLORS[s] }} />
                            <span className="text-[var(--muted)]">{s}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Donut summary */}
                    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 flex flex-col items-center justify-center">
                      <h3 className="text-sm font-semibold text-[var(--foreground)] mb-4">Overall Distribution</h3>
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
                            <span className="text-[var(--muted)]">{s} ({execTotals[s]})</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  /* Table View */
                  <div className="rounded-xl border border-[var(--border)] overflow-hidden bg-[var(--surface)]">
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead>
                          <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)] uppercase tracking-wider">
                            <th className="px-5 py-3 font-medium">Group</th>
                            {STATUS_KEYS.map((s) => (
                              <th key={s} className="px-4 py-3 font-medium text-center">{s}</th>
                            ))}
                            <th className="px-4 py-3 font-medium text-center">Total</th>
                            <th className="px-4 py-3 font-medium text-center">Pass Rate</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--border-subtle)]">
                          {execRows.length === 0 ? (
                            <tr>
                              <td colSpan={9} className="px-5 py-8 text-center text-sm text-[var(--muted-soft)]">No data available</td>
                            </tr>
                          ) : (
                            <>
                              {execRows.map((row) => {
                                const passRate = row.total > 0 ? ((row.Passed / row.total) * 100).toFixed(1) : "0.0";
                                return (
                                  <tr key={row.groupId} className="hover:bg-[var(--surface-secondary)]">
                                    <td className="px-5 py-3 text-sm text-[var(--foreground)] font-medium">
                                      {row.groupName}
                                    </td>
                                    {STATUS_KEYS.map((s) => (
                                      <td key={s} className="px-4 py-3 text-center text-sm">
                                        <span className={`inline-flex items-center justify-center w-8 h-8 rounded-lg text-xs font-semibold ${
                                          (row[s] || 0) > 0
                                            ? s === "Passed" ? "bg-[var(--success-soft)] text-[var(--success)]"
                                              : s === "Failed" ? "bg-[var(--error-soft)] text-[var(--error)]"
                                              : s === "Blocked" ? "bg-[var(--warning-soft)] text-[var(--warning)]"
                                              : s === "Skipped" ? "bg-[var(--warning-soft)] text-[var(--warning)]"
                                              : s === "Retest" ? "bg-[var(--info-soft)] text-[var(--info)]"
                                              : "bg-[var(--surface-tertiary)] text-[var(--muted)]"
                                            : "text-[var(--muted-soft)]"
                                        }`}>
                                          {row[s] || 0}
                                        </span>
                                      </td>
                                    ))}
                                    <td className="px-4 py-3 text-center text-sm font-semibold text-[var(--foreground)]">
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
                              <tr className="bg-[var(--surface-secondary)] font-semibold">
                                <td className="px-5 py-3 text-sm text-[var(--foreground)]">Total</td>
                                {STATUS_KEYS.map((s) => (
                                  <td key={s} className="px-4 py-3 text-center text-sm text-[var(--muted)]">
                                    {execTotals[s]}
                                  </td>
                                ))}
                                <td className="px-4 py-3 text-center text-sm text-[var(--foreground)]">{execTotals.total}</td>
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
              <p className="text-sm text-[var(--muted)]">
                Traceability matrix linking test cases to test runs, execution results, and bugs.
              </p>
              <Input
                type="text"
                value={matrixSearch}
                onChange={(e) => setMatrixSearch(e.target.value)}
                placeholder="Search by ID, title, run, or bug…"
                className="w-64"
              />
            </div>

            {matrixLoading ? (
              <div className="flex items-center justify-center py-16">
                <p className="text-[var(--muted-soft)] text-sm">Loading matrix…</p>
              </div>
            ) : (
              <div className="rounded-xl border border-[var(--border)] overflow-hidden bg-[var(--surface)]">
                <div className="overflow-x-auto">
                  <table className="border-collapse" style={{ minWidth: "100%", tableLayout: "fixed", width: Object.values(matrixColWidths).reduce((a, b) => a + b, 0) }}>
                    <colgroup>
                      {MATRIX_COLUMNS.map((col) => (
                        <col key={col.key} style={{ width: matrixColWidths[col.key] }} />
                      ))}
                    </colgroup>
                    <thead>
                      <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)] uppercase tracking-wider">
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
                          <td colSpan={11} className="px-4 py-8 text-center text-sm text-[var(--muted-soft)]">
                            {matrixSearch ? "No matching rows found." : "No test case data available."}
                          </td>
                        </tr>
                      ) : (
                        groupedMatrixRows.map((group) => {
                          const rowCount = group.runs.length;
                          return group.runs.map((row, ri) => (
                            <tr
                              key={`${row.testcaseId}-${row.runId}-${row.bugId}-${ri}`}
                              className={`hover:bg-[var(--surface-secondary)] ${
                                ri < rowCount - 1
                                  ? ""
                                  : "border-b border-[var(--border)]"
                              }`}
                            >
                              {/* Merged test case columns — only render on the first row of each group */}
                              {ri === 0 && (
                                <>
                                  <td
                                    rowSpan={rowCount}
                                    className="px-4 py-3 text-xs text-[var(--muted)] font-mono whitespace-nowrap align-top border-b border-[var(--border)] bg-[var(--surface)]"
                                  >
                                    {group.externalId}
                                  </td>
                                  <td
                                    rowSpan={rowCount}
                                    className="px-4 py-3 text-sm text-[var(--foreground)] align-top border-b border-[var(--border)] bg-[var(--surface)]"
                                  >
                                    <span className="whitespace-normal break-words">{group.testcaseTitle}</span>
                                  </td>
                                  <td
                                    rowSpan={rowCount}
                                    className="px-4 py-3 align-top border-b border-[var(--border)] bg-[var(--surface)]"
                                  >
                                    <span className="text-xs font-medium" style={{ color: PRIORITY_COLORS[group.priority] || "#71717a" }}>
                                      {group.priority}
                                    </span>
                                  </td>
                                  <td
                                    rowSpan={rowCount}
                                    className="px-4 py-3 align-top border-b border-[var(--border)] bg-[var(--surface)]"
                                  >
                                    <StatusChip tone={statusTone(group.testcaseStatus)}>{group.testcaseStatus || "—"}</StatusChip>
                                  </td>
                                  <td
                                    rowSpan={rowCount}
                                    className="px-4 py-3 text-xs text-[var(--muted)] align-top border-b border-[var(--border)] bg-[var(--surface)]"
                                  >
                                    <span className="whitespace-normal break-words">{group.suiteName || "—"}</span>
                                  </td>
                                </>
                              )}
                              {/* Run / execution / bug columns — rendered for every row */}
                              <td className={`px-4 py-2.5 text-sm text-[var(--muted)] ${ri > 0 ? "border-t border-dashed border-[var(--border-subtle)]" : ""}`}>
                                <span className="whitespace-normal break-words">{row.runName || "—"}</span>
                              </td>
                              <td className={`px-4 py-2.5 ${ri > 0 ? "border-t border-dashed border-[var(--border-subtle)]" : ""}`}>
                                <StatusChip tone={statusTone(row.runStatus)}>{row.runStatus || "—"}</StatusChip>
                              </td>
                              <td className={`px-4 py-2.5 ${ri > 0 ? "border-t border-dashed border-[var(--border-subtle)]" : ""}`}>
                                <StatusChip tone={statusTone(row.executionStatus)}>{row.executionStatus || "—"}</StatusChip>
                              </td>
                              <td className={`px-4 py-2.5 text-xs text-[var(--muted-soft)] whitespace-nowrap ${ri > 0 ? "border-t border-dashed border-[var(--border-subtle)]" : ""}`}>
                                {row.executedAt ? new Date(row.executedAt).toLocaleDateString() : "—"}
                              </td>
                              <td className={`px-4 py-2.5 text-sm ${ri > 0 ? "border-t border-dashed border-[var(--border-subtle)]" : ""}`}>
                                {row.bugTitle ? (
                                  row.bugUrl ? (
                                    <a href={row.bugUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline text-xs break-words">
                                      {row.bugTitle}
                                    </a>
                                  ) : (
                                    <span className="text-xs text-[var(--muted)] break-words">{row.bugTitle}</span>
                                  )
                                ) : (
                                  <span className="text-xs text-[var(--muted-soft)]">—</span>
                                )}
                              </td>
                              <td className={`px-4 py-2.5 ${ri > 0 ? "border-t border-dashed border-[var(--border-subtle)]" : ""}`}>
                                <StatusChip tone={statusTone(row.bugStatus)}>{row.bugStatus || "—"}</StatusChip>
                              </td>
                            </tr>
                          ));
                        })
                      )}
                    </tbody>
                  </table>
                </div>
                {groupedMatrixRows.length > 0 && (
                  <div className="px-4 py-3 border-t border-[var(--border)] text-xs text-[var(--muted-soft)]">
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
                <p className="text-[var(--muted-soft)] text-sm">Loading summary…</p>
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
                  <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
                    <h3 className="text-sm font-semibold text-[var(--foreground)] mb-4">
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
                  <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
                    <div className="flex items-start justify-between mb-4">
                      <h3 className="text-sm font-semibold text-[var(--foreground)]">
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
                          <span className="text-[var(--muted)]">{s.name} ({s.count})</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Test cases added by date (area chart) */}
                <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 mb-8">
                  <h3 className="text-sm font-semibold text-[var(--foreground)] mb-4">
                    Test Cases Added (Last 30 Days)
                  </h3>
                  <AreaSparkline data={repoSummary.addedByDate} />
                </div>

                {/* Test cases by priority */}
                <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
                  <h3 className="text-sm font-semibold text-[var(--foreground)] mb-4">
                    Test Cases by Priority
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    {repoSummary.byPriority.map((p) => (
                      <div
                        key={p.name}
                        className="rounded-lg border border-[var(--border)] p-4 text-center"
                      >
                        <p
                          className="text-2xl font-bold"
                          style={{ color: PRIORITY_COLORS[p.name] || "#71717a" }}
                        >
                          {p.count}
                        </p>
                        <p className="text-xs text-[var(--muted)] mt-1 font-medium">
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
                <p className="text-[var(--muted-soft)] text-sm">No data available.</p>
              </div>
            )}
          </div>
        )}
      </main>
    </StandardPageLayout>
  );
}
