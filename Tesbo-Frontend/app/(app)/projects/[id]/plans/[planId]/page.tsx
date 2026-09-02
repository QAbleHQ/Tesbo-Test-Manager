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
  IconLayoutGrid,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconList,
  IconClipboardList,
  IconCircleCheck,
  IconCircleX,
  IconAlertTriangle,
  IconPlayerSkipForward,
  IconServer,
  IconX,
} from "@tabler/icons-react";
import {
  authMe,
  getPlan,
  updatePlan,
  deletePlan,
  listPlanItems,
  listPlanRuns,
  getPlanProgress,
  listTestRuns,
  createCycleFromPlan,
  associateRunWithPlan,
  dissociateRunFromPlan,
  getProject,
  listPlans,
  listProjectMembers,
  removePlanItem,
  type PlanItem,
  type PlanListItem,
  type PlanRunItem,
  type PlanProgress,
  type TestRunListItem,
  type TestEnvironmentSetting,
} from "@/lib/api";
import { computePassRate, computeExecutionProgress } from "@/lib/executionMetrics";
import { Button, StatusChip, StatusBadge, PriorityBadge, Input, PageLoader, Select, Field, FieldLabel, type TestStatus, type Priority } from "@/components/ui";
import Modal from "@/components/ui/Modal";
import { useTopBarSlots } from "@/components/TopBarSlots";
import { planStatus, formatLastRun, OwnerAvatar, PlanStatusBadge } from "@/components/testplans/PlanCard";
import { readStoredValue, writeStoredValue } from "@/lib/storage";

const PANEL_STORAGE_KEY = "tesbo_plan_switcher_panel";

/* ───── Helpers ───── */

function toPriority(raw: string | null): Priority {
  if (raw === "P0") return "critical";
  if (raw === "P1") return "high";
  if (raw === "P3") return "low";
  return "medium";
}

function toTestStatus(raw: string | null): TestStatus {
  const map: Record<string, TestStatus> = {
    Passed: "pass",
    Failed: "fail",
    Blocked: "blocked",
    Skipped: "skipped",
  };
  return map[raw ?? ""] ?? "not_run";
}

function runStatusToTone(status: string) {
  const map: Record<string, "success" | "info" | "warning" | "neutral"> = {
    Completed: "success",
    "In Progress": "info",
    Planning: "neutral",
  };
  return map[status] ?? "neutral";
}

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

