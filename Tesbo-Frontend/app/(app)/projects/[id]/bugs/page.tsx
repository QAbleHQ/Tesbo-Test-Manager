"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback, useMemo } from "react";
import { IconPencil, IconTrash } from "@tabler/icons-react";
import {
  authMe,
  listBugs,
  createBug,
  updateBug,
  deleteBug,
  getJiraStatus,
  getLinearStatus,
  uploadBugAttachments,
  deleteBugAttachment,
  getBugAttachmentDownloadUrl,
  listTestRuns,
  listProjectMembers,
  getProject,
  type BugItem,
  type BugAttachment,
  type BugSeverity,
  type BugPriority,
} from "@/lib/api";
import {
  Button,
  Card,
  Input,
  Field,
  FieldLabel,
  Modal,
  PageLoader,
  Textarea,
  Select,
  StatusChip,
  PriorityBadge,
  SeverityBadge,
} from "@/components/ui";
import { PageHeader, ListWorkspaceLayout, Breadcrumbs } from "@/components/workflows";
import { avatarColor } from "@/lib/avatarColors";
import TestCaseRunPicker, { type LinkRow } from "@/components/TestCaseRunPicker";
import TrackingDestinationField, { type TrackingDestination } from "@/components/TrackingDestinationField";
import SelfLoggedTrackerField, { type SelfLoggedSystem } from "@/components/SelfLoggedTrackerField";
import BugEvidenceField, { type EvidenceMode } from "@/components/BugEvidenceField";

type ViewMode = "kanban" | "list";

const BUG_STATUSES = ["Open", "In Progress", "Reopened", "Closed"] as const;
const BUG_SEVERITIES: BugSeverity[] = ["Critical", "High", "Medium", "Low"];
/*
 * Basecamp 10226247009 — severity says how bad the defect is, priority says how soon it is worked
 * on. P0..P3 mirrors how test cases already express priority and stays visually distinct from
 * severity's words, so a row reading "Critical · P3" is unambiguous. Empty means untriaged.
 */
const BUG_PRIORITIES: BugPriority[] = ["P0", "P1", "P2", "P3"];

function BugPriorityBadge({ priority }: { priority: BugPriority | null }) {
  if (!priority) return <span className="text-xs text-[var(--muted-soft)]">—</span>;
  return <PriorityBadge priority={priority} />;
}

/* ───── Assignee avatar ─────
 * Seeded on the assignee's id, not their name, matching the same convention used for executions
 * (cycles/[cycleId]/page.tsx) so a person keeps the same colour everywhere they're shown assigned.
 */
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

function MemberAvatar({ name, seed, size = 20 }: { name: string; seed?: string | null; size?: number }) {
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

function BugAssignee({ id, name }: { id: string | null; name: string | null }) {
  if (!id) return <span className="text-xs text-[var(--muted-soft)]">Unassigned</span>;
  // Assigned, but the join in bugSelect turned up no actor_profiles row (a deleted actor). Still a
  // real assignment — distinct from Unassigned — just with nothing to render a name or colour from.
  if (!name) return <span className="text-xs text-[var(--muted-soft)]">Unknown assignee</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <MemberAvatar name={name} seed={id} size={20} />
      <span className="text-xs text-[var(--muted)] truncate max-w-[120px]" title={name}>
        {name}
      </span>
    </span>
  );
}
const PAGE_SIZE = 15;

const STATUS_TONE: Record<string, "error" | "success" | "info" | "warning"> = {
  Open: "error",
  Closed: "success",
  "In Progress": "info",
  Reopened: "warning",
};

const STATUS_COLOR: Record<string, string> = {
  Open: "var(--error)",
  "In Progress": "var(--info)",
  Reopened: "var(--warning)",
  Closed: "var(--success)",
};

/* ───── Status badge ───── */
function BugStatusBadge({ status }: { status: string }) {
  return (
    <StatusChip tone={STATUS_TONE[status] || "error"}>{status}</StatusChip>
  );
}

/* ───── Severity badge ───── */
function BugSeverityBadge({ severity }: { severity: BugSeverity }) {
  return <SeverityBadge severity={severity} />;
}

/* ───── View toggle buttons ───── */
function ViewToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
}) {
  return (
    <div className="flex items-center rounded-lg border border-[var(--border-subtle)] overflow-hidden">
      <button
        onClick={() => onChange("kanban")}
        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${
          mode === "kanban"
            ? "bg-[var(--brand-primary)] text-white"
            : "bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--surface-raised)]"
        }`}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
        </svg>
        Board
      </button>
      <button
        onClick={() => onChange("list")}
        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-l border-[var(--border-subtle)] ${
          mode === "list"
            ? "bg-[var(--brand-primary)] text-white"
            : "bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--surface-raised)]"
        }`}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
        </svg>
        List
      </button>
    </div>
  );
}

