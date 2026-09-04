"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import { authMe, getWorkspaceAnalytics, getWorkspace, type WorkspaceAnalytics, type WorkspaceInfo } from "@/lib/api";
import { Card, PageLoader } from "@/components/ui";
import { PageHeader, StandardPageLayout, Breadcrumbs } from "@/components/workflows";

/*
 * Basecamp 10221720616 ("[Dashboard] Execution progress bar colours are not visible").
 *
 * Two problems in one table. The badge tints were hardcoded Tailwind palette values
 * (bg-emerald-100 / text-emerald-800) rather than theme tokens, so they stayed pale-on-pale in dark
 * mode; and the same tint class was reused as the FILL of the progress bar underneath, which put a
 * 100-level pastel on a --surface-tertiary track — the bar was there, it just could not be seen.
 *
 * Split into two: `badge` keeps the soft tint (it sits behind text and has to stay readable), `fill`
 * is the solid dot colour the rest of the app paints statuses with, so the bar reads at a glance.
 */
const STATUS_COLORS: Record<string, { badge: string; text: string; fill: string; label: string }> = {
  Passed: {
    badge: "bg-[var(--status-pass-fill)]",
    text: "text-[var(--status-pass-text)]",
    fill: "var(--status-pass-dot)",
    label: "Passed",
  },
  Failed: {
    badge: "bg-[var(--status-fail-fill)]",
    text: "text-[var(--status-fail-text)]",
    fill: "var(--status-fail-dot)",
    label: "Failed",
  },
  Blocked: {
    badge: "bg-[var(--status-blocked-fill)]",
    text: "text-[var(--status-blocked-text)]",
    fill: "var(--status-blocked-dot)",
    label: "Blocked",
  },
  Untested: {
    badge: "bg-[var(--status-notrun-fill)]",
    text: "text-[var(--status-notrun-text)]",
    fill: "var(--status-notrun-dot)",
    label: "Untested",
  },
};

function statusStyle(status: string) {
  return (
    STATUS_COLORS[status] ?? {
      badge: "bg-[var(--surface-secondary)]",
      text: "text-[var(--muted)]",
      fill: "var(--muted)",
      label: status,
    }
  );
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
    return <PageLoader variant="screen" />;
  }

  if (loading) {
    return <PageLoader variant="screen" label="Loading analytics…" />;
  }

  if (error || !analytics) {
    return (
      <main>
        <h1 className="text-xl font-semibold text-[var(--foreground)]">Dashboard</h1>
        <p className="mt-2 text-red-600">{error ?? "Unable to load analytics."}</p>
      </main>
    );
  }

  const statusEntries = Object.entries(analytics.executionStatus).sort((a, b) => b[1] - a[1]);
  const totalExec = analytics.executionTotal;

  return (
    <StandardPageLayout
      header={(
        <PageHeader
          title="Dashboard"
          subtitle="Workspace-level analytics across all projects"
          breadcrumb={(
            <Breadcrumbs
              items={[
                { label: workspaceName || "Workspace", href: "/dashboard" },
                { label: "Dashboard" },
              ]}
            />
          )}
        />
      )}
    >
      <section className="tesbo-section">
        <h2 className="mb-3 text-sm font-medium text-[var(--muted)]">Overview</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <Link href="/projects" className="block">
            <Card className="p-4 transition hover:border-[var(--border-strong)]">
              <p className="text-2xl font-semibold text-[var(--foreground)]">{analytics.projectCount}</p>
              <p className="text-sm text-[var(--muted)]">Projects</p>
            </Card>
          </Link>
          <Card className="p-4">
            <p className="text-2xl font-semibold text-[var(--foreground)]">{analytics.testCaseCount}</p>
            <p className="text-sm text-[var(--muted)]">Test cases</p>
          </Card>
          <Card className="p-4">
            <p className="text-2xl font-semibold text-[var(--foreground)]">{analytics.suiteCount}</p>
            <p className="text-sm text-[var(--muted)]">Total Suites</p>
          </Card>
          <Card className="p-4">
            <p className="text-2xl font-semibold text-[var(--foreground)]">{analytics.planCount}</p>
            <p className="text-sm text-[var(--muted)]">Test plans</p>
          </Card>
          <Card className="p-4">
            <p className="text-2xl font-semibold text-[var(--foreground)]">{analytics.cycleCount}</p>
            <p className="text-sm text-[var(--muted)]">Test runs</p>
          </Card>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium text-[var(--muted)]">Execution status</h2>
        <Card className="overflow-hidden">
          {totalExec === 0 ? (
            <div className="px-4 py-8 text-center text-[var(--muted)]">
              No executions yet. Run a test cycle in any project to see status breakdown.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 border-b border-[var(--border-subtle)] p-4 sm:grid-cols-4">
                {statusEntries.map(([status, count]) => {
                  const style = statusStyle(status);
                  const pct = totalExec > 0 ? Math.round((count / totalExec) * 100) : 0;
                  return (
                    <div key={status} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between">
                        <span className={`text-sm font-medium rounded-full px-2 py-0.5 ${style.badge} ${style.text}`}>
                          {style.label}
                        </span>
                        <span className="text-sm text-[var(--muted)]">{pct}%</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-[var(--surface-tertiary)]">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: style.fill }} />
                      </div>
                      <p className="text-xs text-[var(--muted)]">{count} of {totalExec}</p>
                    </div>
                  );
                })}
              </div>
              <div className="border-t border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-4 py-3">
                <p className="text-sm text-[var(--muted)]">
                  Total executions across all projects: <strong>{totalExec}</strong>
                </p>
                <Link href="/projects" className="mt-1 inline-block text-sm text-[var(--accent-light)] hover:underline">
                  View projects →
                </Link>
              </div>
            </>
          )}
        </Card>
      </section>
    </StandardPageLayout>
  );
}
