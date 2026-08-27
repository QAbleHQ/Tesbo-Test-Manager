"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import {
  IconArrowRight,
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
  IconX,
} from "@tabler/icons-react";
import {
  authMe,
  getTestRun,
  updateTestRun,
  listCycleExecutions,
  updateExecution,
  addTestCasesToRun,
  removeTestCaseFromRun,
  removeTestCasesFromRun,
  listTestCases,
  listSuites,
  listProjectMembers,
  listPlans,
  getProject,
  toggleTestRunShare,
  createBug,
  addBugLink,
  listBugs,
  getJiraStatus,
  getLinearStatus,
  uploadBugAttachments,
  type TestRunDetail,
  type ExecutionItem,
  type TestCaseListItem,
  type SuiteNode,
  type BugItem,
  type BugSeverity,
  type BugPriority,
  type IssueSearchResult,
} from "@/lib/api";
import { Button, StatusChip, Input, PageLoader, Select, Textarea, Drawer } from "@/components/ui";
import Modal from "@/components/ui/Modal";
import IssuePickerModal from "@/components/IssuePickerModal";
import ExecutionEvidencePanel from "@/components/ExecutionEvidencePanel";
import { AutomationResultMeta, AutomationRunProvenance } from "@/components/AutomationResultMeta";
import TrackingDestinationField, { type TrackingDestination } from "@/components/TrackingDestinationField";
import SelfLoggedTrackerField, { type SelfLoggedSystem } from "@/components/SelfLoggedTrackerField";
import BugEvidenceField, { type EvidenceMode } from "@/components/BugEvidenceField";
import { useTopBarSlots } from "@/components/TopBarSlots";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7000";

/* ───── Constants ───── */
const EXEC_STATUSES = ["Untested", "Passed", "Failed", "Skipped", "Blocked", "Retest"] as const;
const RUN_TABS = ["All", "Passed", "Failed", "Blocked", "Skipped", "Pending"] as const;
/*
 * Basecamp 10226268634 ("The Log Bug UI should be consistent across both Test Run → Log Bug and Bug
 * Page → Log Bug"). This modal collected only a title, a description and evidence, so every bug
 * filed from a run landed on the severity column's 'Medium' default with no way to say otherwise —
 * while the same action from the Bugs page asked for severity (and now priority). Same fields, same
 * order, same wording as projects/[id]/bugs/page.tsx.
 */
const BUG_SEVERITIES: BugSeverity[] = ["Critical", "High", "Medium", "Low"];
const BUG_PRIORITIES: BugPriority[] = ["P0", "P1", "P2", "P3"];
type RunTab = (typeof RUN_TABS)[number];
const PAGE_SIZE = 10;
import { avatarColor } from "@/lib/avatarColors";

