"use client";

import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { IconPencil, IconTrash } from "@tabler/icons-react";
import {
  listBugs,
  createBug,
  deleteBug,
  getJiraStatus,
  getLinearStatus,
  uploadBugAttachments,
  listTestRuns,
  type BugItem,
  type BugSeverity,
  type BugPriority,
  type IssueSearchResult,
} from "@/lib/api";
import {
  Button,
  Card,
  Input,
  Drawer,
  Field,
  FieldLabel,
  Modal,
  PageLoader,
  Textarea,
  Select,
} from "@/components/ui";
import { PageHeader, ListWorkspaceLayout, Breadcrumbs } from "@/components/workflows";
import { useAppData } from "@/components/app/AppDataProvider";
import { useProjectData } from "@/components/project/ProjectDataProvider";
import TestCaseRunPicker, { type LinkRow } from "@/components/TestCaseRunPicker";
import TrackingDestinationField, { type TrackingDestination } from "@/components/TrackingDestinationField";
import SelfLoggedTrackerField, { type SelfLoggedSystem } from "@/components/SelfLoggedTrackerField";
import IssuePickerModal from "@/components/IssuePickerModal";
import BugEvidenceField, { type EvidenceMode } from "@/components/BugEvidenceField";
import {
  BUG_PRIORITIES,
  BUG_SEVERITIES,
  BUG_STATUSES,
  BugAssignee,
  BugPriorityBadge,
  BugSeverityBadge,
  BugStatusBadge,
  MemberAvatar,
} from "@/components/bugs/BugBadges";
import BugComments from "@/components/bugs/BugComments";
import BugDetailsBody from "@/components/bugs/BugDetailsBody";
import EditBugModal from "@/components/bugs/EditBugModal";
import { getPageCache, setPageCache } from "@/lib/pageDataCache";

interface BugsData {
  bugs: BugItem[];
}

type ViewMode = "kanban" | "list";

const PAGE_SIZE = 15;

