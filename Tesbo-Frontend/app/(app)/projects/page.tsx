"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { authMe, listProjects, listTestCases, listSuites, createProject, getWorkspace, listActivity, listProjectMembers, listTestRuns } from "@/lib/api";
import type { ProjectSummary, ProjectType } from "@/lib/api";
import type { SuiteNode } from "@/lib/api";
import {
  Button,
  Card,
  EmptyStateBlock,
  Field,
  FieldHint,
  FieldLabel,
  Input,
  Modal,
  StatusChip,
  Textarea,
} from "@/components/ui";
import { ListWorkspaceLayout, PageHeader } from "@/components/workflows";

type ProjectWithStats = ProjectSummary & {
  testCaseCount: number;
  suites: SuiteNode[];
  teamMembers: { userId: string; name: string }[];
  lastActivityAt: string | null;
  status: "active" | "configured" | "setup_required";
  passRateTrend: number[];   // pass % per run, ascending by date, 0–100
  currentPassRate: number | null; // latest run's pass %, null if no runs
};

function formatRelativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "just now";
  const diffMs = Date.now() - ts;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "just now";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  return `${Math.floor(diffMs / day)}d ago`;
}

// Deterministic placeholder when no real run data exists (0–100 pass-rate scale)
function placeholderPassTrend(seed: string, count = 14): number[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(31, h) + seed.charCodeAt(i) | 0;
  }
  const rand = () => { h ^= h << 13; h ^= h >> 17; h ^= h << 5; return (Math.abs(h) % 1000) / 1000; };
  const base = 55 + rand() * 25;
  const pts: number[] = [];
  let v = base;
  for (let i = 0; i < count; i++) {
    v = Math.max(10, Math.min(98, v + (rand() - 0.5) * 14));
    pts.push(v);
  }
  return pts;
}

// Color the sparkline green when pass rate is high, amber when it drops
function passRateColor(rate: number | null): { stroke: string; gradId: string } {
  if (rate === null) return { stroke: "var(--muted)", gradId: "sg-muted" };
  if (rate >= 80) return { stroke: "#16a34a", gradId: "sg-pass" };       // green-600
  if (rate >= 50) return { stroke: "#d97706", gradId: "sg-warn" };       // amber-600
  return { stroke: "#dc2626", gradId: "sg-fail" };                        // red-600
}

