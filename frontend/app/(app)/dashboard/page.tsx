"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import { authMe, getWorkspaceAnalytics, getWorkspace, type WorkspaceAnalytics, type WorkspaceInfo } from "@/lib/api";

const STATUS_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  Passed: { bg: "bg-emerald-100 dark:bg-emerald-900/40", text: "text-emerald-800 dark:text-emerald-200", label: "Passed" },
  Failed: { bg: "bg-red-100 dark:bg-red-900/40", text: "text-red-800 dark:text-red-200", label: "Failed" },
  Blocked: { bg: "bg-amber-100 dark:bg-amber-900/40", text: "text-amber-800 dark:text-amber-200", label: "Blocked" },
  Untested: { bg: "bg-zinc-100 dark:bg-zinc-700/50", text: "text-zinc-600 dark:text-zinc-300", label: "Untested" },
};

function statusStyle(status: string) {
  return STATUS_COLORS[status] ?? { bg: "bg-zinc-100 dark:bg-zinc-700/50", text: "text-zinc-700 dark:text-zinc-300", label: status };
}

export default function DashboardPage() {
  const router = useRouter();
  const [auth, setAuth] = useState<{ userId: string } | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<WorkspaceAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    authMe().then((me) => {
      setAuth(me);
      if (!me) {
        router.replace("/login");
        return;
      }
      Promise.all([getWorkspace(), getWorkspaceAnalytics()])
        .then(([workspace, data]) => {
          setWorkspaceName((workspace as WorkspaceInfo).name ?? "Workspace");
          setAnalytics(data);
        })
        .catch((e) => setError(e instanceof Error ? e.message : "Failed to load analytics"))
        .finally(() => setLoading(false));
    });
  }, [router]);

  if (!auth) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-zinc-500">Loading analytics…</p>
      </div>
    );
  }

  if (error || !analytics) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-8">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Dashboard</h1>
        <p className="mt-2 text-red-600 dark:text-red-400">{error ?? "Unable to load analytics."}</p>
      </main>
    );
  }

  const statusEntries = Object.entries(analytics.executionStatus).sort((a, b) => b[1] - a[1]);
  const totalExec = analytics.executionTotal;

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <span className="text-zinc-900 dark:text-zinc-100">{workspaceName}</span>
          <span>/</span>
          <span className="text-zinc-900 dark:text-zinc-100">Dashboard</span>
        </div>
        <h1 className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Dashboard</h1>
        <p className="mt-1 text-zinc-500 dark:text-zinc-400">Workspace-level analytics across all projects</p>
      </div>

      {/* Metric cards */}
      <section className="mb-8">
        <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-3">Overview</h2>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          <Link
            href="/projects"
            className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 hover:border-zinc-300 dark:hover:border-zinc-600 transition-colors"
          >
            <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{analytics.projectCount}</p>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Projects</p>
          </Link>
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
            <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{analytics.testCaseCount}</p>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Test cases</p>
          </div>
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
            <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{analytics.suiteCount}</p>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Suites</p>
          </div>
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
            <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{analytics.planCount}</p>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Plans</p>
          </div>
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
            <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{analytics.cycleCount}</p>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Cycles</p>
          </div>
        </div>
      </section>

      {/* Execution status breakdown */}
      <section>
        <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-3">Execution status (all projects)</h2>
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden">
          {totalExec === 0 ? (
            <div className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
              No executions yet. Run a test cycle in any project to see status breakdown.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4 border-b border-zinc-200 dark:border-zinc-700">
                {statusEntries.map(([status, count]) => {
                  const style = statusStyle(status);
                  const pct = totalExec > 0 ? Math.round((count / totalExec) * 100) : 0;
                  return (
                    <div key={status} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between">
                        <span className={`text-sm font-medium rounded-full px-2 py-0.5 ${style.bg} ${style.text}`}>
                          {style.label}
                        </span>
                        <span className="text-sm text-zinc-500 dark:text-zinc-400">{pct}%</span>
                      </div>
                      <div className="h-2 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${style.bg} ${style.text}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">{count} of {totalExec}</p>
                    </div>
                  );
                })}
              </div>
              <div className="px-4 py-3 bg-zinc-50 dark:bg-zinc-800/50 border-t border-zinc-200 dark:border-zinc-700">
                <p className="text-sm text-zinc-600 dark:text-zinc-300">
                  Total executions across all projects: <strong>{totalExec}</strong>
                </p>
                <Link
                  href="/projects"
                  className="text-sm text-blue-600 dark:text-blue-400 hover:underline mt-1 inline-block"
                >
                  View projects →
                </Link>
              </div>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
