"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  authMe,
  listPlans,
  createPlan,
  deletePlan,
  getProject,
  listProjectMembers,
  type PlanListItem,
} from "@/lib/api";
import { computePassRate } from "@/lib/executionMetrics";
import {
  Button,
  Input,
  Field,
  FieldLabel,
  Card,
  EmptyStateBlock,
  PageLoader,
} from "@/components/ui";
import { PageHeader, ListWorkspaceLayout } from "@/components/workflows";
import { PlanCard, planStatus, type PlanStatus } from "@/components/testplans/PlanCard";
import { readStoredValue, writeStoredValue } from "@/lib/storage";
import {
  IconArrowsSort,
  IconChevronDown,
  IconClipboardList,
  IconFilter,
  IconLayoutGrid,
  IconList,
  IconSearch,
  IconX,
} from "@tabler/icons-react";

type StatusFilter = "all" | PlanStatus;
// Exact same option set as the Projects list's sort menu (app/(app)/projects/page.tsx).
type SortBy = "updated" | "created" | "name_asc" | "name_desc";

const VIEW_STORAGE_KEY = "tesbo_plans_view";
const SORT_OPTIONS: Array<{ value: SortBy; label: string }> = [
  { value: "updated", label: "Last updated" },
  { value: "created", label: "Newest created" },
  { value: "name_asc", label: "Name (A–Z)" },
  { value: "name_desc", label: "Name (Z–A)" },
];

