"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import {
  IconChevronRight,
  IconPlus,
  IconPencil,
  IconTrash,
  IconLink,
  IconCalendarEvent,
  IconClock,
  IconFileDescription,
  IconClipboardList,
  IconCircleCheck,
  IconCircleX,
  IconCircleMinus,
  IconAlertTriangle,
  IconPlayerPlay,
  IconPlayerSkipForward,
  IconArrowRight,
  IconServer,
  IconX,
} from "@tabler/icons-react";
import {
  authMe,
  getPlan,
  updatePlan,
  deletePlan,
  listPlanRuns,
  getPlanProgress,
  listTestRuns,
  createCycleFromPlan,
  associateRunWithPlan,
  dissociateRunFromPlan,
  getProject,
  listPlans,
  listProjectMembers,
  type PlanListItem,
  type PlanRunItem,
  type PlanProgress,
  type TestRunListItem,
  type TestEnvironmentSetting,
} from "@/lib/api";
import { computePassRate, computeExecutionProgress } from "@/lib/executionMetrics";
import { Button, StatusChip, Input, PageLoader, Select, Field, FieldLabel, Card, EmptyStateBlock } from "@/components/ui";
import Modal from "@/components/ui/Modal";
import { useTopBarSlots } from "@/components/TopBarSlots";
import { planStatus, formatLastRun, OwnerAvatar, PlanStatusBadge } from "@/components/testplans/PlanCard";
import { statusTone, formatDate, RunAvatar, RunProgressBar } from "@/components/testruns/runDisplay";

/* ───── Helpers ───── */

function pctColor(pct: number): string {
  if (pct >= 90) return "var(--status-pass-text)";
  if (pct >= 70) return "var(--status-blocked-text)";
  return "var(--status-fail-text)";
}

/* ───── Shared UI pieces ───── */

/*
 * Untested is a segment like any other, not the leftover track.
 *
 * Basecamp 10213200614 ("Untested mark color not match on bar"): this screen showed three different
 * colours for one status — the UNTESTED stat tile in --status-notrun-*, the legend dot in
 * --muted-soft, and the bar in whatever --surface-tertiary happened to be, because untested was
 * never passed in and simply went unpainted. --status-notrun-dot is the app's untested colour
 * everywhere else (components/reports/charts.tsx, StatusChip, StatusBadge), so it is the one used
 * here for both the segment and the dot.
 *
 * Consequence, accepted deliberately: the bar now always totals 100%, so its fill length no longer
 * doubles as the progress reading. The percentage beside it is the progress reading.
 */
function SegmentedBar({ passed, failed, blocked, skipped, untested, total }: { passed: number; failed: number; blocked: number; skipped: number; untested: number; total: number }) {
  if (total === 0) return <div className="h-2 rounded-full bg-[var(--surface-tertiary)] w-full" />;
  const segments = [
    { value: passed, color: "var(--status-pass-dot)" },
    { value: failed, color: "var(--status-fail-dot)" },
    { value: blocked, color: "var(--status-blocked-dot)" },
    { value: skipped, color: "var(--status-skipped-dot)" },
    { value: untested, color: "var(--status-notrun-dot)" },
  ];
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--surface-tertiary)]">
      {segments.map(({ value, color }, i) =>
        value > 0 ? <div key={i} className="h-full transition-all duration-500" style={{ width: `${(value / total) * 100}%`, background: color }} /> : null
      )}
    </div>
  );
}

function StatTile({ label, value, icon, textVar, fillVar }: { label: string; value: number; icon: React.ReactNode; textVar: string; fillVar: string }) {
  return (
    <div className="rounded-[8px] border border-[var(--border)] p-3" style={{ background: `var(${fillVar})` }}>
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide" style={{ color: `var(${textVar})` }}>
        {icon}
        {label}
      </div>
      <p className="font-mono text-[20px] font-semibold" style={{ color: `var(${textVar})` }}>{value}</p>
    </div>
  );
}

/* ───── Main Page ───── */

