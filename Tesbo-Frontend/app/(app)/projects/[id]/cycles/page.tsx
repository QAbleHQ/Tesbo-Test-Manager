"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import {
  IconArrowRight,
  IconCalendarEvent,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleMinus,
  IconCircleX,
  IconAlertTriangle,
  IconClipboardList,
  IconRobot,
  IconClock,
  IconDeviceDesktop,
  IconPencil,
  IconPlayerPlay,
  IconPlayerSkipForward,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import {
  authMe,
  listTestRuns,
  createTestRun,
  updateTestRun,
  deleteTestRun,
  getProject,
  listProjectMembers,
  listPlans,
  type TestRunListItem,
  type TestEnvironmentSetting,
} from "@/lib/api";
import { computePassRate } from "@/lib/executionMetrics";
import {
  Button,
  Input,
  Card,
  StatusChip,
  Select,
  EmptyStateBlock,
  Modal,
  Field,
  FieldLabel,
  PageLoader,
  Textarea,
} from "@/components/ui";
import { PageHeader, ListWorkspaceLayout, Breadcrumbs } from "@/components/workflows";
import { getInitials, statusTone, formatDuration, formatDate, RunAvatar, RunProgressBar } from "@/components/testruns/runDisplay";

const STATUS_FILTERS: { value: string; label: string; dot: string }[] = [
  { value: "all", label: "All", dot: "var(--ink-400)" },
  { value: "Planning", label: "Planning", dot: "var(--warning)" },
  { value: "In Progress", label: "In Progress", dot: "var(--info)" },
  { value: "Completed", label: "Completed", dot: "var(--success)" },
];

const STATUS_SORT_ORDER: Record<string, number> = { Planning: 0, "In Progress": 1, Completed: 2 };
type SortOption = "newest" | "oldest" | "name" | "status";

import { avatarColor } from "@/lib/avatarColors";

function passRateColor(pct: number): string {
  if (pct >= 80) return "var(--status-pass-text)";
  if (pct >= 50) return "var(--status-blocked-text)";
  return "var(--status-fail-text)";
}

// Seeded on the owner's id, not their name — matches every other person avatar (top bar, team
// avatars, activity, admins) so the same person keeps the same colour everywhere. Part of
// Basecamp 10198836413.
function OwnerAvatar({ name, seed }: { name: string; seed?: string | null }) {
  return (
    <span
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-[var(--surface)] text-[10px] font-semibold text-white"
      style={{ background: avatarColor(seed || name) }}
      title={name}
    >
      {getInitials(name)}
    </span>
  );
}

function StatTile({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-3.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">{label}</div>
      <div className="mt-1.5 text-[22px] font-semibold leading-none tracking-tight" style={{ color: color ?? "var(--foreground)" }}>
        {value}
      </div>
    </div>
  );
}

type ProjectSettingsPayload = {
  testRunEnvironments?: Array<{ name?: string; url?: string }>;
};