// Same dropdown interaction as the Projects list's sort control (click to open, pick directly)
// instead of a single button that silently cycled through options one click at a time.
function PlanSortMenu({ sortBy, onSortChange }: { sortBy: SortBy; onSortChange: (v: SortBy) => void }) {
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
        className="flex h-8 cursor-pointer items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--muted)] transition-colors hover:border-[var(--brand-primary)]"
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
              className={`flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-[var(--surface-secondary)] ${
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

function overallPassRate(plans: PlanListItem[]): number | null {
  const passed = plans.reduce((sum, p) => sum + p.passed, 0);
  const failed = plans.reduce((sum, p) => sum + p.failed, 0);
  const blocked = plans.reduce((sum, p) => sum + p.blocked, 0);
  return computePassRate({ passed, failed, blocked });
}

export default function PlansPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.id as string;
  const [plans, setPlans] = useState<PlanListItem[]>([]);
  const [ownerNames, setOwnerNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newRelease, setNewRelease] = useState("");
  const [canManagePlans, setCanManagePlans] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [statusFilterOpen, setStatusFilterOpen] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>("updated");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  useEffect(() => {
    const saved = readStoredValue(VIEW_STORAGE_KEY);
    if (saved === "grid" || saved === "list") setViewMode(saved);
  }, []);

  function handleViewModeChange(next: "grid" | "list") {
    setViewMode(next);
    writeStoredValue(VIEW_STORAGE_KEY, next);
  }

  useEffect(() => {
    if (searchParams.get("create") === "1") {
      setShowCreate(true);
    }
  }, [searchParams]);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      Promise.all([
        listPlans(projectId),
        getProject(projectId),
        listProjectMembers(projectId).catch(() => []),
      ])
        .then(([plansData, projectData, members]) => {
          setPlans(plansData);
          const myRole = typeof projectData.myRole === "string" ? projectData.myRole.toLowerCase() : "";
          setCanManagePlans(!myRole || ["owner", "admin", "manager"].includes(myRole));
          setOwnerNames(Object.fromEntries(members.map((m) => [m.userId, m.name || m.email || "Unknown user"])));
        })
        .catch(() => router.replace("/projects"))
        .finally(() => setLoading(false));
    });
  }, [projectId, router]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const p = await createPlan(projectId, {
        name: newName.trim(),
        description: newDesc.trim() || undefined,
        targetRelease: newRelease.trim() || undefined,
      });
      router.push(`/projects/${projectId}/plans/${p.id}`);
      router.refresh();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create test plan.");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(plan: PlanListItem) {
    if (!confirm(`Delete "${plan.name}"? Associated runs will not be deleted but will be unlinked.`)) return;
    const previous = plans;
    setPlans((list) => list.filter((p) => p.id !== plan.id));
    try {
      await deletePlan(plan.id);
    } catch {
      setPlans(previous);
    }
  }

  const filteredPlans = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = plans.filter((plan) => {
      const matchesSearch =
        !query ||
        plan.name.toLowerCase().includes(query) ||
        plan.description.toLowerCase().includes(query);
      const matchesStatus = statusFilter === "all" || planStatus(plan) === statusFilter;
      return matchesSearch && matchesStatus;
    });
    const sorted = [...filtered];
    // Same four options, same tie-break logic as Projects' sortProjects() —
    // lastRunAt is this list's equivalent of a project's lastActivityAt.
    switch (sortBy) {
      case "name_asc":
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "name_desc":
        sorted.sort((a, b) => b.name.localeCompare(a.name));
        break;
      case "created":
        sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        break;
      case "updated":
      default:
        sorted.sort((a, b) => {
          const aTime = new Date(a.lastRunAt ?? a.createdAt).getTime();
          const bTime = new Date(b.lastRunAt ?? b.createdAt).getTime();
          return bTime - aTime;
        });
        break;
    }
    return sorted;
  }, [plans, searchQuery, statusFilter, sortBy]);

  const activeCount = plans.filter((p) => planStatus(p) === "active").length;
  const draftCount = plans.filter((p) => planStatus(p) === "draft").length;
  const passRate = overallPassRate(plans);

  if (loading) {
    return <PageLoader variant="screen" label="Loading plans…" />;
  }

  return (
    <ListWorkspaceLayout
      header={
        <PageHeader
          title="Test plans"
          subtitle="Organise test runs and track overall testing progress."
          actions={
            canManagePlans ? (
              <Button variant="primary" onClick={() => setShowCreate(!showCreate)}>
                New test plan
              </Button>
            ) : undefined
          }
        />
      }
    >
      {/* Create form */}
      {showCreate && (
        <Card className="p-5">
          <form onSubmit={handleCreate}>
            <h2 className="text-sm font-semibold text-[var(--foreground)] mb-4">Create Test Plan</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field className="sm:col-span-2">
                <FieldLabel>Plan Name *</FieldLabel>
                <Input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Sprint 12 Regression"
                  autoFocus
                />
              </Field>
              <Field>
                <FieldLabel>Description</FieldLabel>
                <Input
                  type="text"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="Optional description"
                />
              </Field>
              <Field>
                <FieldLabel>Target Release</FieldLabel>
                <Input
                  type="text"
                  value={newRelease}
                  onChange={(e) => setNewRelease(e.target.value)}
                  placeholder="e.g. v2.1.0"
                />
              </Field>
            </div>
            {createError && (
              <p className="mt-3 rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/10 px-3 py-2 text-sm text-[var(--error-foreground)]">
                {createError}
              </p>
            )}
            <div className="flex items-center gap-3 mt-4">
              <Button type="submit" disabled={creating || !newName.trim()}>
                {creating ? "Creating..." : "Create Test Plan"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => { setShowCreate(false); setNewName(""); setNewDesc(""); setNewRelease(""); setCreateError(null); }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {plans.length === 0 ? (
        <EmptyStateBlock
          title="No test plans yet"
          description={
            canManagePlans
              ? "Create your first test plan to organize test runs and track progress."
              : "No test plans have been created for this project yet."
          }
          icon={<IconClipboardList size={48} stroke={1.25} className="text-[var(--ink-300)]" />}
          action={
            canManagePlans ? (
              <Button variant="primary" onClick={() => setShowCreate(true)}>
                Create Test Plan
              </Button>
            ) : undefined
          }
          className="border border-dashed border-[var(--border)]"
        />
      ) : (
        <>
          {/* Stats row */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-center">
              <div className="text-[16px] font-semibold leading-tight tracking-tight text-[var(--foreground)]">{plans.length}</div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Total</div>
            </div>
            <div className="rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-center">
              <div className="text-[16px] font-semibold leading-tight tracking-tight text-[var(--status-pass-text)]">{activeCount}</div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Active</div>
            </div>
            <div className="rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-center">
              <div className="text-[16px] font-semibold leading-tight tracking-tight text-[var(--muted)]">{draftCount}</div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Draft</div>
            </div>
            <div className="flex-1" />
            <div className="flex items-center gap-2 rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--status-pass-dot)" }} />
              <div>
                <div className="text-[13px] font-semibold leading-tight text-[var(--foreground)]">{passRate !== null ? `${passRate}%` : "—"}</div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Overall pass rate</div>
              </div>
            </div>
          </div>

          {/* Toolbar */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <label className="flex h-[30px] min-w-[200px] max-w-[280px] flex-1 items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[12px] text-[var(--muted-soft)] transition-colors focus-within:border-[var(--brand-primary)]">
              <IconSearch size={13} stroke={1.75} className="shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search plans..."
                className="min-w-0 flex-1 bg-transparent text-[var(--foreground)] outline-none placeholder:text-[var(--muted-soft)]"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  aria-label="Clear search"
                  className="shrink-0 cursor-pointer rounded-full p-0.5 text-[var(--muted-soft)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
                >
                  <IconX size={12} stroke={2} />
                </button>
              )}
            </label>
            <button
              type="button"
              onClick={() => setStatusFilterOpen((v) => !v)}
              className="flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[6px] border px-3 text-[12px] font-medium transition-colors"
              style={
                statusFilter !== "all"
                  ? { borderColor: "var(--brand-primary)", color: "var(--accent-light)", background: "var(--brand-soft)" }
                  : { borderColor: "var(--border)", color: "var(--muted)", background: "var(--surface)" }
              }
            >
              <IconFilter size={13} stroke={1.75} />
              Status
              {statusFilter !== "all" && (
                <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--brand-primary)] text-[9px] font-semibold text-white">1</span>
              )}
            </button>
            <PlanSortMenu sortBy={sortBy} onSortChange={setSortBy} />
            <div className="flex-1" />
            <div className="flex items-center gap-0.5 rounded-[6px] bg-[var(--surface-secondary)] p-[3px]">
              <button
                type="button"
                onClick={() => handleViewModeChange("grid")}
                aria-label="Grid view"
                aria-pressed={viewMode === "grid"}
                className="flex h-[26px] w-7 cursor-pointer items-center justify-center rounded-[4px] transition-colors"
                style={{ background: viewMode === "grid" ? "var(--surface)" : "transparent", color: viewMode === "grid" ? "var(--brand-primary)" : "var(--muted-soft)" }}
              >
                <IconLayoutGrid size={15} stroke={1.75} />
              </button>
              <button
                type="button"
                onClick={() => handleViewModeChange("list")}
                aria-label="List view"
                aria-pressed={viewMode === "list"}
                className="flex h-[26px] w-7 cursor-pointer items-center justify-center rounded-[4px] transition-colors"
                style={{ background: viewMode === "list" ? "var(--surface)" : "transparent", color: viewMode === "list" ? "var(--brand-primary)" : "var(--muted-soft)" }}
              >
                <IconList size={15} stroke={1.75} />
              </button>
            </div>
          </div>

          {/* Status filter chips */}
          {statusFilterOpen && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {(["all", "active", "draft"] as StatusFilter[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setStatusFilter(option)}
                  className="cursor-pointer rounded-full border px-3 py-[3px] text-[11.5px] font-medium capitalize transition-colors"
                  style={
                    statusFilter === option
                      ? { borderColor: "var(--brand-primary)", color: "var(--accent-light)", background: "var(--brand-soft)" }
                      : { borderColor: "var(--border)", color: "var(--muted)" }
                  }
                >
                  {option}
                </button>
              ))}
            </div>
          )}

          {/* Plan cards */}
          {filteredPlans.length === 0 ? (
            <div className="mt-6 flex flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--border)] py-14 text-center">
              <p className="text-[14px] font-medium text-[var(--foreground)]">No test plans found</p>
              <p className="text-[13px] text-[var(--muted-soft)]">Try adjusting your search or filters.</p>
              <button
                type="button"
                onClick={() => { setSearchQuery(""); setStatusFilter("all"); }}
                className="flex cursor-pointer items-center gap-1 text-[12px] font-medium text-[var(--accent-light)] hover:underline"
              >
                <IconX size={12} stroke={2} />
                Clear filters
              </button>
            </div>
          ) : (
            <div
              className={
                viewMode === "grid"
                  ? "mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2"
                  : "mt-4 flex flex-col gap-3"
              }
            >
              {filteredPlans.map((plan) => (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  projectId={projectId}
                  ownerName={plan.ownerId ? ownerNames[plan.ownerId] ?? null : null}
                  canManage={canManagePlans}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}
        </>
      )}
    </ListWorkspaceLayout>
  );
}
