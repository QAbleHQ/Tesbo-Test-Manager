"use client";

import { useParams } from "next/navigation";
import { useEffect, useState, useMemo } from "react";
import Image from "next/image";
import {
  getPublicSharedRun,
  getPublicSharedExecutions,
  type TestRunDetail,
  type ExecutionItem,
} from "@/lib/api";

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
        Total
      </text>
    </svg>
  );
}

/* ───── Status badge ───── */
function StatusBadge({ status }: { status: string }) {
  const cls: Record<string, string> = {
    Passed: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    Failed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
    Skipped: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
    Blocked: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
    Retest: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
    Untested: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cls[status] || cls.Untested}`}>
      {status}
    </span>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  const cls: Record<string, string> = {
    Planning: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    "In Progress": "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
    Hold: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
    Completed: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${cls[status] || cls.Planning}`}>
      {status}
    </span>
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
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 flex items-center gap-3">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${color}`}>
        {icon}
      </div>
      <div>
        <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{value}</p>
        <p className="text-xs text-zinc-500">{label}</p>
      </div>
    </div>
  );
}

/* ═══════════════════ PUBLIC SHARED PAGE ═══════════════════ */
export default function PublicSharedRunPage() {
  const params = useParams();
  const token = params.token as string;

  const [run, setRun] = useState<TestRunDetail | null>(null);
  const [executions, setExecutions] = useState<ExecutionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getPublicSharedRun(token), getPublicSharedExecutions(token)])
      .then(([r, e]) => {
        setRun(r);
        setExecutions(e);
      })
      .catch(() => {
        setError("This shared link is not available. It may have been disabled or does not exist.");
      })
      .finally(() => setLoading(false));
  }, [token]);

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

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-zinc-500 text-sm">Loading shared test run…</p>
        </div>
      </div>
    );
  }

  if (error || !run) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950">
        <div className="text-center max-w-md px-6">
          <div className="w-16 h-16 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">Link Not Available</h1>
          <p className="text-sm text-zinc-500">
            {error || "This shared test run link is not available."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* ───── Header ───── */}
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
              <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
            </div>
            <Image src="/tesbox-logo-transparent.png" alt="TesboX" width={120} height={34} className="h-7 w-auto" />
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>Shared Test Run Report</span>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6">
        {/* ───── Title + Status ───── */}
        <div className="mb-6">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
              {run.name}
            </h1>
            <RunStatusBadge status={run.status} />
          </div>
          {run.description && (
            <p className="mt-1 text-sm text-zinc-500">{run.description}</p>
          )}
          <div className="flex items-center gap-4 mt-2 text-xs text-zinc-400">
            {run.environment && <span>Env: {run.environment}</span>}
            {run.buildVersion && <span>Build: {run.buildVersion}</span>}
            <span>Created {new Date(run.createdAt).toLocaleDateString()}</span>
            {run.startedAt && <span>Started {new Date(run.startedAt).toLocaleDateString()}</span>}
            {run.endedAt && <span>Ended {new Date(run.endedAt).toLocaleDateString()}</span>}
          </div>
        </div>

        {/* ───── Dashboard: Metric Cards + Donut Chart ───── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          <div className="lg:col-span-2 grid grid-cols-2 sm:grid-cols-3 gap-3">
            <MetricCard
              label="Total Cases"
              value={stats.total}
              color="bg-blue-50 dark:bg-blue-900/30 text-blue-600"
              icon={
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
              }
            />
            <MetricCard
              label="Passed"
              value={stats.passed}
              color="bg-green-50 dark:bg-green-900/30 text-green-600"
              icon={
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              }
            />
            <MetricCard
              label="Failed"
              value={stats.failed}
              color="bg-red-50 dark:bg-red-900/30 text-red-600"
              icon={
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              }
            />
            <MetricCard
              label="Skipped"
              value={stats.skipped}
              color="bg-yellow-50 dark:bg-yellow-900/30 text-yellow-600"
              icon={
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                </svg>
              }
            />
            <MetricCard
              label="Pending"
              value={stats.pending}
              color="bg-zinc-100 dark:bg-zinc-800 text-zinc-500"
              icon={
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
            />
          </div>

          {/* Donut chart */}
          <div className="flex flex-col items-center justify-center rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
            <DonutChart data={chartData} size={160} />
            <div className="flex flex-wrap justify-center gap-3 mt-3">
              {chartData
                .filter((d) => d.value > 0)
                .map((d) => (
                  <div key={d.label} className="flex items-center gap-1.5 text-xs">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: d.color }} />
                    <span className="text-zinc-600 dark:text-zinc-400">
                      {d.label} ({d.value})
                    </span>
                  </div>
                ))}
            </div>
          </div>
        </div>

        {/* ───── Executions Table ───── */}
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden bg-white dark:bg-zinc-900">
          <div className="px-5 py-3 border-b border-zinc-200 dark:border-zinc-700">
            <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">
              Test Cases ({executions.length})
            </h2>
          </div>
          {executions.length === 0 ? (
            <div className="text-center py-12 text-zinc-400 text-sm">
              No test cases in this test run.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-200 dark:border-zinc-700 text-left text-xs text-zinc-500 uppercase tracking-wider">
                    <th className="px-5 py-3 font-medium">ID</th>
                    <th className="px-5 py-3 font-medium">Test Case</th>
                    <th className="px-5 py-3 font-medium">Priority</th>
                    <th className="px-5 py-3 font-medium">Type</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {executions.map((e) => (
                    <tr key={e.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                      <td className="px-5 py-3 text-xs text-zinc-400 font-mono whitespace-nowrap">
                        {e.externalId || "—"}
                      </td>
                      <td className="px-5 py-3 text-sm text-zinc-900 dark:text-zinc-100">
                        {e.title}
                      </td>
                      <td className="px-5 py-3">
                        <span className="text-xs text-zinc-500">{e.priority || "—"}</span>
                      </td>
                      <td className="px-5 py-3">
                        <span className="text-xs text-zinc-500">{e.type || "—"}</span>
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge status={e.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-8 flex items-center justify-center gap-2 text-xs text-zinc-400 pb-8">
          <span>Shared via</span>
          <Image src="/tesbox-logo-transparent.png" alt="TesboX" width={90} height={26} className="h-5 w-auto" />
          <span>&mdash; Test Case Management</span>
        </div>
      </main>
    </div>
  );
}
