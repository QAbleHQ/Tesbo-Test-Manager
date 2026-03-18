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

/* ───── Status badge colors ───── */
function statusColor(status: string) {
  switch (status) {
    case "Planning":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
    case "In Progress":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";
    case "Hold":
      return "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300";
    case "Completed":
      return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
}

type ProjectSettingsPayload = {
  testRunEnvironments?: Array<{ name?: string; url?: string }>;
};

/* ───── Modal wrapper ───── */
function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white dark:bg-zinc-900 rounded-xl shadow-2xl w-full max-w-lg mx-4 p-6">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-4">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

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
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            Test Runs
          </h1>
          <p className="mt-1 text-zinc-500 text-sm">
            Create and manage test runs to track execution progress.
          </p>
        </div>
        {canManageRuns && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                resetForm();
                setFormError(null);
                setShowCreate(true);
              }}
              className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-sm font-medium transition-colors"
            >
              + New Test Run
            </button>
            <Link
              href={`/projects/${projectId}/cycles/schedule`}
              className="rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              Schedule Run
            </Link>
          </div>
        )}
      </div>

      {/* Empty state */}
      {runs.length === 0 && (
        <div className="text-center py-20 text-zinc-400">
          <svg className="mx-auto w-12 h-12 mb-3 text-zinc-300 dark:text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
          <p className="text-sm">
            {canManageRuns
              ? "No test runs yet. Create one to get started."
              : "No test runs have been created for this project yet."}
          </p>
        </div>
      )}

      {/* Cards list */}
      <div className="grid gap-4">
        {runs.map((r) => {
          const total = r.totalCases;
          const passRate = total > 0 ? Math.round((r.passed / total) * 100) : 0;
          return (
            <div
              key={r.id}
              className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1">
                    {r.externalId && (
                      <span className="shrink-0 rounded bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 font-mono text-xs font-medium text-zinc-600 dark:text-zinc-400">
                        {r.externalId}
                      </span>
                    )}
                    <Link
                      href={`/projects/${projectId}/cycles/${r.id}`}
                      className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 hover:text-blue-600 dark:hover:text-blue-400 truncate"
                    >
                      {r.name}
                    </Link>
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColor(
                        r.status
                      )}`}
                    >
                      {r.status}
                    </span>
                  </div>
                  {r.description && (
                    <p className="text-sm text-zinc-500 dark:text-zinc-400 truncate mb-2">
                      {r.description}
                    </p>
                  )}
                  <div className="flex items-center gap-4 text-xs text-zinc-400">
                    {r.environment && <span>Env: {r.environment}</span>}
                    {r.buildVersion && <span>Build: {r.buildVersion}</span>}
                    <span>{new Date(r.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>

                {/* Quick stats */}
                <div className="flex items-center gap-4 ml-4 shrink-0">
                  <div className="text-center">
                    <p className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
                      {total}
                    </p>
                    <p className="text-xs text-zinc-400">Cases</p>
                  </div>
                  {total > 0 && (
                    <div className="text-center">
                      <p className="text-lg font-bold text-green-600">{passRate}%</p>
                      <p className="text-xs text-zinc-400">Pass</p>
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
                        className="p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
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
                        className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-zinc-400 hover:text-red-600"
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
            </div>
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
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sprint 42 Regression"
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
              autoFocus
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                Environment <span className="text-red-500">*</span>
              </label>
              <select
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
                required
              >
                <option value="">Select environment</option>
                {environmentOptions.map((env) => (
                  <option key={env.name} value={env.name}>
                    {env.name}
                  </option>
                ))}
              </select>
              {environment && (
                <p className="mt-1 text-xs text-zinc-500">
                  URL: {environmentOptions.find((item) => item.name === environment)?.url ?? "Not available"}
                </p>
              )}
              {environmentOptions.length === 0 && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  No environments configured. Add one in{" "}
                  <Link href={`/projects/${projectId}/settings?tab=general`} className="underline">
                    Project settings
                  </Link>
                  .
                </p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                Build Version
              </label>
              <input
                type="text"
                value={buildVersion}
                onChange={(e) => setBuildVersion(e.target.value)}
                placeholder="e.g. v2.4.1"
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
              />
            </div>
          </div>
          {formError && (
            <p className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {formError}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => { setShowCreate(false); setFormError(null); }}
              className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim() || !environment.trim() || environmentOptions.length === 0}
              className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {saving ? "Creating…" : "Create"}
            </button>
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
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
              autoFocus
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                Environment <span className="text-red-500">*</span>
              </label>
              <select
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
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
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                Build Version
              </label>
              <input
                type="text"
                value={buildVersion}
                onChange={(e) => setBuildVersion(e.target.value)}
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
              />
            </div>
          </div>
          {formError && (
            <p className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {formError}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => {
                setEditRun(null);
                resetForm();
                setFormError(null);
              }}
              className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !environment.trim()}
              className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </form>
      </Modal>

      {/* Delete Confirm Modal */}
      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete Test Run"
      >
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-6">
          Are you sure you want to delete{" "}
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">
            {deleteTarget?.name}
          </span>
          ? This will remove all associated test case executions. This action
          cannot be undone.
        </p>
        {formError && (
          <p className="mb-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {formError}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={() => { setDeleteTarget(null); setFormError(null); }}
            className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            disabled={saving}
            className="rounded-lg bg-red-600 hover:bg-red-700 text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {saving ? "Deleting…" : "Delete"}
          </button>
        </div>
      </Modal>
    </main>
  );
}
