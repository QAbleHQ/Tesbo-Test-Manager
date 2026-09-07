"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  IconFileText,
  IconFolders,
  IconClipboardCheck,
  IconPlayerPlay,
  IconBug,
  IconRosetteDiscountCheck,
  IconGauge,
  IconCircleHalf2,
  IconTrendingUp,
  IconTrendingDown,
  IconActivity,
} from "@tabler/icons-react";
import {
  authMe,
  getProject,
  listCycles,
  listActivity,
  getProjectDashboardSummary,
  type ProjectDashboardSummary,
  type TestRunListItem,
  type ActivityLogItem,
} from "@/lib/api";
import { Card, PageLoader, StatusChip, type StatusChipProps } from "@/components/ui";
import { PageHeader, StandardPageLayout, Breadcrumbs } from "@/components/workflows";
import { OwnerAvatar } from "@/components/testplans/PlanCard";

/* ───── shared small helpers ───── */

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function runStatusTone(status: string): StatusChipProps["tone"] {
  switch (status) {
    case "Planning":
      return "warning";
    case "In Progress":
      return "info";
    case "Completed":
      return "success";
    default:
      return "neutral";
  }
}

const ENTITY_LABEL: Record<string, string> = {
  testcase: "a test case",
  suite: "a suite",
  plan: "a test plan",
  cycle: "a test run",
  bug: "a bug",
  knowledge_folder: "a folder",
  knowledge_document: "a knowledge document",
  knowledge_file: "a file",
  execution: "an execution",
  zyra_chat: "a Zyra chat",
};

// Keeps this feed honest: only ever summarizes real actor/action/entity fields from the
// activity log, never invents narrative detail (e.g. pass-rate deltas) the log doesn't carry.
function describeActivity(item: ActivityLogItem): string {
  const actor = item.actorKind === "agent" ? item.actorName || "Zyra" : item.actorName || item.actorEmail || "System";
  const action = item.action;
  const verb = action.includes("delet")
    ? "deleted"
    : action.includes("creat") || action.startsWith("zyra_") && action.includes("creat")
      ? "created"
      : action.includes("updat")
        ? "updated"
        : action.includes("mov")
          ? "moved"
          : action.includes("approv")
            ? "approved"
            : action.includes("reject")
              ? "rejected"
              : action.replace(/_/g, " ");
  const entityLabel = ENTITY_LABEL[item.entityType] || item.entityType.replace(/_/g, " ");
  return `${actor} ${verb} ${entityLabel}${item.entityName ? `: ${item.entityName}` : ""}`;
}

function activityDotColor(item: ActivityLogItem): string {
  if (item.actorKind === "agent") return "var(--ai-primary)";
  if (item.action.includes("delet") || item.action.includes("reject")) return "var(--error)";
  if (item.action.includes("creat") || item.action.includes("approv")) return "var(--success)";
  if (item.action.includes("updat") || item.action.includes("mov")) return "var(--info)";
  return "var(--muted-soft)";
}

/* ───── stat card ───── */

function StatCard({
  href,
  icon,
  iconBg,
  iconColor,
  badge,
  value,
  label,
  bar,
}: {
  href: string;
  icon: ReactNode;
  iconBg: string;
  iconColor: string;
  badge?: ReactNode;
  value: ReactNode;
  label: string;
  bar?: ReactNode;
}) {
  return (
    <Link href={href} className="group">
      <Card className="flex flex-col p-4 transition-colors hover:border-[var(--border-strong)]">
        <div className="mb-3 flex items-center justify-between">
          <div className="inline-flex w-fit rounded-[8px] p-2" style={{ background: iconBg }}>
            <span style={{ color: iconColor }}>{icon}</span>
          </div>
          {badge}
        </div>
        <p className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-[var(--foreground)]">{value}</p>
        <p className="mt-1.5 text-[13px] text-[var(--muted)]">{label}</p>
        {bar}
      </Card>
    </Link>
  );
}

