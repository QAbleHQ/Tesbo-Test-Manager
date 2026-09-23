"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import {
  IconAlertCircle,
  IconArrowRight,
  IconArrowsSort,
  IconSortAscending,
  IconSortDescending,
  IconBug,
  IconCalendarEvent,
  IconChevronLeft,
  IconChevronRight,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleMinus,
  IconCircleX,
  IconClipboardCheck,
  IconClipboardList,
  IconClock,
  IconDeviceDesktop,
  IconDownload,
  IconFilterOff,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconShare,
  IconTag,
  IconTrash,
  IconUserPlus,
  IconX,
} from "@tabler/icons-react";
import {
  getTestRun,
  updateTestRun,
  listCycleExecutions,
  updateExecution,
  bulkAssignExecutions,
  addTestCasesToRun,
  removeTestCaseFromRun,
  removeTestCasesFromRun,
  listTestCases,
  listSuites,
  listPlans,
  toggleTestRunShare,
  listBugs,
  removeBugLink,
  type TestRunDetail,
  type ExecutionItem,
  type TestCaseListItem,
  type SuiteNode,
  type BugItem,
} from "@/lib/api";
import { computePassRate, computeExecutionProgress } from "@/lib/executionMetrics";
import { Button, StatusChip, Input, PageLoader, Select, Textarea, Drawer, PriorityBadge, ConfirmModal, type Priority } from "@/components/ui";
import Modal from "@/components/ui/Modal";
import ExecutionEvidencePanel from "@/components/ExecutionEvidencePanel";
import { AutomationResultMeta, AutomationRunProvenance } from "@/components/AutomationResultMeta";
import { useLogBugDialog } from "@/components/LogBugDialog";
import { useTopBarSlots } from "@/components/TopBarSlots";
import { Breadcrumbs } from "@/components/workflows";
import { useAppData } from "@/components/app/AppDataProvider";
import { useProjectData } from "@/components/project/ProjectDataProvider";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7000";

/* ───── Constants ───── */
const EXEC_STATUSES = ["Untested", "Passed", "Failed", "Skipped", "Blocked", "Retest"] as const;
const RUN_TABS = ["All", "Passed", "Failed", "Blocked", "Skipped", "Pending"] as const;
const CANONICAL_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
type RunTab = (typeof RUN_TABS)[number];
const PAGE_SIZE = 10;

/*
 * ID column sort: compares by the numeric portion of the external id (e.g. "PRO-TC-9" before
 * "PRO-TC-10"), not plain string order, which would put "PRO-TC-10" before "PRO-TC-9". Falls back
 * to a locale string compare when either id has no digits, so the sort stays total and stable
 * instead of leaving equal-ranked rows in an arbitrary order.
 */
function compareExternalId(a: string, b: string): number {
  const numOf = (id: string) => {
    const match = id.match(/(\d+)(?!.*\d)/);
    return match ? parseInt(match[1], 10) : NaN;
  };
  const na = numOf(a);
  const nb = numOf(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}

/*
 * Priority column sort: follows the app-wide P0 (Critical) -> P3 (Low) convention already used by
 * the priority filter dropdown just below (CANONICAL_PRIORITIES) rather than the ticket's fallback
 * P1->P4, since that convention already exists here. A legacy/imported priority string outside the
 * canonical set sorts after it (alphabetically among themselves); a missing priority sorts last of
 * all so it doesn't jump to the top under a descending sort.
 */
const PRIORITY_RANK: Record<string, number> = Object.fromEntries(CANONICAL_PRIORITIES.map((p, i) => [p, i]));
function comparePriority(a: string, b: string): number {
  const rankOf = (p: string) => (p ? (p in PRIORITY_RANK ? PRIORITY_RANK[p] : CANONICAL_PRIORITIES.length) : CANONICAL_PRIORITIES.length + 1);
  const ra = rankOf(a);
  const rb = rankOf(b);
  if (ra !== rb) return ra - rb;
  return a.localeCompare(b);
}

/* Test Case column sort: plain alphabetical by title, case-insensitive. */
function compareTestCaseTitle(a: string, b: string): number {
  return a.toLowerCase().localeCompare(b.toLowerCase());
}
import { avatarColor } from "@/lib/avatarColors";

/* ───── Status tone helpers ───── */
function statusToTone(status: string) {
  const map: Record<string, "success" | "error" | "blocked" | "skipped" | "retest" | "notRun"> = {
    Passed: "success",
    Failed: "error",
    Skipped: "skipped",
    Blocked: "blocked",
    Retest: "retest",
    Untested: "notRun",
  };
  return map[status] ?? "neutral";
}

function runStatusToTone(status: string) {
  const map: Record<string, "success" | "info" | "warning" | "neutral"> = {
    Completed: "success",
    "In Progress": "info",
    Planning: "warning",
  };
  return map[status] ?? "neutral";
}

/* ───── Step parsing (for the test case detail panel) ───── */
function normalizeSteps(value: unknown): Array<{ action: string; expected: string }> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return value.trim() ? [{ action: value, expected: "" }] : [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item, index) => {
    if (typeof item === "string") return { action: item, expected: "" };
    const row = item as Record<string, unknown>;
    return {
      action: String(row.action || row.step || row.description || `Step ${index + 1}`),
      expected: String(row.expected || row.expectedResult || row.result || ""),
    };
  });
}

const PANEL_STATUS_COLORS: Record<string, { active: string; idle: string }> = {
  Passed: { active: "bg-[var(--success)] text-white border-[var(--success)]", idle: "border-[var(--success)]/30 text-[var(--success-foreground)] hover:bg-[var(--success-soft)]" },
  Failed: { active: "bg-[var(--error)] text-white border-[var(--error)]", idle: "border-[var(--error)]/30 text-[var(--error-foreground)] hover:bg-[var(--error-soft)]" },
  Skipped: { active: "bg-[var(--status-skipped-dot)] text-white border-[var(--status-skipped-dot)]", idle: "border-[var(--status-skipped-dot)]/30 text-[var(--status-skipped-text)] hover:bg-[var(--status-skipped-fill)]" },
  Blocked: { active: "bg-[var(--status-blocked-dot)] text-white border-[var(--status-blocked-dot)]", idle: "border-[var(--status-blocked-dot)]/30 text-[var(--status-blocked-text)] hover:bg-[var(--status-blocked-fill)]" },
  Retest: { active: "bg-[var(--info)] text-white border-[var(--info)]", idle: "border-[var(--info)]/30 text-[var(--info-foreground)] hover:bg-[var(--info-soft)]" },
  Untested: { active: "bg-[var(--muted)] text-white border-[var(--muted)]", idle: "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-secondary)]" },
};

/* ───── Avatar helpers ───── */
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

function RunAvatar({ name, size = 40 }: { name: string; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-lg text-[13px] font-bold tracking-wide text-white"
      style={{ background: avatarColor(name), width: size, height: size }}
    >
      {getInitials(name)}
    </div>
  );
}

// Seeded on the member's id, not their name — matches every other person avatar (top bar, team
// avatars, activity, admins) so the same person keeps the same colour everywhere. Part of
// Basecamp 10198836413.
function MemberAvatar({ name, seed, size = 22 }: { name: string; seed?: string | null; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full border-2 border-[var(--surface)] font-semibold text-white"
      style={{ background: avatarColor(seed || name), width: size, height: size, fontSize: size * 0.42 }}
      title={name}
    >
      {getInitials(name)}
    </span>
  );
}

/* A column header for the run table's ID/Priority/Test Case sort. Un-highlighted arrows when this
   column isn't the active sort; a direction-specific icon (and brand color) when it is. */
function SortableColumnHeader({
  label,
  column,
  runSort,
  onToggle,
}: {
  label: string;
  column: "id" | "priority" | "testCase";
  runSort: { column: "id" | "priority" | "testCase"; direction: "asc" | "desc" } | null;
  onToggle: (column: "id" | "priority" | "testCase") => void;
}) {
  const active = runSort?.column === column ? runSort.direction : null;
  return (
    <button
      type="button"
      onClick={() => onToggle(column)}
      className={`inline-flex items-center gap-1 ${active ? "text-[var(--accent-light)]" : "hover:text-[var(--foreground)]"}`}
      title={`Sort by ${label}`}
      aria-label={`Sort by ${label}${active ? `, currently ${active === "asc" ? "ascending" : "descending"}` : ""}`}
    >
      {label}
      {active === "asc" ? (
        <IconSortAscending size={13} stroke={1.75} />
      ) : active === "desc" ? (
        <IconSortDescending size={13} stroke={1.75} />
      ) : (
        <IconArrowsSort size={13} stroke={1.75} className="text-[var(--muted-soft)]" />
      )}
    </button>
  );
}

