"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  IconArrowsSort,
  IconChevronDown,
  IconFolders,
  IconLayoutGrid,
  IconList,
  IconPlus,
  IconSearch,
} from "@tabler/icons-react";
import { authMe, listProjects, listProjectsOverview, createProject, getWorkspace } from "@/lib/api";
import type { ProjectIcon, ProjectSummary, ProjectType } from "@/lib/api";
import {
  Button,
  Card,
  EmptyStateBlock,
  Field,
  FieldError,
  FieldHint,
  FieldLabel,
  Input,
  Modal,
  PageLoader,
  Textarea,
} from "@/components/ui";
import { ProjectIconPicker, type ProjectIconValue } from "@/components/ProjectIconPicker";
import { ListWorkspaceLayout, PageHeader } from "@/components/workflows";
import { readStoredValue, writeStoredValue } from "@/lib/storage";
import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_KEY_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  validateProjectDescription,
  validateProjectIconGlyph,
  validateProjectKey,
  validateProjectName,
} from "@/lib/validation";
import { avatarColor } from "@/lib/avatarColors";

const EMPTY_ICON: ProjectIconValue = { color: null, glyph: null };

/** The badge a project card actually paints: an explicit icon override, or the generated fallback. */
function resolveProjectIcon(id: string, name: string, icon: ProjectIcon | null | undefined) {
  return {
    color: icon?.color || avatarColor(id),
    glyph: icon?.glyph || (name.trim().charAt(0).toUpperCase() || "P"),
  };
}

type RunCounts = { passed: number; failed: number; blocked: number; skipped: number; total: number };
type ProjectStatus = "active" | "configured" | "setup_required";

/*
 * A card before its stats have arrived, and after.
 *
 * The list paints from `/api/projects` alone, so every stat is optional until the overview call
 * lands. `statsLoaded` is what the card reads to tell "no runs yet" apart from "not counted yet" —
 * without it an unloaded card is indistinguishable from an empty project and would flash the
 * setup-required badge and a 0% pass rate at every user on every load.
 */
type ProjectWithStats = ProjectSummary & {
  statsLoaded: boolean;
  testCaseCount: number;
  suiteCount: number;
  teamMembers: { userId: string; name: string }[];
  lastActivityAt: string | null;
  status: ProjectStatus;
  runCounts: RunCounts | null; // latest completed run's breakdown, null if no runs
  currentPassRate: number | null; // latest run's pass %, null if no runs
};

const VIEW_STORAGE_KEY = "tesbo_projects_view";

/*
 * Avatar fills come from lib/avatarColors.ts.
 *
 * This module used to hold its own copy of the palette and its own hashSeed — byte-identical to the
 * shared ones, which is exactly how they drift apart. Basecamp 10198836413 ("Display picture initials
 * show different colours across the website") was that drift: one person's initials were painted five
 * different ways across the app.
 */

type SortOption = "updated" | "name_asc" | "name_desc" | "created";

const SORT_OPTIONS: Array<{ value: SortOption; label: string }> = [
  { value: "updated", label: "Last updated" },
  { value: "created", label: "Newest created" },
  { value: "name_asc", label: "Name (A–Z)" },
  { value: "name_desc", label: "Name (Z–A)" },
];

function sortProjects(projects: ProjectWithStats[], sortBy: SortOption): ProjectWithStats[] {
  const sorted = [...projects];
  switch (sortBy) {
    case "name_asc":
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
    case "name_desc":
      return sorted.sort((a, b) => b.name.localeCompare(a.name));
    case "created":
      return sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    case "updated":
    default:
      return sorted.sort((a, b) => {
        const aTime = new Date(a.lastActivityAt ?? a.createdAt).getTime();
        const bTime = new Date(b.lastActivityAt ?? b.createdAt).getTime();
        return bTime - aTime;
      });
  }
}

function projectColor(seed: string): string {
  return avatarColor(seed);
}

const STATUS_META: Record<ProjectStatus, { label: string; text: string; dot: string; fill: string }> = {
  active: { label: "Active", text: "var(--status-pass-text)", dot: "var(--status-pass-dot)", fill: "var(--status-pass-fill)" },
  configured: { label: "Configured", text: "var(--status-notrun-text)", dot: "var(--status-notrun-dot)", fill: "var(--status-notrun-fill)" },
  setup_required: { label: "Setup required", text: "var(--status-blocked-text)", dot: "var(--status-blocked-dot)", fill: "var(--status-blocked-fill)" },
};

