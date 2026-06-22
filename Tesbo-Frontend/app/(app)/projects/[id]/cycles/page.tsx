"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { IconPencil, IconTrash, IconCalendarEvent, IconPlayerPlay } from "@tabler/icons-react";
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
  const searchParams = useSearchParams();
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

  useEffect(() => {
    if (searchParams.get("create") === "1") {
      resetForm();
      setFormError(null);
      setShowCreate(true);
    }
  }, [searchParams]);

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
        const myRole = typeof project.myRole === "string" ? project.myRole.toLowerCase() : "";
        setCanManageRuns(!myRole || ["owner", "admin", "manager"].includes(myRole));
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
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--ink-200)] border-t-[var(--denim)]" />
          <p className="text-[13px] text-[var(--ink-400)]">Loading runs…</p>
        </div>
      </div>
    );
  }

  const emptyIcon = <IconPlayerPlay size={48} stroke={1.25} className="text-[var(--ink-300)]" />;

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
                  Create Test Run
                </Button>
                <Link
                  href={`/projects/${projectId}/cycles/schedule`}
                  className="inline-flex h-9 items-center gap-2 rounded-[6px] border border-[var(--ink-200)] px-4 text-[13px] font-medium text-[var(--ink-600)] transition-colors hover:bg-[var(--ink-100)]"
                >
                  <IconCalendarEvent size={15} stroke={1.75} />
                  Schedule
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
              Create Test Run
            </Button>
          ) : undefined}
        />
      )}

      {/* Cards list */}
      <div className="grid gap-3">
        {runs.map((r) => {
          const total = r.totalCases;
          const passRate = total > 0 ? Math.round((r.passed / total) * 100) : null;
          const passRateColor =
            passRate === null ? "var(--ink-400)"
            : passRate >= 80 ? "var(--status-pass-text)"
            : passRate >= 50 ? "var(--status-blocked-text)"
            : "var(--status-fail-text)";
          return (
            <Card key={r.id} className="p-5 transition-colors hover:border-[var(--border-strong)]">
              <div className="flex items-start justify-between gap-4">
                {/* Left: name + meta */}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/projects/${projectId}/cycles/${r.id}`}
                      className="text-[15px] font-medium text-[var(--ink-800)] hover:text-[var(--denim)] transition-colors"
                    >
                      {r.name}
                    </Link>
                    <StatusChip tone={statusTone(r.status)}>{r.status}</StatusChip>
                  </div>
                  {r.description && (
                    <p className="mt-1 line-clamp-1 text-[13px] text-[var(--ink-400)]">
                      {r.description}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px] text-[var(--ink-400)]">
                    {r.environment && (
                      <span className="rounded bg-[var(--ink-50)] px-2 py-0.5 font-medium">
                        {r.environment}
                      </span>
                    )}
                    {r.buildVersion && (
                      <span className="rounded bg-[var(--ink-50)] px-2 py-0.5 font-mono">
                        {r.buildVersion}
                      </span>
                    )}
                    <span>{new Date(r.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>

                {/* Right: stats + actions */}
                <div className="flex shrink-0 items-center gap-5">
                  <div className="text-right">
                    <p className="text-[18px] font-semibold leading-none text-[var(--ink-800)]">{total}</p>
                    <p className="mt-1 text-[11px] text-[var(--ink-400)]">cases</p>
                  </div>
                  <div className="text-right">
                    {passRate !== null ? (
                      <>
                        <p className="text-[18px] font-semibold leading-none" style={{ color: passRateColor }}>{passRate}%</p>
                        <p className="mt-1 text-[11px] text-[var(--ink-400)]">pass rate</p>
                      </>
                    ) : (
                      <>
                        <p className="text-[18px] font-semibold leading-none text-[var(--ink-300)]">—</p>
                        <p className="mt-1 text-[11px] text-[var(--ink-400)]">no cases</p>
                      </>
                    )}
                  </div>

                  {canManageRuns && (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); setFormError(null); openEdit(r); }}
                        className="rounded-[6px] p-1.5 text-[var(--ink-400)] transition-colors hover:bg-[var(--ink-100)] hover:text-[var(--ink-800)]"
                        title="Edit"
                      >
                        <IconPencil size={15} stroke={1.75} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setFormError(null); setDeleteTarget(r); }}
                        className="rounded-[6px] p-1.5 text-[var(--ink-400)] transition-colors hover:bg-[var(--status-fail-fill)] hover:text-[var(--status-fail-text)]"
                        title="Delete"
                      >
                        <IconTrash size={15} stroke={1.75} />
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
              {saving ? "Creating…" : "Create Test Run"}
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