/* ───── Format helpers ───── */
function formatDuration(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "—";
  const totalMinutes = Math.round((end - start) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatDate(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "—";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/* The neutral ("Untested") palette — also the fallback in execSelectStyle for any status the
 * map below doesn't name. Pulled out so the dropdown's option list (EXEC_OPTION_STYLE) can pin
 * every option to this one theme instead of inheriting whichever status color the closed
 * <select> currently has: a native <option> with no style of its own inherits its parent
 * <select>'s color/background, so without this the whole popup re-themed to match the row's
 * current status (e.g. all-red when Failed was selected) instead of staying consistent. */
const EXEC_STATUS_NEUTRAL = { border: "var(--border)", bg: "var(--surface-secondary)", color: "var(--muted)" };

function execSelectStyle(status: string): React.CSSProperties {
  const map: Record<string, { border: string; bg: string; color: string }> = {
    Passed: { border: "var(--success-border)", bg: "var(--success-soft)", color: "var(--success-foreground)" },
    Failed: { border: "var(--error-border)", bg: "var(--error-soft)", color: "var(--error-foreground)" },
    Skipped: { border: "var(--status-skipped-dot)", bg: "var(--status-skipped-fill)", color: "var(--status-skipped-text)" },
    Blocked: { border: "var(--status-blocked-dot)", bg: "var(--status-blocked-fill)", color: "var(--status-blocked-text)" },
    Retest: { border: "var(--status-retest-dot)", bg: "var(--status-retest-fill)", color: "var(--status-retest-text)" },
  };
  const s = map[status] || EXEC_STATUS_NEUTRAL;
  return { borderColor: s.border, background: s.bg, color: s.color };
}

/* Fixed style for every <option> in the execution status dropdown, so the open popup always
 * reads the same regardless of which status is currently selected. */
const EXEC_OPTION_STYLE: React.CSSProperties = {
  backgroundColor: EXEC_STATUS_NEUTRAL.bg,
  color: EXEC_STATUS_NEUTRAL.color,
};

function tabBadgeStyle(tab: RunTab): { bg: string; color: string } {
  const map: Partial<Record<RunTab, { bg: string; color: string }>> = {
    Passed: { bg: "var(--success-soft)", color: "var(--success-foreground)" },
    Failed: { bg: "var(--error-soft)", color: "var(--error-foreground)" },
    Blocked: { bg: "var(--warning-soft)", color: "var(--warning-foreground)" },
    Skipped: { bg: "var(--surface-tertiary)", color: "var(--muted)" },
    Pending: { bg: "var(--info-soft)", color: "var(--info-foreground)" },
  };
  return map[tab] || { bg: "var(--surface-tertiary)", color: "var(--muted)" };
}

/* ───── Segmented progress bar ───── */
/*
 * Basecamp 10221778177 ("Progress not showing correct colours or progress").
 *
 * Blocked, skipped and pending used to be summed into one `other` segment painted --warning, which
 * is the BLOCKED colour. On a run of 109 cases with 100 still pending, the bar was ~92% amber and
 * read as "everything is blocked" — and because the segments filled the whole track regardless, the
 * fill length said nothing about progress either.
 *
 * Each status is now its own segment in the colour the rest of the app uses for it, including
 * --status-notrun-dot for untested. This is the same fix 7f9b59a applied to the plan detail screen
 * for Basecamp 10213200614; the run screen had the identical defect and was missed.
 *
 * Consequence, accepted deliberately and shared with that screen: the bar always totals 100%, so
 * the percentage beside it — not the fill length — is the progress reading.
 *
 * dev's 48363ea fixed the same defect independently; the token set kept here is the one the StatPill
 * row and the per-execution badges already use, so a Blocked segment reads as the same colour as
 * "Blocked" everywhere else on the screen.
 */
function RunProgressBar({
  passed,
  failed,
  blocked,
  skipped,
  pending,
  total,
}: {
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  pending: number;
  total: number;
}) {
  const pct = (n: number) => (total ? `${(n / total) * 100}%` : "0%");
  const segments: [number, string][] = [
    [passed, "var(--status-pass-dot)"],
    [failed, "var(--status-fail-dot)"],
    [blocked, "var(--status-blocked-dot)"],
    [skipped, "var(--status-skipped-dot)"],
    [pending, "var(--status-notrun-dot)"],
  ];
  return (
    <div className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-[var(--surface-secondary)]">
      {segments.map(([value, color], index) =>
        value > 0 ? <div key={index} style={{ width: pct(value), background: color }} /> : null
      )}
    </div>
  );
}

/* ───── Stat pill ───── */
function StatPill({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone?: "success" | "error" | "blocked" | "skipped";
}) {
  const toneClasses =
    tone === "success"
      ? "border-[var(--success-border)] bg-[var(--success-soft)]"
      : tone === "error"
      ? "border-[var(--error-border)] bg-[var(--error-soft)]"
      : tone === "blocked"
      ? "border-[var(--status-blocked-dot)]/30 bg-[var(--status-blocked-fill)]"
      : tone === "skipped"
      ? "border-[var(--status-skipped-dot)]/30 bg-[var(--status-skipped-fill)]"
      : "border-[var(--border)] bg-[var(--surface-secondary)]";
  const textColor =
    tone === "success"
      ? "var(--success-foreground)"
      : tone === "error"
      ? "var(--error-foreground)"
      : tone === "blocked"
      ? "var(--status-blocked-text)"
      : tone === "skipped"
      ? "var(--status-skipped-text)"
      : "var(--muted)";
  return (
    <div className={`flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium ${toneClasses}`} style={{ color: textColor }}>
      {icon}
      <span style={{ color: tone ? textColor : "var(--muted-soft)" }}>{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

/* ═══════════════════ MAIN PAGE ═══════════════════ */
export default function TestRunDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const { currentUser } = useAppData();
  const { project, projectMembers: members } = useProjectData();
  const projectName = String(project.name || "");
  const cycleId = params.cycleId as string;

  const { startEl: topBarStartEl, endEl: topBarEndEl, setFilled: setTopBarFilled } = useTopBarSlots();
  useEffect(() => {
    setTopBarFilled(true);
    return () => setTopBarFilled(false);
  }, [setTopBarFilled]);

  const [run, setRun] = useState<TestRunDetail | null>(null);
  const [executions, setExecutions] = useState<ExecutionItem[]>([]);
  // Keyed by testcaseId because that is what the remove endpoints take.
  const [selectedRunCaseIds, setSelectedRunCaseIds] = useState<Set<string>>(new Set());
  const [bulkRemoveOpen, setBulkRemoveOpen] = useState(false);
  const [bulkRemoving, setBulkRemoving] = useState(false);
  const [bulkRemoveError, setBulkRemoveError] = useState<string | null>(null);
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false);
  const [bulkAssignAssigneeId, setBulkAssignAssigneeId] = useState("");
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [bulkAssignError, setBulkAssignError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const memberNames = useMemo(
    () => Object.fromEntries(members.map((m) => [m.userId, m.name || m.email || "Unknown user"])),
    [members]
  );
  const [planNames, setPlanNames] = useState<Record<string, string>>({});

  /* test cases table: tab filter, search, pagination */
  const [activeTab, setActiveTab] = useState<RunTab>("All");
  const [tableSearch, setTableSearch] = useState("");
  const [page, setPage] = useState(1);
  /* Priority/Type/Assignee filters for the run's own results table. Named distinctly from the
     "Add Test Cases" picker's filterPriority/filterType (below) so the two filter sets never
     collide — they filter different arrays (executions here vs. allCases in the picker). */
  const [runFilterPriority, setRunFilterPriority] = useState("");
  const [runFilterType, setRunFilterType] = useState("");
  const [runFilterAssignee, setRunFilterAssignee] = useState("");
  /* ID/Priority/Test Case column sort — null means "no sort", i.e. the existing (creation) order.
     Only one column can be active at a time: picking another column replaces this rather than
     combining. */
  const [runSort, setRunSort] = useState<{ column: "id" | "priority" | "testCase"; direction: "asc" | "desc" } | null>(null);

  /* test case picker state */
  const [showPicker, setShowPicker] = useState(false);
  const [allCases, setAllCases] = useState<TestCaseListItem[]>([]);
  const [suites, setSuites] = useState<SuiteNode[]>([]);
  const [casesLoading, setCasesLoading] = useState(false);
  const [selectedCases, setSelectedCases] = useState<Set<string>>(new Set());
  const [filterSearch, setFilterSearch] = useState("");
  const [filterPriority, setFilterPriority] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterSuiteId, setFilterSuiteId] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  /* synchronous double-submit guard: `adding` state only takes effect after a render, so two
     click events dispatched in the same tick (fast double-click, or a stuck key) would both
     read adding === false and both fire the request. */
  const addInFlightRef = useRef(false);

  /* inline status editing */
  const [statusSaving, setStatusSaving] = useState<string | null>(null);
  /* Set only when a status PATCH fails after the optimistic update below already showed the new
     value — tells that one row's dropdown to roll back and explains why. */
  const [statusError, setStatusError] = useState<{ id: string; message: string } | null>(null);

  /* right-side test case detail panel */
  const [panelExecution, setPanelExecution] = useState<ExecutionItem | null>(null);
  const [panelStatus, setPanelStatus] = useState("Untested");
  const [panelActualResult, setPanelActualResult] = useState("");
  const [panelAssigneeId, setPanelAssigneeId] = useState("");
  const [panelSaving, setPanelSaving] = useState(false);
  /* Bug Key / Bug Title shown for a Failed execution — read from the real bug(s) filed via "Log
     bug" (bugs/bug_links), not the old free-text defectKey/defectUrl columns on the execution row.
     An execution can have more than one bug linked to it, so this is every bug linked to THIS
     execution specifically, not just the first bug linked to its testcase+cycle. */
  const [panelBugs, setPanelBugs] = useState<BugItem[]>([]);
  /* Confirm-then-unlink for a single already-persisted bug — separate from the "Report a Bug"
     dialog's own chip removal, which only discards an unsaved working pick and never calls this. */
  const [bugToUnlink, setBugToUnlink] = useState<BugItem | null>(null);
  const [unlinkingBug, setUnlinkingBug] = useState(false);

  /* sharing state */
  const [showShare, setShowShare] = useState(false);
  const [shareEnabled, setShareEnabled] = useState(false);
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [shareToggling, setShareToggling] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    Promise.all([getTestRun(cycleId), listCycleExecutions(cycleId)])
      .then(([r, e]) => {
        setRun(r);
        setExecutions(e);
        setShareEnabled(r.shareEnabled ?? false);
        setShareToken(r.shareToken ?? null);
      })
      .catch(() => router.replace(`/projects/${projectId}/cycles`))
      .finally(() => setLoading(false));
  }, [cycleId, projectId, router]);

  const { dialog: bugDialog, openBugDialogFor } = useLogBugDialog({
    projectId,
    cycleId,
    members,
    // Reopen the panel for the execution the dialog actually just logged/linked a bug against,
    // rather than trusting panelExecution — handlePanelSave's auto-prompt (mark Failed -> Save ->
    // Report a Bug) closes the panel before opening this dialog, so panelExecution is null exactly
    // when a bug is filed through that path, and the freshly linked Bug Key/Title would otherwise
    // never surface until the user manually reopened the row.
    //
    // Force status to "Failed" rather than trusting exec.status: the backend's
    // failLinkedExecutions unconditionally flips the linked execution to Failed on every successful
    // "Log bug"/"Link Bug" (see legacy.service.ts), but exec is a snapshot taken when the dialog was
    // opened. Clicking the "Log bug" footer button (or the row's bug icon) straight from an
    // Untested/Passed/etc. panel — without first clicking the local "Failed" status button and
    // Save — carries that stale status into the snapshot, so trusting it here would reopen the
    // panel on "Untested" and immediately hide the very Bug Key/Title it just fetched.
    onLogged: (exec) => {
      load();
      openExecutionPanel({ ...exec, status: "Failed" });
    },
  });


  useEffect(() => {
    if (!currentUser) {
      router.replace("/login");
      return;
    }
    load();
    listPlans(projectId)
      .then((plans) => setPlanNames(Object.fromEntries(plans.map((p) => [p.id, p.name]))))
      .catch(() => {});
  }, [router, load, projectId, currentUser]);

  /* reset to first page whenever the filter/search/sort changes */
  useEffect(() => {
    setPage(1);
  }, [activeTab, tableSearch, runFilterPriority, runFilterType, runFilterAssignee, runSort]);

  /* toggle the ID/Priority/Test Case column sort: same column clicked again flips direction, the
     other column replaces it starting at ascending — "only one active sort at a time". */
  function toggleRunSort(column: "id" | "priority" | "testCase") {
    setRunSort((prev) => {
      if (prev?.column === column) return { column, direction: prev.direction === "asc" ? "desc" : "asc" };
      return { column, direction: "asc" };
    });
  }


  /* ───── Load test cases for picker ───── */
  async function openPicker() {
    setShowPicker(true);
    setCasesLoading(true);
    setSelectedCases(new Set());
    setAddError(null);
    addInFlightRef.current = false;
    try {
      const [casesResult, suitesResult] = await Promise.all([
        listTestCases(projectId, { limit: 1000 }),
        listSuites(projectId),
      ]);
      setAllCases(casesResult.list);
      setSuites(suitesResult);
    } catch {
      // ignore
    } finally {
      setCasesLoading(false);
    }
  }

  /* already-included case IDs */
  const includedCaseIds = useMemo(
    () => new Set(executions.map((e) => e.testcaseId)),
    [executions]
  );

  /*
   * A suite filter has to match the suite AND everything nested under it — same as the repository
   * screen's `includeDescendants` (Tesbo-Backend-Nest/src/legacy/legacy.service.ts's listTestCases).
   * Matching only `tc.suiteId === filterSuiteId` silently hid every case filed under a sub-suite,
   * which is why this picker offered fewer approved cases than the repository reported for the same
   * suite (e.g. 170 approved in the repository vs. 165 selectable here — the missing 5 lived in a
   * child suite). `suites` is already loaded flat with `parentId`, so the subtree is walked
   * client-side rather than adding a second network round trip.
   */
  const suiteSubtreeIds = useMemo(() => {
    const ids = new Set<string>();
    if (!filterSuiteId) return ids;
    const childrenByParent = new Map<string, string[]>();
    for (const s of suites) {
      const key = s.parentId ?? "";
      const siblings = childrenByParent.get(key);
      if (siblings) siblings.push(s.id);
      else childrenByParent.set(key, [s.id]);
    }
    const stack = [filterSuiteId];
    ids.add(filterSuiteId);
    while (stack.length) {
      const current = stack.pop()!;
      for (const childId of childrenByParent.get(current) ?? []) {
        if (!ids.has(childId)) {
          ids.add(childId);
          stack.push(childId);
        }
      }
    }
    return ids;
  }, [filterSuiteId, suites]);

  /* filtered available cases (not already added) */
  const filteredCases = useMemo(() => {
    return allCases.filter((tc) => {
      if (includedCaseIds.has(tc.id)) return false;
      if (filterSearch && !tc.title.toLowerCase().includes(filterSearch.toLowerCase()) && !tc.externalId.toLowerCase().includes(filterSearch.toLowerCase())) return false;
      if (filterPriority && tc.priority !== filterPriority) return false;
      if (filterType && tc.type !== filterType) return false;
      if (filterSuiteId && !suiteSubtreeIds.has(tc.suiteId ?? "")) return false;
      if (filterStatus && tc.status !== filterStatus) return false;
      return true;
    });
  }, [allCases, includedCaseIds, filterSearch, filterPriority, filterType, filterSuiteId, suiteSubtreeIds, filterStatus]);

  /* selectable = only Approved cases */
  const selectableCases = useMemo(
    () => filteredCases.filter((tc) => tc.status === "Approved"),
    [filteredCases]
  );

  /*
   * Selections are cumulative across filter changes (a case picked under one Module filter stays
   * picked after switching to another), which the per-row checkbox already reflects correctly via
   * `selectedCases.has(tc.id)`. But the header "select all" checkbox and the summary line need a
   * count scoped to what the *current* filter shows — comparing the raw `selectedCases.size`
   * (cumulative, can include hidden rows) against `selectableCases.length` (filtered) produced
   * nonsense like "37 of 3 selectable selected" once a Module filter hid most of a prior selection.
   */
  const selectedInView = useMemo(
    () => selectableCases.filter((tc) => selectedCases.has(tc.id)).length,
    [selectableCases, selectedCases]
  );

  /* toggle selection (only Approved) */
  function toggleCase(id: string) {
    if (adding) return;
    const tc = filteredCases.find((c) => c.id === id);
    if (tc && tc.status !== "Approved") return;
    setSelectedCases((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (adding || selectableCases.length === 0) return;
    setSelectedCases((prev) => {
      // Recompute from `prev`, not the outer `selectedInView`, so two toggle-all clicks fired
      // before React re-renders still see each other's effect instead of racing on stale state.
      const allVisibleSelected = selectableCases.every((tc) => prev.has(tc.id));
      const next = new Set(prev);
      for (const tc of selectableCases) {
        if (allVisibleSelected) next.delete(tc.id);
        else next.add(tc.id);
      }
      return next;
    });
  }

  async function handleAddCases() {
    if (addInFlightRef.current) return;
    if (selectedCases.size === 0) return;
    addInFlightRef.current = true;
    setAdding(true);
    setAddError(null);
    try {
      const idsToAdd = Array.from(selectedCases);
      const result = await addTestCasesToRun(cycleId, idsToAdd);
      if (!result || result.added >= result.requested) {
        setShowPicker(false);
        load();
        return;
      }
      // Some selected cases were skipped server-side (e.g. another session added one of them to
      // this run first, or a case was un-approved between selection and submit). Not a failure,
      // but the modal must not report success while some selections silently didn't land — keep
      // it open with the discrepancy explained, and refresh so the ones that did land drop out of
      // the "not yet added" list instead of staying selectable for a re-submit.
      setAddError(
        `${result.added} of ${result.requested} case${result.requested !== 1 ? "s" : ""} added — ${result.skipped} already existed in this run or are no longer eligible.`
      );
      load();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add test cases to this run. Please try again.");
    } finally {
      addInFlightRef.current = false;
      setAdding(false);
    }
  }

  /* ───── Inline status change ─────
     Applied optimistically: the dropdown used to stay locked on the old value (disabled) until the
     PATCH round trip resolved, which is what actually read as the "noticeable delay" — the write
     itself is a single fast query, but the UI made the user wait for it anyway. The new value is
     shown the instant it's picked; a failed PATCH rolls the row back and surfaces why via
     statusError, the same revert-on-failure convention handleRemoveCase already uses. */
  async function handleStatusChange(executionId: string, newStatus: string) {
    const prevStatus = executions.find((e) => e.id === executionId)?.status;
    setStatusSaving(executionId);
    setStatusError(null);
    setExecutions((prev) =>
      prev.map((e) => (e.id === executionId ? { ...e, status: newStatus } : e))
    );
    try {
      await updateExecution(cycleId, executionId, { status: newStatus });
      if (newStatus === "Failed") {
        const exec = executions.find((e) => e.id === executionId);
        if (exec) openBugDialogFor({ ...exec, status: newStatus }, "Failed");
      }
    } catch (err) {
      setExecutions((prev) =>
        prev.map((e) => (e.id === executionId ? { ...e, status: prevStatus ?? e.status } : e))
      );
      setStatusError({
        id: executionId,
        message: err instanceof Error ? err.message : "Failed to update status. Please try again.",
      });
    } finally {
      setStatusSaving(null);
    }
  }

  /* ───── Right-side test case detail panel ───── */
  // Guards against an out-of-order response: switching panels fires a new listBugs() call before
  // the previous execution's call has resolved, and without this a slower earlier response could
  // land after the panel has moved on, showing one test case's linked bug on another's panel.
  const panelBugRequestIdRef = useRef<string | null>(null);

  function loadPanelBug(exec: ExecutionItem) {
    panelBugRequestIdRef.current = exec.id;
    // listBugs is scoped to testcase+cycle, not to this one execution (the API has no executionId
    // filter) — a testcase can be executed more than once in the same cycle, so this narrows to
    // the bugs actually linked to THIS execution via each bug's own links[].
    listBugs(projectId, { testcaseId: exec.testcaseId, cycleId })
      .then((bugs) => {
        if (panelBugRequestIdRef.current !== exec.id) return;
        setPanelBugs(bugs.filter((bug) => bug.links.some((l) => l.executionId === exec.id)));
      })
      .catch(() => {
        if (panelBugRequestIdRef.current === exec.id) setPanelBugs([]);
      });
  }

  /* ───── Unlink one bug from this execution — removes only the bug_links row tying it to this
   * testcase/cycle/execution via the existing addBugLink/removeBugLink pair; never deletes the
   * bug (or, for a Jira/Linear-originated bug, its external ticket). Reloads from the API rather
   * than just filtering panelBugs locally so the list reflects the same state a refresh would. */
  function requestUnlinkBug(bug: BugItem) {
    setBugToUnlink(bug);
  }

  async function confirmUnlinkBug() {
    if (!bugToUnlink || !panelExecution) return;
    const link = bugToUnlink.links.find((l) => l.executionId === panelExecution.id);
    if (!link) {
      setBugToUnlink(null);
      return;
    }
    setUnlinkingBug(true);
    try {
      await removeBugLink(bugToUnlink.id, link.id);
      loadPanelBug(panelExecution);
      setBugToUnlink(null);
    } finally {
      setUnlinkingBug(false);
    }
  }

  function openExecutionPanel(exec: ExecutionItem) {
    setPanelExecution(exec);
    setPanelStatus(exec.status || "Untested");
    setPanelActualResult(exec.actualResult || "");
    setPanelAssigneeId(exec.assigneeId || "");
    setPanelBugs([]);
    loadPanelBug(exec);
  }

  function closeExecutionPanel() {
    panelBugRequestIdRef.current = null;
    setPanelExecution(null);
    setPanelBugs([]);
  }

  async function handlePanelSave() {
    if (!panelExecution) return;
    setPanelSaving(true);
    // Optimistic: the row behind this panel reflects the pick immediately rather than only after
    // the PATCH resolves — same fix, and same revert-on-failure below, as handleStatusChange.
    const prev = panelExecution;
    setExecutions((list) =>
      list.map((e) =>
        e.id === panelExecution.id
          ? { ...e, status: panelStatus, actualResult: panelActualResult, assigneeId: panelAssigneeId || null }
          : e
      )
    );
    try {
      await updateExecution(cycleId, panelExecution.id, {
        status: panelStatus,
        actualResult: panelActualResult,
        assigneeId: panelAssigneeId || null,
      });
      const wasFailed = prev.status === "Failed";
      closeExecutionPanel();
      if (panelStatus === "Failed" && !wasFailed) {
        openBugDialogFor({ ...prev, status: panelStatus }, "Failed");
      }
    } catch (err) {
      setExecutions((list) =>
        list.map((e) =>
          e.id === prev.id
            ? { ...e, status: prev.status, actualResult: prev.actualResult, assigneeId: prev.assigneeId }
            : e
        )
      );
      setStatusError({
        id: prev.id,
        message: err instanceof Error ? err.message : "Failed to update status. Please try again.",
      });
    } finally {
      setPanelSaving(false);
    }
  }

  /* ───── Remove test case ───── */
  async function handleRemoveCase(testcaseId: string) {
    try {
      await removeTestCaseFromRun(cycleId, testcaseId);
      setExecutions((prev) => prev.filter((e) => e.testcaseId !== testcaseId));
      setSelectedRunCaseIds((prev) => {
        const next = new Set(prev);
        next.delete(testcaseId);
        return next;
      });
    } catch (err) {
      // Was a bare `// ignore`: a removal that failed left the row on screen with no explanation, so
      // it read as an unresponsive button.
      setBulkRemoveError(err instanceof Error ? err.message : "Failed to remove the test case.");
    }
  }

  /* ───── Remove selected test cases ─────
     The only ways out of a run used to be one case at a time or deleting the whole run. */
  async function handleRemoveSelectedCases() {
    const testcaseIds = Array.from(selectedRunCaseIds);
    if (!testcaseIds.length || bulkRemoving) return;
    setBulkRemoving(true);
    try {
      await removeTestCasesFromRun(cycleId, testcaseIds);
      const removed = new Set(testcaseIds);
      setExecutions((prev) => prev.filter((e) => !removed.has(e.testcaseId)));
      setSelectedRunCaseIds(new Set());
      setBulkRemoveError(null);
      setBulkRemoveOpen(false);
    } catch (err) {
      setBulkRemoveError(err instanceof Error ? err.message : "Failed to remove the selected test cases.");
    } finally {
      setBulkRemoving(false);
    }
  }

  /* ───── Assign selected test cases ─────
     selectedRunCaseIds is keyed by testcaseId (same set the remove action uses); the bulk-assign
     endpoint takes execution ids, so they're resolved through the already-loaded executions list. */
  async function handleBulkAssign() {
    const executionIds = executions
      .filter((e) => selectedRunCaseIds.has(e.testcaseId))
      .map((e) => e.id);
    if (!executionIds.length || bulkAssigning) return;
    setBulkAssigning(true);
    try {
      const assigneeId = bulkAssignAssigneeId || null;
      await bulkAssignExecutions(cycleId, { executionIds, assigneeId });
      const updated = new Set(executionIds);
      setExecutions((prev) => prev.map((e) => (updated.has(e.id) ? { ...e, assigneeId } : e)));
      setSelectedRunCaseIds(new Set());
      setBulkAssignError(null);
      setBulkAssignOpen(false);
    } catch (err) {
      setBulkAssignError(err instanceof Error ? err.message : "Failed to assign the selected test cases.");
    } finally {
      setBulkAssigning(false);
    }
  }

  function toggleRunCaseSelection(testcaseId: string) {
    setSelectedRunCaseIds((prev) => {
      const next = new Set(prev);
      if (next.has(testcaseId)) next.delete(testcaseId);
      else next.add(testcaseId);
      return next;
    });
  }

  // Only the rows on the current page — selecting "all" must not reach into other pages, and
  // toggling it off must not drop selections made on a page the user has since left.
  function toggleSelectAllRunCases() {
    setSelectedRunCaseIds((prev) => {
      const pageIds = pagedExecutions.map((e) => e.testcaseId);
      const allPageSelected = pageIds.length > 0 && pageIds.every((id) => prev.has(id));
      const next = new Set(prev);
      for (const id of pageIds) {
        if (allPageSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  /* ───── Change run status ───── */
  async function handleRunStatusChange(newStatus: string) {
    if (!run) return;
    try {
      await updateTestRun(cycleId, { status: newStatus });
      setRun({ ...run, status: newStatus });
    } catch {
      // ignore
    }
  }


  /* ───── Share toggle ───── */
  async function handleShareToggle(enabled: boolean) {
    setShareToggling(true);
    setShareError(null);
    try {
      const result = await toggleTestRunShare(cycleId, enabled);
      setShareEnabled(result.shareEnabled);
      setShareToken(result.shareToken || null);
      setRun((current) => current ? { ...current, shareEnabled: result.shareEnabled, shareToken: result.shareToken || null } : current);
    } catch (error) {
      setShareError(error instanceof Error ? error.message : "Failed to update public sharing.");
    } finally {
      setShareToggling(false);
    }
  }

  function getShareUrl() {
    if (!shareToken) return "";
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/share/${shareToken}`;
  }

  async function copyShareLink() {
    const url = getShareUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

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

  // Pass Rate = Passed / (Passed + Failed + Blocked) — Skipped is neither a pass nor a fail, so it
  // is excluded from this ratio the same way the Test Plan page excludes it. This used to divide by
  // stats.total (every case, including Untested/Retest), which is what made this page read 30% for
  // a run the Test Plan page read as 43% for. Execution Progress (below) is the total-based metric.
  const passRate = computePassRate(stats);
  const executionProgress = computeExecutionProgress(stats, stats.total);

  /* ───── Test cases table: tab counts, filter, search, pagination ───── */
  const tabCounts = useMemo(() => {
    const counts: Partial<Record<RunTab, number>> = {};
    for (const e of executions) {
      const bucket: RunTab = e.status === "Untested" || e.status === "Retest" ? "Pending" : (e.status as RunTab);
      counts[bucket] = (counts[bucket] || 0) + 1;
    }
    return counts;
  }, [executions]);

  // Type has no fixed enum in the DB (VARCHAR, free text) and the picker modal's canonical list
  // (Functional/Regression/…/Usability/Other) doesn't match the Test Cases page's own list —
  // rather than pick one, the filter options are the distinct values actually present on this
  // run's test cases, so a legacy/imported Type string is always filterable, never hidden.
  const runTypeOptions = useMemo(
    () => Array.from(new Set(executions.map((e) => e.type).filter((t): t is string => !!t))).sort(),
    [executions]
  );

  // Priority has a canonical P0–P3 list used app-wide, but the DB column is unconstrained free
  // text, so a legacy/imported row could carry something outside it — append any such value
  // rather than let it disappear from the filter silently.
  const runPriorityOptions = useMemo(() => {
    const extra = Array.from(
      new Set(
        executions
          .map((e) => e.priority)
          .filter((p): p is string => !!p && !(CANONICAL_PRIORITIES as readonly string[]).includes(p))
      )
    ).sort();
    return [...CANONICAL_PRIORITIES, ...extra];
  }, [executions]);

  const activeRunFilterCount =
    (runFilterPriority ? 1 : 0) + (runFilterType ? 1 : 0) + (runFilterAssignee ? 1 : 0);

  function clearRunFilters() {
    setRunFilterPriority("");
    setRunFilterType("");
    setRunFilterAssignee("");
  }

  const filteredExecutions = useMemo(() => {
    let list = executions;
    if (activeTab !== "All") {
      list = list.filter((e) => (activeTab === "Pending" ? e.status === "Untested" || e.status === "Retest" : e.status === activeTab));
    }
    if (runFilterPriority) {
      list = list.filter((e) => e.priority === runFilterPriority);
    }
    if (runFilterType) {
      list = list.filter((e) => e.type === runFilterType);
    }
    if (runFilterAssignee) {
      list = list.filter((e) => (runFilterAssignee === "__unassigned__" ? !e.assigneeId : e.assigneeId === runFilterAssignee));
    }
    const term = tableSearch.trim().toLowerCase();
    if (term) {
      list = list.filter(
        (e) =>
          (e.title || e.snapshotTitle || "").toLowerCase().includes(term) ||
          (e.externalId || "").toLowerCase().includes(term)
      );
    }
    // Applied after every filter/search above (so it always covers the full filtered dataset, not
    // just the current page) and before pagedExecutions slices it — runSort === null keeps the
    // existing order untouched, which is also why `list` is copied rather than sorted in place:
    // `list` can still be the original `executions` reference here when no filter matched anything.
    if (runSort) {
      const direction = runSort.direction === "asc" ? 1 : -1;
      list = [...list].sort((a, b) => {
        if (runSort.column === "id") return direction * compareExternalId(a.externalId || "", b.externalId || "");
        if (runSort.column === "priority") return direction * comparePriority(a.priority || "", b.priority || "");
        return direction * compareTestCaseTitle(a.title || a.snapshotTitle || "", b.title || b.snapshotTitle || "");
      });
    }
    return list;
  }, [executions, activeTab, tableSearch, runFilterPriority, runFilterType, runFilterAssignee, runSort]);

  const pageCount = Math.max(1, Math.ceil(filteredExecutions.length / PAGE_SIZE));
  const pagedExecutions = useMemo(
    () => filteredExecutions.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filteredExecutions, page]
  );


  if (loading || !run) {
    return <PageLoader variant="screen" />;
  }

  const isInProgress = run.status === "In Progress";
  const isPlanning = run.status === "Planning";
  const isCompleted = run.status === "Completed";

  const ownerName = run.ownerId ? memberNames[run.ownerId] : null;
  const planName = run.planId ? planNames[run.planId] : null;

  return (
    // Full-bleed, full-height workspace: `tc-fullbleed` drops the wrapping .tesbo-page's
    // centered 1280px cap so this fills the content region below the 3.5rem TopBar,
    // matching the Test Plan detail workspace pattern.
    <main className="tc-fullbleed flex flex-col p-4" style={{ height: "calc(100vh - 3.5rem)" }}>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* TopBar takeover: breadcrumb (start) + actions (end) */}
        {topBarStartEl &&
          createPortal(
            <Breadcrumbs
              items={[
                { label: "Projects", href: "/projects" },
                { label: projectName || "Project", href: `/projects/${projectId}/dashboard` },
                { label: "Test Runs", href: `/projects/${projectId}/cycles` },
                { label: run.name },
              ]}
            />,
            topBarStartEl,
          )}
        {topBarEndEl &&
          createPortal(
            <div className="flex flex-wrap items-center gap-2">
              {isPlanning && (
                <Button onClick={() => handleRunStatusChange("In Progress")}>
                  <IconPlayerPlay size={14} />
                  Start Execution
                </Button>
              )}
              {isInProgress && (
                <Button onClick={() => handleRunStatusChange("Completed")}>
                  <IconCircleCheck size={14} />
                  Mark Completed
                </Button>
              )}
              {isCompleted && (
                <Button variant="secondary" onClick={() => handleRunStatusChange("In Progress")}>
                  <IconRefresh size={14} />
                  Reopen
                </Button>
              )}
              {!isCompleted && (
                <Button variant="secondary" onClick={openPicker}>
                  <IconPlus size={14} />
                  Add Test Cases
                </Button>
              )}
              <Button variant="secondary" onClick={() => setShowShare(true)}>
                <IconShare size={14} />
                Share
              </Button>
              <a
                href={`${API_BASE}/api/cycles/${cycleId}/export/csv`}
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--ink-600)" }}
                className="flex h-[30px] items-center gap-1.5 rounded-[6px] border border-[var(--ink-200)] bg-transparent px-3 text-[12px] font-medium transition-colors hover:bg-[var(--ink-100)]"
              >
                <IconDownload size={13} stroke={1.75} />
                Export CSV
              </a>
            </div>,
            topBarEndEl,
          )}

        {/* Page header: title + status + owner + description + meta */}
        <div className="mb-3 shrink-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <RunAvatar name={run.name} size={28} />
            <h1 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-[var(--foreground)]">{run.name}</h1>
            <StatusChip tone={runStatusToTone(run.status)}>{run.status}</StatusChip>
            {ownerName && <MemberAvatar name={ownerName} seed={run.ownerId} size={24} />}
          </div>
          {run.description && <p className="mt-1 text-[13px] text-[var(--muted-soft)]">{run.description}</p>}
          {/*
            * "Automated · github-actions · main · a1b2c3d · Build ↗" — renders nothing on a manual
            * run, so the header is unchanged for every run a person created (Basecamp 10189985971 §4).
            */}
          {run.source === "automation" && (
            <div className="mt-2">
              <AutomationRunProvenance run={run} />
            </div>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-4">
            {planName && (
              <span className="flex items-center gap-1.5 text-[12px] text-[var(--muted)]">
                <IconClipboardList size={13} stroke={1.75} className="text-[var(--muted-soft)]" /> {planName}
              </span>
            )}
            {run.environment && (
              <span className="flex items-center gap-1.5 text-[12px] text-[var(--muted)]">
                <IconDeviceDesktop size={13} stroke={1.75} className="text-[var(--muted-soft)]" /> {run.environment}
              </span>
            )}
            {run.buildVersion && (
              <span className="flex items-center gap-1.5 text-[12px] text-[var(--muted)]">
                <IconTag size={13} stroke={1.75} className="text-[var(--muted-soft)]" /> {run.buildVersion}
              </span>
            )}
            <span className="flex items-center gap-1.5 text-[12px] text-[var(--muted)]">
              <IconClock size={13} stroke={1.75} className="text-[var(--muted-soft)]" /> <span className="font-mono">{formatDuration(run.startedAt, run.endedAt)}</span>
            </span>
            <span className="flex items-center gap-1.5 text-[12px] text-[var(--muted)]">
              <IconCalendarEvent size={13} stroke={1.75} className="text-[var(--muted-soft)]" /> Created {formatDate(run.createdAt)}
            </span>
          </div>
        </div>

        {/* Body: detail content.
            The runs switcher panel that used to sit to the left of this was removed — a run detail
            already reaches its siblings through the "Test Runs" breadcrumb and the sidebar's Runs
            entry, and the ~220px it held now goes to the test cases table. */}
        <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
            {/* Stat pills + progress */}
            <section className="mb-5 rounded-[10px] border border-[var(--border)] p-5">
              <div className="flex flex-wrap items-center gap-3">
                <StatPill icon={<IconClipboardCheck size={13} />} label="Total" value={stats.total} />
                <StatPill icon={<IconCircleCheck size={13} />} label="Passed" value={stats.passed} tone="success" />
                <StatPill icon={<IconCircleX size={13} />} label="Failed" value={stats.failed} tone="error" />
                <StatPill icon={<IconCircleMinus size={13} />} label="Blocked" value={stats.blocked} tone="blocked" />
                <StatPill icon={<IconCircleDashed size={13} />} label="Skipped" value={stats.skipped} tone="skipped" />
                <StatPill icon={<IconClock size={13} />} label="Pending" value={stats.pending} />

                <div className="min-w-[220px] flex-1">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[12px] text-[var(--muted-soft)]">Execution Progress</span>
                    <span className="text-[12px] font-semibold" style={{ color: "var(--info-foreground)" }}>
                      {stats.total ? `${executionProgress}% executed` : "No cases in this run"}
                    </span>
                  </div>
                  <RunProgressBar
                    passed={stats.passed}
                    failed={stats.failed}
                    blocked={stats.blocked}
                    skipped={stats.skipped}
                    pending={stats.pending}
                    total={stats.total}
                  />
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-[12px] text-[var(--muted-soft)]">Pass Rate</span>
                    <span className="text-[12px] font-semibold" style={{ color: "var(--success-foreground)" }}>
                      {passRate !== null ? `${passRate}%` : "No cases executed yet"}
                    </span>
                  </div>
                </div>
              </div>
            </section>

            {/* ───── Test Cases section ───── */}
            <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-5 py-3">
            <h2 className="text-[15px] font-semibold text-[var(--foreground)]">Test Cases</h2>
            <span className="rounded-full bg-[var(--surface-secondary)] px-2 py-0.5 text-[11px] font-semibold text-[var(--muted)]">{executions.length}</span>

            <div className="flex flex-wrap items-center gap-1">
              {RUN_TABS.map((tab) => {
                const active = activeTab === tab;
                const count = tab === "All" ? 0 : tabCounts[tab] || 0;
                const badge = tabBadgeStyle(tab);
                return (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setActiveTab(tab)}
                    className={`flex h-[30px] items-center gap-1.5 rounded-[6px] px-3 text-[12.5px] font-medium transition-colors ${
                      active ? "bg-[var(--brand-soft)]" : "text-[var(--muted)] hover:bg-[var(--surface-secondary)]"
                    }`}
                    style={active ? { color: "var(--accent-light)" } : undefined}
                  >
                    {tab}
                    {tab !== "All" && count > 0 && (
                      <span className="rounded-full px-1.5 text-[10px]" style={{ background: badge.bg, color: badge.color }}>
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <Select
                aria-label="Filter by priority"
                data-testid="run-filter-priority"
                value={runFilterPriority}
                onChange={(e) => setRunFilterPriority(e.target.value)}
                className="h-[30px] rounded-[6px] border border-[var(--border)] bg-[var(--surface-secondary)] px-2 text-[12.5px] text-[var(--foreground)] outline-none focus:border-[var(--brand-primary)]"
              >
                <option value="">All priorities</option>
                {runPriorityOptions.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </Select>
              <Select
                aria-label="Filter by type"
                data-testid="run-filter-type"
                value={runFilterType}
                onChange={(e) => setRunFilterType(e.target.value)}
                className="h-[30px] rounded-[6px] border border-[var(--border)] bg-[var(--surface-secondary)] px-2 text-[12.5px] text-[var(--foreground)] outline-none focus:border-[var(--brand-primary)]"
              >
                <option value="">All types</option>
                {runTypeOptions.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </Select>
              <Select
                aria-label="Filter by assignee"
                data-testid="run-filter-assignee"
                value={runFilterAssignee}
                onChange={(e) => setRunFilterAssignee(e.target.value)}
                className="h-[30px] rounded-[6px] border border-[var(--border)] bg-[var(--surface-secondary)] px-2 text-[12.5px] text-[var(--foreground)] outline-none focus:border-[var(--brand-primary)]"
              >
                <option value="">All assignees</option>
                <option value="__unassigned__">Unassigned</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>{m.name || m.email}</option>
                ))}
              </Select>
              {activeRunFilterCount > 0 && (
                <button
                  type="button"
                  data-testid="run-filter-clear"
                  onClick={clearRunFilters}
                  className="flex h-[30px] items-center gap-1 rounded-[6px] px-2 text-[12px] text-[var(--muted)] hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
                >
                  <IconX size={12} stroke={2} />
                  Clear filters ({activeRunFilterCount})
                </button>
              )}
            </div>

            <div className="relative ml-auto">
              <IconSearch size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--muted-soft)]" />
              <input
                value={tableSearch}
                onChange={(e) => setTableSearch(e.target.value)}
                placeholder="Search test cases…"
                className="h-[30px] w-[220px] rounded-[6px] border border-[var(--border)] bg-[var(--surface-secondary)] pl-8 pr-3 text-[13px] text-[var(--foreground)] outline-none focus:border-[var(--brand-primary)]"
              />
            </div>
          </div>

          {selectedRunCaseIds.size > 0 && !isCompleted && (
            <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-[var(--border)] bg-[var(--brand-soft)] px-4 text-[12px]">
              <span className="font-medium text-[var(--brand-primary)]">{selectedRunCaseIds.size} selected</span>
              <div className="h-4 w-px bg-[var(--border-strong)]" />
              <button
                type="button"
                data-testid="run-bulk-remove"
                onClick={() => {
                  setBulkRemoveError(null);
                  setBulkRemoveOpen(true);
                }}
                className="flex items-center gap-1 font-medium text-[var(--error-foreground)] hover:underline"
              >
                <IconTrash size={13} />
                Remove from run
              </button>
              <button
                type="button"
                data-testid="run-bulk-assign"
                onClick={() => {
                  setBulkAssignError(null);
                  setBulkAssignAssigneeId("");
                  setBulkAssignOpen(true);
                }}
                className="flex items-center gap-1 font-medium text-[var(--brand-primary)] hover:underline"
              >
                <IconUserPlus size={13} />
                Assign to
              </button>
              <button
                type="button"
                onClick={() => setSelectedRunCaseIds(new Set())}
                className="ml-auto flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]"
              >
                <IconX size={12} stroke={2} />
                Clear selection
              </button>
            </div>
          )}

          {executions.length === 0 ? (
            <div className="py-12 text-center text-sm text-[var(--muted-soft)]">
              No test cases added yet. Click &quot;Add Test Cases&quot; to get started.
            </div>
          ) : pagedExecutions.length === 0 ? (
            <div className="py-12 text-center">
              <IconFilterOff size={28} className="mx-auto mb-3 text-[var(--muted-soft)]" />
              <p className="text-[14px] font-medium text-[var(--muted)]">No test cases match</p>
              <p className="mt-1 text-[13px] text-[var(--muted-soft)]">Try adjusting the filter or search query.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--border)] bg-[var(--surface-secondary)] text-left text-[11px] uppercase tracking-wide text-[var(--muted-soft)]">
                    {!isCompleted && (
                      <th className="w-9 px-3 py-2.5">
                        <input
                          type="checkbox"
                          aria-label="Select all test cases on this page"
                          data-testid="run-select-all"
                          checked={
                            pagedExecutions.length > 0 &&
                            pagedExecutions.every((e) => selectedRunCaseIds.has(e.testcaseId))
                          }
                          onChange={toggleSelectAllRunCases}
                          className="h-3.5 w-3.5 cursor-pointer accent-[var(--brand-primary)]"
                        />
                      </th>
                    )}
                    <th className="px-5 py-2.5 font-semibold">
                      <SortableColumnHeader label="ID" column="id" runSort={runSort} onToggle={toggleRunSort} />
                    </th>
                    <th className="px-5 py-2.5 font-semibold">
                      <SortableColumnHeader label="Test Case" column="testCase" runSort={runSort} onToggle={toggleRunSort} />
                    </th>
                    <th className="px-5 py-2.5 font-semibold">
                      <SortableColumnHeader label="Priority" column="priority" runSort={runSort} onToggle={toggleRunSort} />
                    </th>
                    <th className="px-5 py-2.5 font-semibold">Type</th>
                    <th className="px-5 py-2.5 font-semibold">Assigned To</th>
                    <th className="px-5 py-2.5 text-right font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-subtle)]">
                  {pagedExecutions.map((e) => {
                    const assigneeName = e.assigneeId ? memberNames[e.assigneeId] : null;
                    return (
                      <tr key={e.id} className="group hover:bg-[var(--surface-secondary)]">
                        {!isCompleted && (
                          <td className="px-3 py-3">
                            <input
                              type="checkbox"
                              aria-label={`Select ${e.title || e.snapshotTitle || "test case"}`}
                              checked={selectedRunCaseIds.has(e.testcaseId)}
                              onChange={() => toggleRunCaseSelection(e.testcaseId)}
                              className="h-3.5 w-3.5 cursor-pointer accent-[var(--brand-primary)]"
                            />
                          </td>
                        )}
                        <td className="whitespace-nowrap px-5 py-3 font-mono text-[12px] text-[var(--muted-soft)]">{e.externalId || "—"}</td>
                        <td className="px-5 py-3">
                          <button
                            type="button"
                            onClick={() => openExecutionPanel(e)}
                            className="text-left text-[13px] text-[var(--accent-light)] hover:underline"
                          >
                            {e.title || e.snapshotTitle || "Untitled test case"}
                          </button>
                        </td>
                        <td className="px-5 py-3">
                          {e.priority ? <PriorityBadge priority={e.priority as Priority} /> : <span className="text-[12.5px] text-[var(--muted-soft)]">—</span>}
                        </td>
                        <td className="px-5 py-3 text-[12.5px] text-[var(--muted)]">{e.type || "—"}</td>
                        <td className="px-5 py-3">
                          {assigneeName ? (
                            <span className="flex items-center gap-1.5">
                              <MemberAvatar name={assigneeName} seed={e.assigneeId} size={20} />
                              <span className="text-[12.5px] text-[var(--muted)]">{assigneeName}</span>
                            </span>
                          ) : (
                            <span className="text-[12.5px] text-[var(--muted-soft)]">Unassigned</span>
                          )}
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex items-center justify-end gap-2">
                            <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                              <Link
                                href={`/projects/${projectId}/cycles/${cycleId}/execute/${e.id}`}
                                title="Open full page"
                                className="flex h-6 w-6 items-center justify-center rounded-[6px] text-[var(--muted-soft)] hover:bg-[var(--surface-tertiary)] hover:text-[var(--foreground)]"
                              >
                                <IconArrowRight size={13} />
                              </Link>
                              <button
                                type="button"
                                title="Log bug"
                                onClick={() => openBugDialogFor(e)}
                                className="flex h-6 w-6 items-center justify-center rounded-[6px] text-[var(--muted-soft)] hover:bg-[var(--error-soft)] hover:text-[var(--error-foreground)]"
                              >
                                <IconBug size={13} />
                              </button>
                              {!isCompleted && (
                                <button
                                  type="button"
                                  title="Remove from test run"
                                  onClick={() => handleRemoveCase(e.testcaseId)}
                                  className="flex h-6 w-6 items-center justify-center rounded-[6px] text-[var(--muted-soft)] hover:bg-[var(--error-soft)] hover:text-[var(--error-foreground)]"
                                >
                                  <IconTrash size={13} />
                                </button>
                              )}
                            </div>
                            {isInProgress ? (
                              <span className="flex items-center gap-1.5">
                                <select
                                  value={e.status}
                                  onChange={(ev) => handleStatusChange(e.id, ev.target.value)}
                                  className={`h-7 cursor-pointer rounded-[6px] border px-2 text-[11.5px] font-medium outline-none ${
                                    statusSaving === e.id ? "opacity-60" : ""
                                  }`}
                                  style={execSelectStyle(e.status)}
                                >
                                  {EXEC_STATUSES.map((s) => (
                                    <option key={s} value={s} style={EXEC_OPTION_STYLE}>
                                      {s}
                                    </option>
                                  ))}
                                </select>
                                {statusError?.id === e.id && (
                                  <IconAlertCircle
                                    size={15}
                                    className="shrink-0 text-[var(--error-foreground)]"
                                    title={statusError.message}
                                  />
                                )}
                              </span>
                            ) : (
                              <StatusChip tone={statusToTone(e.status)}>{e.status}</StatusChip>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Footer / pagination */}
          {executions.length > 0 && (
            <div className="flex items-center justify-between border-t border-[var(--border)] px-5 py-3">
              <span className="text-[12px] text-[var(--muted-soft)]">
                Showing {filteredExecutions.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filteredExecutions.length)} of{" "}
                {filteredExecutions.length} cases
              </span>
              {pageCount > 1 && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label="Previous page"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="flex h-7 w-7 items-center justify-center rounded-[6px] border border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-secondary)] disabled:opacity-40"
                  >
                    <IconChevronLeft size={13} />
                  </button>
                  <span className="text-[12px] text-[var(--muted)]">
                    Page {page} of {pageCount}
                  </span>
                  <button
                    type="button"
                    aria-label="Next page"
                    disabled={page >= pageCount}
                    onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                    className="flex h-7 w-7 items-center justify-center rounded-[6px] border border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-secondary)] disabled:opacity-40"
                  >
                    <IconChevronRight size={13} />
                  </button>
                </div>
              )}
            </div>
          )}
            </div>
        </div>
      </div>

      {/* ───── Test Case Picker Modal ───── */}
      <Modal
        open={bulkRemoveOpen}
        onClose={() => setBulkRemoveOpen(false)}
        title="Remove test cases from run"
        className="max-w-[460px]"
      >
        <p className="text-[13px] text-[var(--muted)]">
          Remove <span className="font-semibold text-[var(--foreground)]">{selectedRunCaseIds.size}</span> test case
          {selectedRunCaseIds.size === 1 ? "" : "s"} from this run? Any execution results recorded against them in this
          run are discarded. The test cases themselves stay in the repository.
        </p>
        {bulkRemoveError && (
          <p className="mt-3 text-[12.5px] text-[var(--error-foreground)]">{bulkRemoveError}</p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setBulkRemoveOpen(false)} disabled={bulkRemoving}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleRemoveSelectedCases} disabled={bulkRemoving}>
            {bulkRemoving ? "Removing…" : `Remove ${selectedRunCaseIds.size}`}
          </Button>
        </div>
      </Modal>

      <Modal
        open={bulkAssignOpen}
        onClose={() => setBulkAssignOpen(false)}
        title="Assign test cases"
        className="max-w-[460px]"
      >
        <p className="text-[13px] text-[var(--muted)]">
          Assign <span className="font-semibold text-[var(--foreground)]">{selectedRunCaseIds.size}</span> test case
          {selectedRunCaseIds.size === 1 ? "" : "s"} to:
        </p>
        <div className="mt-3">
          <label className="mb-1 block text-[12.5px] font-medium text-[var(--muted)]">Assigned to</label>
          <Select value={bulkAssignAssigneeId} onChange={(e) => setBulkAssignAssigneeId(e.target.value)} aria-label="Assign selected test cases to">
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name || m.email}
              </option>
            ))}
          </Select>
        </div>
        {bulkAssignError && (
          <p className="mt-3 text-[12.5px] text-[var(--error-foreground)]">{bulkAssignError}</p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setBulkAssignOpen(false)} disabled={bulkAssigning}>
            Cancel
          </Button>
          <Button onClick={handleBulkAssign} disabled={bulkAssigning}>
            {bulkAssigning ? "Assigning…" : `Assign ${selectedRunCaseIds.size}`}
          </Button>
        </div>
      </Modal>

      <Modal
        open={showPicker}
        onClose={() => {
          // Escape/backdrop bypasses the Cancel button's `disabled={adding}` guard — block it too,
          // otherwise closing (and later reopening) mid-submit lets the in-flight request's result
          // land on a picker session the user never asked it to affect (stale success/error banner,
          // or an unexpected re-close of the freshly reopened modal).
          if (adding) return;
          setShowPicker(false);
        }}
        title="Add Test Cases to Run"
        className="!max-w-4xl"
      >
        {/* Filters */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
          <Input
            type="text"
            placeholder="Search by title or ID…"
            value={filterSearch}
            onChange={(e) => setFilterSearch(e.target.value)}
            className="col-span-2 sm:col-span-2"
          />
          <Select
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value)}
          >
            <option value="">All Priorities</option>
            <option value="P0">P0 - Critical</option>
            <option value="P1">P1 - High</option>
            <option value="P2">P2 - Medium</option>
            <option value="P3">P3 - Low</option>
          </Select>
          <Select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
          >
            <option value="">All Types</option>
            <option value="Functional">Functional</option>
            <option value="Regression">Regression</option>
            <option value="Smoke">Smoke</option>
            <option value="Integration">Integration</option>
            <option value="Performance">Performance</option>
            <option value="Security">Security</option>
            <option value="Usability">Usability</option>
            <option value="Other">Other</option>
          </Select>
          <Select
            value={filterSuiteId}
            onChange={(e) => setFilterSuiteId(e.target.value)}
          >
            <option value="">All Suites</option>
            {suites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
          >
            <option value="">All Statuses</option>
            <option value="Approved">Approved</option>
            <option value="Draft">Draft</option>
            <option value="In Review">In Review</option>
          </Select>
        </div>

        {/* Info note */}
        <div className="flex items-center gap-2 mb-4 rounded-lg bg-blue-50 border border-blue-200 px-3 py-2">
          <svg className="w-4 h-4 text-blue-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-xs text-blue-700">
            Only <span className="font-semibold">Approved</span> test cases can be added to a test run. Draft, In Review, or other status cases are shown but cannot be selected.
          </p>
        </div>

        {addError && (
          <div className="flex items-center justify-between gap-2 mb-4 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
            <p className="text-xs text-amber-800">{addError}</p>
            <button
              type="button"
              onClick={() => setAddError(null)}
              className="text-amber-500 hover:text-amber-700 shrink-0"
              aria-label="Dismiss"
            >
              <IconX size={14} />
            </button>
          </div>
        )}

        {/* Case list */}
        {casesLoading ? (
          <div className="text-center py-8 text-[var(--muted-soft)] text-sm">Loading test cases…</div>
        ) : filteredCases.length === 0 ? (
          <div className="text-center py-8 text-[var(--muted-soft)] text-sm">
            {allCases.length === 0
              ? "No test cases in this project."
              : "No matching test cases found (all may already be added)."}
          </div>
        ) : (
          <>
            <div className="max-h-80 overflow-y-auto rounded-lg border border-[var(--border)]">
              <table className="w-full">
                <thead className="sticky top-0 bg-[var(--surface-secondary)]">
                  <tr className="text-left text-xs text-[var(--muted)] uppercase tracking-wider">
                    <th className="px-3 py-2 w-8">
                      <input
                        type="checkbox"
                        checked={selectedInView === selectableCases.length && selectableCases.length > 0}
                        onChange={toggleAll}
                        className="rounded"
                        disabled={selectableCases.length === 0 || adding}
                      />
                    </th>
                    <th className="px-3 py-2 font-medium">ID</th>
                    <th className="px-3 py-2 font-medium">Title</th>
                    <th className="px-3 py-2 font-medium">Priority</th>
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-subtle)]">
                  {filteredCases.map((tc) => {
                    const isApproved = tc.status === "Approved";
                    return (
                      <tr
                        key={tc.id}
                        className={`${
                          isApproved
                            ? `cursor-pointer hover:bg-[var(--surface-secondary)] ${
                                selectedCases.has(tc.id) ? "bg-blue-50/50" : ""
                              }`
                            : "opacity-50 cursor-not-allowed"
                        }`}
                        onClick={() => isApproved && toggleCase(tc.id)}
                        title={!isApproved ? `Only Approved test cases can be added to a test run. This case is "${tc.status}" — please approve it first.` : undefined}
                      >
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={selectedCases.has(tc.id)}
                            onChange={() => toggleCase(tc.id)}
                            className={`rounded ${!isApproved ? "cursor-not-allowed" : ""}`}
                            onClick={(e) => e.stopPropagation()}
                            disabled={!isApproved || adding}
                            title={!isApproved ? `Only Approved test cases can be added. This case is "${tc.status}".` : undefined}
                          />
                        </td>
                        <td className="px-3 py-2 text-xs text-[var(--muted-soft)] font-mono whitespace-nowrap">
                          {tc.externalId}
                        </td>
                        <td className="px-3 py-2 text-sm text-[var(--foreground)] truncate max-w-xs">
                          {tc.title}
                        </td>
                        <td className="px-3 py-2"><PriorityBadge priority={tc.priority as Priority} /></td>
                        <td className="px-3 py-2 text-xs text-[var(--muted)]">{tc.type}</td>
                        <td className="px-3 py-2">
                          <span className={`text-xs ${
                            isApproved
                              ? "text-[var(--success-foreground)] font-medium"
                              : "text-[var(--muted)]"
                          }`}>
                            {tc.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm text-[var(--muted)]">
                {selectedInView} of {selectableCases.length} selectable selected
                {selectableCases.length < filteredCases.length && (
                  <span className="text-[var(--muted-soft)] ml-1">
                    ({filteredCases.length - selectableCases.length} non-approved)
                  </span>
                )}
                {selectedCases.size > selectedInView && (
                  <span className="text-[var(--muted-soft)] ml-1">
                    ({selectedCases.size - selectedInView} more selected outside this filter)
                  </span>
                )}
              </p>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setShowPicker(false)} disabled={adding}>
                  Cancel
                </Button>
                <Button
                  onClick={handleAddCases}
                  disabled={adding || selectedCases.size === 0}
                >
                  {adding ? "Adding…" : `Add ${selectedCases.size} Case${selectedCases.size !== 1 ? "s" : ""}`}
                </Button>
              </div>
            </div>
          </>
        )}
      </Modal>

      {bugDialog}

      {/* ───── Unlink-bug confirmation — unlink only, never deletes the bug or its Jira/Linear
          ticket. Distinct from the "Report a Bug" dialog's own chip ✕, which only discards an
          unsaved working pick and never reaches this or the removeBugLink API. ───── */}
      <ConfirmModal
        open={!!bugToUnlink}
        title="Unlink bug"
        message={`Remove "${bugToUnlink?.title ?? ""}" from this test case? This only removes the link — the bug itself will not be deleted.`}
        confirmLabel="Unlink"
        loading={unlinkingBug}
        onConfirm={confirmUnlinkBug}
        onCancel={() => setBugToUnlink(null)}
      />

      {/* ───── Share Modal ───── */}
      <Modal
        open={showShare}
        onClose={() => setShowShare(false)}
        title="Share Test Run"
      >
        <div className="space-y-5">
          <p className="text-sm text-[var(--muted)]">
            Create a public link to share this test run&apos;s results with anyone &mdash; no login required.
          </p>
          {shareError && (
            <p className="rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error-foreground)]">
              {shareError}
            </p>
          )}

          {/* Toggle */}
          <div className="flex items-center justify-between rounded-lg border border-[var(--border)] p-4">
            <div>
              <p className="text-sm font-medium text-[var(--foreground)]">
                Public sharing
              </p>
              <p className="text-xs text-[var(--muted)] mt-0.5">
                {shareEnabled
                  ? "Anyone with the link can view this test run"
                  : "Sharing is currently disabled"}
              </p>
            </div>
            <button
              onClick={() => handleShareToggle(!shareEnabled)}
              disabled={shareToggling}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)] focus:ring-offset-2 ${
                shareEnabled
                  ? "bg-[var(--brand-primary)]"
                  : "bg-[var(--surface-tertiary)]"
              } ${shareToggling ? "opacity-50" : ""}`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  shareEnabled ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {/* Link display + copy */}
          {shareEnabled && shareToken && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  readOnly
                  value={getShareUrl()}
                  className="flex-1 bg-[var(--surface-secondary)] font-mono truncate"
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                />
                <Button
                  onClick={copyShareLink}
                  className={copied ? "!bg-green-600" : ""}
                >
                  {copied ? (
                    <span className="flex items-center gap-1">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Copied
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                      </svg>
                      Copy Link
                    </span>
                  )}
                </Button>
              </div>
              <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 p-3">
                <svg className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <p className="text-xs text-amber-800">
                  This link is publicly accessible. Anyone with it can view the test run results, execution statuses, and test case details. You can disable sharing at any time.
                </p>
              </div>
            </div>
          )}

          <div className="flex justify-end pt-2">
            <Button variant="secondary" onClick={() => setShowShare(false)}>
              Done
            </Button>
          </div>
        </div>
      </Modal>

      {/* ───── Test Case Detail Panel (right side) ───── */}
      <Drawer
        open={panelExecution !== null}
        onClose={closeExecutionPanel}
        title={
          panelExecution && (
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[15px] font-semibold text-[var(--foreground)]">
                  {panelExecution.title || panelExecution.snapshotTitle || "Untitled test case"}
                </h3>
                <StatusChip tone={statusToTone(panelExecution.status)}>{panelExecution.status}</StatusChip>
              </div>
              {panelExecution.externalId && (
                <p className="mt-0.5 font-mono text-[11px] text-[var(--muted-soft)]">{panelExecution.externalId}</p>
              )}
            </div>
          )
        }
      >
        {panelExecution && (
          <div className="flex h-full flex-col">
            <div className="flex-1 space-y-5 overflow-y-auto p-5">
              {/* Meta row */}
              <div className="flex flex-wrap items-center gap-4 text-[12.5px]">
                {panelExecution.priority ? <PriorityBadge priority={panelExecution.priority as Priority} /> : <span className="text-[var(--muted-soft)]">—</span>}
                <span className="text-[var(--muted)]">{panelExecution.type || "—"}</span>
                {panelExecution.assigneeId && memberNames[panelExecution.assigneeId] && (
                  <span className="flex items-center gap-1.5 text-[var(--muted)]">
                    <MemberAvatar name={memberNames[panelExecution.assigneeId]} seed={panelExecution.assigneeId} size={18} />
                    {memberNames[panelExecution.assigneeId]}
                  </span>
                )}
              </div>

              {/* Test case details */}
              <div className="space-y-4 text-[13px]">
                {panelExecution.description && (
                  <div>
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--muted)]">Description</p>
                    <p className="whitespace-pre-wrap text-[var(--foreground)]">{panelExecution.description}</p>
                  </div>
                )}
                {panelExecution.preconditions && (
                  <div>
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--muted)]">Preconditions</p>
                    <p className="whitespace-pre-wrap text-[var(--foreground)]">{panelExecution.preconditions}</p>
                  </div>
                )}
                {panelExecution.testData && (
                  <div>
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--muted)]">Test data</p>
                    <p className="whitespace-pre-wrap text-[var(--foreground)]">{panelExecution.testData}</p>
                  </div>
                )}
                {normalizeSteps(panelExecution.steps).length > 0 && (
                  <div>
                    <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--muted)]">Steps</p>
                    <ol className="space-y-2">
                      {normalizeSteps(panelExecution.steps).map((step, index) => (
                        <li key={`${step.action}-${index}`} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-3">
                          <p className="font-medium text-[var(--foreground)]">
                            {index + 1}. {step.action}
                          </p>
                          {step.expected && <p className="mt-1 text-[var(--muted)]">Expected: {step.expected}</p>}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                {!panelExecution.description && !panelExecution.preconditions && !panelExecution.testData && normalizeSteps(panelExecution.steps).length === 0 && (
                  <p className="text-[var(--muted)]">No additional test case details were captured for this execution.</p>
                )}
              </div>

              <div className="h-px bg-[var(--border)]" />

              {/*
                * Automation facts for this result — duration, retries and the framework's own
                * failure text. Renders nothing at all for a human-recorded result, so a manually
                * executed run's drawer is unchanged (Basecamp 10189985971).
                */}
              <AutomationResultMeta execution={panelExecution} />

              {/* Status picker */}
              <div>
                <label className="mb-2 block text-[12.5px] font-medium text-[var(--muted)]">Status</label>
                <div className="flex flex-wrap gap-2">
                  {EXEC_STATUSES.map((s) => {
                    const active = panelStatus === s;
                    const colors = PANEL_STATUS_COLORS[s] || PANEL_STATUS_COLORS.Untested;
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setPanelStatus(s)}
                        className={`rounded-lg border px-3 py-1.5 text-[12.5px] font-medium transition-colors ${active ? colors.active : colors.idle}`}
                      >
                        {s}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Assignee */}
              <div>
                <label className="mb-1 block text-[12.5px] font-medium text-[var(--muted)]">Assigned to</label>
                <Select value={panelAssigneeId} onChange={(e) => setPanelAssigneeId(e.target.value)} aria-label="Assigned to">
                  <option value="">Unassigned</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name || m.email}
                    </option>
                  ))}
                  {/* The current assignee may be someone this fetch didn't return — an AI agent
                      (executions can be assigned to Zyra outside this UI) or a project member row
                      that dropped out of `members` for some other reason. Surfacing it as a disabled
                      option keeps the true current value visible instead of silently defaulting to
                      "Unassigned", which would clear a real assignment on the next Save. */}
                  {panelAssigneeId && !members.some((m) => m.userId === panelAssigneeId) && (
                    <option value={panelAssigneeId} disabled>
                      {memberNames[panelAssigneeId] || "Unknown assignee"} (not a project member)
                    </option>
                  )}
                </Select>
              </div>

              {/* Actual result */}
              <div>
                <label className="mb-1 block text-[12.5px] font-medium text-[var(--muted)]">Actual Result / Notes</label>
                <Textarea
                  value={panelActualResult}
                  onChange={(e) => setPanelActualResult(e.target.value)}
                  rows={4}
                  placeholder="Describe what actually happened…"
                />
              </div>

              {/* Bug Key / Bug Title — shown only for a Failed case that also has at least one real
                  persisted bug association (panelBugs, loaded from bug_links via listBugs). Both
                  conditions matter: Failed alone does not imply a bug exists (only a successful
                  "Log bug" / "Link Bug" does), and a bug linked while the case was Failed must not
                  keep showing once the case is Untested/Passed/Skipped/Blocked/Retest. Read-only:
                  these reflect the real bug(s), not a free-text value typed here. One execution can
                  now have several bugs linked (multi-select existing-bug picker) — a single linked
                  bug keeps the original "Bug Key"/"Bug Title" labels; more than one numbers them
                  ("Bug 1 Key", "Bug 2 Key", …) so none is silently dropped. Every row gets its own
                  Unlink action regardless of count. */}
              <div className="space-y-3" hidden={panelStatus !== "Failed" || panelBugs.length === 0}>
                {panelBugs.map((bug, i) => {
                  const keyLabel = panelBugs.length > 1 ? `Bug ${i + 1} Key` : "Bug Key";
                  const titleLabel = panelBugs.length > 1 ? `Bug ${i + 1} Title` : "Bug Title";
                  return (
                    <div key={bug.id} className="grid grid-cols-[1fr_1fr_auto] gap-3 items-end">
                      <div>
                        <label className="mb-1 block text-[12.5px] font-medium text-[var(--muted)]">{keyLabel}</label>
                        <Input type="text" aria-label={keyLabel} value={bug.integrationIssueKey || bug.externalId || ""} readOnly placeholder="e.g. PROJ-123" />
                      </div>
                      <div>
                        <label className="mb-1 block text-[12.5px] font-medium text-[var(--muted)]">{titleLabel}</label>
                        <Input type="text" aria-label={titleLabel} value={bug.title || ""} readOnly placeholder="Title of the linked bug" />
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        aria-label={`Unlink ${bug.title}`}
                        onClick={() => requestUnlinkBug(bug)}
                      >
                        Unlink
                      </Button>
                    </div>
                  );
                })}
              </div>

              <div className="h-px bg-[var(--border)]" />

              {/*
                * Evidence. Keyed on the execution id so switching rows in the drawer remounts the
                * panel and refetches, rather than showing the previous result's files.
                */}
              <ExecutionEvidencePanel
                key={panelExecution.id}
                cycleId={cycleId}
                executionId={panelExecution.id}
                onCountChange={(count) =>
                  setExecutions((prev) =>
                    prev.map((e) => (e.id === panelExecution.id ? { ...e, evidenceCount: count } : e))
                  )
                }
              />
            </div>

            {/* Footer actions */}
            <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] p-4">
              <Button onClick={handlePanelSave} disabled={panelSaving}>
                {panelSaving ? "Saving…" : "Save"}
              </Button>
              <Button variant="secondary" onClick={() => openBugDialogFor(panelExecution)}>
                <IconBug size={14} />
                Log bug
              </Button>
              <Link
                href={`/projects/${projectId}/cycles/${cycleId}/execute/${panelExecution.id}`}
                className="ml-auto text-[12.5px] font-medium hover:underline"
                style={{ color: "var(--accent-light)" }}
              >
                Open full page
              </Link>
            </div>
          </div>
        )}
      </Drawer>
    </main>
  );
}