/*
 * The -foreground tokens, not the raw --success/--warning/--error fills: those are tuned to carry
 * white text as a background, and read at 3.1–4.0:1 when used as text on a light surface.
 */
function passRateTextColor(rate: number | null): string {
  if (rate === null) return "var(--muted-soft)";
  if (rate >= 90) return "var(--success-foreground)";
  if (rate >= 70) return "var(--warning-foreground)";
  return "var(--error-foreground)";
}

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

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

/*
 * Basecamp 10221710841 ("[Projects] List view not showing failed pass rate").
 *
 * The grid card has always shown the full breakdown; the list row showed a single green bar filled
 * to the pass rate, so a project at 67% looked like a third of its work was simply missing rather
 * than failed. Same data, same colours, no legend — the row has no space for one, so the counts go
 * in a tooltip instead.
 */
function PassRateBarCompact({ counts }: { counts: RunCounts }) {
  const { passed, failed, blocked, total } = counts;
  if (total <= 0) return null;
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;
  const title = [`${passed} passed`, `${failed} failed`, blocked > 0 ? `${blocked} blocked` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex h-1 max-w-[60px] flex-1 gap-px overflow-hidden rounded-full bg-[var(--surface-secondary)]" title={title}>
      {passed > 0 && <div className="h-full" style={{ width: pct(passed), background: "var(--status-pass-dot)" }} />}
      {failed > 0 && <div className="h-full" style={{ width: pct(failed), background: "var(--status-fail-dot)" }} />}
      {blocked > 0 && <div className="h-full" style={{ width: pct(blocked), background: "var(--status-blocked-dot)" }} />}
    </div>
  );
}

function PassRateBar({ counts }: { counts: RunCounts }) {
  const { passed, failed, blocked, total } = counts;
  if (total <= 0) return null;
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;
  return (
    <div className="mt-3.5">
      <div className="flex h-[5px] gap-0.5 overflow-hidden rounded-full bg-[var(--surface-secondary)]">
        {passed > 0 && <div className="h-full" style={{ width: pct(passed), background: "var(--status-pass-dot)" }} />}
        {failed > 0 && <div className="h-full" style={{ width: pct(failed), background: "var(--status-fail-dot)" }} />}
        {blocked > 0 && <div className="h-full" style={{ width: pct(blocked), background: "var(--status-blocked-dot)" }} />}
      </div>
      <div className="mt-2 flex flex-wrap gap-3">
        <span className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--status-pass-dot)" }} />
          {passed} passed
        </span>
        <span className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--status-fail-dot)" }} />
          {failed} failed
        </span>
        {blocked > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--status-blocked-dot)" }} />
            {blocked} blocked
          </span>
        )}
      </div>
    </div>
  );
}

function TeamAvatars({ team, pending }: { team: { userId: string; name: string }[]; pending?: boolean }) {
  // Before the overview lands the roster is empty because it is unknown, not because there is
  // nobody on it — saying "No members assigned" here would be a claim the page cannot yet make.
  if (pending) return <span className="text-xs text-[var(--muted-soft)]">—</span>;
  if (team.length === 0) return <span className="text-xs text-[var(--muted)]">No members assigned</span>;
  return (
    <div className="flex items-center">
      {team.slice(0, 4).map((member, idx) => (
        <span
          key={member.userId}
          className={`inline-flex h-6 w-6 items-center justify-center rounded-full border-2 border-[var(--surface)] text-[10px] font-semibold text-white ${idx > 0 ? "-ml-1.5" : ""}`}
          style={{ background: projectColor(member.userId) }}
          title={member.name}
        >
          {getInitials(member.name)}
        </span>
      ))}
      {team.length > 4 ? (
        <span className="-ml-1.5 inline-flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-[var(--surface)] bg-[var(--surface-tertiary)] px-1.5 text-[10px] font-semibold text-[var(--foreground)]">
          +{team.length - 4}
        </span>
      ) : null}
    </div>
  );
}