export default function PlanDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const planId = params.planId as string;

  const { startEl: topBarStartEl, endEl: topBarEndEl, setFilled: setTopBarFilled } = useTopBarSlots();
  useEffect(() => {
    setTopBarFilled(true);
    return () => setTopBarFilled(false);
  }, [setTopBarFilled]);

  const [plan, setPlan] = useState<Record<string, unknown> | null>(null);
  const [runs, setRuns] = useState<PlanRunItem[]>([]);
  /*
   * The header is DERIVED from the runs below it, not fetched separately.
   *
   * Basecamp 10213208002 — "Test plan: Overall progress percentage not matching", reported as the
   * header disagreeing with the run listed beneath it. The two numbers were two independent reads of
   * the same rows: getPlanProgress aggregates `cycles WHERE plan_id = $1` and listPlanRuns groups the
   * very same join per cycle, so the header was only ever the sum of the rows — but nothing enforced
   * that, and two round trips against a live database can land either side of a status change.
   *
   * Summing the rows the screen is already showing makes the agreement structural instead of
   * coincidental, and drops a request. Same arithmetic the run rows use for their own percentage
   * (passed + failed + blocked + skipped), so a run's figure and the plan's cannot diverge.
   */
  const [progress, setProgress] = useState<PlanProgress | null>(null);
  const [projectName, setProjectName] = useState("");
  const [allPlans, setAllPlans] = useState<PlanListItem[]>([]);
  const [ownerNames, setOwnerNames] = useState<Record<string, string>>({});
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
      const [p, r, pg, project, plansList, members] = await Promise.all([
        getPlan(planId),
        listPlanRuns(planId),
        getPlanProgress(planId),
        getProject(projectId),
        listPlans(projectId),
        listProjectMembers(projectId).catch(() => []),
      ]);
      setPlan(p);
      setRuns(r);
      setProgress(pg);
      setProjectName(String(project.name || ""));
      setAllPlans(plansList);
      setOwnerNames(Object.fromEntries(members.map((m) => [m.userId, m.name || m.email || "Unknown user"])));
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

  const derivedProgress = useMemo<PlanProgress | null>(() => {
    if (!runs.length) return progress;
    const sum = (pick: (r: (typeof runs)[number]) => number) => runs.reduce((acc, r) => acc + (pick(r) || 0), 0);
    const totalCases = sum((r) => r.totalCases);
    const passed = sum((r) => r.passed);
    const failed = sum((r) => r.failed);
    const blocked = sum((r) => r.blocked);
    const skipped = sum((r) => r.skipped);
    const untested = sum((r) => r.untested);
    return {
      ...(progress ?? ({} as PlanProgress)),
      runCount: runs.length,
      totalCases,
      passed,
      failed,
      blocked,
      skipped,
      untested,
      passRate: computePassRate({ passed, failed, blocked }),
      completionPercent: computeExecutionProgress({ passed, failed, blocked, skipped }, totalCases),
    };
  }, [runs, progress]);

  if (loading || !plan) {
    return <PageLoader variant="screen" label="Loading plan…" />;
  }

  const total = derivedProgress?.totalCases || 0;
  /*
   * Every run linked to the plan, whatever its status. The list used to drop anything that was not
   * "In Progress" or "Completed" while the Overall progress header above it kept aggregating all of
   * them, so the two disagreed by exactly the runs that were hidden. "Planning" is the status every
   * run is created with — including the ones this page's own Create test run button makes — so the
   * filter hid a run the moment it was created and then counted its cases in the header anyway.
   */
  const visibleRuns = runs;
  const planName = typeof plan.name === "string" ? plan.name : "";
  const planDescription = typeof plan.description === "string" ? plan.description : "";
  const planTargetRelease = typeof plan.targetRelease === "string" ? plan.targetRelease : "";
  const planOwnerId = typeof plan.ownerId === "string" ? plan.ownerId : null;
  const currentPlanSummary = allPlans.find((p) => p.id === planId) ?? null;
  const status = currentPlanSummary ? planStatus(currentPlanSummary) : "draft";
  const ownerName = planOwnerId ? ownerNames[planOwnerId] : undefined;

  return (
    // Full-bleed, full-height workspace: `tc-fullbleed` drops the wrapping .tesbo-page's
    // centered 1280px cap so this fills the content region below the 3.5rem TopBar,
    // matching the Test Cases workspace pattern.
    <main className="tc-fullbleed flex flex-col pb-4 pr-4 pt-4" style={{ height: "calc(100vh - 3.5rem)" }}>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* TopBar takeover: breadcrumb (start) + actions (end) */}
        {topBarStartEl &&
          createPortal(
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[12px]">
              {projectName && (
                <>
                  <button
                    type="button"
                    onClick={() => router.push("/projects")}
                    className="cursor-pointer truncate text-[var(--muted-soft)] transition-colors hover:text-[var(--accent-light)]"
                  >
                    {projectName}
                  </button>
                  <IconChevronRight size={12} stroke={1.75} className="shrink-0 text-[var(--muted-soft)]" />
                </>
              )}
              <button
                type="button"
                onClick={() => router.push(`/projects/${projectId}/plans`)}
                className="shrink-0 cursor-pointer text-[var(--muted-soft)] transition-colors hover:text-[var(--accent-light)]"
              >
                Test plans
              </button>
              <IconChevronRight size={12} stroke={1.75} className="shrink-0 text-[var(--muted-soft)]" />
              <span className="truncate font-medium text-[var(--accent-light)]">{planName}</span>
            </nav>,
            topBarStartEl,
          )}
        {topBarEndEl &&
          createPortal(
            <div className="flex flex-wrap items-center gap-2">
              {!editing && (
                <>
                  <button
                    type="button"
                    onClick={() => { setEditName(planName); setEditDesc(planDescription); setEditRelease(planTargetRelease); setEditing(true); }}
                    className="flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[6px] border border-[var(--ink-200)] bg-transparent px-3 text-[12px] font-medium text-[var(--ink-600)] transition-colors hover:bg-[var(--ink-100)]"
                  >
                    <IconPencil size={13} stroke={1.75} />
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[6px] border border-[var(--ink-200)] bg-transparent px-3 text-[12px] font-medium text-[var(--ink-600)] transition-colors hover:border-[var(--error)] hover:text-[var(--error-foreground)]"
                  >
                    <IconTrash size={13} stroke={1.75} />
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowCreateCycle(true)}
                    className="flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[6px] border-0 bg-[var(--cta-primary)] px-3.5 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-[var(--cta-hover)]"
                  >
                    <IconPlus size={14} stroke={2} />
                    Create test run
                  </button>
                </>
              )}
            </div>,
            topBarEndEl,
          )}

        {/* Page header: title + status + meta */}
        <div className="mb-3 shrink-0 pl-4">
          {editing ? (
            /*
              * Basecamp 10221977100 ("Edit test plan > field labels are missing"). Three bare inputs:
              * the name had nothing at all identifying it, and the other two leaned on placeholders,
              * which disappear the moment there is a value — so editing an existing plan showed three
              * unlabelled boxes of text. Field/FieldLabel is what every other form in the app uses.
              */
            <div className="max-w-lg space-y-3">
              <Field>
                <FieldLabel htmlFor="plan-edit-name">Plan name</FieldLabel>
                <Input
                  id="plan-edit-name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="text-[15px] font-semibold"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="plan-edit-description">Description</FieldLabel>
                <Input
                  id="plan-edit-description"
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  placeholder="What this plan covers"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="plan-edit-release">Target release</FieldLabel>
                <Input
                  id="plan-edit-release"
                  value={editRelease}
                  onChange={(e) => setEditRelease(e.target.value)}
                  placeholder="e.g. 2026.09"
                />
              </Field>
              <div className="flex gap-2">
                <Button onClick={handleSaveEdit}>Save</Button>
                <Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-[var(--foreground)]">{planName}</h1>
                <PlanStatusBadge status={status} />
                {planTargetRelease && (
                  <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--ai-soft)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--ai-primary)]">
                    {planTargetRelease}
                  </span>
                )}
              </div>
              {planDescription && <p className="mt-1 text-[13px] text-[var(--muted-soft)]">{planDescription}</p>}
              <div className="mt-2.5 flex flex-wrap items-center gap-4">
                <span className="flex items-center gap-1.5 text-[12px] text-[var(--muted)]">
                  <IconCalendarEvent size={13} stroke={1.75} className="text-[var(--muted-soft)]" />
                  Created {plan.createdAt ? new Date(plan.createdAt as string).toLocaleDateString() : "—"}
                </span>
                <span className="flex items-center gap-1.5 text-[12px] text-[var(--muted)]">
                  <IconClock size={13} stroke={1.75} className="text-[var(--muted-soft)]" />
                  {formatLastRun(currentPlanSummary?.lastRunAt ?? null)}
                </span>
                <span className="flex items-center gap-1.5 text-[12px] text-[var(--muted)]">
                  <IconFileDescription size={13} stroke={1.75} className="text-[var(--muted-soft)]" />
                  {/*
                    * Basecamp 10221932189 ("Test cases shows incorrect count"). This chip read
                    * `caseCount` — the plan_items rows, i.e. cases explicitly pinned to the plan's
                    * scope — while the Overall progress panel three lines below counted the cases in
                    * the plan's runs. A plan with two runs and twelve cases therefore announced "0
                    * test cases" directly above a TOTAL of 12.
                    *
                    * The chip now reports the same number as TOTAL, because that is what a reader
                    * means by "how many test cases are in this plan".
                    */}
                  <span className="font-mono text-[var(--foreground)]">
                    {/*
                      * `||`, not `??`. derivedProgress is never null — with no runs it returns the
                      * plan-progress payload, whose totalCases is 0 — so `??` never fell through and
                      * a plan with pinned items but no runs yet showed "0 test cases", which is the
                      * same defect as 10221932189 pointing the other way. Caught by PLN-U-05, which
                      * exists precisely to catch this chip being widened by accident.
                      */}
                    {derivedProgress?.totalCases || currentPlanSummary?.caseCount || 0}
                  </span> test cases
                </span>
                {ownerName && <OwnerAvatar name={ownerName} seed={planOwnerId} />}
              </div>
            </>
          )}
        </div>

        {/* Test runs */}
        <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            {/* Overall progress */}
              {derivedProgress && total > 0 && (
                <section className="mb-5 rounded-[10px] border border-[var(--border)] p-5">
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <span className="text-[13px] font-medium text-[var(--muted)]">Overall progress</span>
                      <div className="font-mono text-[24px] font-bold tracking-tight" style={{ color: pctColor(derivedProgress.completionPercent) }}>
                        {derivedProgress.completionPercent}%
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="text-[13px] font-medium text-[var(--muted)]">Pass rate</span>
                      <div
                        className="font-mono text-[24px] font-bold tracking-tight"
                        style={{ color: derivedProgress.passRate !== null ? pctColor(derivedProgress.passRate) : "var(--muted-soft)" }}
                      >
                        {derivedProgress.passRate !== null ? `${derivedProgress.passRate}%` : "—"}
                      </div>
                    </div>
                  </div>
                  <SegmentedBar passed={derivedProgress.passed} failed={derivedProgress.failed} blocked={derivedProgress.blocked} skipped={derivedProgress.skipped} untested={derivedProgress.untested} total={total} />
                  <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
                    <StatTile label="Total" value={total} textVar="--foreground" fillVar="--surface-tertiary" icon={<IconClipboardList size={12} stroke={1.75} />} />
                    <StatTile label="Passed" value={derivedProgress.passed} textVar="--status-pass-text" fillVar="--status-pass-fill" icon={<IconCircleCheck size={12} stroke={1.75} />} />
                    <StatTile label="Failed" value={derivedProgress.failed} textVar="--status-fail-text" fillVar="--status-fail-fill" icon={<IconCircleX size={12} stroke={1.75} />} />
                    <StatTile label="Blocked" value={derivedProgress.blocked} textVar="--status-blocked-text" fillVar="--status-blocked-fill" icon={<IconAlertTriangle size={12} stroke={1.75} />} />
                    <StatTile label="Skipped" value={derivedProgress.skipped} textVar="--status-skipped-text" fillVar="--status-skipped-fill" icon={<IconPlayerSkipForward size={12} stroke={1.75} />} />
                    <StatTile label="Untested" value={derivedProgress.untested} textVar="--status-notrun-text" fillVar="--status-notrun-fill" icon={<IconClock size={12} stroke={1.75} />} />
                  </div>
                </section>
              )}

              {progress && total === 0 && (
                <section className="mb-5 rounded-[10px] border border-dashed border-[var(--border)] p-8 text-center">
                  <IconClipboardList size={36} stroke={1.25} className="mx-auto text-[var(--muted-soft)]" />
                  <p className="mt-3 text-[13px] text-[var(--muted-soft)]">No test runs associated with this plan yet. Create a new run or link an existing one to start tracking progress.</p>
                </section>
              )}

              <section>
                <div className="mb-4 flex items-center gap-2">
                  <Button onClick={() => setShowCreateCycle(!showCreateCycle)}>
                    <IconPlus size={14} stroke={2} className="mr-1.5 inline" />
                    Create test run
                  </Button>
                  <Button variant="secondary" onClick={handleOpenAssociate}>
                    <IconLink size={14} stroke={1.75} className="mr-1.5 inline" />
                    Link existing run
                  </Button>
                </div>

                {showCreateCycle && (
                  <form onSubmit={handleCreateCycle} className="mb-4 space-y-3 rounded-[10px] border border-[var(--border)] p-4">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[var(--muted)]">Run Name</label>
                      <Input value={newCycleName} onChange={(e) => setNewCycleName(e.target.value)} placeholder={planName || "Test Run"} autoFocus />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[var(--muted)]">
                        Environment <span className="text-[var(--error-foreground)]">*</span>
                      </label>
                      <Select value={selectedEnvironment} onChange={(e) => setSelectedEnvironment(e.target.value)} required>
                        <option value="">Select environment</option>
                        {environmentOptions.map((env) => (
                          <option key={env.name} value={env.name}>{env.name}</option>
                        ))}
                      </Select>
                      {selectedEnvironment && (
                        <p className="mt-1 text-xs text-[var(--muted)]">
                          URL: {environmentOptions.find((item) => item.name === selectedEnvironment)?.url ?? "Not available"}
                        </p>
                      )}
                      {environmentOptions.length === 0 && (
                        <p className="mt-1 text-xs text-[var(--status-blocked-text)]">No environments configured in project settings.</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button type="submit" disabled={creatingCycle || !selectedEnvironment.trim() || environmentOptions.length === 0}>
                        {creatingCycle ? "Creating..." : "Create Test Run"}
                      </Button>
                      <Button variant="secondary" type="button" onClick={() => setShowCreateCycle(false)}>Cancel</Button>
                    </div>
                  </form>
                )}

                <Modal open={showAssociate} onClose={() => setShowAssociate(false)} title="Link Existing Test Run">
                  <div className="max-h-80 overflow-y-auto">
                    {loadingRuns ? (
                      <div className="flex items-center justify-center py-8">
                        <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--brand-primary)] border-t-transparent" />
                      </div>
                    ) : allRuns.length === 0 ? (
                      <p className="py-8 text-center text-sm text-[var(--muted)]">No unlinked test runs available.</p>
                    ) : (
                      <ul className="space-y-2">
                        {allRuns.map((run) => (
                          <li key={run.id} className="flex items-center justify-between rounded-lg border border-[var(--border)] p-3 transition-colors hover:bg-[var(--surface-secondary)]">
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium text-[var(--foreground)]">{run.name}</p>
                              <div className="mt-0.5 flex items-center gap-2">
                                <StatusChip tone={statusTone(run.status)}>{run.status}</StatusChip>
                                <span className="text-xs text-[var(--muted)]">{run.totalCases} cases</span>
                              </div>
                            </div>
                            <Button size="sm" onClick={() => handleAssociate(run.id)} disabled={associating === run.id} className="ml-3 shrink-0">
                              {associating === run.id ? "Linking..." : "Link"}
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </Modal>

                {visibleRuns.length === 0 ? (
                  <EmptyStateBlock
                    title="No test runs yet"
                    description="Create one or link an existing run to start tracking progress for this plan."
                    icon={<IconPlayerPlay size={48} stroke={1.25} className="text-[var(--ink-300)]" />}
                    action={
                      <Button onClick={() => setShowCreateCycle(true)}>
                        Create Test Run
                      </Button>
                    }
                  />
                ) : (
                  <div className="grid gap-3">
                    {visibleRuns.map((run) => {
                      const runTotal = run.totalCases;
                      const executed = run.passed + run.failed + run.blocked + run.skipped;
                      const ownerName = run.ownerId ? ownerNames[run.ownerId] : null;
                      return (
                        <Card key={run.id} className="p-0 transition-colors hover:border-[var(--border-strong)]">
                          <div className="flex items-center gap-3 p-4">
                            <RunAvatar name={run.name} />

                            <div className="min-w-0 flex-1">
                              <div className="mb-0.5 flex flex-wrap items-center gap-2">
                                <Link
                                  href={`/projects/${projectId}/cycles/${run.id}`}
                                  className="text-[14.5px] font-semibold text-[var(--foreground)] hover:text-[var(--accent-light)]"
                                >
                                  {run.name}
                                </Link>
                                <StatusChip tone={statusTone(run.status)}>{run.status}</StatusChip>
                              </div>
                              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[var(--muted-soft)]">
                                {run.environment && (
                                  <span className="flex items-center gap-1">
                                    <IconServer size={12} stroke={1.75} />
                                    {run.environment}
                                  </span>
                                )}
                                {run.buildVersion && <span>Build: {run.buildVersion}</span>}
                                <span className="flex items-center gap-1">
                                  <IconCalendarEvent size={12} stroke={1.75} />
                                  {formatDate(run.createdAt)}
                                </span>
                              </div>
                            </div>

                            {ownerName && <OwnerAvatar name={ownerName} seed={run.ownerId} />}

                            <div className="flex shrink-0 items-center gap-1">
                              <Link
                                href={`/projects/${projectId}/cycles/${run.id}`}
                                title="View run"
                                className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--muted-soft)] transition-colors hover:bg-[var(--ink-100)] hover:text-[var(--foreground)]"
                              >
                                <IconArrowRight size={15} stroke={1.75} />
                              </Link>
                              <button
                                onClick={() => handleDissociate(run.id)}
                                title="Unlink from plan"
                                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[6px] text-[var(--muted-soft)] transition-colors hover:bg-[var(--status-fail-fill)] hover:text-[var(--error-foreground)]"
                              >
                                <IconX size={15} stroke={1.75} />
                              </button>
                            </div>
                          </div>

                          {runTotal > 0 && (
                            <div className="border-t border-[var(--border-subtle)] px-4 py-3">
                              <RunProgressBar passed={run.passed} failed={run.failed} blocked={run.blocked} skipped={run.skipped} total={runTotal} />
                              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                                <div className="flex flex-wrap items-center gap-4">
                                  <span className="flex items-center gap-1 text-[11.5px] font-medium text-[var(--status-pass-text)]">
                                    <IconCircleCheck size={13} stroke={1.75} />
                                    {run.passed} passed
                                  </span>
                                  <span className="flex items-center gap-1 text-[11.5px] font-medium text-[var(--status-fail-text)]">
                                    <IconCircleX size={13} stroke={1.75} />
                                    {run.failed} failed
                                  </span>
                                  <span className="flex items-center gap-1 text-[11.5px] font-medium text-[var(--status-blocked-text)]">
                                    <IconCircleMinus size={13} stroke={1.75} />
                                    {run.blocked} blocked
                                  </span>
                                  <span className="flex items-center gap-1 text-[11.5px] font-medium text-[var(--status-skipped-text)]">
                                    <IconPlayerSkipForward size={13} stroke={1.75} />
                                    {run.skipped} skipped
                                  </span>
                                </div>
                                <span className="text-[11.5px] text-[var(--muted)]">
                                  {executed} / {runTotal} cases
                                </span>
                              </div>
                            </div>
                          )}
                        </Card>
                      );
                    })}
                  </div>
                )}
              </section>
          </div>
        </div>
      </div>
    </main>
  );
}
