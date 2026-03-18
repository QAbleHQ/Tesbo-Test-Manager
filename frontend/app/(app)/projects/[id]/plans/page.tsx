"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { authMe, listPlans, createPlan, getProject, type PlanListItem } from "@/lib/api";
import {
  Button,
  Input,
  Field,
  FieldLabel,
  Card,
  EmptyStateBlock,
} from "@/components/ui";
import { PageHeader, ListWorkspaceLayout } from "@/components/workflows";

function StatusBadge({ count, label, color }: { count: number; label: string; color: string }) {
  if (count === 0) return null;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${color}`}>
      <span className="w-2 h-2 rounded-full bg-current" />
      {count} {label}
    </span>
  );
}

function ProgressBar({ passed, failed, untested, total }: { passed: number; failed: number; untested: number; total: number }) {
  if (total === 0) return <div className="h-2 rounded-full bg-[var(--surface-tertiary)] w-full" />;
  const pPassed = (passed / total) * 100;
  const pFailed = (failed / total) * 100;
  const other = 100 - pPassed - pFailed;
  return (
    <div className="h-2 rounded-full bg-[var(--surface-tertiary)] w-full overflow-hidden flex">
      {pPassed > 0 && <div className="bg-emerald-500 h-full transition-all" style={{ width: `${pPassed}%` }} />}
      {pFailed > 0 && <div className="bg-red-500 h-full transition-all" style={{ width: `${pFailed}%` }} />}
      {other > 0 && <div className="bg-[var(--surface-secondary)] h-full transition-all" style={{ width: `${other}%` }} />}
    </div>
  );
}

export default function PlansPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const [plans, setPlans] = useState<PlanListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newRelease, setNewRelease] = useState("");
  const [canManagePlans, setCanManagePlans] = useState(false);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      Promise.all([
        listPlans(projectId),
        getProject(projectId),
      ])
        .then(([plansData, projectData]) => {
          setPlans(plansData as unknown as PlanListItem[]);
          const myRole = (projectData.myRole as string ?? "").toLowerCase();
          setCanManagePlans(["owner", "admin", "manager"].includes(myRole));
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

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-[var(--muted)]">Loading test plans...</p>
        </div>
      </div>
    );
  }

  return (
    <main className="tesbo-page max-w-5xl mx-auto">
      <ListWorkspaceLayout
        header={
          <PageHeader
            title="Test Plans"
            subtitle="Organize test runs and track overall testing progress"
            actions={
              canManagePlans ? (
                <Button
                  variant="primary"
                  onClick={() => setShowCreate(!showCreate)}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  New Plan
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
                <p className="mt-3 rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/10 px-3 py-2 text-sm text-[var(--error)]">
                  {createError}
                </p>
              )}
              <div className="flex items-center gap-3 mt-4">
                <Button type="submit" disabled={creating || !newName.trim()}>
                  {creating ? "Creating..." : "Create Plan"}
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

        {/* Plans list */}
        {plans.length === 0 ? (
          <EmptyStateBlock
            title="No test plans yet"
            description={
              canManagePlans
                ? "Create your first test plan to organize test runs and track progress."
                : "No test plans have been created for this project yet."
            }
            icon={
              <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
            }
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
          <div className="space-y-3">
            {plans.map((plan) => {
              const total = plan.totalCases || 0;
              return (
                <Link key={plan.id} href={`/projects/${projectId}/plans/${plan.id}`}>
                  <Card className="block p-5 hover:border-[var(--brand-primary)]/50 hover:shadow-md transition-all group">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3">
                        <h3 className="text-base font-semibold text-[var(--foreground)] group-hover:text-[var(--brand-primary)] transition-colors truncate">
                          {plan.name}
                        </h3>
                        {plan.targetRelease && (
                          <span className="inline-flex items-center rounded-full bg-[var(--ai-soft)] text-[var(--ai-primary)] px-2.5 py-0.5 text-xs font-medium shrink-0">
                            {plan.targetRelease}
                          </span>
                        )}
                        </div>
                        {plan.description && (
                        <p className="mt-1 text-sm text-[var(--muted)] line-clamp-1">{plan.description}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 ml-4 shrink-0">
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--surface-tertiary)] px-3 py-1 text-xs font-medium text-[var(--muted)]">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                        {plan.runCount} {plan.runCount === 1 ? "run" : "runs"}
                        </span>
                        {total > 0 && (
                          <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-bold ${
                          plan.completionPercent === 100
                            ? "bg-[var(--success-soft)] text-[var(--success)]"
                            : plan.completionPercent > 0
                            ? "bg-[var(--brand-soft)] text-[var(--brand-primary)]"
                            : "bg-[var(--surface-tertiary)] text-[var(--muted)]"
                          }`}>
                            {plan.completionPercent}%
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Progress bar & stats */}
                    {total > 0 && (
                      <div className="mt-4">
                        <ProgressBar passed={plan.passed} failed={plan.failed} untested={plan.untested} total={total} />
                        <div className="flex items-center gap-4 mt-2">
                          <span className="text-xs text-[var(--muted)]">{total} total cases</span>
                          <StatusBadge count={plan.passed} label="passed" color="text-[var(--success)]" />
                          <StatusBadge count={plan.failed} label="failed" color="text-[var(--error)]" />
                          <StatusBadge count={plan.untested} label="untested" color="text-[var(--muted)]" />
                        </div>
                      </div>
                    )}

                    {total === 0 && (
                      <p className="mt-3 text-xs text-[var(--muted-soft)]">No runs associated yet</p>
                    )}
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </ListWorkspaceLayout>
    </main>
  );
}