function StatusBadge({ status, pending }: { status: ProjectStatus; pending?: boolean }) {
  // Same reasoning as TeamAvatars: the badge is derived from counts that have not arrived, and
  // "Setup required" on a project that is fully set up is worse than no badge for a moment.
  if (pending) return null;
  const meta = STATUS_META[status];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium"
      style={{ background: meta.fill, color: meta.text }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: meta.dot }} />
      {meta.label}
    </span>
  );
}

function SortMenu({ sortBy, onSortChange }: { sortBy: SortOption; onSortChange: (v: SortOption) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const currentLabel = SORT_OPTIONS.find((o) => o.value === sortBy)?.label ?? "Last updated";

  useEffect(() => {
    if (!isOpen) return;
    function handleOutsideClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setIsOpen(false);
    }
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [isOpen]);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        className="flex h-8 items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--muted)] transition-colors hover:border-[var(--brand-primary)]"
      >
        <IconArrowsSort size={14} stroke={1.75} className="text-[var(--muted-soft)]" />
        Sort: {currentLabel}
        <IconChevronDown size={13} stroke={1.75} className="text-[var(--muted-soft)]" />
      </button>
      {isOpen && (
        <div className="absolute left-0 top-full z-40 mt-1 w-44 rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[var(--shadow-elevated)]">
          {SORT_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onSortChange(option.value);
                setIsOpen(false);
              }}
              className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-[var(--surface-secondary)] ${
                option.value === sortBy ? "text-[var(--brand-primary)]" : "text-[var(--foreground)]"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectsToolbar({
  viewMode,
  onViewModeChange,
  searchQuery,
  onSearchChange,
  sortBy,
  onSortChange,
}: {
  viewMode: "grid" | "list";
  onViewModeChange: (v: "grid" | "list") => void;
  searchQuery: string;
  onSearchChange: (v: string) => void;
  sortBy: SortOption;
  onSortChange: (v: SortOption) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <label className="flex h-8 min-w-[200px] max-w-[280px] flex-1 items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[13px] text-[var(--muted-soft)] transition-colors focus-within:border-[var(--brand-primary)]">
          <IconSearch size={14} stroke={1.75} className="shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search projects"
            aria-label="Search projects by name or keyword"
            className="min-w-0 flex-1 bg-transparent text-[var(--foreground)] outline-none placeholder:text-[var(--muted-soft)]"
          />
        </label>
        <SortMenu sortBy={sortBy} onSortChange={onSortChange} />
      </div>
      <div className="flex items-center gap-0.5 rounded-[6px] bg-[var(--surface-secondary)] p-[3px]">
        <button
          type="button"
          onClick={() => onViewModeChange("grid")}
          aria-label="Grid view"
          aria-pressed={viewMode === "grid"}
          className="flex h-[26px] w-7 items-center justify-center rounded-[4px] transition-colors"
          style={{ background: viewMode === "grid" ? "var(--surface)" : "transparent", color: viewMode === "grid" ? "var(--brand-primary)" : "var(--muted-soft)" }}
        >
          <IconLayoutGrid size={15} stroke={1.75} />
        </button>
        <button
          type="button"
          onClick={() => onViewModeChange("list")}
          aria-label="List view"
          aria-pressed={viewMode === "list"}
          className="flex h-[26px] w-7 items-center justify-center rounded-[4px] transition-colors"
          style={{ background: viewMode === "list" ? "var(--surface)" : "transparent", color: viewMode === "list" ? "var(--brand-primary)" : "var(--muted-soft)" }}
        >
          <IconList size={15} stroke={1.75} />
        </button>
      </div>
    </div>
  );
}

function ProjectsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [projects, setProjects] = useState<ProjectWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("updated");
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createKey, setCreateKey] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createIcon, setCreateIcon] = useState<ProjectIconValue>(EMPTY_ICON);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createNameError, setCreateNameError] = useState("");
  const [createKeyError, setCreateKeyError] = useState("");
  const [createDescriptionError, setCreateDescriptionError] = useState("");
  const [createIconGlyphError, setCreateIconGlyphError] = useState("");
  const [workspaceRole, setWorkspaceRole] = useState<string>("");
  const canCreateProject = workspaceRole === "owner" || workspaceRole === "admin" || workspaceRole === "manager";

  useEffect(() => {
    const saved = readStoredValue(VIEW_STORAGE_KEY);
    if (saved === "grid" || saved === "list") setViewMode(saved);
  }, []);

  function handleViewModeChange(next: "grid" | "list") {
    setViewMode(next);
    writeStoredValue(VIEW_STORAGE_KEY, next);
  }

  useEffect(() => {
    if (canCreateProject && searchParams.get("create") === "1") {
      setCreateOpen(true);
    }
  }, [canCreateProject, searchParams]);

  useEffect(() => {
    let cancelled = false;
    authMe().then((me) => {
      if (cancelled) return;
      if (!me) {
        router.replace("/login");
        return;
      }
      /*
       * First paint depends on these two calls and nothing else.
       *
       * It used to depend on seventy-eight: the list, then five stat calls per project, all awaited
       * before `setLoading(false)` ran in the outer chain's `finally`. The per-call `.catch()`
       * guards below survive from that version and are still worth having, but a catch protects
       * against a rejection, not against latency — one slow call held the spinner and the page
       * showed nothing at all until the slowest of seventy-five returned.
       *
       * So the cards render from `/api/projects` as soon as it lands, and the stats arrive
       * afterwards from a single `/api/projects/overview`. A slow or failed overview now costs the
       * numbers on the cards, not the list.
       */
      Promise.all([getWorkspace().catch(() => null), listProjects()])
        .then(([workspace, list]) => {
          if (cancelled) return;
          setWorkspaceRole((workspace?.role || "").toLowerCase());
          setProjects(
            list.map((p) => ({
              ...p,
              projectType: (p.projectType || "tesbox") as ProjectType,
              statsLoaded: false,
              testCaseCount: 0,
              suiteCount: 0,
              teamMembers: [],
              lastActivityAt: null,
              status: "configured" as ProjectStatus,
              runCounts: null,
              currentPassRate: null,
            })),
          );
          setLoading(false);

          return listProjectsOverview()
            .then((overview) => {
              if (cancelled) return;
              const stats = new Map(overview.map((o) => [o.id, o]));
              setProjects((current) =>
                current.map((p) => {
                  const s = stats.get(p.id);
                  return s ? { ...p, ...s, projectType: p.projectType, statsLoaded: true } : p;
                }),
              );
            })
            // A failed overview leaves the cards on the list's own fields rather than blanking
            // them — the same "degrade one thing, not the whole list" rule the old per-call
            // catches enforced, applied to the call that replaced them.
            .catch(() => undefined);
        })
        .catch(() => {
          if (!cancelled) setLoading(false);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  /*
   * Closing discards the draft. Leaving it behind meant reopening the modal showed the abandoned
   * name — so a fresh key could be typed against a stale name and submitted without the user ever
   * seeing what they were actually creating.
   */
  function closeCreate() {
    if (createLoading) return;
    setCreateOpen(false);
    setCreateName("");
    setCreateKey("");
    setCreateDescription("");
    setCreateIcon(EMPTY_ICON);
    setCreateError("");
    // Field-level validation errors have to go too, or reopening the modal shows a complaint about
    // input the user can no longer see.
    setCreateNameError("");
    setCreateKeyError("");
    setCreateDescriptionError("");
    setCreateIconGlyphError("");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError("");
    if (!canCreateProject) {
      setCreateError("Only workspace owner, admin, or manager can create projects.");
      return;
    }
    const nameError = validateProjectName(createName);
    if (nameError) {
      setCreateNameError(nameError);
      return;
    }
    const keyError = validateProjectKey(createKey);
    if (keyError) {
      setCreateKeyError(keyError);
      return;
    }
    const descriptionError = validateProjectDescription(createDescription);
    if (descriptionError) {
      setCreateDescriptionError(descriptionError);
      return;
    }
    const iconGlyphError = validateProjectIconGlyph(createIcon.glyph ?? "");
    if (iconGlyphError) {
      setCreateIconGlyphError(iconGlyphError);
      return;
    }
    setCreateLoading(true);
    try {
      const created = await createProject({
        name: createName.trim(),
        key: createKey.trim() || undefined,
        description: createDescription.trim() || undefined,
        projectType: "tesbox",
        icon: { color: createIcon.color, glyph: createIcon.glyph?.trim() || null },
      });
      setCreateOpen(false);
      setCreateName("");
      setCreateKey("");
      setCreateDescription("");
      setCreateIcon(EMPTY_ICON);
      setCreateError("");
      setCreateNameError("");
      setCreateKeyError("");
      setCreateDescriptionError("");
      setCreateIconGlyphError("");
      router.push(`/projects/${created.id}/dashboard`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setCreateLoading(false);
    }
  }

  const filteredProjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const matched = !query
      ? projects
      : projects.filter((p) =>
          [p.name, p.key, p.description ?? ""].some((field) => field.toLowerCase().includes(query))
        );
    return sortProjects(matched, sortBy);
  }, [projects, searchQuery, sortBy]);

  if (loading) {
    return <PageLoader variant="screen" label="Loading projects…" />;
  }

  return (
    <ListWorkspaceLayout
      header={(
        <PageHeader
          title="Projects"
          subtitle="Tesbo Test Manager end-to-end test management projects."
          actions={canCreateProject ? (
            <Button onClick={() => setCreateOpen(true)}>
              <IconPlus size={16} stroke={2} />
              {projects.length === 0 ? "Create your first project" : "Create project"}
            </Button>
          ) : null}
        />
      )}
      filterBar={
        projects.length > 0 ? (
          <ProjectsToolbar
            viewMode={viewMode}
            onViewModeChange={handleViewModeChange}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            sortBy={sortBy}
            onSortChange={setSortBy}
          />
        ) : null
      }
    >
      {projects.length === 0 ? (
        <EmptyStateBlock
          title="No projects yet"
          description={
            canCreateProject
              ? "Create a Tesbo Test Manager project for full E2E test management."
              : "You do not have project access yet. Ask your manager to grant access."
          }
          action={canCreateProject ? (
            <Button onClick={() => setCreateOpen(true)}>
              <IconPlus size={16} stroke={2} />
              Create first project
            </Button>
          ) : null}
        />
      ) : null}

      {projects.length > 0 && filteredProjects.length === 0 ? (
        <EmptyStateBlock
          title="No projects match your search"
          description={`No projects found for "${searchQuery.trim()}". Try a different name or keyword.`}
        />
      ) : null}

      <Modal open={createOpen} onClose={closeCreate} title="Create project">
        <form onSubmit={handleCreate} className="space-y-5">
          <Field>
            <div className="flex items-baseline justify-between">
              <FieldLabel htmlFor="create-name">Name *</FieldLabel>
              <span className="text-[12px] text-[var(--muted)]">
                {createName.length}/{PROJECT_NAME_MAX_LENGTH}
              </span>
            </div>
            <Input
                  id="create-name"
                  type="text"
                  value={createName}
                  onChange={(e) => {
                    const value = e.target.value;
                    setCreateName(value);
                    if (createNameError && !validateProjectName(value)) setCreateNameError("");
                  }}
                  placeholder="My Project"
                  disabled={createLoading}
                  maxLength={PROJECT_NAME_MAX_LENGTH}
                  autoFocus
                />
            {createNameError && <FieldError>{createNameError}</FieldError>}
          </Field>
          <ProjectIconPicker
            value={createIcon}
            onChange={setCreateIcon}
            fallbackColor="#7C5FCC"
            fallbackGlyph={createName.trim().charAt(0).toUpperCase() || "P"}
            glyphError={createIconGlyphError}
            onGlyphErrorChange={setCreateIconGlyphError}
            disabled={createLoading}
          />
          <Field>
            <div className="flex items-baseline justify-between">
              <FieldLabel htmlFor="create-key">Key (optional)</FieldLabel>
              <span className="text-[12px] text-[var(--muted)]">
                {createKey.length}/{PROJECT_KEY_MAX_LENGTH}
              </span>
            </div>
            <Input
                  id="create-key"
                  type="text"
                  value={createKey}
                  onChange={(e) => {
                    const value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
                    setCreateKey(value);
                    if (createKeyError && !validateProjectKey(value)) setCreateKeyError("");
                  }}
                  placeholder="PROJ"
                  className="font-mono"
                  disabled={createLoading}
                  maxLength={PROJECT_KEY_MAX_LENGTH}
                />
            <FieldHint>Short code; derived from name if blank.</FieldHint>
            {createKeyError && <FieldError>{createKeyError}</FieldError>}
          </Field>
          <Field>
            <div className="flex items-baseline justify-between">
              <FieldLabel htmlFor="create-desc">Description (optional)</FieldLabel>
              <span className="text-[12px] text-[var(--muted)]">
                {createDescription.length}/{PROJECT_DESCRIPTION_MAX_LENGTH}
              </span>
            </div>
            <Textarea
                  id="create-desc"
                  value={createDescription}
                  onChange={(e) => {
                    const value = e.target.value;
                    setCreateDescription(value);
                    if (createDescriptionError && !validateProjectDescription(value)) setCreateDescriptionError("");
                  }}
                  rows={2}
                  disabled={createLoading}
                  maxLength={PROJECT_DESCRIPTION_MAX_LENGTH}
                />
            {createDescriptionError && <FieldError>{createDescriptionError}</FieldError>}
          </Field>
          {createError && <FieldError>{createError}</FieldError>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={closeCreate}>
              Cancel
            </Button>
            <Button type="submit" disabled={createLoading}>
              {createLoading ? "Creating…" : "Create project"}
            </Button>
          </div>
        </form>
      </Modal>

      {filteredProjects.length > 0 && (
        <div className="mt-6">
          <div className="mb-4 flex items-center gap-2">
            <IconFolders size={15} stroke={1.75} className="text-[var(--muted-soft)]" />
            <span className="text-xs font-medium uppercase tracking-[0.06em] text-[var(--muted)]">Tesbo Test Manager Projects</span>
            <span className="rounded-full bg-[var(--surface-secondary)] px-2 py-0.5 text-[11px] font-medium text-[var(--muted)]">{filteredProjects.length}</span>
          </div>

          {viewMode === "grid" ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredProjects.map((p) => {
                const icon = resolveProjectIcon(p.id, p.name, p.icon);
                return (
                  <Link key={p.id} href={`/projects/${p.id}/dashboard`} className="group block cursor-pointer">
                    {/* Hover border/shadow live in globals.css (a.group:hover > .tesbo-card) — see
                        the comment there for why this isn't a Tailwind hover: utility. */}
                    <Card className="flex h-full flex-col overflow-hidden p-0 transition">
                      <div className="border-b border-[var(--border-subtle)] p-5">
                        <div className="mb-2.5 flex items-start gap-3">
                          <div
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white"
                            style={{ background: icon.color }}
                          >
                            {icon.glyph}
                          </div>
                          <div className="min-w-0 flex-1">
                            <h2 className="truncate text-[15px] font-medium leading-5 text-[var(--foreground)] group-hover:text-[var(--accent-light)]">
                              {p.name}
                            </h2>
                            <span className="mt-0.5 block font-mono text-[11px] uppercase tracking-wide text-[var(--muted-soft)]">
                              {p.key}
                            </span>
                          </div>
                          <StatusBadge status={p.status} pending={!p.statsLoaded} />
                        </div>
                        <p className="line-clamp-2 text-[13px] leading-6 text-[var(--muted)]">
                          {p.description || "Add project context to guide test case planning and execution."}
                        </p>
                      </div>

                      <div className="border-b border-[var(--border-subtle)] p-5">
                        <div className="grid grid-cols-3 gap-2">
                          <div className="border-r border-[var(--border-subtle)] pr-2 text-center">
                            <div className="text-xl font-semibold tracking-tight text-[var(--foreground)]">{p.statsLoaded ? p.testCaseCount : "—"}</div>
                            <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Test cases</div>
                          </div>
                          <div className="border-r border-[var(--border-subtle)] px-2 text-center">
                            <div className="text-xl font-semibold tracking-tight text-[var(--foreground)]">{p.statsLoaded ? p.suiteCount : "—"}</div>
                            <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Total Suites</div>
                          </div>
                          <div className="pl-2 text-center">
                            <div className="text-xl font-semibold tracking-tight" style={{ color: passRateTextColor(p.currentPassRate) }}>
                              {p.currentPassRate !== null ? `${p.currentPassRate}%` : "—"}
                            </div>
                            <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Pass rate</div>
                          </div>
                        </div>
                        {p.runCounts ? <PassRateBar counts={p.runCounts} /> : null}
                      </div>

                      <div className="flex items-center justify-between gap-3 p-5">
                        <TeamAvatars team={p.teamMembers} pending={!p.statsLoaded} />
                        <span className="whitespace-nowrap font-mono text-[11px] text-[var(--muted-soft)]">
                          {p.lastActivityAt ? formatRelativeTime(p.lastActivityAt) : `Created ${formatRelativeTime(p.createdAt)}`}
                        </span>
                      </div>
                    </Card>
                  </Link>
                );
              })}
            </div>
          ) : (
            <Card className="overflow-hidden p-0">
              <div
                className="grid items-center gap-0 border-b border-[var(--border-subtle)] px-5 py-2.5"
                style={{ gridTemplateColumns: "1fr 120px 90px 100px 110px 160px 100px" }}
              >
                <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Project</div>
                <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Status</div>
                <div className="text-center text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Test cases</div>
                <div className="text-center text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Total Suites</div>
                <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Pass rate</div>
                <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Team</div>
                <div className="text-right text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Updated</div>
              </div>
              {filteredProjects.map((p, idx) => {
                const icon = resolveProjectIcon(p.id, p.name, p.icon);
                // `last:border-b-0` doesn't work here: each row's border-carrying div is wrapped in
                // its own <Link>, so it's trivially the :last-child of that single-child parent on
                // every row, not just the last project — CSS never sees "last in this list", only
                // "last sibling under this specific parent". Computed from array position instead.
                const isLastRow = idx === filteredProjects.length - 1;
                return (
                  <Link key={p.id} href={`/projects/${p.id}/dashboard`} className="group block cursor-pointer">
                    <div
                      className={`grid items-center gap-0 px-5 py-3 transition-colors hover:bg-[var(--surface-secondary)] ${isLastRow ? "" : "border-b border-[var(--border-subtle)]"}`}
                      style={{ gridTemplateColumns: "1fr 120px 90px 100px 110px 160px 100px" }}
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold text-white" style={{ background: icon.color }}>
                          {icon.glyph}
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-[var(--foreground)] group-hover:text-[var(--accent-light)]">{p.name}</div>
                          <div className="font-mono text-[11px] uppercase text-[var(--muted-soft)]">{p.key}</div>
                        </div>
                      </div>
                      <div>
                        <StatusBadge status={p.status} pending={!p.statsLoaded} />
                      </div>
                      <div className="text-center text-[13px] font-medium text-[var(--foreground)]">{p.statsLoaded ? p.testCaseCount : "—"}</div>
                      <div className="text-center text-[13px] font-medium text-[var(--foreground)]">{p.statsLoaded ? p.suiteCount : "—"}</div>
                      <div>
                        {p.currentPassRate !== null ? (
                          <div className="flex items-center gap-2">
                            {p.runCounts ? (
                              <PassRateBarCompact counts={p.runCounts} />
                            ) : (
                              <div className="h-1 max-w-[60px] flex-1 overflow-hidden rounded-full bg-[var(--surface-secondary)]">
                                <div className="h-full rounded-full" style={{ width: `${p.currentPassRate}%`, background: "var(--status-pass-dot)" }} />
                              </div>
                            )}
                            <span className="text-xs font-medium" style={{ color: passRateTextColor(p.currentPassRate) }}>{p.currentPassRate}%</span>
                            {p.runCounts && p.runCounts.failed > 0 && (
                              <span className="whitespace-nowrap text-[11px]" style={{ color: "var(--status-fail-text)" }}>
                                {p.runCounts.failed} failed
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-[var(--muted-soft)]">{p.statsLoaded ? "No runs yet" : "—"}</span>
                        )}
                      </div>
                      <TeamAvatars team={p.teamMembers} pending={!p.statsLoaded} />
                      <div className="text-right font-mono text-[11px] text-[var(--muted-soft)]">
                        {p.lastActivityAt ? formatRelativeTime(p.lastActivityAt) : formatRelativeTime(p.createdAt)}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </Card>
          )}
        </div>
      )}
    </ListWorkspaceLayout>
  );
}

export default function ProjectsPage() {
  return (
    <Suspense fallback={<PageLoader variant="screen" />}>
      <ProjectsPageContent />
    </Suspense>
  );
}