export default function TestRunsPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.id as string;

  const [runs, setRuns] = useState<TestRunListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [ownerNames, setOwnerNames] = useState<Record<string, string>>({});
  const [planNames, setPlanNames] = useState<Record<string, string>>({});

  const [statusFilter, setStatusFilter] = useState("all");
  const [sortBy, setSortBy] = useState<SortOption>("newest");

  /* modal state */
  const [showCreate, setShowCreate] = useState(false);
  const [editRun, setEditRun] = useState<TestRunListItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TestRunListItem | null>(null);

  /* form fields */
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [environment, setEnvironment] = useState("");
  const [buildVersion, setBuildVersion] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [environmentOptions, setEnvironmentOptions] = useState<TestEnvironmentSetting[]>([]);
  const [canManageRuns, setCanManageRuns] = useState(false);
  const [projectName, setProjectName] = useState("");

  useEffect(() => {
    if (searchParams.get("create") === "1") {
      resetForm();
      setFormError(null);
      setShowCreate(true);
    }
  }, [searchParams]);

  function parseProjectSettings(raw: unknown): ProjectSettingsPayload {
    if (typeof raw !== "string" || !raw.trim()) return {};
    try {
      const parsed = JSON.parse(raw) as ProjectSettingsPayload;
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

  const load = useCallback(() => {
    Promise.all([
      listTestRuns(projectId),
      getProject(projectId),
      listProjectMembers(projectId).catch(() => []),
      listPlans(projectId).catch(() => []),
    ])
      .then(([runsData, project, members, plans]) => {
        setRuns(runsData);
        const parsedSettings = parseProjectSettings(project.settings);
        setEnvironmentOptions(normalizeTestRunEnvironments(parsedSettings.testRunEnvironments));
        const myRole = typeof project.myRole === "string" ? project.myRole.toLowerCase() : "";
        setCanManageRuns(!myRole || ["owner", "admin", "manager"].includes(myRole));
        setOwnerNames(Object.fromEntries(members.map((m) => [m.userId, m.name || m.email || "Unknown user"])));
        setPlanNames(Object.fromEntries(plans.map((p) => [p.id, p.name])));
        setProjectName(String(project.name || ""));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      load();
    });
  }, [router, load]);

  const visibleRuns = useMemo(() => {
    const filtered = statusFilter === "all" ? runs : runs.filter((r) => r.status === statusFilter);
    const sorted = [...filtered];
    switch (sortBy) {
      case "oldest":
        sorted.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        break;
      case "name":
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "status":
        sorted.sort((a, b) => (STATUS_SORT_ORDER[a.status] ?? 99) - (STATUS_SORT_ORDER[b.status] ?? 99));
        break;
      case "newest":
      default:
        sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    return sorted;
  }, [runs, statusFilter, sortBy]);

  // Pass Rate = Passed / (Passed + Failed + Blocked) across every visible run, matching the Test
  // Run Details and Test Plan pages (lib/executionMetrics) — this used to divide by totalCases
  // (every case, including Untested/Skipped), which disagreed with both of those pages.
  // Scoped to visibleRuns so the tile matches whatever status filter is applied below it.
  const summary = useMemo(() => {
    const totalRuns = visibleRuns.length;
    const inProgress = visibleRuns.filter((r) => r.status === "In Progress").length;
    let passed = 0;
    let failed = 0;
    let blocked = 0;
    let openFailures = 0;
    for (const r of visibleRuns) {
      passed += r.passed;
      failed += r.failed;
      blocked += r.blocked;
      openFailures += r.failed;
    }
    const passRate = computePassRate({ passed, failed, blocked });
    return { totalRuns, inProgress, passRate, openFailures };
  }, [visibleRuns]);

  /* create */
  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !environment.trim()) return;
    setSaving(true);
    setFormError(null);
    try {
      await createTestRun(projectId, { name, description, environment, buildVersion });
      setShowCreate(false);
      resetForm();
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create test run.");
    } finally {
      setSaving(false);
    }
  }

  /* edit */
  function openEdit(r: TestRunListItem) {
    setEditRun(r);
    setName(r.name);
    setDescription(r.description);
    setEnvironment(r.environment);
    setBuildVersion(r.buildVersion);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editRun || !environment.trim()) return;
    setSaving(true);
    setFormError(null);
    try {
      await updateTestRun(editRun.id, { name, description, environment, buildVersion });
      setEditRun(null);
      resetForm();
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to update test run.");
    } finally {
      setSaving(false);
    }
  }

  /* delete */
  async function handleDelete() {
    if (!deleteTarget) return;
    setSaving(true);
    setFormError(null);
    try {
      await deleteTestRun(deleteTarget.id);
      setDeleteTarget(null);
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to delete test run.");
    } finally {
      setSaving(false);
    }
  }

  function resetForm() {
    setName("");
    setDescription("");
    setEnvironment("");
    setBuildVersion("");
  }

  if (loading) {
    return <PageLoader variant="screen" label="Loading runs…" />;
  }

  const emptyIcon = <IconPlayerPlay size={48} stroke={1.25} className="text-[var(--ink-300)]" />;

  return (
    <ListWorkspaceLayout
      header={
        <PageHeader
          title="Test Runs"
          subtitle="Create and manage test runs to track execution progress."
          breadcrumb={
            <Breadcrumbs
              items={[
                { label: "Projects", href: "/projects" },
                { label: projectName || "Project", href: `/projects/${projectId}/dashboard` },
                { label: "Test Runs" },
              ]}
            />
          }
          actions={
            canManageRuns ? (
              <div className="flex items-center gap-2">
                <Link
                  href={`/projects/${projectId}/cycles/schedule`}
                  className="inline-flex h-9 items-center gap-2 rounded-[6px] border border-[var(--ink-200)] px-4 text-[13px] font-medium text-[var(--ink-600)] transition-colors hover:bg-[var(--ink-100)]"
                >
                  <IconCalendarEvent size={15} stroke={1.75} />
                  Schedule
                </Link>
                <Button
                  onClick={() => {
                    resetForm();
                    setFormError(null);
                    setShowCreate(true);
                  }}
                >
                  <IconPlus size={15} stroke={2} />
                  Create Test Run
                </Button>
              </div>
            ) : undefined
          }
        />
      }
    >
      {/* Empty state */}
      {runs.length === 0 && (
        <EmptyStateBlock
          title={canManageRuns ? "No test runs yet" : "No test runs have been created"}
          description={canManageRuns ? "Create one to get started." : "No test runs have been created for this project yet."}
          icon={emptyIcon}
          action={canManageRuns ? (
            <Button onClick={() => { resetForm(); setFormError(null); setShowCreate(true); }}>
              Create Test Run
            </Button>
          ) : undefined}
        />
      )}

      {runs.length > 0 && (
        <>
          {/* Summary stats */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Total Runs" value={String(summary.totalRuns)} />
            <StatTile label="In Progress" value={String(summary.inProgress)} color="var(--info-foreground)" />
            <StatTile
              label="Pass Rate"
              value={summary.passRate !== null ? `${summary.passRate}%` : "—"}
              color={summary.passRate !== null ? passRateColor(summary.passRate) : undefined}
            />
            <StatTile label="Open Failures" value={String(summary.openFailures)} color="var(--status-fail-text)" />
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-[12px] text-[var(--muted-soft)]">Status</span>
            {STATUS_FILTERS.map((f) => {
              const active = statusFilter === f.value;
              return (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setStatusFilter(f.value)}
                  className={`flex h-[26px] items-center gap-1.5 rounded-full border px-3 text-[11.5px] font-medium transition-colors ${
                    active
                      ? "border-[var(--brand-border)] bg-[var(--brand-soft)] text-[var(--accent-light)]"
                      : "border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:border-[var(--brand-border)] hover:text-[var(--foreground)]"
                  }`}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: f.dot }} />
                  {f.label}
                </button>
              );
            })}
            <div className="ml-auto flex items-center gap-2">
              <span className="text-[12px] text-[var(--muted-soft)]">Sort</span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortOption)}
                className="h-[28px] rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[12px] text-[var(--ink-600)] outline-none"
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="name">Name A–Z</option>
                <option value="status">Status</option>
              </select>
            </div>
          </div>

          {/* Run cards */}
          <div className="grid gap-3">
            {visibleRuns.map((r) => {
              const total = r.totalCases;
              const executed = r.passed + r.failed + r.blocked + r.skipped;
              const ownerName = r.ownerId ? ownerNames[r.ownerId] : null;
              const planName = r.planId ? planNames[r.planId] : null;
              return (
                <Card key={r.id} className="p-0 transition-colors hover:border-[var(--border-strong)]">
                  <div className="flex items-center gap-3 p-4">
                    <RunAvatar name={r.name} />

                    <div className="min-w-0 flex-1">
                      <div className="mb-0.5 flex flex-wrap items-center gap-2">
                        <Link
                          href={`/projects/${projectId}/cycles/${r.id}`}
                          className="text-[14.5px] font-semibold text-[var(--foreground)] hover:text-[var(--accent-light)]"
                        >
                          {r.name}
                        </Link>
                        <StatusChip tone={statusTone(r.status)}>{r.status}</StatusChip>
                        {/*
                          * Whether a run's results were reported by an SDK or typed in by a person
                          * is the first thing you need to know when a pass rate looks wrong, so it
                          * belongs next to the name rather than only on the detail page. Nothing
                          * renders for a manual run (Basecamp 10189985971).
                          */}
                        {r.source === "automation" && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--muted)]"
                            title={
                              r.closeStatus === "incomplete"
                                ? "Reported by an automation SDK. The test process never reported that it finished, so some results may be missing."
                                : "Results reported by an automation SDK"
                            }
                          >
                            <IconRobot size={11} stroke={1.75} />
                            Automated
                            {r.closeStatus === "incomplete" && (
                              <IconAlertTriangle size={11} stroke={1.75} style={{ color: "var(--warning)" }} />
                            )}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[var(--muted-soft)]">
                        {planName && (
                          <span className="flex items-center gap-1">
                            <IconClipboardList size={12} stroke={1.75} />
                            {planName}
                          </span>
                        )}
                        {r.environment && (
                          <span className="flex items-center gap-1">
                            <IconDeviceDesktop size={12} stroke={1.75} />
                            {r.environment}
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <IconClock size={12} stroke={1.75} />
                          <span className="font-mono">{formatDuration(r.startedAt, r.endedAt)}</span>
                        </span>
                        <span className="flex items-center gap-1">
                          <IconCalendarEvent size={12} stroke={1.75} />
                          {formatDate(r.createdAt)}
                        </span>
                      </div>
                    </div>

                    {ownerName && <OwnerAvatar name={ownerName} seed={r.ownerId} />}

                    <div className="flex shrink-0 items-center gap-1">
                      <Link
                        href={`/projects/${projectId}/cycles/${r.id}`}
                        title="View run"
                        className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--muted-soft)] transition-colors hover:bg-[var(--ink-100)] hover:text-[var(--foreground)]"
                      >
                        <IconArrowRight size={15} stroke={1.75} />
                      </Link>
                      {canManageRuns && (
                        <>
                          <button
                            onClick={(e) => { e.stopPropagation(); setFormError(null); openEdit(r); }}
                            className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--muted-soft)] transition-colors hover:bg-[var(--ink-100)] hover:text-[var(--foreground)]"
                            title="Edit run"
                          >
                            <IconPencil size={15} stroke={1.75} />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setFormError(null); setDeleteTarget(r); }}
                            className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--muted-soft)] transition-colors hover:bg-[var(--status-fail-fill)] hover:text-[var(--status-fail-text)]"
                            title="Delete run"
                          >
                            <IconTrash size={15} stroke={1.75} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {total > 0 && (
                    <div className="border-t border-[var(--border-subtle)] px-4 py-3">
                      <RunProgressBar passed={r.passed} failed={r.failed} blocked={r.blocked} skipped={r.skipped} total={total} />
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-4">
                          <span className="flex items-center gap-1 text-[11.5px] font-medium text-[var(--status-pass-text)]">
                            <IconCircleCheck size={13} stroke={1.75} />
                            {r.passed} passed
                          </span>
                          <span className="flex items-center gap-1 text-[11.5px] font-medium text-[var(--status-fail-text)]">
                            <IconCircleX size={13} stroke={1.75} />
                            {r.failed} failed
                          </span>
                          <span className="flex items-center gap-1 text-[11.5px] font-medium text-[var(--status-blocked-text)]">
                            <IconCircleMinus size={13} stroke={1.75} />
                            {r.blocked} blocked
                          </span>
                          <span className="flex items-center gap-1 text-[11.5px] font-medium text-[var(--status-skipped-text)]">
                            <IconPlayerSkipForward size={13} stroke={1.75} />
                            {r.skipped} skipped
                          </span>
                          <span className="flex items-center gap-1 text-[11.5px] text-[var(--muted-soft)]">
                            <IconCircleDashed size={13} stroke={1.75} />
                            {r.untested} untested
                          </span>
                        </div>
                        <span className="text-[11.5px] text-[var(--muted)]">
                          {executed} / {total} cases
                        </span>
                      </div>
                    </div>
                  )}
                </Card>
              );
            })}
            {visibleRuns.length === 0 && (
              <p className="py-8 text-center text-[13px] text-[var(--muted)]">No test runs match this filter.</p>
            )}
          </div>
        </>
      )}

      {/* Create Modal */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Create Test Run"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <Field>
            <FieldLabel>
              Name <span className="text-[var(--error-foreground)]">*</span>
            </FieldLabel>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sprint 42 Regression"
              autoFocus
              required
            />
          </Field>
          <Field>
            <FieldLabel>Description</FieldLabel>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel>
                Environment <span className="text-[var(--error-foreground)]">*</span>
              </FieldLabel>
              <Select
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
                required
              >
                <option value="">Select environment</option>
                {environmentOptions.map((env) => (
                  <option key={env.name} value={env.name}>
                    {env.name}
                  </option>
                ))}
              </Select>
              {environment && (
                <p className="mt-1 text-xs text-[var(--muted)]">
                  URL: {environmentOptions.find((item) => item.name === environment)?.url ?? "Not available"}
                </p>
              )}
              {environmentOptions.length === 0 && (
                <p className="mt-1 text-xs text-[var(--warning-foreground)]">
                  No environments configured. Add one in{" "}
                  <Link href={`/projects/${projectId}/settings?tab=general`} className="underline">
                    Project settings
                  </Link>
                  .
                </p>
              )}
            </Field>
            <Field>
              <FieldLabel>Build Version</FieldLabel>
              <Input
                type="text"
                value={buildVersion}
                onChange={(e) => setBuildVersion(e.target.value)}
                placeholder="e.g. v2.4.1"
              />
            </Field>
          </div>
          {formError && (
            <p className="rounded-lg border border-[var(--error)]/30 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error-foreground)]">
              {formError}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => { setShowCreate(false); setFormError(null); }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || !name.trim() || !environment.trim() || environmentOptions.length === 0}
            >
              {saving ? "Creating…" : "Create Test Run"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Edit Modal */}
      <Modal
        open={editRun !== null}
        onClose={() => {
          setEditRun(null);
          resetForm();
        }}
        title="Edit Test Run"
      >
        <form onSubmit={handleEdit} className="space-y-4">
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
            />
          </Field>
          <Field>
            <FieldLabel>Description</FieldLabel>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel>
                Environment <span className="text-[var(--error-foreground)]">*</span>
              </FieldLabel>
              <Select
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
                required
              >
                <option value="">Select environment</option>
                {environment &&
                  !environmentOptions.some((item) => item.name === environment) && (
                    <option value={environment}>{environment} (legacy)</option>
                  )}
                {environmentOptions.map((env) => (
                  <option key={env.name} value={env.name}>
                    {env.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              <FieldLabel>Build Version</FieldLabel>
              <Input
                type="text"
                value={buildVersion}
                onChange={(e) => setBuildVersion(e.target.value)}
              />
            </Field>
          </div>
          {formError && (
            <p className="rounded-lg border border-[var(--error)]/30 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error-foreground)]">
              {formError}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setEditRun(null);
                resetForm();
                setFormError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || !environment.trim()}
            >
              {saving ? "Saving…" : "Save Changes"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete Confirm Modal */}
      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete Test Run"
      >
        <p className="text-sm text-[var(--muted)] mb-6">
          Are you sure you want to delete{" "}
          <span className="font-semibold text-[var(--foreground)]">
            {deleteTarget?.name}
          </span>
          ? This will remove all associated test case executions. This action
          cannot be undone.
        </p>
        {formError && (
          <p className="mb-4 rounded-lg border border-[var(--error)]/30 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error-foreground)]">
            {formError}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => { setDeleteTarget(null); setFormError(null); }}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={saving}
          >
            {saving ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </Modal>
    </ListWorkspaceLayout>
  );
}