/* ───── Status tone helpers ───── */
function statusToTone(status: string) {
  const map: Record<string, "success" | "error" | "blocked" | "skipped" | "info" | "neutral"> = {
    Passed: "success",
    Failed: "error",
    Skipped: "skipped",
    Blocked: "blocked",
    Retest: "info",
    Untested: "neutral",
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

/* ───── Existing bug picker (for "link this failure to an already-existing Tesbo bug") ───── */
function ExistingBugPickerModal({
  projectId,
  open,
  onClose,
  onSelect,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onSelect: (bug: BugItem) => void;
}) {
  const [bugs, setBugs] = useState<BugItem[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setLoading(true);
    listBugs(projectId)
      .then(setBugs)
      .finally(() => setLoading(false));
  }, [open, projectId]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return bugs;
    return bugs.filter((bug) => bug.title.toLowerCase().includes(term));
  }, [bugs, search]);

  if (!open) return null;

  return (
    <Modal open={open} onClose={onClose} title="Link an existing bug" className="max-w-[520px]">
      <div className="space-y-3">
        <Input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search bugs by title…" />
        <div className="max-h-[320px] overflow-y-auto rounded-[var(--radius-control)] border border-[var(--border)]">
          {loading ? (
            <p className="p-3 text-[13px] text-[var(--muted)]">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="p-3 text-[13px] text-[var(--muted)]">No bugs found.</p>
          ) : (
            filtered.map((bug) => (
              <button
                key={bug.id}
                type="button"
                onClick={() => onSelect(bug)}
                className="flex w-full flex-col items-start gap-0.5 border-b border-[var(--border)] px-3 py-2 text-left last:border-b-0 hover:bg-[var(--surface-secondary)]"
              >
                <span className="text-[13px] font-medium text-[var(--foreground)]">{bug.title}</span>
                <span className="text-[12px] text-[var(--muted)]">{bug.status}</span>
              </button>
            ))
          )}
        </div>
        <div className="flex justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

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

/* ───── Priority / status color helpers ───── */
function priorityColor(priority: string): string {
  if (priority === "P0") return "var(--error-foreground)";
  if (priority === "P1") return "var(--warning-foreground)";
  if (priority === "P2") return "var(--info-foreground)";
  return "var(--muted-soft)";
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
    Retest: { border: "var(--info-border)", bg: "var(--info-soft)", color: "var(--info-foreground)" },
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
  const [loading, setLoading] = useState(true);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [planNames, setPlanNames] = useState<Record<string, string>>({});
  const [projectName, setProjectName] = useState("");

  /* test cases table: tab filter, search, pagination */
  const [activeTab, setActiveTab] = useState<RunTab>("All");
  const [tableSearch, setTableSearch] = useState("");
  const [page, setPage] = useState(1);

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

  /* right-side test case detail panel */
  const [panelExecution, setPanelExecution] = useState<ExecutionItem | null>(null);
  const [panelStatus, setPanelStatus] = useState("Untested");
  const [panelActualResult, setPanelActualResult] = useState("");
  const [panelDefectKey, setPanelDefectKey] = useState("");
  const [panelDefectUrl, setPanelDefectUrl] = useState("");
  const [panelSaving, setPanelSaving] = useState(false);

  /* sharing state */
  const [showShare, setShowShare] = useState(false);
  const [shareEnabled, setShareEnabled] = useState(false);
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [shareToggling, setShareToggling] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /* issue tracker connection status (gates the ticket-related dialog choices) */
  const [jiraConnected, setJiraConnected] = useState(false);
  const [linearConnected, setLinearConnected] = useState(false);

  /* bug report dialog state (triggered on "Failed") */
  const [showBugDialog, setShowBugDialog] = useState(false);
  const [bugExecution, setBugExecution] = useState<ExecutionItem | null>(null);
  const [bugTitle, setBugTitle] = useState("");
  const [bugSeverity, setBugSeverity] = useState<BugSeverity>("Medium");
  const [bugPriority, setBugPriority] = useState<BugPriority | "">("");
  const [bugDesc, setBugDesc] = useState("");
  const [bugAlreadyLogged, setBugAlreadyLogged] = useState(false);
  const [bugExistingChoice, setBugExistingChoice] = useState<"JIRA" | "LINEAR" | "TESBO">("TESBO");
  const [bugDestination, setBugDestination] = useState<TrackingDestination>("TESBO");
  const [bugSelfSystem, setBugSelfSystem] = useState<SelfLoggedSystem>("OTHER");
  const [bugUrl, setBugUrl] = useState("");
  const [bugIssue, setBugIssue] = useState<IssueSearchResult | null>(null);
  const [showBugIssuePicker, setShowBugIssuePicker] = useState(false);
  const [selectedExistingBug, setSelectedExistingBug] = useState<BugItem | null>(null);
  const [showExistingBugPicker, setShowExistingBugPicker] = useState(false);
  const [bugEvidenceMode, setBugEvidenceMode] = useState<EvidenceMode>("FILES");
  const [bugStagedFiles, setBugStagedFiles] = useState<File[]>([]);
  const [bugBetterbugsUrl, setBugBetterbugsUrl] = useState("");
  const [bugSaving, setBugSaving] = useState(false);
  const load = useCallback(() => {
    Promise.all([getTestRun(cycleId), listCycleExecutions(cycleId), getProject(projectId)])
      .then(([r, e, project]) => {
        setRun(r);
        setExecutions(e);
        setShareEnabled(r.shareEnabled ?? false);
        setShareToken(r.shareToken ?? null);
        setProjectName(String(project.name || ""));
      })
      .catch(() => router.replace(`/projects/${projectId}/cycles`))
      .finally(() => setLoading(false));
  }, [cycleId, projectId, router]);

  useEffect(() => {
    getJiraStatus(projectId).then((s) => setJiraConnected(s.connected)).catch(() => setJiraConnected(false));
    getLinearStatus(projectId).then((s) => setLinearConnected(s.connected)).catch(() => setLinearConnected(false));
  }, [projectId]);


  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      load();
      listProjectMembers(projectId)
        .then((members) => setMemberNames(Object.fromEntries(members.map((m) => [m.userId, m.name || m.email || "Unknown user"]))))
        .catch(() => {});
      listPlans(projectId)
        .then((plans) => setPlanNames(Object.fromEntries(plans.map((p) => [p.id, p.name]))))
        .catch(() => {});
    });
  }, [router, load, projectId]);

  /* reset to first page whenever the filter/search changes */
  useEffect(() => {
    setPage(1);
  }, [activeTab, tableSearch]);


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

  /* filtered available cases (not already added) */
  const filteredCases = useMemo(() => {
    return allCases.filter((tc) => {
      if (includedCaseIds.has(tc.id)) return false;
      if (filterSearch && !tc.title.toLowerCase().includes(filterSearch.toLowerCase()) && !tc.externalId.toLowerCase().includes(filterSearch.toLowerCase())) return false;
      if (filterPriority && tc.priority !== filterPriority) return false;
      if (filterType && tc.type !== filterType) return false;
      if (filterSuiteId && tc.suiteId !== filterSuiteId) return false;
      if (filterStatus && tc.status !== filterStatus) return false;
      return true;
    });
  }, [allCases, includedCaseIds, filterSearch, filterPriority, filterType, filterSuiteId, filterStatus]);

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

  /* ───── Prefill + open the bug dialog for a given execution ───── */
  function prepareBugDialog(exec: ExecutionItem, titlePrefix: string) {
    setBugExecution(exec);
    setBugTitle(`${titlePrefix}: ${exec.title || exec.snapshotTitle || "Untitled test case"}`);
    setBugDesc("");
    setBugSeverity("Medium");
    setBugPriority("");
    setBugAlreadyLogged(false);
    setBugExistingChoice(jiraConnected ? "JIRA" : linearConnected ? "LINEAR" : "TESBO");
    setBugDestination("TESBO");
    setBugSelfSystem(jiraConnected ? "JIRA" : linearConnected ? "LINEAR" : "OTHER");
    setBugUrl("");
    setBugIssue(null);
    setSelectedExistingBug(null);
    setBugEvidenceMode("FILES");
    setBugStagedFiles([]);
    setBugBetterbugsUrl("");
    setShowBugDialog(true);
  }

  /* ───── Quick "Log bug" row action — available regardless of status ───── */
  function openBugDialogFor(exec: ExecutionItem) {
    prepareBugDialog(exec, "Bug");
  }

  /* ───── Inline status change ───── */
  async function handleStatusChange(executionId: string, newStatus: string) {
    setStatusSaving(executionId);
    try {
      await updateExecution(cycleId, executionId, { status: newStatus });
      setExecutions((prev) =>
        prev.map((e) => (e.id === executionId ? { ...e, status: newStatus } : e))
      );

      if (newStatus === "Failed") {
        const exec = executions.find((e) => e.id === executionId);
        if (exec) prepareBugDialog({ ...exec, status: newStatus }, "Failed");
      }
    } finally {
      setStatusSaving(null);
    }
  }

  /* ───── Right-side test case detail panel ───── */
  function openExecutionPanel(exec: ExecutionItem) {
    setPanelExecution(exec);
    setPanelStatus(exec.status || "Untested");
    setPanelActualResult(exec.actualResult || "");
    setPanelDefectKey(exec.defectKey || "");
    setPanelDefectUrl(exec.defectUrl || "");
  }

  function closeExecutionPanel() {
    setPanelExecution(null);
  }

  async function handlePanelSave() {
    if (!panelExecution) return;
    setPanelSaving(true);
    try {
      await updateExecution(cycleId, panelExecution.id, {
        status: panelStatus,
        actualResult: panelActualResult,
        defectKey: panelDefectKey || undefined,
        defectUrl: panelDefectUrl || undefined,
      });
      setExecutions((prev) =>
        prev.map((e) =>
          e.id === panelExecution.id
            ? { ...e, status: panelStatus, actualResult: panelActualResult, defectKey: panelDefectKey, defectUrl: panelDefectUrl }
            : e
        )
      );
      const wasFailed = panelExecution.status === "Failed";
      closeExecutionPanel();
      if (panelStatus === "Failed" && !wasFailed) {
        prepareBugDialog({ ...panelExecution, status: panelStatus }, "Failed");
      }
    } finally {
      setPanelSaving(false);
    }
  }

  /* ───── Reset & close the bug dialog ───── */
  function resetBugDialog() {
    setShowBugDialog(false);
    setBugExecution(null);
    setBugTitle("");
    setBugSeverity("Medium");
    setBugPriority("");
    setBugDesc("");
    setBugAlreadyLogged(false);
    setBugExistingChoice(jiraConnected ? "JIRA" : linearConnected ? "LINEAR" : "TESBO");
    setBugDestination("TESBO");
    setBugSelfSystem(jiraConnected ? "JIRA" : linearConnected ? "LINEAR" : "OTHER");
    setBugUrl("");
    setBugIssue(null);
    setSelectedExistingBug(null);
    setBugEvidenceMode("FILES");
    setBugStagedFiles([]);
    setBugBetterbugsUrl("");
  }

  /* ───── Submit bug from dialog (new bug, optionally noting where it's tracked elsewhere) ───── */
  async function handleBugSubmit() {
    if (!bugExecution || !bugTitle.trim() || !bugSeverity) return;
    const selfLogged = (jiraConnected || linearConnected) && bugDestination === "SELF";
    setBugSaving(true);
    try {
      const bug = await createBug(projectId, {
        title: bugTitle.trim(),
        description: bugDesc.trim(),
        severity: bugSeverity,
        priority: bugPriority || null,
        externalUrl: selfLogged ? bugUrl.trim() : undefined,
        integrationProvider: selfLogged && bugSelfSystem !== "OTHER" ? bugSelfSystem : null,
        integrationIssueKey: null,
        betterbugsUrl: bugEvidenceMode === "BETTERBUGS" ? bugBetterbugsUrl.trim() : undefined,
        links: [{ testcaseId: bugExecution.testcaseId, cycleId, executionId: bugExecution.id }],
      });
      if (bugEvidenceMode === "FILES" && bugStagedFiles.length) {
        await uploadBugAttachments(projectId, bug.id, bugStagedFiles);
      }
      resetBugDialog();
      load();
    } finally {
      setBugSaving(false);
    }
  }

  /* ───── Link this failing execution to an already-existing Tesbo bug (backtrace) ───── */
  async function handleLinkExistingBug() {
    if (!bugExecution || !selectedExistingBug) return;
    setBugSaving(true);
    try {
      await addBugLink(selectedExistingBug.id, { testcaseId: bugExecution.testcaseId, cycleId, executionId: bugExecution.id });
      resetBugDialog();
      load();
    } finally {
      setBugSaving(false);
    }
  }

  function handleBugSkip() {
    resetBugDialog();
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

  // null (rendered as "—") for a run with zero cases, so an empty run is never shown as a
  // misleading "0% pass rate" — mirrors the Test Runs list summary tile's zero-case handling.
  const passRate = stats.total ? Math.round((stats.passed / stats.total) * 100) : null;

  /* ───── Test cases table: tab counts, filter, search, pagination ───── */
  const tabCounts = useMemo(() => {
    const counts: Partial<Record<RunTab, number>> = {};
    for (const e of executions) {
      const bucket: RunTab = e.status === "Untested" || e.status === "Retest" ? "Pending" : (e.status as RunTab);
      counts[bucket] = (counts[bucket] || 0) + 1;
    }
    return counts;
  }, [executions]);

  const filteredExecutions = useMemo(() => {
    let list = executions;
    if (activeTab !== "All") {
      list = list.filter((e) => (activeTab === "Pending" ? e.status === "Untested" || e.status === "Retest" : e.status === activeTab));
    }
    const term = tableSearch.trim().toLowerCase();
    if (term) {
      list = list.filter(
        (e) =>
          (e.title || e.snapshotTitle || "").toLowerCase().includes(term) ||
          (e.externalId || "").toLowerCase().includes(term)
      );
    }
    return list;
  }, [executions, activeTab, tableSearch]);

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
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[12px]">
              {projectName && (
                <>
                  <button
                    type="button"
                    onClick={() => router.push("/projects")}
                    className="truncate text-[var(--muted-soft)] transition-colors hover:text-[var(--accent-light)]"
                  >
                    {projectName}
                  </button>
                  <IconChevronRight size={12} stroke={1.75} className="shrink-0 text-[var(--muted-soft)]" />
                </>
              )}
              <button
                type="button"
                onClick={() => router.push(`/projects/${projectId}/cycles`)}
                className="shrink-0 text-[var(--muted-soft)] transition-colors hover:text-[var(--accent-light)]"
              >
                Test Runs
              </button>
              <IconChevronRight size={12} stroke={1.75} className="shrink-0 text-[var(--muted-soft)]" />
              <span className="truncate font-medium text-[var(--accent-light)]">{run.name}</span>
            </nav>,
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

                <div className="min-w-[160px] flex-1">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[12px] text-[var(--muted-soft)]">Progress</span>
                    <span className="text-[12px] font-semibold" style={{ color: "var(--success-foreground)" }}>
                      {passRate !== null ? `${passRate}% pass rate` : "No cases executed yet"}
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
                    <th className="px-5 py-2.5 font-semibold">ID</th>
                    <th className="px-5 py-2.5 font-semibold">Test Case</th>
                    <th className="px-5 py-2.5 font-semibold">Priority</th>
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
                          <span className="inline-flex items-center gap-1.5">
                            <span className="h-1.5 w-1.5 rounded-full" style={{ background: priorityColor(e.priority) }} />
                            <span className="font-mono text-[11.5px] font-semibold" style={{ color: priorityColor(e.priority) }}>
                              {e.priority || "—"}
                            </span>
                          </span>
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
                              <select
                                value={e.status}
                                onChange={(ev) => handleStatusChange(e.id, ev.target.value)}
                                disabled={statusSaving === e.id}
                                className="h-7 cursor-pointer rounded-[6px] border px-2 text-[11.5px] font-medium outline-none"
                                style={execSelectStyle(e.status)}
                              >
                                {EXEC_STATUSES.map((s) => (
                                  <option key={s} value={s} style={EXEC_OPTION_STYLE}>
                                    {s}
                                  </option>
                                ))}
                              </select>
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
                        <td className="px-3 py-2 text-xs text-[var(--muted)]">{tc.priority}</td>
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

      {/* ───── Bug Report Modal (triggered on Failed) ───── */}
      <Modal
        open={showBugDialog}
        onClose={handleBugSkip}
        title="Report a Bug"
      >
        <div className="space-y-4">
          {/* Themed rather than the literal red-50/red-200 these carried: in dark mode that pale
              block stayed light while its text followed the theme, which is the same mismatch the
              danger Button variant was fixed for. */}
          <div className="flex items-start gap-2 rounded-lg border border-[var(--error-border)] bg-[var(--error-soft)] p-3">
            <svg className="w-5 h-5 text-[var(--status-fail-text)] mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-[var(--status-fail-text)]">Test case marked as Failed</p>
              <p className="text-xs text-[var(--status-fail-text)] opacity-80 mt-0.5">
                {bugExecution?.externalId && <span className="font-mono mr-1">{bugExecution.externalId}</span>}
                {bugExecution?.title || bugExecution?.snapshotTitle || "Untitled test case"}
              </p>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--muted)] mb-1">
              Is this defect already logged?
            </label>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={!bugAlreadyLogged ? "primary" : "secondary"}
                onClick={() => setBugAlreadyLogged(false)}
              >
                No, log a new one
              </Button>
              <Button
                type="button"
                size="sm"
                variant={bugAlreadyLogged ? "primary" : "secondary"}
                onClick={() => setBugAlreadyLogged(true)}
              >
                Yes, link existing
              </Button>
            </div>
          </div>

          {bugAlreadyLogged && (
            <div className="flex flex-wrap gap-2">
              {jiraConnected && (
                <Button
                  type="button"
                  size="sm"
                  variant={bugExistingChoice === "JIRA" ? "primary" : "secondary"}
                  onClick={() => { setBugExistingChoice("JIRA"); setBugIssue(null); }}
                >
                  Jira ticket
                </Button>
              )}
              {linearConnected && (
                <Button
                  type="button"
                  size="sm"
                  variant={bugExistingChoice === "LINEAR" ? "primary" : "secondary"}
                  onClick={() => { setBugExistingChoice("LINEAR"); setBugIssue(null); }}
                >
                  Linear ticket
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant={bugExistingChoice === "TESBO" ? "primary" : "secondary"}
                onClick={() => setBugExistingChoice("TESBO")}
              >
                Existing Tesbo bug
              </Button>
            </div>
          )}

          {bugAlreadyLogged && bugExistingChoice === "TESBO" ? (
            <div>
              <label className="block text-sm font-medium text-[var(--muted)] mb-1">Bug</label>
              {selectedExistingBug ? (
                <div className="flex items-center justify-between rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-1.5 text-[13px]">
                  <span className="font-medium text-[var(--foreground)]">{selectedExistingBug.title}</span>
                  <button type="button" onClick={() => setSelectedExistingBug(null)} className="text-[var(--muted)] hover:text-[var(--error-foreground)]">
                    ✕
                  </button>
                </div>
              ) : (
                <Button type="button" variant="secondary" size="sm" onClick={() => setShowExistingBugPicker(true)}>
                  Choose an existing bug…
                </Button>
              )}
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-[var(--muted)] mb-1">
                  Bug Title <span className="text-[var(--error-foreground)]">*</span>
                </label>
                <Input
                  type="text"
                  value={bugTitle}
                  onChange={(e) => setBugTitle(e.target.value)}
                  placeholder="Brief summary of the bug…"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--muted)] mb-1">
                  Description
                </label>
                <Textarea
                  value={bugDesc}
                  onChange={(e) => setBugDesc(e.target.value)}
                  rows={3}
                  placeholder="Steps to reproduce, expected vs actual behavior…"
                />
              </div>
              {/*
                * Severity carries dev's required marker (48363ea/10226268634 — the run's modal used
                * to collect no severity at all, so every bug filed from a run took the column
                * default), paired with Priority from 10226247009. Evidence keeps its own full-width
                * row below rather than sharing the grid with Severity: three controls do not fit two
                * columns, and the file list needs the width.
                */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-[var(--muted)] mb-1">
                    Severity <span className="text-[var(--error-foreground)]">*</span>
                  </label>
                  <Select
                    value={bugSeverity}
                    onChange={(e) => setBugSeverity(e.target.value as BugSeverity)}
                    aria-label="Severity"
                  >
                    {BUG_SEVERITIES.map((severity) => (
                      <option key={severity} value={severity}>
                        {severity}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--muted)] mb-1">Priority</label>
                  <Select
                    value={bugPriority}
                    onChange={(e) => setBugPriority(e.target.value as BugPriority | "")}
                    aria-label="Bug priority"
                  >
                    <option value="">Not set</option>
                    {BUG_PRIORITIES.map((priority) => (
                      <option key={priority} value={priority}>
                        {priority}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
              <BugEvidenceField
                mode={bugEvidenceMode}
                onModeChange={setBugEvidenceMode}
                stagedFiles={bugStagedFiles}
                onStagedFilesChange={setBugStagedFiles}
                betterbugsUrl={bugBetterbugsUrl}
                onBetterbugsUrlChange={setBugBetterbugsUrl}
              />
              {bugAlreadyLogged ? (
                <div>
                  <label className="block text-sm font-medium text-[var(--muted)] mb-1">Ticket</label>
                  {bugIssue ? (
                    <div className="flex items-center justify-between rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-1.5 text-[13px]">
                      <span className="font-medium text-[var(--foreground)]">{bugIssue.key} — {bugIssue.summary}</span>
                      <button type="button" onClick={() => setBugIssue(null)} className="text-[var(--muted)] hover:text-[var(--error-foreground)]">
                        ✕
                      </button>
                    </div>
                  ) : (
                    <Button type="button" variant="secondary" size="sm" onClick={() => setShowBugIssuePicker(true)}>
                      Search {bugExistingChoice === "JIRA" ? "Jira" : "Linear"} tickets…
                    </Button>
                  )}
                </div>
              ) : (
                (jiraConnected || linearConnected) && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-[var(--muted)] mb-1">
                        Where should this be tracked?
                      </label>
                      <TrackingDestinationField destination={bugDestination} onChange={setBugDestination} />
                    </div>
                    {bugDestination === "SELF" && (
                      <SelfLoggedTrackerField
                        jiraConnected={jiraConnected}
                        linearConnected={linearConnected}
                        system={bugSelfSystem}
                        onSystemChange={setBugSelfSystem}
                        url={bugUrl}
                        onUrlChange={setBugUrl}
                      />
                    )}
                  </>
                )
              )}
            </>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={handleBugSkip}>
              Skip
            </Button>
            {bugAlreadyLogged && bugExistingChoice === "TESBO" ? (
              <Button
                variant="destructive"
                onClick={handleLinkExistingBug}
                disabled={bugSaving || !selectedExistingBug}
              >
                {bugSaving ? "Linking…" : "Link Bug"}
              </Button>
            ) : (
              <Button
                variant="destructive"
                onClick={handleBugSubmit}
                disabled={bugSaving || !bugTitle.trim() || !bugSeverity}
              >
                {bugSaving ? (
                  "Filing…"
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                    </svg>
                    File Bug
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </Modal>

      <IssuePickerModal
        projectId={projectId}
        open={showBugIssuePicker}
        onClose={() => setShowBugIssuePicker(false)}
        onSelect={(issue) => {
          setBugIssue(issue);
          setShowBugIssuePicker(false);
        }}
      />

      <ExistingBugPickerModal
        projectId={projectId}
        open={showExistingBugPicker}
        onClose={() => setShowExistingBugPicker(false)}
        onSelect={(bug) => {
          setSelectedExistingBug(bug);
          setShowExistingBugPicker(false);
        }}
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
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: priorityColor(panelExecution.priority) }} />
                  <span className="font-mono font-semibold" style={{ color: priorityColor(panelExecution.priority) }}>
                    {panelExecution.priority || "—"}
                  </span>
                </span>
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

              {/* Defect key/url — Failed only (Basecamp 10221790207). Same rule as the full-page
                  execute screen: a defect reference on a passing case ends up in the export and the
                  traceability matrix, so the backend clears it when a non-Failed status is saved. */}
              <div className="space-y-3" hidden={panelStatus !== "Failed"}>
                <div>
                  <label className="mb-1 block text-[12.5px] font-medium text-[var(--muted)]">Defect Key</label>
                  <Input type="text" value={panelDefectKey} onChange={(e) => setPanelDefectKey(e.target.value)} placeholder="e.g. PROJ-123" />
                </div>
                <div>
                  <label className="mb-1 block text-[12.5px] font-medium text-[var(--muted)]">Defect URL</label>
                  <Input type="url" value={panelDefectUrl} onChange={(e) => setPanelDefectUrl(e.target.value)} placeholder="https://…" />
                </div>
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