const STATUS_COLOR: Record<string, string> = {
  Open: "var(--error)",
  "In Progress": "var(--info)",
  Reopened: "var(--warning)",
  Closed: "var(--success)",
};

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
        <div className="min-w-0">
          <p className="font-mono text-[11px] text-[var(--muted-soft)]">{bug.integrationIssueKey || bug.externalId}</p>
          <h4 className="text-sm font-medium text-[var(--foreground)] leading-snug line-clamp-2 break-words">
            {bug.title}
          </h4>
        </div>
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
  const { currentUser } = useAppData();
  const { project, projectMembers: members } = useProjectData();
  const projectName = String(project.name || "");

  const cacheKey = `bugs:${projectId}`;
  const cached = getPageCache<BugsData>(cacheKey);

  const [bugs, setBugs] = useState<BugItem[]>(cached?.bugs ?? []);
  // Only the true first visit to this project's bugs list has no cache to seed from — every
  // later visit renders the last-known data immediately while the effect below revalidates it
  // in the background, instead of blocking behind the spinner on every single click.
  const [loading, setLoading] = useState(!cached);
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
  // Same searchable-picker treatment as Edit Bug's editSelectedIssue/editIssuePickerOpen (see
  // handleEditSystemChange) — kept as its own state rather than shared, since Create and Edit
  // reset independently and must not bleed into each other.
  const [createSelectedIssue, setCreateSelectedIssue] = useState<IssueSearchResult | null>(null);
  const [createIssuePickerOpen, setCreateIssuePickerOpen] = useState(false);

  function handleCreateSystemChange(system: SelfLoggedSystem) {
    setCreateSelfSystem(system);
    setCreateSelectedIssue((prev) => {
      if (prev && prev.provider !== system) {
        setCreateUrl("");
        return null;
      }
      return prev;
    });
  }
  const [createEvidenceMode, setCreateEvidenceMode] = useState<EvidenceMode>("FILES");
  const [createStagedFiles, setCreateStagedFiles] = useState<File[]>([]);
  const [createBetterbugsUrl, setCreateBetterbugsUrl] = useState("");
  const [createAssigneeId, setCreateAssigneeId] = useState("");
  const [creating, setCreating] = useState(false);
  /*
   * Basecamp: >10 attachments made createBug() succeed, then the (single, unbatched)
   * uploadBugAttachments() request get rejected by the server's per-request file cap — leaving the
   * modal open with an error and the bug already created. Retrying resubmitted the whole form,
   * calling createBug() again and producing a duplicate bug. This ref remembers the bug created by
   * the in-flight (or most recently failed) submit so a retry only resumes the attachment upload
   * instead of creating a second bug; resetCreate() clears it once the submit is done or abandoned.
   */
  const createdBugIdRef = useRef<string | null>(null);

  /* edit modal — its form state lives in EditBugModal */
  const [editBug, setEditBug] = useState<BugItem | null>(null);
  /*
   * Basecamp 10226296533: createBug/updateBug succeeded, uploadBugAttachments then threw, and the
   * throw went nowhere — `finally` cleared the spinner but the modal stayed open unchanged with no
   * reason shown, which is what "stuck on Saving" looked like from the outside. The server's
   * message (unsupported type, over the size limit, storage allowance exhausted) is worth showing
   * verbatim: it names the file.
   */
  const [createError, setCreateError] = useState<string | null>(null);

  /* detail view modal */
  const [viewBug, setViewBug] = useState<BugItem | null>(null);

  /* delete confirm */
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(() => {
    listBugs(projectId)
      .then((bugsData) => {
        setPageCache(`bugs:${projectId}`, { bugs: bugsData });
        setBugs(bugsData);
      })
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    const key = `bugs:${projectId}`;
    const existing = getPageCache<BugsData>(key);
    if (existing) {
      setBugs(existing.bugs);
      setLoading(false);
    }
    if (!currentUser) {
      router.replace("/login");
      return;
    }
    load();
  }, [projectId, router, load, currentUser]);

  useEffect(() => {
    getJiraStatus(projectId).then((s) => setJiraConnected(s.connected)).catch(() => setJiraConnected(false));
    getLinearStatus(projectId).then((s) => setLinearConnected(s.connected)).catch(() => setLinearConnected(false));
    listTestRuns(projectId).then((runs) => setHasTestRuns(runs.length > 0)).catch(() => setHasTestRuns(false));
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
    createdBugIdRef.current = null;
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
    setCreateSelectedIssue(null);
    setCreateIssuePickerOpen(false);
    setCreateEvidenceMode("FILES");
    setCreateStagedFiles([]);
    setCreateBetterbugsUrl("");
    setCreateAssigneeId("");
  }

  /* create */
  async function handleCreate() {
    if (!createTitle.trim() || (hasTestRuns && !createLinks.length) || createIssueRequired) return;
    // Belt-and-suspenders alongside the button's `disabled={creating}`: guards a re-entrant call
    // (e.g. a key-repeat Enter) that lands before the disabled state has re-rendered.
    if (creating) return;
    const selfLogged = (jiraConnected || linearConnected) && createDestination === "SELF";
    setCreating(true);
    setCreateError(null);
    try {
      // A retry after a failed attachment upload must not create a second bug: reuse the bug
      // created by the previous attempt (if any) instead of calling createBug() again.
      let bugId = createdBugIdRef.current;
      if (!bugId) {
        const bug = await createBug(projectId, {
          title: createTitle.trim(),
          description: createDesc.trim(),
          severity: createSeverity,
          priority: createPriority || null,
          assigneeId: createAssigneeId || null,
          externalUrl: selfLogged ? createUrl.trim() : undefined,
          integrationProvider: selfLogged && createSelfSystem !== "OTHER" ? createSelfSystem : null,
          integrationIssueKey: selfLogged && createSelfSystem !== "OTHER" ? createSelectedIssue?.key || null : null,
          betterbugsUrl: createEvidenceMode === "BETTERBUGS" ? createBetterbugsUrl.trim() : undefined,
          links: createLinks.map((link) => ({
            testcaseId: link.testcaseId,
            cycleId: link.cycleId,
            executionId: link.executionId,
          })),
        });
        bugId = bug.id;
        createdBugIdRef.current = bugId;
      }
      if (createEvidenceMode === "FILES" && createStagedFiles.length) {
        // Drop each batch from the staged list as it lands, so a retry after a later batch fails
        // only resends the files that never made it, not ones already attached to the bug.
        await uploadBugAttachments(projectId, bugId, createStagedFiles, (batch) => {
          setCreateStagedFiles((prev) => prev.slice(batch.length));
        });
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
    return <PageLoader variant="content" />;
  }

  // Same rule for Create: picking Jira/Linear as the system requires an actual ticket before
  // Report Bug is enabled, so a fresh bug can't be saved with a provider set and no key.
  const createIssueRequired =
    (jiraConnected || linearConnected) &&
    createDestination === "SELF" &&
    (createSelfSystem === "JIRA" || createSelfSystem === "LINEAR") &&
    !createSelectedIssue;

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
                                <span className="font-mono text-[11px] text-[var(--muted-soft)]">{b.integrationIssueKey || b.externalId}</span>
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

      {/* ───── Bug Detail Panel (right side) ─────
          Same shared Drawer the Test Run detail panel uses: header with the close control, a
          scrolling body, and footer actions pinned below it. */}
      <Drawer
        open={!!viewBug}
        onClose={() => setViewBug(null)}
        title={
          viewBug && (
            <div className="min-w-0">
              <p className="mb-0.5 text-xs font-medium uppercase tracking-wide text-[var(--muted-soft)]">Bug Details</p>
              {/* Bug Key + Title — severity/priority/status are labelled fields in the body.
                  Falls back to the bug's own per-project id when it has no external tracker
                  ticket — same "Bug Key" fallback the Test Run and Test Case Detail screens use. */}
              <p className="font-mono text-xs text-[var(--muted-soft)] mb-0.5">{viewBug.integrationIssueKey || viewBug.externalId}</p>
              <h3 className="text-base font-semibold text-[var(--foreground)] break-words leading-snug">
                {viewBug.title}
              </h3>
            </div>
          )
        }
      >
        {viewBug && (
          <section aria-label="Bug details" className="flex h-full flex-col">
            <div className="flex-1 space-y-5 overflow-y-auto p-5">
              <BugDetailsBody
                bug={viewBug}
                projectId={projectId}
                onAttachmentDeleted={(attachmentId) => {
                  // The panel renders its own copy of the bug, so drop the file there at once, then
                  // reload the list so its rows and the next open are current too.
                  setViewBug((prev) => (prev ? { ...prev, attachments: prev.attachments.filter((a) => a.id !== attachmentId) } : prev));
                  load();
                }}
              />
              <BugComments key={viewBug.id} projectId={projectId} bugId={viewBug.id} />
            </div>

            {/* Footer actions — primary on the left, destructive on the right, as in the Test Case
                detail panel. */}
            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--border)] p-4">
              <div className="flex items-center gap-2">
                {/* Opens the full bug page straight into its in-place edit form, rather than the
                    Edit Bug dialog the list row and board card still use. */}
                <Button
                  variant="primary"
                  onClick={() => router.push(`/projects/${projectId}/bugs/${viewBug.id}?edit=1`)}
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
                <Button variant="secondary" onClick={() => setViewBug(null)}>
                  Close
                </Button>
              </div>
              <div className="flex items-center gap-3">
                {/* Same link the Test Run detail panel offers for its full-page view. */}
                <Link
                  href={`/projects/${projectId}/bugs/${viewBug.id}`}
                  className="text-[12.5px] font-medium hover:underline"
                  style={{ color: "var(--accent-light)" }}
                >
                  Open full page
                </Link>
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
              </div>
            </div>
          </section>
        )}
      </Drawer>

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
              onSystemChange={handleCreateSystemChange}
              url={createUrl}
              onUrlChange={setCreateUrl}
              renderUrlField={(system, defaultField) => {
                if (system === "OTHER") return defaultField;
                return (
                  <div className="mt-2 space-y-1">
                    <div className="flex items-center justify-between gap-2 rounded-[var(--radius-control)] border border-[var(--border)] px-3 py-2 text-[13px]">
                      {createSelectedIssue ? (
                        <a
                          href={createSelectedIssue.url || createUrl || undefined}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate text-[var(--foreground)] hover:underline"
                        >
                          {createSelectedIssue.key}
                          {createSelectedIssue.summary ? ` — ${createSelectedIssue.summary}` : ""}
                        </a>
                      ) : (
                        <span className="text-[var(--muted)]">No issue selected.</span>
                      )}
                      <Button type="button" size="sm" variant="secondary" onClick={() => setCreateIssuePickerOpen(true)}>
                        {createSelectedIssue ? "Change issue" : "Select issue"}
                      </Button>
                    </div>
                    {createIssueRequired && (
                      <p className="text-[13px] text-[var(--error-foreground)]">
                        Select a {system === "JIRA" ? "Jira" : "Linear"} ticket before saving.
                      </p>
                    )}
                  </div>
                );
              }}
            />
          )}
          {(createSelfSystem === "JIRA" || createSelfSystem === "LINEAR") && (
            <IssuePickerModal
              projectId={projectId}
              testcaseId={null}
              cycleId={null}
              provider={createSelfSystem}
              open={createIssuePickerOpen}
              onClose={() => setCreateIssuePickerOpen(false)}
              selectedIssues={createSelectedIssue ? [createSelectedIssue] : []}
              mode="single"
              onConfirm={(issues) => {
                const issue = issues[0] ?? null;
                setCreateSelectedIssue(issue);
                setCreateUrl(issue?.url ?? "");
              }}
            />
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={resetCreate}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleCreate}
              disabled={creating || !createTitle.trim() || (hasTestRuns && !createLinks.length) || createIssueRequired}
            >
              {creating ? "Creating…" : "Report Bug"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ───── Edit Bug Modal ───── */}
      {editBug && (
        <EditBugModal
          key={editBug.id}
          projectId={projectId}
          bug={editBug}
          jiraConnected={jiraConnected}
          linearConnected={linearConnected}
          hasTestRuns={hasTestRuns}
          onClose={() => setEditBug(null)}
          onChanged={load}
        />
      )}

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
