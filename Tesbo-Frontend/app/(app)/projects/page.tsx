"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { authMe, listProjects, listTestCases, listSuites, createProject, getWorkspace, listActivity, listProjectMembers } from "@/lib/api";
import type { ProjectSummary } from "@/lib/api";
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
              const [tcRes, suites, activity, members] = await Promise.all([
                listTestCases(p.id, { limit: 1 }),
                listSuites(p.id),
                listActivity(p.id, { limit: 1 }),
                listProjectMembers(p.id),
              ]);
              const lastActivityAt = activity.list[0]?.createdAt ?? null;
              const status: ProjectWithStats["status"] =
                tcRes.total === 0 ? "setup_required" : (lastActivityAt ? "active" : "configured");
              return {
                ...p,
                testCaseCount: tcRes.total,
                suites,
                teamMembers: members.map((m) => ({ userId: m.userId, name: m.name || m.email || "Unknown User" })),
                lastActivityAt,
                status,
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
          subtitle="Workspaces and projects organized for test operations."
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
              ? "Create your first project to start organizing scenarios, runs, and reviews."
              : "You do not have project access yet. Ask your manager to grant access."
          }
          action={canCreateProject ? <Button onClick={() => setCreateOpen(true)}>Create first project</Button> : null}
        />
      ) : null}

      <Modal open={createOpen} onClose={() => !createLoading && setCreateOpen(false)} title="Create project">
        <form onSubmit={handleCreate} className="space-y-4">
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
              {createLoading ? "Creating…" : "Create"}
            </Button>
          </div>
        </form>
      </Modal>

      {projects.length > 0 ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.id}/dashboard`}
              className="group block"
            >
              <Card className="flex h-full flex-col p-5 transition hover:border-[var(--border-strong)]">
              <div className="flex items-start justify-between gap-3">
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
                <p className="mt-2 line-clamp-2 text-sm text-[var(--muted)]">
                  {p.description}
                </p>
              ) : (
                <p className="mt-2 text-sm text-[var(--muted-soft)]">
                  Add project context to guide agent execution and reviews.
                </p>
              )}
              <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-soft)]">Test cases</p>
                  <p className="mt-1 text-base font-semibold text-[var(--foreground)]">{p.testCaseCount}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-soft)]">Suites</p>
                  <p className="mt-1 text-base font-semibold text-[var(--foreground)]">{p.suites.length}</p>
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
              <div className="mt-3 border-t border-[var(--border-subtle)] pt-3 text-sm text-[var(--muted)]">
                {p.lastActivityAt
                  ? `Last updated ${formatRelativeTime(p.lastActivityAt)} · Agent and team activity available`
                  : `Created ${formatRelativeTime(p.createdAt)} · No activity events yet`}
              </div>
              </Card>
            </Link>
          ))}
        </div>
      ) : null}
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