function StatusDot({ color }: { color: string }) {
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />;
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
  const [items, setItems] = useState<PlanItem[]>([]);
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

  const [planPanelOpen, setPlanPanelOpen] = useState(true);

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

  // Removing a plan item
  const [removingItemId, setRemovingItemId] = useState<string | null>(null);

  // Tab state
  const [activeTab, setActiveTab] = useState<"runs" | "items">("runs");

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
      const [p, i, r, pg, project, plansList, members] = await Promise.all([
        getPlan(planId),
        listPlanItems(planId),
        listPlanRuns(planId),
        getPlanProgress(planId),
        getProject(projectId),
        listPlans(projectId),
        listProjectMembers(projectId).catch(() => []),
      ]);
      setPlan(p);
      setItems(i);
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
    const saved = readStoredValue(PANEL_STORAGE_KEY);
    if (saved === "closed") setPlanPanelOpen(false);
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      loadData().finally(() => setLoading(false));
    });
  }, [loadData, router]);

  function togglePlanPanel() {
    setPlanPanelOpen((prev) => {
      const next = !prev;
      writeStoredValue(PANEL_STORAGE_KEY, next ? "open" : "closed");
      return next;
    });
  }

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

  async function handleRemoveItem(itemId: string) {
    if (removingItemId) return;
    setRemovingItemId(itemId);
    try {
      await removePlanItem(planId, itemId);
      await loadData();
    } finally {
      setRemovingItemId(null);
    }
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
                    onClick={() => { setActiveTab("runs"); setShowCreateCycle(true); }}
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
                    * means by "how many test cases are in this plan". The pinned scope still has its
                    * own count on the Plan items tab, where the word "items" says what it is.
                    */}
                  <span className="font-mono text-[var(--foreground)]">
                    {/*
                      * `||`, not `??`. derivedProgress is never null — with no runs it returns the
                      * plan-progress payload, whose totalCases is 0 — so `??` never fell through and
                      * a plan with pinned items but no runs yet showed "0 test cases", which is the
                      * same defect as 10221932189 pointing the other way. Caught by PLN-U-05, which
                      * exists precisely to catch this chip being widened by accident.
                      */}
                    {derivedProgress?.totalCases || currentPlanSummary?.caseCount || items.length}
                  </span> test cases
                </span>
                {ownerName && <OwnerAvatar name={ownerName} seed={planOwnerId} />}
              </div>
            </>
          )}
        </div>

        {/* Body: plan switcher panel + detail content */}
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-r-xl border border-l-0 border-[var(--border)] bg-[var(--surface)]">
          {/* ── Plans switcher panel ── */}
          <aside className={`flex shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] transition-[width] duration-150 ${planPanelOpen ? "w-[220px]" : "w-[38px]"}`}>
            <div className={`flex h-10 shrink-0 items-center border-b border-[var(--border)] px-3 ${planPanelOpen ? "justify-between" : "justify-center"}`}>
              {planPanelOpen && (
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--ink-600)]">
                  <IconLayoutGrid size={14} stroke={1.75} className="text-[var(--accent-light)]" />
                  Plans
                  <span className="rounded-full bg-[var(--brand-soft)] px-1.5 py-px font-mono text-[10px] font-normal normal-case text-[var(--accent-light)]">
                    {allPlans.length}
                  </span>
                </p>
              )}
              <div className="flex items-center gap-0.5">
                {planPanelOpen && (
                  <button
                    type="button"
                    title="New test plan"
                    onClick={() => router.push(`/projects/${projectId}/plans?create=1`)}
                    className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-[var(--muted)] transition-colors hover:bg-[var(--brand-soft)] hover:text-[var(--accent-light)]"
                  >
                    <IconPlus size={14} stroke={2.5} />
                  </button>
                )}
                <button
                  type="button"
                  title={planPanelOpen ? "Collapse plans" : "Show plans"}
                  onClick={togglePlanPanel}
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-[var(--muted)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
                >
                  {planPanelOpen ? <IconLayoutSidebarLeftCollapse size={14} stroke={1.75} /> : <IconLayoutSidebarLeftExpand size={14} stroke={1.75} />}
                </button>
              </div>
            </div>

            {planPanelOpen && (
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                <button
                  type="button"
                  onClick={() => router.push(`/projects/${projectId}/plans`)}
                  className="mb-1 flex h-8 w-full cursor-pointer items-center justify-between rounded-[6px] px-2 text-left text-[13px] text-[var(--ink-600)] transition-colors hover:bg-[var(--surface-secondary)]"
                >
                  <span className="flex items-center gap-1.5"><IconList size={14} stroke={1.75} className="text-[var(--muted)]" />All plans</span>
                  <span className="font-mono text-[11px] text-[var(--muted)]">{allPlans.length}</span>
                </button>

                <div className="mx-1 my-1.5 h-px bg-[var(--border)]" />

                {allPlans.map((p) => {
                  const isActive = p.id === planId;
                  const itemStatus = planStatus(p);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => router.push(`/projects/${projectId}/plans/${p.id}`)}
                      className={`mb-0.5 flex h-8 w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 text-left transition-colors ${isActive ? "bg-[var(--brand-soft)]" : "hover:bg-[var(--surface-secondary)]"}`}
                    >
                      <StatusDot color={itemStatus === "active" ? "var(--status-pass-dot)" : "var(--muted-soft)"} />
                      <span className={`min-w-0 flex-1 truncate text-[12.5px] ${isActive ? "font-medium text-[var(--accent-light)]" : "text-[var(--ink-600)]"}`}>
                        {p.name}
                      </span>
                      <span className={`shrink-0 font-mono text-[11px] ${isActive ? "text-[var(--accent-light)] opacity-70" : "text-[var(--muted)]"}`}>
                        {p.runCount}
                      </span>
                    </button>
                  );
                })}

                <button
                  type="button"
                  onClick={() => router.push(`/projects/${projectId}/plans?create=1`)}
                  className="mt-2 flex h-8 w-full cursor-pointer items-center gap-1.5 rounded-[6px] border border-dashed border-[var(--border)] px-2 text-[12px] text-[var(--muted)] transition-colors hover:border-[var(--brand-primary)] hover:text-[var(--accent-light)]"
                >
                  <IconPlus size={13} stroke={1.75} />
                  New test plan
                </button>
              </div>
            )}
          </aside>

          {/* ── Detail content ── */}
          <div className="flex min-w-0 flex-1 flex-col bg-[var(--surface)]">
            {/* Tabs */}
            <div className="flex shrink-0 items-center gap-0 border-b border-[var(--border)] px-4">
              <button
                onClick={() => setActiveTab("runs")}
                className={`flex h-10 cursor-pointer items-center gap-1.5 border-b-2 px-3 text-[13px] font-medium transition-colors ${
                  activeTab === "runs" ? "border-[var(--brand-primary)] text-[var(--accent-light)]" : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
                }`}
              >
                Test runs
                <span className="rounded-full bg-[var(--surface-tertiary)] px-1.5 py-px font-mono text-[11px] text-[var(--muted)]">{visibleRuns.length}</span>
              </button>
              <button
                onClick={() => setActiveTab("items")}
                className={`flex h-10 cursor-pointer items-center gap-1.5 border-b-2 px-3 text-[13px] font-medium transition-colors ${
                  activeTab === "items" ? "border-[var(--brand-primary)] text-[var(--accent-light)]" : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
                }`}
              >
                Plan items
                <span className="rounded-full bg-[var(--surface-tertiary)] px-1.5 py-px font-mono text-[11px] text-[var(--muted)]">{items.length}</span>
              </button>
            </div>

            {/* Scrollable content */}
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

              {/* Runs tab */}
              {activeTab === "runs" && (
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
                                  <StatusChip tone={runStatusToTone(run.status)}>{run.status}</StatusChip>
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
                    <div className="rounded-[10px] border border-dashed border-[var(--border)] p-8 text-center">
                      <p className="text-sm text-[var(--muted)]">No runs associated with this plan. Create a new run or link an existing one.</p>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {visibleRuns.map((run) => {
                        const runTotal = run.totalCases;
                        // Executed is spelled out the same way the header's completionPercent is
                        // (passed + failed + blocked + skipped), rather than total - untested, so a
                        // run's percentage and the plan's are the same arithmetic on the same rows.
                        const runProgress = computeExecutionProgress(run, runTotal);
                        const runPassRate = computePassRate(run);
                        return (
                          <div key={run.id} className="rounded-[10px] border border-[var(--border)] bg-[var(--background)] p-4 transition-colors hover:border-[var(--brand-primary)]">
                            <div className="flex items-start justify-between gap-3">
                              <Link href={`/projects/${projectId}/cycles/${run.id}`} className="group min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <h4 className="truncate text-[14px] font-semibold text-[var(--foreground)] transition-colors group-hover:text-[var(--accent-light)]">{run.name}</h4>
                                  <StatusChip tone={runStatusToTone(run.status)}>{run.status}</StatusChip>
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-3 text-[12px] text-[var(--muted)]">
                                  {run.environment && (
                                    <span className="flex items-center gap-1"><IconServer size={12} stroke={1.75} />Env: {run.environment}</span>
                                  )}
                                  {run.buildVersion && <span>Build: {run.buildVersion}</span>}
                                  <span className="flex items-center gap-1"><IconCalendarEvent size={12} stroke={1.75} />{new Date(run.createdAt).toLocaleDateString()}</span>
                                </div>
                              </Link>
                              <div className="ml-2 flex shrink-0 items-center gap-2">
                                <div className="text-right">
                                  <div className="font-mono text-[16px] font-bold" style={{ color: runTotal > 0 ? pctColor(runProgress) : "var(--muted-soft)" }}>
                                    {runProgress}%
                                  </div>
                                  <div className="text-[10px] text-[var(--muted-soft)]">executed</div>
                                </div>
                                <button
                                  onClick={() => handleDissociate(run.id)}
                                  title="Unlink from plan"
                                  className="cursor-pointer rounded-lg p-1.5 text-[var(--muted-soft)] transition-colors hover:bg-[var(--status-fail-fill)] hover:text-[var(--error-foreground)]"
                                >
                                  <IconX size={15} stroke={1.75} />
                                </button>
                              </div>
                            </div>

                            {runTotal > 0 && (
                              <div className="mt-3">
                                <SegmentedBar passed={run.passed} failed={run.failed} blocked={run.blocked} skipped={run.skipped} untested={run.untested} total={runTotal} />
                                <div className="mt-1.5 flex flex-wrap items-center gap-3">
                                  <span className="font-mono text-[11px] text-[var(--muted)]">{runTotal} cases</span>
                                  {run.passed > 0 && <span className="flex items-center gap-1 text-[11px] text-[var(--muted)]"><StatusDot color="var(--status-pass-dot)" />{run.passed} passed</span>}
                                  {run.failed > 0 && <span className="flex items-center gap-1 text-[11px] text-[var(--muted)]"><StatusDot color="var(--status-fail-dot)" />{run.failed} failed</span>}
                                  {run.blocked > 0 && <span className="flex items-center gap-1 text-[11px] text-[var(--muted)]"><StatusDot color="var(--status-blocked-dot)" />{run.blocked} blocked</span>}
                                  {run.skipped > 0 && <span className="flex items-center gap-1 text-[11px] text-[var(--muted)]"><StatusDot color="var(--status-skipped-dot)" />{run.skipped} skipped</span>}
                                  {run.untested > 0 && <span className="flex items-center gap-1 text-[11px] text-[var(--muted)]"><StatusDot color="var(--status-notrun-dot)" />{run.untested} untested</span>}
                                  {runPassRate !== null && (
                                    <span className="ml-auto text-[11px] font-medium text-[var(--muted)]">{runPassRate}% pass rate</span>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              )}

              {/* Items tab */}
              {activeTab === "items" && (
                <section>
                  {items.length === 0 ? (
                    <div className="rounded-[10px] border border-dashed border-[var(--border)] p-8 text-center">
                      {/*
                        * Basecamp 10221983132 ("Plan items shows 0 count and message 'no planed
                        * items'"). The count was accurate — nothing was pinned — but it sat next to
                        * a plan that was visibly running twelve cases, so it read as a bug. Naming
                        * the other number is what removes the contradiction.
                        */}
                      <p className="text-sm text-[var(--muted)]">
                        {total > 0
                          ? `Nothing is pinned to this plan's scope yet. Its ${total} test case${total === 1 ? "" : "s"} come from the linked test runs — pin suites or cases here to say what the plan is meant to cover.`
                          : "No items in this plan. Items are suites or test cases that define the scope of the plan."}
                      </p>
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-[10px] border border-[var(--border)]">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-[var(--border)] bg-[var(--surface-secondary)]">
                            <th className="px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">ID</th>
                            <th className="px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">Title</th>
                            <th className="px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">Priority</th>
                            <th className="px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">Last Result</th>
                            <th className="w-10 px-4 py-2.5" />
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((item) => {
                            const isSuite = !!item.suiteId;
                            return (
                              <tr key={item.id} className="border-b border-[var(--border-subtle)] transition-colors last:border-0 hover:bg-[var(--surface-secondary)]">
                                <td className="px-4 py-2.5">
                                  {isSuite ? (
                                    <StatusChip tone="info">Suite</StatusChip>
                                  ) : (
                                    <span className="font-mono text-[12px] font-medium text-[var(--accent-light)]">{item.tcExternalId ?? "—"}</span>
                                  )}
                                </td>
                                <td className="px-4 py-2.5 text-[var(--foreground)]">{isSuite ? (item.suiteName ?? "Unknown suite") : (item.tcTitle ?? "Untitled test case")}</td>
                                <td className="px-4 py-2.5">{isSuite ? <span className="text-[var(--muted-soft)]">—</span> : <PriorityBadge priority={toPriority(item.tcPriority)} />}</td>
                                <td className="px-4 py-2.5">{isSuite ? <span className="text-[var(--muted-soft)]">—</span> : <StatusBadge status={toTestStatus(item.lastStatus)} />}</td>
                                <td className="px-4 py-2.5 text-center">
                                  <button
                                    onClick={() => handleRemoveItem(item.id)}
                                    disabled={removingItemId === item.id}
                                    title="Remove from plan"
                                    className="cursor-pointer rounded p-1 text-[var(--muted-soft)] transition-colors hover:text-[var(--error-foreground)] disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    <IconX size={14} stroke={1.75} />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