function MiniSparkline({ data, currentPassRate }: { data: number[]; currentPassRate: number | null }) {
  const W = 300;
  const H = 60;
  const px = 2;
  const py = 5;

  // Always anchor y-axis: min=0, max=100 so drops are visually meaningful
  const lo = 0;
  const hi = 100;
  const range = hi - lo;

  const pts = data.map((v, i) => [
    px + (i / Math.max(data.length - 1, 1)) * (W - px * 2),
    H - py - ((Math.max(0, Math.min(100, v)) - lo) / range) * (H - py * 2),
  ] as [number, number]);

  const line = pts.reduce((acc, [x, y], i) => {
    if (i === 0) return `M ${x.toFixed(1)} ${y.toFixed(1)}`;
    const [px0, py0] = pts[i - 1];
    const cpx = ((px0 + x) / 2).toFixed(1);
    return `${acc} C ${cpx} ${py0.toFixed(1)}, ${cpx} ${y.toFixed(1)}, ${x.toFixed(1)} ${y.toFixed(1)}`;
  }, "");

  const area = `${line} L ${pts[pts.length - 1][0].toFixed(1)} ${H} L ${pts[0][0].toFixed(1)} ${H} Z`;
  const { stroke, gradId } = passRateColor(currentPassRate);

  return (
    <svg
      width="100%"
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="pointer-events-none absolute bottom-0 left-0 right-0"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: stroke, stopOpacity: 0.14 }} />
          <stop offset="100%" style={{ stopColor: stroke, stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      <path d={area} style={{ fill: `url(#${gradId})` }} />
      <path d={line} fill="none" style={{ stroke, strokeOpacity: 0.45 }} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

function ProjectsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [projects, setProjects] = useState<ProjectWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createKey, setCreateKey] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState("");
  const [workspaceRole, setWorkspaceRole] = useState<string>("");
  const canCreateProject = workspaceRole === "owner" || workspaceRole === "admin" || workspaceRole === "manager";

  useEffect(() => {
    if (canCreateProject && searchParams.get("create") === "1") {
      setCreateOpen(true);
    }
  }, [canCreateProject, searchParams]);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      Promise.all([getWorkspace(), listProjects()])
        .then(async ([workspace, list]) => {
          setWorkspaceRole((workspace.role || "").toLowerCase());
          const withStats = await Promise.all(
            list.map(async (p) => {
              const [tcRes, suites, activity, members, runs] = await Promise.all([
                listTestCases(p.id, { limit: 1 }),
                listSuites(p.id),
                listActivity(p.id, { limit: 1 }),
                listProjectMembers(p.id),
                listTestRuns(p.id).catch(() => []),
              ]);
              const lastActivityAt = activity.list[0]?.createdAt ?? null;
              const status: ProjectWithStats["status"] =
                tcRes.total === 0 ? "setup_required" : (lastActivityAt ? "active" : "configured");

              // Build pass rate trend from most recent 14 completed runs (ascending)
              const completedRuns = [...runs]
                .filter((r) => r.totalCases > 0)
                .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
                .slice(-14);
              const passRateTrend = completedRuns.map((r) => Math.round((r.passed / r.totalCases) * 100));
              const latestRun = completedRuns[completedRuns.length - 1];
              const currentPassRate = latestRun
                ? Math.round((latestRun.passed / latestRun.totalCases) * 100)
                : null;

              return {
                ...p,
                projectType: (p.projectType || "tesbox") as ProjectType,
                testCaseCount: tcRes.total,
                suites,
                teamMembers: members.map((m) => ({ userId: m.userId, name: m.name || m.email || "Unknown User" })),
                lastActivityAt,
                status,
                passRateTrend,
                currentPassRate,
              };
            })
          );
          setProjects(withStats);
        })
        .finally(() => setLoading(false));
    });
  }, [router]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError("");
    if (!canCreateProject) {
      setCreateError("Only workspace owner, admin, or manager can create projects.");
      return;
    }
    if (!createName.trim()) {
      setCreateError("Project name is required");
      return;
    }
    setCreateLoading(true);
    try {
      const created = await createProject({
        name: createName.trim(),
        key: createKey.trim() || undefined,
        description: createDescription.trim() || undefined,
        projectType: "tesbox",
      });
      setCreateOpen(false);
      setCreateName("");
      setCreateKey("");
      setCreateDescription("");
      router.push(`/projects/${created.id}/dashboard`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setCreateLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-[var(--muted)]">Loading…</p>
      </div>
    );
  }

  return (
    <ListWorkspaceLayout
      header={(
        <PageHeader
          title="Projects"
          subtitle="TesboX end-to-end test management projects."
          actions={canCreateProject ? (
            <Button onClick={() => setCreateOpen(true)}>
              {projects.length === 0 ? "Create your first project" : "Create project"}
            </Button>
          ) : null}
        />
      )}
    >
      {projects.length === 0 ? (
        <EmptyStateBlock
          title="No projects yet"
          description={
            canCreateProject
              ? "Create a TesboX project for full E2E test management."
              : "You do not have project access yet. Ask your manager to grant access."
          }
          action={canCreateProject ? <Button onClick={() => setCreateOpen(true)}>Create first project</Button> : null}
        />
      ) : null}

      <Modal open={createOpen} onClose={() => !createLoading && setCreateOpen(false)} title="Create project">
        <form onSubmit={handleCreate} className="space-y-5">
          <Field>
            <FieldLabel htmlFor="create-name">Name *</FieldLabel>
            <Input
                  id="create-name"
                  type="text"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="My Project"
                  disabled={createLoading}
                  autoFocus
                />
          </Field>
          <Field>
            <FieldLabel htmlFor="create-key">Key (optional)</FieldLabel>
            <Input
                  id="create-key"
                  type="text"
                  value={createKey}
                  onChange={(e) => setCreateKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                  placeholder="PROJ"
                  className="font-mono"
                  disabled={createLoading}
                />
            <FieldHint>Short code; derived from name if blank.</FieldHint>
          </Field>
          <Field>
            <FieldLabel htmlFor="create-desc">Description (optional)</FieldLabel>
            <Textarea
                  id="create-desc"
                  value={createDescription}
                  onChange={(e) => setCreateDescription(e.target.value)}
                  rows={2}
                  disabled={createLoading}
                />
          </Field>
          {createError && <p className="text-sm text-red-600">{createError}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => !createLoading && setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createLoading}>
              {createLoading ? "Creating…" : "Create project"}
            </Button>
          </div>
        </form>
      </Modal>

      {projects.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
            <svg className="h-4 w-4 text-[var(--brand-primary)]" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 7h8l2 2h8v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /></svg>
            TesboX Projects
          </h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <Link key={p.id} href={`/projects/${p.id}/dashboard`} className="group block">
                <Card className="relative flex h-full flex-col overflow-hidden p-5 transition hover:border-[var(--border-strong)]">
                  <MiniSparkline
                    data={p.passRateTrend.length >= 2 ? p.passRateTrend : placeholderPassTrend(p.id)}
                    currentPassRate={p.currentPassRate}
                  />
                  <div className="relative flex items-start justify-between gap-3">
                    <h2 className="line-clamp-2 text-xl font-semibold leading-7 text-[var(--foreground)] group-hover:text-[var(--brand-primary)]">
                      {p.name}
                    </h2>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="rounded bg-[var(--surface-secondary)] px-2 py-0.5 font-mono text-xs text-[var(--muted)]">
                        {p.key}
                      </span>
                      <StatusChip
                        tone={p.status === "active" ? "brand" : p.status === "configured" ? "neutral" : "warning"}
                        live={p.status === "active"}
                        className="px-2.5 py-0.5 text-xs"
                      >
                        {p.status === "active" ? "Active" : p.status === "configured" ? "Configured" : "Setup required"}
                      </StatusChip>
                    </div>
                  </div>
                  {p.description ? (
                    <p className="mt-2 line-clamp-2 text-sm text-[var(--muted)]">{p.description}</p>
                  ) : (
                    <p className="mt-2 text-sm text-[var(--muted-soft)]">Add project context to guide agent execution and reviews.</p>
                  )}
                  <div className="mt-4 grid grid-cols-3 gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-soft)]">Test cases</p>
                      <p className="mt-1 text-base font-semibold text-[var(--foreground)]">{p.testCaseCount}</p>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-soft)]">Suites</p>
                      <p className="mt-1 text-base font-semibold text-[var(--foreground)]">{p.suites.length}</p>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-soft)]">Pass rate</p>
                      {p.currentPassRate !== null ? (
                        <p className={`mt-1 text-base font-semibold ${p.currentPassRate >= 80 ? "text-green-600" : p.currentPassRate >= 50 ? "text-amber-600" : "text-red-600"}`}>
                          {p.currentPassRate}%
                        </p>
                      ) : (
                        <p className="mt-1 text-base font-semibold text-[var(--muted-soft)]">—</p>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-soft)]">Team</p>
                    {p.teamMembers.length > 0 ? (
                      <div className="flex items-center">
                        {p.teamMembers.slice(0, 4).map((member, idx) => (
                          <span
                            key={member.userId}
                            className={`inline-flex h-7 w-7 items-center justify-center rounded-full border border-[var(--surface-primary)] bg-[var(--brand-soft)] text-[11px] font-semibold text-[var(--brand-primary)] ${idx > 0 ? "-ml-2" : ""}`}
                            title={member.name}
                          >
                            {getInitials(member.name)}
                          </span>
                        ))}
                        {p.teamMembers.length > 4 ? (
                          <span className="-ml-2 inline-flex h-7 min-w-7 items-center justify-center rounded-full border border-[var(--surface-primary)] bg-[var(--surface-tertiary)] px-2 text-[11px] font-semibold text-[var(--foreground)]">
                            +{p.teamMembers.length - 4}
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-xs text-[var(--muted)]">No members assigned</span>
                    )}
                  </div>
                  <div className="relative mt-3 border-t border-[var(--border-subtle)] pb-10 pt-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-[var(--muted)]">
                        {p.lastActivityAt
                          ? `Updated ${formatRelativeTime(p.lastActivityAt)}`
                          : `Created ${formatRelativeTime(p.createdAt)}`}
                      </span>
                      {p.passRateTrend.length > 0 ? (
                        <span className="flex items-center gap-1 text-[11px] font-medium text-[var(--muted-soft)]">
                          <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 17l4-8 4 4 4-6 4 3" /></svg>
                          Pass trend · {p.passRateTrend.length} run{p.passRateTrend.length !== 1 ? "s" : ""}
                        </span>
                      ) : (
                        <span className="text-[11px] text-[var(--muted-soft)]">No runs yet</span>
                      )}
                    </div>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      )}
    </ListWorkspaceLayout>
  );
}

export default function ProjectsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <p className="text-[var(--muted)]">Loading…</p>
        </div>
      }
    >
      <ProjectsPageContent />
    </Suspense>
  );
}