/* ───── Kanban card ───── */
function KanbanCard({
  bug,
  onView,
  onEdit,
  onDelete,
}: {
  bug: BugItem;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onView}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onView();
        }
      }}
      className="group bg-[var(--surface)] border border-[var(--border-subtle)] rounded-lg p-3 cursor-pointer hover:border-[var(--brand-primary)]/40 hover:shadow-sm transition-all"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <h4 className="text-sm font-medium text-[var(--foreground)] leading-snug line-clamp-2 break-words">
          {bug.title}
        </h4>
        {/*
          * Same defect as the List view's row actions (Basecamp 10226234070 / 10218564160): a
          * 14px glyph in a ~22px box is a hairline nobody can reliably click. Matches the List
          * view's fix — ghost Button, 18px icon, 32px box, aria-labels, distinct destructive
          * colour — plus focus-within so the actions are reachable by keyboard, not just hover.
          */}
        <div
          role="presentation"
          className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="icon"
            onClick={onEdit}
            className="text-[var(--muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--accent-light)]"
            title="Edit bug"
            aria-label="Edit bug"
          >
            <IconPencil size={18} stroke={1.75} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onDelete}
            className="text-[var(--status-fail-text)] hover:bg-[var(--error-soft)] hover:text-[var(--status-fail-text)]"
            title="Delete bug"
            aria-label="Delete bug"
          >
            <IconTrash size={18} stroke={1.75} />
          </Button>
        </div>
      </div>

      {bug.description && (
        <p className="text-xs text-[var(--muted)] line-clamp-2 mb-2">
          {bug.description}
        </p>
      )}

      <div className="mb-2">
        <BugSeverityBadge severity={bug.severity} />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {bug.links.slice(0, 2).map((link) => (
          <span
            key={link.id}
            className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--surface-raised)] text-[var(--muted-soft)]"
          >
            {link.testcaseExternalId || link.testcaseTitle}
          </span>
        ))}
        {bug.links.length > 2 && (
          <span className="text-[10px] text-[var(--muted-soft)]">+{bug.links.length - 2} more</span>
        )}
        {bug.externalUrl && (
          <a
            href={bug.externalUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-[10px] text-[var(--accent-light)] hover:underline truncate max-w-[120px]"
            title={bug.externalUrl}
          >
            Link
          </a>
        )}
      </div>

      <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-[var(--border-subtle)]">
        <span className="text-[10px] text-[var(--muted-soft)]">
          {bug.reporterName || bug.reporterEmail || "Unknown"}
        </span>
        <div className="flex items-center gap-1.5">
          {bug.assigneeId && bug.assigneeName && <MemberAvatar name={bug.assigneeName} seed={bug.assigneeId} size={16} />}
          <span className="text-[10px] text-[var(--muted-soft)]">
            {new Date(bug.createdAt).toLocaleDateString()}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ───── Kanban column ───── */
function KanbanColumn({
  status,
  bugs,
  onView,
  onEdit,
  onDelete,
}: {
  status: string;
  bugs: BugItem[];
  onView: (b: BugItem) => void;
  onEdit: (b: BugItem) => void;
  onDelete: (id: string) => void;
}) {
  const color = STATUS_COLOR[status] || "var(--muted)";

  return (
    <div className="flex flex-col min-w-[280px] w-[280px] shrink-0">
      <div className="flex items-center gap-2 mb-3 px-1">
        <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
        <h3 className="text-sm font-semibold text-[var(--foreground)]">{status}</h3>
        <span className="ml-auto text-xs font-medium text-[var(--muted)] bg-[var(--surface-raised)] px-1.5 py-0.5 rounded-full">
          {bugs.length}
        </span>
      </div>
      <div className="flex flex-col gap-2 flex-1 overflow-y-auto max-h-[calc(100vh-280px)] pr-1 pb-4 custom-scrollbar">
        {bugs.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-xs text-[var(--muted-soft)] border border-dashed border-[var(--border-subtle)] rounded-lg">
            No bugs
          </div>
        ) : (
          bugs.map((b) => (
            <KanbanCard
              key={b.id}
              bug={b}
              onView={() => onView(b)}
              onEdit={() => onEdit(b)}
              onDelete={() => onDelete(b.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

/* ───── Pagination controls ───── */
function Pagination({
  page,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (p: number) => void;
}) {
  if (totalPages <= 1) return null;

  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalItems);

  const pages: (number | "...")[] = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    pages.push(1);
    if (page > 3) pages.push("...");
    for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) {
      pages.push(i);
    }
    if (page < totalPages - 2) pages.push("...");
    pages.push(totalPages);
  }

  return (
    <div className="flex items-center justify-between px-1 pt-4">
      <span className="text-xs text-[var(--muted-soft)]">
        {start}–{end} of {totalItems}
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page === 1}
          className="p-1.5 rounded text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--surface-raised)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        {pages.map((p, i) =>
          p === "..." ? (
            <span key={`ellipsis-${i}`} className="px-1 text-xs text-[var(--muted-soft)]">
              ...
            </span>
          ) : (
            <button
              key={p}
              onClick={() => onPageChange(p)}
              className={`min-w-[28px] h-7 rounded text-xs font-medium transition-colors ${
                p === page
                  ? "bg-[var(--brand-primary)] text-white"
                  : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--surface-raised)]"
              }`}
            >
              {p}
            </button>
          )
        )}
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page === totalPages}
          className="p-1.5 rounded text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--surface-raised)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════ MAIN PAGE ═══════════════════ */
export default function BugsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [bugs, setBugs] = useState<BugItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState("");
  /*
   * Basecamp 10226242373 ("Severity filter is missing"). Severity is a first-class field — it has its
   * own column, its own badge and its own index on the table — but the only filter was status. Like
   * the status filter it is shown in BOTH views, since `filtered` below feeds the board's columns as
   * well as the list rows: a filter that applies everywhere needs a control that is visible
   * everywhere.
   */
  const [filterSeverity, setFilterSeverity] = useState("");
  const [filterPriority, setFilterPriority] = useState("");
  /* "" = everyone, "unassigned" = no assignee, otherwise a user id. A sentinel string rather than
     null/"" for "unassigned" because "" already means "no filter" — the two have to stay distinct. */
  const [filterAssignee, setFilterAssignee] = useState("");
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("kanban");
  const [page, setPage] = useState(1);

  /* issue tracker connection status (gates the Tesbo-vs-self choice) */
  const [jiraConnected, setJiraConnected] = useState(false);
  const [linearConnected, setLinearConnected] = useState(false);

  /* whether the project has any test runs to link a bug to — the link picker is only
     mandatory when there's actually something to pick, so reporting a bug is never blocked
     in a project that has no test runs yet */
  const [hasTestRuns, setHasTestRuns] = useState(false);
  const [members, setMembers] = useState<{ userId: string; email: string; name: string }[]>([]);
  const [projectName, setProjectName] = useState("");

  /* create modal */
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [createPriority, setCreatePriority] = useState<BugPriority | "">("");
  const [createSeverity, setCreateSeverity] = useState<BugSeverity>("Medium");
  const [createLinks, setCreateLinks] = useState<LinkRow[]>([]);
  const [createDestination, setCreateDestination] = useState<TrackingDestination>("TESBO");
  const [createSelfSystem, setCreateSelfSystem] = useState<SelfLoggedSystem>("OTHER");
  const [createUrl, setCreateUrl] = useState("");
  const [createEvidenceMode, setCreateEvidenceMode] = useState<EvidenceMode>("FILES");
  const [createStagedFiles, setCreateStagedFiles] = useState<File[]>([]);
  const [createBetterbugsUrl, setCreateBetterbugsUrl] = useState("");
  const [createAssigneeId, setCreateAssigneeId] = useState("");
  const [creating, setCreating] = useState(false);

  /* edit modal */
  const [editBug, setEditBug] = useState<BugItem | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editPriority, setEditPriority] = useState<BugPriority | "">("");
  const [editSeverity, setEditSeverity] = useState<BugSeverity>("Medium");
  const [editLinks, setEditLinks] = useState<LinkRow[]>([]);
  const [editDestination, setEditDestination] = useState<TrackingDestination>("TESBO");
  const [editSelfSystem, setEditSelfSystem] = useState<SelfLoggedSystem>("OTHER");
  const [editUrl, setEditUrl] = useState("");
  const [editEvidenceMode, setEditEvidenceMode] = useState<EvidenceMode>("FILES");
  const [editStagedFiles, setEditStagedFiles] = useState<File[]>([]);
  const [editAttachments, setEditAttachments] = useState<BugAttachment[]>([]);
  const [editBetterbugsUrl, setEditBetterbugsUrl] = useState("");
  const [editStatus, setEditStatus] = useState("");
  const [editAssigneeId, setEditAssigneeId] = useState("");
  const [saving, setSaving] = useState(false);
  /*
   * Basecamp 10226296533: createBug/updateBug succeeded, uploadBugAttachments then threw, and the
   * throw went nowhere — `finally` cleared the spinner but the modal stayed open unchanged with no
   * reason shown, which is what "stuck on Saving" looked like from the outside. The server's
   * message (unsupported type, over the size limit, storage allowance exhausted) is worth showing
   * verbatim: it names the file.
   */
  const [createError, setCreateError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  /* detail view modal */
  const [viewBug, setViewBug] = useState<BugItem | null>(null);

  /* delete confirm */
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(() => {
    listBugs(projectId)
      .then(setBugs)
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

  useEffect(() => {
    getJiraStatus(projectId).then((s) => setJiraConnected(s.connected)).catch(() => setJiraConnected(false));
    getLinearStatus(projectId).then((s) => setLinearConnected(s.connected)).catch(() => setLinearConnected(false));
    listTestRuns(projectId).then((runs) => setHasTestRuns(runs.length > 0)).catch(() => setHasTestRuns(false));
    listProjectMembers(projectId).then(setMembers).catch(() => {});
    getProject(projectId).then((p) => setProjectName(String(p.name || ""))).catch(() => setProjectName(""));
  }, [projectId]);

  /* filtered list */
  const filtered = useMemo(() => {
    const term = search.toLowerCase();
    return bugs.filter((b) => {
      if (filterStatus && b.status !== filterStatus) return false;
      if (filterSeverity && b.severity !== filterSeverity) return false;
      if (filterPriority && b.priority !== filterPriority) return false;
      if (filterAssignee === "unassigned" && b.assigneeId) return false;
      if (filterAssignee && filterAssignee !== "unassigned" && b.assigneeId !== filterAssignee) return false;
      if (
        term &&
        !b.title.toLowerCase().includes(term) &&
        !b.links.some(
          (link) =>
            link.testcaseTitle?.toLowerCase().includes(term) ||
            link.testcaseExternalId?.toLowerCase().includes(term)
        )
      )
        return false;
      return true;
    });
  }, [bugs, filterStatus, filterSeverity, filterPriority, filterAssignee, search]);

  const hasActiveFilters = Boolean(
    search.trim() || filterStatus || filterSeverity || filterPriority || filterAssignee
  );

  function clearFilters() {
    setSearch("");
    setFilterStatus("");
    setFilterSeverity("");
    setFilterPriority("");
    setFilterAssignee("");
  }

  /* Options for the "Assign to" filter: every project member, plus any bug's current assignee who
     has since left the project (or is an AI agent, never a member to begin with) — otherwise
     filtering to that person would offer no way to select them. */
  const assigneeFilterOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const m of members) seen.set(m.userId, m.name || m.email);
    for (const b of bugs) {
      if (b.assigneeId && !seen.has(b.assigneeId)) seen.set(b.assigneeId, b.assigneeName || "Unknown assignee");
    }
    return Array.from(seen.entries());
  }, [members, bugs]);

  /* reset page when filters change */
  useEffect(() => {
    setPage(1);
  }, [filterStatus, filterSeverity, filterAssignee, search, viewMode]);

  /* paginated list for list view */
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginatedBugs = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  /* kanban grouped data */
  const kanbanColumns = useMemo(() => {
    return BUG_STATUSES.map((status) => ({
      status,
      bugs: filtered.filter((b) => b.status === status),
    }));
  }, [filtered]);

  /*
   * Header stats must match the board's own per-status columns below them — the board treats
   * "Open" and "Reopened" as distinct columns, so the header's "open" count previously summing
   * both (Open + Reopened) showed a number no column on the board actually displayed.
   */
  const openCount = bugs.filter((b) => b.status === "Open").length;
  const closedCount = bugs.filter((b) => b.status === "Closed").length;

  /* reset create modal state */
  function resetCreate() {
    setShowCreate(false);
    setCreateError(null);
    setCreateTitle("");
    setCreateDesc("");
    setCreateSeverity("Medium");
    setCreatePriority("");
    setCreateLinks([]);
    setCreateDestination("TESBO");
    setCreateSelfSystem(jiraConnected ? "JIRA" : linearConnected ? "LINEAR" : "OTHER");
    setCreateUrl("");
    setCreateEvidenceMode("FILES");
    setCreateStagedFiles([]);
    setCreateBetterbugsUrl("");
    setCreateAssigneeId("");
  }

  /* create */
  async function handleCreate() {
    if (!createTitle.trim() || (hasTestRuns && !createLinks.length)) return;
    const selfLogged = (jiraConnected || linearConnected) && createDestination === "SELF";
    setCreating(true);
    setCreateError(null);
    try {
      const bug = await createBug(projectId, {
        title: createTitle.trim(),
        description: createDesc.trim(),
        severity: createSeverity,
        priority: createPriority || null,
        assigneeId: createAssigneeId || null,
        externalUrl: selfLogged ? createUrl.trim() : undefined,
        integrationProvider: selfLogged && createSelfSystem !== "OTHER" ? createSelfSystem : null,
        integrationIssueKey: null,
        betterbugsUrl: createEvidenceMode === "BETTERBUGS" ? createBetterbugsUrl.trim() : undefined,
        links: createLinks.map((link) => ({
          testcaseId: link.testcaseId,
          cycleId: link.cycleId,
          executionId: link.executionId,
        })),
      });
      if (createEvidenceMode === "FILES" && createStagedFiles.length) {
        await uploadBugAttachments(projectId, bug.id, createStagedFiles);
      }
      resetCreate();
      load();
    } catch (err) {
      // The bug itself may already have been created — the evidence upload is the step that fails.
      // Reloading keeps the list truthful about that, so the person doesn't report it twice.
      load();
      setCreateError(err instanceof Error ? err.message : "Something went wrong while reporting this bug.");
    } finally {
      setCreating(false);
    }
  }

  /* open edit */
  function openEdit(bug: BugItem) {
    setEditBug(bug);
    setEditTitle(bug.title);
    setEditDesc(bug.description);
    setEditSeverity(bug.severity);
    setEditPriority(bug.priority ?? "");
    setEditLinks(
      bug.links.map((link) => ({
        cycleId: link.cycleId || "",
        cycleName: link.cycleName || "",
        testcaseId: link.testcaseId || "",
        testcaseTitle: link.testcaseTitle || "",
        executionId: link.executionId || undefined,
      }))
    );
    setEditDestination(bug.externalUrl ? "SELF" : "TESBO");
    setEditSelfSystem(bug.integrationProvider === "JIRA" || bug.integrationProvider === "LINEAR" ? bug.integrationProvider : "OTHER");
    setEditUrl(bug.externalUrl || "");
    setEditEvidenceMode(bug.betterbugsUrl ? "BETTERBUGS" : "FILES");
    setEditStagedFiles([]);
    setEditAttachments(bug.attachments);
    setEditBetterbugsUrl(bug.betterbugsUrl || "");
    setEditStatus(bug.status);
    setEditAssigneeId(bug.assigneeId || "");
  }

  /* remove an already-uploaded attachment from the bug being edited */
  async function handleRemoveEditAttachment(attachmentId: string) {
    await deleteBugAttachment(attachmentId);
    setEditAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
  }

  /* save edit */
  async function handleEditSave() {
    if (!editBug || !editTitle.trim() || (hasTestRuns && !editLinks.length)) return;
    const selfLogged = (jiraConnected || linearConnected) && editDestination === "SELF";
    setSaving(true);
    setEditError(null);
    try {
      await updateBug(editBug.id, {
        title: editTitle.trim(),
        description: editDesc.trim(),
        status: editStatus,
        severity: editSeverity,
        priority: editPriority || null,
        assigneeId: editAssigneeId || null,
        externalUrl: selfLogged ? editUrl.trim() : undefined,
        integrationProvider: selfLogged && editSelfSystem !== "OTHER" ? editSelfSystem : null,
        integrationIssueKey: null,
        betterbugsUrl: editEvidenceMode === "BETTERBUGS" ? editBetterbugsUrl.trim() : undefined,
        links: editLinks.map((link) => ({
          testcaseId: link.testcaseId,
          cycleId: link.cycleId,
          executionId: link.executionId,
        })),
      });
      if (editEvidenceMode === "FILES" && editStagedFiles.length) {
        await uploadBugAttachments(projectId, editBug.id, editStagedFiles);
      }
      setEditBug(null);
      load();
    } catch (err) {
      load();
      setEditError(err instanceof Error ? err.message : "Something went wrong while saving this bug.");
    } finally {
      setSaving(false);
    }
  }

  /* delete */
  async function handleDelete(bugId: string) {
    try {
      await deleteBug(bugId);
      setDeletingId(null);
      load();
    } catch {
      // ignore
    }
  }

  if (loading) {
    return <PageLoader variant="screen" />;
  }

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <main className="tesbo-page max-w-7xl mx-auto">
        <ListWorkspaceLayout
          header={
            <PageHeader
              title="Bugs"
              subtitle={`${openCount} open · ${closedCount} closed · ${bugs.length} total`}
              breadcrumb={
                <Breadcrumbs
                  items={[
                    { label: "Projects", href: "/projects" },
                    { label: projectName || "Project", href: `/projects/${projectId}/dashboard` },
                    { label: "Bugs" },
                  ]}
                />
              }
              actions={
                <Button variant="primary" onClick={() => setShowCreate(true)}>
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 4v16m8-8H4"
                    />
                  </svg>
                  Report Bug
                </Button>
              }
            />
          }
          filterBar={
            <div className="flex items-center gap-3 mb-4">
              <Input
                type="text"
                placeholder="Search bugs…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-64"
              />
              {/*
                * Both filters are rendered in BOTH views. `filtered` feeds the List rows and the
                * board's kanbanColumns alike, so a filter set in List kept narrowing the board with
                * no visible control there to see or clear it (dev commit cdcd5dd). Search was never
                * gated on viewMode; these now match it.
                */}
              <Select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                aria-label="Filter by status"
              >
                <option value="">All Statuses</option>
                <option value="Open">Open</option>
                <option value="In Progress">In Progress</option>
                <option value="Closed">Closed</option>
                <option value="Reopened">Reopened</option>
              </Select>
              <Select
                value={filterSeverity}
                onChange={(e) => setFilterSeverity(e.target.value)}
                aria-label="Filter by severity"
              >
                <option value="">All Severities</option>
                {BUG_SEVERITIES.map((severity) => (
                  <option key={severity} value={severity}>
                    {severity}
                  </option>
                ))}
              </Select>
              <Select
                value={filterPriority}
                onChange={(e) => setFilterPriority(e.target.value)}
                aria-label="Filter by priority"
              >
                <option value="">All Priorities</option>
                {BUG_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority}
                  </option>
                ))}
              </Select>
              <Select
                value={filterAssignee}
                onChange={(e) => setFilterAssignee(e.target.value)}
                aria-label="Filter by assignee"
              >
                <option value="">All Assignees</option>
                <option value="unassigned">Unassigned</option>
                {assigneeFilterOptions.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </Select>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="flex h-[30px] shrink-0 items-center rounded-[6px] border border-[var(--ink-200)] px-3 text-[12px] font-medium text-[var(--ink-600)] hover:bg-[var(--ink-100)]"
                >
                  Clear all
                </button>
              )}
              <div className="ml-auto">
                <ViewToggle mode={viewMode} onChange={setViewMode} />
              </div>
            </div>
          }
        >
          {/* ───── Kanban View ───── */}
          {viewMode === "kanban" && (
            <>
              {bugs.length === 0 ? (
                <Card>
                  <div className="text-center py-12 text-sm text-[var(--muted-soft)]">
                    No bugs reported yet. Bugs filed from failed test executions
                    will appear here.
                  </div>
                </Card>
              ) : (
                <div className="flex gap-4 overflow-x-auto pb-2">
                  {kanbanColumns.map((col) => (
                    <KanbanColumn
                      key={col.status}
                      status={col.status}
                      bugs={col.bugs}
                      onView={setViewBug}
                      onEdit={openEdit}
                      onDelete={setDeletingId}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {/* ───── List View ───── */}
          {viewMode === "list" && (
            <>
              <Card className="overflow-hidden">
                {filtered.length === 0 ? (
                  <div className="text-center py-12 text-sm text-[var(--muted-soft)]">
                    {bugs.length === 0
                      ? "No bugs reported yet. Bugs filed from failed test executions will appear here."
                      : "No bugs match your filter."}
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="tesbo-table">
                      <thead>
                        <tr>
                          <th>Title</th>
                          <th>Status</th>
                          <th>Severity</th>
                          <th>Priority</th>
                          <th>Test Case</th>
                          <th>Test Run</th>
                          <th>Reporter</th>
                          <th>Assignee</th>
                          <th>Reported</th>
                          <th className="w-8"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {paginatedBugs.map((b) => (
                          <tr
                            key={b.id}
                            className="cursor-pointer"
                            role="button"
                            tabIndex={0}
                            onClick={() => setViewBug(b)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setViewBug(b);
                              }
                            }}
                          >
                            {/*
                              * Basecamp 10226229423 ("No tool tip pop up is available for log text").
                              * Two halves of one problem: a long title had no clamp, so one bug could
                              * push a row six lines tall, and the cells that DO truncate (linked
                              * cases, run names, reporter) cut the text off with no way to read the
                              * rest. Clamp plus a native title attribute on everything that can
                              * overflow — native rather than a custom tooltip so it works on the
                              * keyboard-focused and mobile-long-press paths too.
                              */}
                            <td>
                              <div className="flex flex-col gap-0.5 max-w-sm">
                                <span
                                  title={b.title}
                                  className="line-clamp-2 text-sm font-medium text-[var(--accent-light)] hover:underline break-words"
                                >
                                  {b.title}
                                </span>
                                {b.externalUrl && (
                                  <a
                                    href={b.externalUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    title={b.externalUrl}
                                    onClick={(e) => e.stopPropagation()}
                                    className="text-xs text-[var(--muted-soft)] hover:text-[var(--accent-light)] hover:underline truncate"
                                  >
                                    {b.externalUrl}
                                  </a>
                                )}
                              </div>
                            </td>
                            <td>
                              <BugStatusBadge status={b.status} />
                            </td>
                            <td>
                              <BugSeverityBadge severity={b.severity} />
                            </td>
                            {/* A field you can set and never see is not a field — 10226247009 asked
                                for it on the form, and the list is where triage actually happens. */}
                            <td>
                              <BugPriorityBadge priority={b.priority} />
                            </td>
                            <td>
                              {b.links.length ? (
                                <div className="flex flex-col gap-0.5">
                                  {b.links.slice(0, 2).map((link) => (
                                    <span
                                      key={link.id}
                                      title={`${link.testcaseExternalId ?? ""} ${link.testcaseTitle ?? ""}`.trim()}
                                      className="text-xs text-[var(--muted)] truncate max-w-[180px]"
                                    >
                                      <span className="font-mono text-[var(--muted-soft)]">{link.testcaseExternalId}</span>{" "}
                                      {link.testcaseTitle}
                                    </span>
                                  ))}
                                  {b.links.length > 2 && (
                                    <span
                                      title={b.links
                                        .slice(2)
                                        .map((link) => `${link.testcaseExternalId ?? ""} ${link.testcaseTitle ?? ""}`.trim())
                                        .join("\n")}
                                      className="text-xs text-[var(--muted-soft)]"
                                    >
                                      +{b.links.length - 2} more
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <span className="text-xs text-[var(--muted-soft)]">
                                  —
                                </span>
                              )}
                            </td>
                            <td>
                              <span
                                title={b.links.map((link) => link.cycleName).filter(Boolean).join(", ") || undefined}
                                className="text-xs text-[var(--muted)]"
                              >
                                {b.links.map((link) => link.cycleName).filter(Boolean).join(", ") || "—"}
                              </span>
                            </td>
                            <td>
                              <span
                                title={b.reporterName || b.reporterEmail || undefined}
                                className="text-xs text-[var(--muted)]"
                              >
                                {b.reporterName || b.reporterEmail || "—"}
                              </span>
                            </td>
                            <td>
                              <BugAssignee id={b.assigneeId} name={b.assigneeName} />
                            </td>
                            <td className="text-xs text-[var(--muted-soft)] whitespace-nowrap">
                              {new Date(b.createdAt).toLocaleDateString()}
                            </td>
                            <td>
                              <div
                                role="presentation"
                                className="flex items-center gap-1"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {/*
                                  * Basecamp 10226234070 ("icon size is very small not visible
                                  * properly") and 10218564160 ("Delete button is not visible") are
                                  * the same defect from two reporters: a 16px hairline glyph inside a
                                  * transparent secondary button, whose --ink-600 on --ink-200 border
                                  * is barely a shade off the dark table behind it. Ghost buttons make
                                  * the glyph the thing you see rather than the box, at 18px, with
                                  * colour that separates the destructive action from the safe one.
                                  * aria-labels because an icon-only control otherwise announces
                                  * nothing.
                                  */}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => openEdit(b)}
                                  className="text-[var(--muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--accent-light)]"
                                  title="Edit bug"
                                  aria-label="Edit bug"
                                >
                                  <IconPencil size={18} stroke={1.75} />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => setDeletingId(b.id)}
                                  className="text-[var(--status-fail-text)] hover:bg-[var(--error-soft)] hover:text-[var(--status-fail-text)]"
                                  title="Delete bug"
                                  aria-label="Delete bug"
                                >
                                  <IconTrash size={18} stroke={1.75} />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
              <Pagination
                page={page}
                totalPages={totalPages}
                totalItems={filtered.length}
                pageSize={PAGE_SIZE}
                onPageChange={setPage}
              />
            </>
          )}
        </ListWorkspaceLayout>
      </main>

      {/* ───── Bug Detail Modal ───── */}
      <Modal
        open={!!viewBug}
        onClose={() => setViewBug(null)}
        title="Bug Details"
      >
        {viewBug && (
          <div className="space-y-5">
            {/* Title + Status */}
            <div>
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-base font-semibold text-[var(--foreground)] break-words leading-snug">
                  {viewBug.title}
                </h3>
                <div className="flex items-center gap-2 shrink-0">
                  <BugSeverityBadge severity={viewBug.severity} />
                  <BugPriorityBadge priority={viewBug.priority} />
                  <BugStatusBadge status={viewBug.status} />
                </div>
              </div>
            </div>

            {/* Description */}
            {viewBug.description && (
              <div>
                <p className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-1">
                  Description
                </p>
                <div className="rounded-lg bg-[var(--background)] border border-[var(--border-subtle)] p-3">
                  <p className="text-sm text-[var(--foreground)] whitespace-pre-wrap break-words">
                    {viewBug.description}
                  </p>
                </div>
              </div>
            )}

            {/* Bug Link */}
            {viewBug.externalUrl && (
              <div>
                <p className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-1">
                  {viewBug.integrationProvider ? `${viewBug.integrationProvider === "JIRA" ? "Jira" : "Linear"} Ticket` : "Bug Link"}
                </p>
                <a
                  href={viewBug.externalUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-[var(--accent-light)] hover:underline break-all"
                >
                  <svg
                    className="w-4 h-4 shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                    />
                  </svg>
                  {viewBug.integrationIssueKey || viewBug.externalUrl}
                </a>
              </div>
            )}

            {/* Evidence */}
            {viewBug.betterbugsUrl ? (
              <div>
                <p className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-1">BetterBugs Session</p>
                <a
                  href={viewBug.betterbugsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-[var(--accent-light)] hover:underline break-all"
                >
                  {viewBug.betterbugsUrl}
                </a>
              </div>
            ) : viewBug.attachments.length > 0 ? (
              <div>
                <p className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-1">Attachments</p>
                <ul className="space-y-1">
                  {viewBug.attachments.map((att) => (
                    <li key={att.id}>
                      <a
                        href={getBugAttachmentDownloadUrl(projectId, att.id)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm text-[var(--accent-light)] hover:underline break-all"
                      >
                        {att.fileName}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* Metadata grid */}
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <p className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-1">
                  Linked Test Cases &amp; Runs
                </p>
                {viewBug.links.length ? (
                  <ul className="space-y-1">
                    {viewBug.links.map((link) => (
                      <li key={link.id} className="text-sm text-[var(--foreground)]">
                        <span className="font-mono text-xs text-[var(--muted-soft)]">{link.testcaseExternalId}</span>{" "}
                        {link.testcaseTitle}
                        <span className="text-[var(--muted)]"> — {link.cycleName}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-sm text-[var(--muted-soft)]">Not linked</span>
                )}
              </div>
              <div>
                <p className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-1">
                  Reported By
                </p>
                <span className="text-sm text-[var(--foreground)]">
                  {viewBug.reporterName || viewBug.reporterEmail || "Unknown"}
                </span>
              </div>
              <div>
                <p className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-1">
                  Assigned To
                </p>
                <BugAssignee id={viewBug.assigneeId} name={viewBug.assigneeName} />
              </div>
              <div>
                <p className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-1">
                  Reported On
                </p>
                <span className="text-sm text-[var(--foreground)]">
                  {new Date(viewBug.createdAt).toLocaleString()}
                </span>
              </div>
            </div>

            {viewBug.updatedAt !== viewBug.createdAt && (
              <p className="text-xs text-[var(--muted-soft)]">
                Last updated: {new Date(viewBug.updatedAt).toLocaleString()}
              </p>
            )}

            {/* Actions */}
            <div className="flex items-center justify-between pt-2 border-t border-[var(--border-subtle)]">
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setDeletingId(viewBug.id);
                  setViewBug(null);
                }}
                className="!bg-transparent !text-[var(--error-foreground)] hover:!bg-[var(--error)]/10 hover:!opacity-100"
              >
                Delete Bug
              </Button>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setViewBug(null)}>
                  Close
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    openEdit(viewBug);
                    setViewBug(null);
                  }}
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                    />
                  </svg>
                  Edit
                </Button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* ───── Create Bug Modal ───── */}
      <Modal
        open={showCreate}
        onClose={resetCreate}
        title="Report a Bug"
      >
        <div className="space-y-4">
          {createError && (
            <p
              data-testid="create-bug-error"
              className="rounded-[var(--radius-control)] border border-[var(--error)] bg-[var(--error)]/10 px-3 py-2 text-[13px] text-[var(--error-foreground)]"
            >
              {createError}
            </p>
          )}
          <Field>
            <FieldLabel>
              Bug Title <span className="text-[var(--error-foreground)]">*</span>
            </FieldLabel>
            <Input
              type="text"
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              placeholder="Brief summary of the bug…"
            />
          </Field>
          <Field>
            <FieldLabel>Description</FieldLabel>
            <Textarea
              value={createDesc}
              onChange={(e) => setCreateDesc(e.target.value)}
              rows={3}
              placeholder="Steps to reproduce, expected vs actual behavior…"
            />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field>
              <FieldLabel>Severity</FieldLabel>
              <Select value={createSeverity} onChange={(e) => setCreateSeverity(e.target.value as BugSeverity)}>
                {BUG_SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              {/* Optional on purpose: "not triaged yet" is a real answer, and forcing a guess here
                  would make the field noise rather than signal. */}
              <FieldLabel>Priority</FieldLabel>
              <Select
                value={createPriority}
                onChange={(e) => setCreatePriority(e.target.value as BugPriority | "")}
                aria-label="Bug priority"
              >
                <option value="">Not set</option>
                {BUG_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              <FieldLabel>Assign to</FieldLabel>
              <Select
                value={createAssigneeId}
                onChange={(e) => setCreateAssigneeId(e.target.value)}
                aria-label="Assign to"
              >
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name || m.email}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <BugEvidenceField
            mode={createEvidenceMode}
            onModeChange={setCreateEvidenceMode}
            stagedFiles={createStagedFiles}
            onStagedFilesChange={setCreateStagedFiles}
            betterbugsUrl={createBetterbugsUrl}
            onBetterbugsUrlChange={setCreateBetterbugsUrl}
          />
          <Field>
            <FieldLabel>
              Linked Test Case(s) &amp; Run(s) {hasTestRuns && <span className="text-[var(--error-foreground)]">*</span>}
            </FieldLabel>
            <TestCaseRunPicker projectId={projectId} value={createLinks} onChange={setCreateLinks} />
            {!hasTestRuns && (
              <p className="text-[13px] text-[var(--muted)]">
                This project has no test runs yet, so this bug will be reported unlinked. You can link it once a run exists.
              </p>
            )}
          </Field>
          {(jiraConnected || linearConnected) && (
            <Field>
              <FieldLabel>Where should this be tracked?</FieldLabel>
              <TrackingDestinationField destination={createDestination} onChange={setCreateDestination} />
            </Field>
          )}
          {(jiraConnected || linearConnected) && createDestination === "SELF" && (
            <SelfLoggedTrackerField
              jiraConnected={jiraConnected}
              linearConnected={linearConnected}
              system={createSelfSystem}
              onSystemChange={setCreateSelfSystem}
              url={createUrl}
              onUrlChange={setCreateUrl}
            />
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={resetCreate}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleCreate}
              disabled={creating || !createTitle.trim() || (hasTestRuns && !createLinks.length)}
            >
              {creating ? "Creating…" : "Report Bug"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ───── Edit Bug Modal ───── */}
      <Modal
        open={!!editBug}
        onClose={() => {
          setEditError(null);
          setEditBug(null);
        }}
        title="Edit Bug"
      >
        <div className="space-y-4">
          {editError && (
            <p
              data-testid="edit-bug-error"
              className="rounded-[var(--radius-control)] border border-[var(--error)] bg-[var(--error)]/10 px-3 py-2 text-[13px] text-[var(--error-foreground)]"
            >
              {editError}
            </p>
          )}
          <Field>
            <FieldLabel>
              Bug Title <span className="text-[var(--error-foreground)]">*</span>
            </FieldLabel>
            <Input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel>Description</FieldLabel>
            <Textarea
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              rows={3}
            />
          </Field>
          <BugEvidenceField
            mode={editEvidenceMode}
            onModeChange={setEditEvidenceMode}
            stagedFiles={editStagedFiles}
            onStagedFilesChange={setEditStagedFiles}
            existingAttachments={editAttachments}
            onRemoveExisting={handleRemoveEditAttachment}
            downloadUrl={(attachmentId) => getBugAttachmentDownloadUrl(projectId, attachmentId)}
            betterbugsUrl={editBetterbugsUrl}
            onBetterbugsUrlChange={setEditBetterbugsUrl}
          />
          <Field>
            <FieldLabel>
              Linked Test Case(s) &amp; Run(s) {hasTestRuns && <span className="text-[var(--error-foreground)]">*</span>}
            </FieldLabel>
            <TestCaseRunPicker projectId={projectId} value={editLinks} onChange={setEditLinks} />
            {!hasTestRuns && (
              <p className="text-[13px] text-[var(--muted)]">
                This project has no test runs yet, so this bug will stay unlinked. You can link it once a run exists.
              </p>
            )}
          </Field>
          {(jiraConnected || linearConnected) && (
            <Field>
              <FieldLabel>Where should this be tracked?</FieldLabel>
              <TrackingDestinationField destination={editDestination} onChange={setEditDestination} />
            </Field>
          )}
          {(jiraConnected || linearConnected) && editDestination === "SELF" && (
            <SelfLoggedTrackerField
              jiraConnected={jiraConnected}
              linearConnected={linearConnected}
              system={editSelfSystem}
              onSystemChange={setEditSelfSystem}
              url={editUrl}
              onUrlChange={setEditUrl}
            />
          )}
          <Field>
            <FieldLabel>Status</FieldLabel>
            <Select
              value={editStatus}
              onChange={(e) => setEditStatus(e.target.value)}
            >
              <option value="Open">Open</option>
              <option value="In Progress">In Progress</option>
              <option value="Closed">Closed</option>
              <option value="Reopened">Reopened</option>
            </Select>
          </Field>
          <Field>
            <FieldLabel>Severity</FieldLabel>
            <Select value={editSeverity} onChange={(e) => setEditSeverity(e.target.value as BugSeverity)} aria-label="Severity">
              {BUG_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field>
            <FieldLabel>Priority</FieldLabel>
            <Select
              value={editPriority}
              onChange={(e) => setEditPriority(e.target.value as BugPriority | "")}
              aria-label="Bug priority"
            >
              <option value="">Not set</option>
              {BUG_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>
          <Field>
            <FieldLabel>Assign to</FieldLabel>
            <Select
              value={editAssigneeId}
              onChange={(e) => setEditAssigneeId(e.target.value)}
              aria-label="Assign to"
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name || m.email}
                </option>
              ))}
              {/* Current assignee not among this project's members — an AI agent or a stale row.
                  Kept visible as a disabled option so Save doesn't silently clear a real
                  assignment nobody touched. */}
              {editAssigneeId && !members.some((m) => m.userId === editAssigneeId) && (
                <option value={editAssigneeId} disabled>
                  {editBug?.assigneeName || "Unknown assignee"} (not a project member)
                </option>
              )}
            </Select>
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setEditBug(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleEditSave}
              disabled={saving || !editTitle.trim() || (hasTestRuns && !editLinks.length)}
            >
              {saving ? "Saving…" : "Save Changes"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ───── Delete Confirm Modal ───── */}
      <Modal
        open={!!deletingId}
        onClose={() => setDeletingId(null)}
        title="Delete Bug"
      >
        <p className="text-sm text-[var(--muted)] mb-6">
          Are you sure you want to delete this bug? This action cannot be
          undone.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDeletingId(null)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => deletingId && handleDelete(deletingId)}
          >
            Delete
          </Button>
        </div>
      </Modal>
    </div>
  );
}
