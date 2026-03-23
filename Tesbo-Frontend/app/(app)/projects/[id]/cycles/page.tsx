"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  authMe,
  listTestRuns,
  createTestRun,
  updateTestRun,
  deleteTestRun,
  getProject,
  type TestRunListItem,
  type TestEnvironmentSetting,
} from "@/lib/api";
import {
  Button,
  Input,
  Card,
  StatusChip,
  Select,
  EmptyStateBlock,
  Modal,
  Field,
  FieldLabel,
  Textarea,
} from "@/components/ui";
import { PageHeader, ListWorkspaceLayout } from "@/components/workflows";

/* ───── Status badge tone mapping ───── */
function statusTone(status: string): "neutral" | "brand" | "ai" | "success" | "warning" | "error" | "info" {
  switch (status) {
    case "Planning":
      return "warning";
    case "In Progress":
      return "info";
    case "Completed":
      return "success";
    default:
      return "neutral";
  }
}

type ProjectSettingsPayload = {
  testRunEnvironments?: Array<{ name?: string; url?: string }>;
};

export default function TestRunsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [runs, setRuns] = useState<TestRunListItem[]>([]);
  const [loading, setLoading] = useState(true);

  /* modal state */
  const [showCreate, setShowCreate] = useState(false);
  const [editRun, setEditRun] = useState<TestRunListItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TestRunListItem | null>(null);

  /* form fields */
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [environment, setEnvironment] = useState("");
  const [buildVersion, setBuildVersion] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [environmentOptions, setEnvironmentOptions] = useState<TestEnvironmentSetting[]>([]);
  const [canManageRuns, setCanManageRuns] = useState(false);

  function parseProjectSettings(raw: unknown): ProjectSettingsPayload {
    if (typeof raw !== "string" || !raw.trim()) return {};
    try {
      const parsed = JSON.parse(raw) as ProjectSettingsPayload;
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

  const load = useCallback(() => {
    Promise.all([listTestRuns(projectId), getProject(projectId)])
      .then(([runsData, project]) => {
        setRuns(runsData);
        const parsedSettings = parseProjectSettings(project.settings);
        setEnvironmentOptions(normalizeTestRunEnvironments(parsedSettings.testRunEnvironments));
        const myRole = (project.myRole as string ?? "").toLowerCase();
        setCanManageRuns(["owner", "admin", "manager"].includes(myRole));
      })
      .catch(() => {})
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

  /* create */
  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !environment.trim()) return;
    setSaving(true);
    setFormError(null);
    try {
      await createTestRun(projectId, { name, description, environment, buildVersion });
      setShowCreate(false);
      resetForm();
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create test run.");
    } finally {
      setSaving(false);
    }
  }

  /* edit */
  function openEdit(r: TestRunListItem) {
    setEditRun(r);
    setName(r.name);
    setDescription(r.description);
    setEnvironment(r.environment);
    setBuildVersion(r.buildVersion);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editRun || !environment.trim()) return;
    setSaving(true);
    setFormError(null);
    try {
      await updateTestRun(editRun.id, { name, description, environment, buildVersion });
      setEditRun(null);
      resetForm();
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to update test run.");
    } finally {
      setSaving(false);
    }
  }

  /* delete */
  async function handleDelete() {
    if (!deleteTarget) return;
    setSaving(true);
    setFormError(null);
    try {
      await deleteTestRun(deleteTarget.id);
      setDeleteTarget(null);
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to delete test run.");
    } finally {
      setSaving(false);
    }
  }

  function resetForm() {
    setName("");
    setDescription("");
    setEnvironment("");
    setBuildVersion("");
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-[var(--muted)]">Loading…</p>
      </div>
    );
  }

  const emptyIcon = (
    <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
    </svg>
  );

  return (
    <ListWorkspaceLayout
      header={
        <PageHeader
          title="Test Runs"
          subtitle="Create and manage test runs to track execution progress."
          actions={
            canManageRuns ? (
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => {
                    resetForm();
                    setFormError(null);
                    setShowCreate(true);
                  }}
                >
                  + New Test Run
                </Button>
                <Link
                  href={`/projects/${projectId}/cycles/schedule`}
                  className="inline-flex items-center justify-center h-10 rounded-xl px-4 text-sm font-medium border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] hover:bg-[var(--surface-secondary)] transition-colors"
                >
                  Schedule Run
                </Link>
              </div>
            ) : undefined
          }
        />
      }
    >
      {/* Empty state */}
      {runs.length === 0 && (
        <EmptyStateBlock
          title={canManageRuns ? "No test runs yet" : "No test runs have been created"}
          description={canManageRuns ? "Create one to get started." : "No test runs have been created for this project yet."}
          icon={emptyIcon}
          action={canManageRuns ? (
            <Button onClick={() => { resetForm(); setFormError(null); setShowCreate(true); }}>
              + New Test Run
            </Button>
          ) : undefined}
        />
      )}

      {/* Cards list */}
      <div className="grid gap-4">
        {runs.map((r) => {
          const total = r.totalCases;
          const passRate = total > 0 ? Math.round((r.passed / total) * 100) : 0;
          return (
            <Card key={r.id} className="p-5 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1">
                    <Link
                      href={`/projects/${projectId}/cycles/${r.id}`}
                      className="text-lg font-semibold text-[var(--foreground)] hover:text-[var(--brand-primary)] truncate"
                    >
                      {r.name}
                    </Link>
                    <StatusChip tone={statusTone(r.status)}>{r.status}</StatusChip>
                  </div>
                  {r.description && (
                    <p className="text-sm text-[var(--muted)] truncate mb-2">
                      {r.description}
                    </p>
                  )}
                  <div className="flex items-center gap-4 text-xs text-[var(--muted-soft)]">
                    {r.environment && <span>Env: {r.environment}</span>}
                    {r.buildVersion && <span>Build: {r.buildVersion}</span>}
                    <span>{new Date(r.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>

                {/* Quick stats */}
                <div className="flex items-center gap-4 ml-4 shrink-0">
                  <div className="text-center">
                    <p className="text-lg font-bold text-[var(--foreground)]">
                      {total}
                    </p>
                    <p className="text-xs text-[var(--muted-soft)]">Cases</p>
                  </div>
                  {total > 0 && (
                    <div className="text-center">
                      <p className="text-lg font-bold text-[var(--success)]">{passRate}%</p>
                      <p className="text-xs text-[var(--muted-soft)]">Pass</p>
                    </div>
                  )}

                  {/* Actions */}
                  {canManageRuns && (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setFormError(null);
                          openEdit(r);
                        }}
                        className="p-1.5 rounded-lg hover:bg-[var(--surface-secondary)] text-[var(--muted-soft)] hover:text-[var(--muted)]"
                        title="Edit"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setFormError(null);
                          setDeleteTarget(r);
                        }}
                        className="p-1.5 rounded-lg hover:bg-red-50 text-[var(--muted-soft)] hover:text-[var(--error)]"
                        title="Delete"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {/* Create Modal */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Create Test Run"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <Field>
            <FieldLabel>
              Name <span className="text-[var(--error)]">*</span>
            </FieldLabel>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sprint 42 Regression"
              autoFocus
              required
            />
          </Field>
          <Field>
            <FieldLabel>Description</FieldLabel>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel>
                Environment <span className="text-[var(--error)]">*</span>
              </FieldLabel>
              <Select
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
                required
              >
                <option value="">Select environment</option>
                {environmentOptions.map((env) => (
                  <option key={env.name} value={env.name}>
                    {env.name}
                  </option>
                ))}
              </Select>
              {environment && (
                <p className="mt-1 text-xs text-[var(--muted)]">
                  URL: {environmentOptions.find((item) => item.name === environment)?.url ?? "Not available"}
                </p>
              )}
              {environmentOptions.length === 0 && (
                <p className="mt-1 text-xs text-[var(--warning)]">
                  No environments configured. Add one in{" "}
                  <Link href={`/projects/${projectId}/settings?tab=general`} className="underline">
                    Project settings
                  </Link>
                  .
                </p>
              )}
            </Field>
            <Field>
              <FieldLabel>Build Version</FieldLabel>
              <Input
                type="text"
                value={buildVersion}
                onChange={(e) => setBuildVersion(e.target.value)}
                placeholder="e.g. v2.4.1"
              />
            </Field>
          </div>
          {formError && (
            <p className="rounded-lg border border-[var(--error)]/30 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error)]">
              {formError}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => { setShowCreate(false); setFormError(null); }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || !name.trim() || !environment.trim() || environmentOptions.length === 0}
            >
              {saving ? "Creating…" : "Create"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Edit Modal */}
      <Modal
        open={editRun !== null}
        onClose={() => {
          setEditRun(null);
          resetForm();
        }}
        title="Edit Test Run"
      >
        <form onSubmit={handleEdit} className="space-y-4">
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
            />
          </Field>
          <Field>
            <FieldLabel>Description</FieldLabel>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel>
                Environment <span className="text-[var(--error)]">*</span>
              </FieldLabel>
              <Select
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
                required
              >
                <option value="">Select environment</option>
                {environment &&
                  !environmentOptions.some((item) => item.name === environment) && (
                    <option value={environment}>{environment} (legacy)</option>
                  )}
                {environmentOptions.map((env) => (
                  <option key={env.name} value={env.name}>
                    {env.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              <FieldLabel>Build Version</FieldLabel>
              <Input
                type="text"
                value={buildVersion}
                onChange={(e) => setBuildVersion(e.target.value)}
              />
            </Field>
          </div>
          {formError && (
            <p className="rounded-lg border border-[var(--error)]/30 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error)]">
              {formError}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setEditRun(null);
                resetForm();
                setFormError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || !environment.trim()}
            >
              {saving ? "Saving…" : "Save Changes"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete Confirm Modal */}
      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete Test Run"
      >
        <p className="text-sm text-[var(--muted)] mb-6">
          Are you sure you want to delete{" "}
          <span className="font-semibold text-[var(--foreground)]">
            {deleteTarget?.name}
          </span>
          ? This will remove all associated test case executions. This action
          cannot be undone.
        </p>
        {formError && (
          <p className="mb-4 rounded-lg border border-[var(--error)]/30 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error)]">
            {formError}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => { setDeleteTarget(null); setFormError(null); }}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={saving}
          >
            {saving ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </Modal>
    </ListWorkspaceLayout>
  );
}