function ThinBar({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2 flex h-[3px] gap-[1px] overflow-hidden rounded-full bg-[var(--surface-secondary)]">
      {children}
    </div>
  );
}

/* ═══════════════════ MAIN PAGE ═══════════════════ */

export default function ProjectDashboardPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [project, setProject] = useState<Record<string, unknown> | null>(null);
  const [summary, setSummary] = useState<ProjectDashboardSummary | null>(null);
  const [runs, setRuns] = useState<TestRunListItem[]>([]);
  const [activities, setActivities] = useState<ActivityLogItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Reset for the new projectId — otherwise navigating from one project's dashboard straight
    // to another's (the whole project card is a single Link) reuses this same mounted page
    // instance, and stale project/summary from the previous project would render underneath —
    // or, if the previous project's request settles after this one starts, its .then/.catch
    // would clobber state that belongs to the new project. `cancelled` guards against that race.
    let cancelled = false;
    setLoading(true);
    setProject(null);
    setSummary(null);
    authMe().then((me) => {
      if (cancelled) return;
      if (!me) {
        router.replace("/login");
        return;
      }
      getProject(projectId)
        .then((p) => {
          if (cancelled) return undefined;
          setProject(p);
          return Promise.all([
            getProjectDashboardSummary(projectId),
            listCycles(projectId),
            listActivity(projectId, { limit: 10 }),
          ]);
        })
        .then((res) => {
          if (cancelled || !res) return;
          const [summaryRes, cyclesRes, activityRes] = res;
          setSummary(summaryRes);
          setRuns(cyclesRes.slice(0, 4));
          setActivities(activityRes.list);
        })
        .catch(() => {
          if (!cancelled) router.replace("/projects");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, router]);

  if (loading || !project || !summary) {
    return <PageLoader variant="screen" label="Loading project…" />;
  }

  const name = (project.name as string) ?? "";
  const description = (project.description as string) ?? "";

  const bySeverity = summary.openBugs.bySeverity;
  const openBugsTotal = summary.openBugs.total;
  const severityPct = (n: number) => (openBugsTotal > 0 ? (n / openBugsTotal) * 100 : 0);

  const SEVERITY_ROWS: { label: string; count: number; text: string; bg: string; bar: string }[] = [
    { label: "Critical", count: bySeverity.Critical, text: "var(--error-foreground)", bg: "var(--error-soft)", bar: "var(--error)" },
    { label: "High", count: bySeverity.High, text: "var(--warning-foreground)", bg: "var(--warning-soft)", bar: "var(--warning)" },
    { label: "Medium", count: bySeverity.Medium, text: "var(--muted)", bg: "var(--surface-secondary)", bar: "var(--muted-soft)" },
    { label: "Low", count: bySeverity.Low, text: "var(--success-foreground)", bg: "var(--success-soft)", bar: "var(--success)" },
  ];
  // The "Open bugs" stat card's badge used to only ever show Critical's count — so a project with,
  // say, 5 High bugs and 0 Critical showed no count badge at all, even though a non-zero count
  // existed. Falls through in severity order to the first non-zero row instead.
  const topSeverityRow = SEVERITY_ROWS.find((row) => row.count > 0);

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title={name}
          subtitle={description || undefined}
          breadcrumb={
            <Breadcrumbs
              items={[
                { label: "Projects", href: "/projects" },
                { label: name || "Project" },
              ]}
            />
          }
          actions={
            <>
              <Link
                href={`/projects/${projectId}/cycles?create=1`}
                className="inline-flex h-9 items-center gap-2 rounded-[6px] border border-[var(--ink-200)] px-4 text-[13px] font-medium text-[var(--ink-600)] transition-colors hover:bg-[var(--ink-100)]"
              >
                <IconPlayerPlay size={15} stroke={1.75} />
                New run
              </Link>
              <Link
                href={`/projects/${projectId}/plans?create=1`}
                className="inline-flex h-9 items-center gap-2 rounded-[6px] bg-[var(--denim)] px-4 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-[var(--denim-400)]"
              >
                New test plan
              </Link>
            </>
          }
        />
      }
    >
      {/* Primary stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
        <StatCard
          href={`/projects/${projectId}/testcases`}
          icon={<IconFileText size={18} stroke={1.75} />}
          iconBg="var(--brand-soft)"
          iconColor="var(--brand-primary)"
          badge={
            summary.testCases.addedThisWeek > 0 ? (
              <StatusChip tone="success">+{summary.testCases.addedThisWeek} this week</StatusChip>
            ) : undefined
          }
          value={summary.testCases.total}
          label="Test cases"
        />

        <StatCard
          href={`/projects/${projectId}/reports`}
          icon={<IconRosetteDiscountCheck size={18} stroke={1.75} />}
          iconBg="var(--success-soft)"
          iconColor="var(--success-foreground)"
          badge={
            summary.passRate.deltaThisWeek !== null ? (
              <StatusChip tone={summary.passRate.deltaThisWeek >= 0 ? "success" : "error"}>
                <span className="inline-flex items-center gap-1">
                  {summary.passRate.deltaThisWeek >= 0 ? (
                    <IconTrendingUp size={11} stroke={1.75} />
                  ) : (
                    <IconTrendingDown size={11} stroke={1.75} />
                  )}
                  {summary.passRate.deltaThisWeek >= 0 ? "+" : ""}
                  {summary.passRate.deltaThisWeek}% this week
                </span>
              </StatusChip>
            ) : undefined
          }
          value={
            summary.passRate.value !== null ? (
              <>
                {summary.passRate.value}
                <span className="text-[16px] font-medium text-[var(--muted)]">%</span>
              </>
            ) : (
              "—"
            )
          }
          label="Pass rate"
          bar={
            summary.passRate.value !== null ? (
              <ThinBar>
                <div className="h-full rounded-full" style={{ width: `${summary.passRate.value}%`, background: "var(--success)" }} />
              </ThinBar>
            ) : undefined
          }
        />

        {/*
          * A distinct metric from Pass rate above: this is how much of the project's execution
          * history has a result at all (Passed+Failed+Blocked+Skipped / total), while Pass rate is
          * how much of what was actually run came back green. Basecamp report: the two used to be
          * conflated on the Test Run and Test Plan pages, so they get their own tile here too.
          */}
        <StatCard
          href={`/projects/${projectId}/cycles`}
          icon={<IconGauge size={18} stroke={1.75} />}
          iconBg="var(--info-soft)"
          iconColor="var(--info-foreground)"
          value={
            <>
              {summary.executionProgress.value}
              <span className="text-[16px] font-medium text-[var(--muted)]">%</span>
            </>
          }
          label="Execution progress"
          bar={
            <ThinBar>
              <div className="h-full rounded-full" style={{ width: `${summary.executionProgress.value}%`, background: "var(--info)" }} />
            </ThinBar>
          }
        />

        <StatCard
          href={`/projects/${projectId}/bugs`}
          icon={<IconBug size={18} stroke={1.75} />}
          iconBg="var(--error-soft)"
          iconColor="var(--error-foreground)"
          badge={
            topSeverityRow ? (
              <StatusChip
                tone={
                  topSeverityRow.label === "Critical" ? "error" : topSeverityRow.label === "High" ? "warning" : "neutral"
                }
              >
                {topSeverityRow.count} {topSeverityRow.label.toLowerCase()}
              </StatusChip>
            ) : undefined
          }
          value={openBugsTotal}
          label="Open bugs"
          bar={
            openBugsTotal > 0 ? (
              <ThinBar>
                {SEVERITY_ROWS.filter((r) => r.count > 0).map((r) => (
                  <div
                    key={r.label}
                    className="h-full"
                    title={`${r.count} ${r.label}`}
                    style={{ width: `${severityPct(r.count)}%`, background: r.bar }}
                  />
                ))}
              </ThinBar>
            ) : undefined
          }
        />

        <StatCard
          href={`/projects/${projectId}/requirements`}
          icon={<IconCircleHalf2 size={18} stroke={1.75} />}
          iconBg="var(--info-soft)"
          iconColor="var(--info-foreground)"
          badge={
            summary.coverage.totalRequirements > 0 ? (
              <StatusChip tone="neutral">of {summary.coverage.totalRequirements} reqs</StatusChip>
            ) : undefined
          }
          value={
            summary.coverage.pct !== null ? (
              <>
                {summary.coverage.pct}
                <span className="text-[16px] font-medium text-[var(--muted)]">%</span>
              </>
            ) : (
              "—"
            )
          }
          label={summary.coverage.totalRequirements > 0 ? "Test coverage" : "Test coverage — no requirements linked"}
          bar={
            summary.coverage.pct !== null ? (
              <ThinBar>
                <div className="h-full rounded-full" style={{ width: `${summary.coverage.pct}%`, background: "var(--info)" }} />
              </ThinBar>
            ) : undefined
          }
        />
      </div>

      {/* Secondary stats */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          href={`/projects/${projectId}/plans`}
          icon={<IconClipboardCheck size={18} stroke={1.75} />}
          iconBg="var(--brand-soft)"
          iconColor="var(--brand-primary)"
          value={summary.plans}
          label="Test plans"
        />

        <StatCard
          href={`/projects/${projectId}/testcases`}
          icon={<IconFolders size={18} stroke={1.75} />}
          iconBg="var(--success-soft)"
          iconColor="var(--success-foreground)"
          value={summary.suites}
          label="Suites"
        />

        <StatCard
          href={`/projects/${projectId}/cycles`}
          icon={<IconPlayerPlay size={18} stroke={1.75} />}
          iconBg="var(--warning-soft)"
          iconColor="var(--warning-foreground)"
          badge={summary.activeRuns > 0 ? <StatusChip tone="warning">running</StatusChip> : undefined}
          value={summary.activeRuns}
          label="Active runs"
        />
      </div>

      {/* Two-column: runs+bugs | activity */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_356px]">
        {/* Left column */}
        <div className="flex flex-col gap-4">
          {/* Recent runs panel */}
          <Card className="overflow-hidden p-0">
            <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3.5">
              <div className="flex items-center gap-2">
                <IconPlayerPlay size={15} stroke={1.75} className="text-[var(--muted)]" />
                <span className="text-[14px] font-medium text-[var(--foreground)]">Recent test runs</span>
              </div>
              <Link href={`/projects/${projectId}/cycles`} className="text-[12px] font-medium text-[var(--accent-light)] hover:underline">
                View all
              </Link>
            </div>
            {runs.length === 0 ? (
              <div className="px-4 py-10 text-center text-[13px] text-[var(--muted-soft)]">No test runs yet.</div>
            ) : (
              runs.map((run) => {
                // A cycle with zero cycle_items still yields one all-NULL row from the backend's
                // LEFT JOIN aggregation, so untested can read 1 even when totalCases is 0 — clamp
                // rather than show a negative "executed" count.
                const executed = Math.max(0, run.totalCases - run.untested);
                return (
                  <Link
                    key={run.id}
                    href={`/projects/${projectId}/cycles/${run.id}`}
                    className="block border-b border-[var(--border-subtle)] px-4 py-3.5 last:border-b-0 transition-colors hover:bg-[var(--surface-secondary)]/40"
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-[13px] font-medium text-[var(--foreground)]">{run.name}</span>
                      <div className="flex shrink-0 items-center gap-2">
                        <StatusChip tone={runStatusTone(run.status)}>{run.status}</StatusChip>
                        <span className="font-mono text-[11px] text-[var(--muted-soft)]">{formatRelative(run.createdAt)}</span>
                      </div>
                    </div>
                    <ThinBar>
                      {run.passed > 0 && (
                        <div className="h-full" style={{ width: `${(run.passed / run.totalCases) * 100}%`, background: "var(--status-pass-dot)" }} />
                      )}
                      {run.failed > 0 && (
                        <div className="h-full" style={{ width: `${(run.failed / run.totalCases) * 100}%`, background: "var(--status-fail-dot)" }} />
                      )}
                      {run.blocked > 0 && (
                        <div className="h-full" style={{ width: `${(run.blocked / run.totalCases) * 100}%`, background: "var(--status-blocked-dot)" }} />
                      )}
                    </ThinBar>
                    <div className="mt-2 flex items-center gap-3.5">
                      <span className="text-[11px] font-medium text-[var(--status-pass-text)]">{run.passed} passed</span>
                      <span className="text-[11px] font-medium text-[var(--status-fail-text)]">{run.failed} failed</span>
                      <span className="text-[11px] text-[var(--muted)]">{run.blocked} blocked</span>
                      <span className="ml-auto font-mono text-[11px] text-[var(--muted-soft)]">
                        {executed}/{run.totalCases} executed
                      </span>
                    </div>
                  </Link>
                );
              })
            )}
          </Card>

          {/* Bug severity breakdown panel */}
          <Card className="p-4">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <IconBug size={15} stroke={1.75} className="text-[var(--muted)]" />
                <span className="text-[14px] font-medium text-[var(--foreground)]">Bug severity breakdown</span>
              </div>
              <span className="text-[12px] text-[var(--muted)]">{openBugsTotal} open</span>
            </div>
            {openBugsTotal === 0 ? (
              <p className="text-[13px] text-[var(--muted-soft)]">No open bugs right now.</p>
            ) : (
              <div className="space-y-2.5">
                {SEVERITY_ROWS.map((row) => (
                  <div key={row.label} className="flex items-center gap-3">
                    <span
                      className="w-16 shrink-0 rounded-[4px] px-2 py-0.5 text-center text-[11px] font-medium"
                      style={{ background: row.bg, color: row.text }}
                    >
                      {row.label}
                    </span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-secondary)]">
                      <div className="h-full rounded-full" style={{ width: `${severityPct(row.count)}%`, background: row.bar }} />
                    </div>
                    <span className="w-[18px] shrink-0 text-right text-[12px] font-semibold text-[var(--foreground)]">{row.count}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* Right column: activity feed */}
        <Card className="flex max-h-[640px] flex-col overflow-hidden p-0">
          <div className="flex shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3.5">
            <div className="flex items-center gap-2">
              <IconActivity size={15} stroke={1.75} className="text-[var(--muted)]" />
              <span className="text-[14px] font-medium text-[var(--foreground)]">Recent activity</span>
            </div>
            <StatusChip tone="neutral">{activities.length}</StatusChip>
          </div>
          <div className="flex-1 overflow-y-auto">
            {activities.length === 0 ? (
              <div className="px-4 py-10 text-center text-[13px] text-[var(--muted-soft)]">No activity yet.</div>
            ) : (
              activities.map((item) => (
                <div key={item.id} className="flex items-start gap-2.5 border-b border-[var(--border-subtle)] px-4 py-3 last:border-b-0">
                  <span
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                    style={{ background: activityDotColor(item) }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] leading-[1.5] text-[var(--muted)]">{describeActivity(item)}</p>
                    <div className="mt-1 flex items-center gap-1.5">
                      <OwnerAvatar
                        name={item.actorKind === "agent" ? item.actorName || "Zyra" : item.actorName || item.actorEmail || "System"}
                        seed={item.actorKind === "agent" ? undefined : item.actorId}
                      />
                      <span className="font-mono text-[11px] text-[var(--muted-soft)]">{formatRelative(item.createdAt)}</span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </StandardPageLayout>
  );
}
