"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import {
  authMe,
  listBugs,
  createBug,
  updateBug,
  deleteBug,
  type BugItem,
} from "@/lib/api";

/* ───── Status badge ───── */
function BugStatusBadge({ status }: { status: string }) {
  const cls: Record<string, string> = {
    Open: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
    Closed: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    "In Progress": "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
    Reopened: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
        cls[status] || cls.Open
      }`}
    >
      {status}
    </span>
  );
}

/* ───── Modal ───── */
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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 overflow-y-auto">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white dark:bg-zinc-900 rounded-xl shadow-2xl w-full max-w-lg mx-4 p-6 mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            {title}
          </h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        {children}
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
  const [search, setSearch] = useState("");

  /* create modal */
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [createUrl, setCreateUrl] = useState("");
  const [creating, setCreating] = useState(false);

  /* edit modal */
  const [editBug, setEditBug] = useState<BugItem | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editStatus, setEditStatus] = useState("");
  const [saving, setSaving] = useState(false);

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

  /* filtered list */
  const filtered = useMemo(() => {
    return bugs.filter((b) => {
      if (filterStatus && b.status !== filterStatus) return false;
      if (
        search &&
        !b.title.toLowerCase().includes(search.toLowerCase()) &&
        !b.tcTitle.toLowerCase().includes(search.toLowerCase()) &&
        !b.tcExternalId.toLowerCase().includes(search.toLowerCase())
      )
        return false;
      return true;
    });
  }, [bugs, filterStatus, search]);

  /* stats */
  const openCount = bugs.filter((b) => b.status === "Open" || b.status === "Reopened").length;
  const closedCount = bugs.filter((b) => b.status === "Closed").length;

  /* create */
  async function handleCreate() {
    if (!createTitle.trim()) return;
    setCreating(true);
    try {
      await createBug(projectId, {
        title: createTitle.trim(),
        description: createDesc.trim(),
        externalUrl: createUrl.trim(),
      });
      setShowCreate(false);
      setCreateTitle("");
      setCreateDesc("");
      setCreateUrl("");
      load();
    } finally {
      setCreating(false);
    }
  }

  /* open edit */
  function openEdit(bug: BugItem) {
    setEditBug(bug);
    setEditTitle(bug.title);
    setEditDesc(bug.description);
    setEditUrl(bug.externalUrl);
    setEditStatus(bug.status);
  }

  /* save edit */
  async function handleEditSave() {
    if (!editBug || !editTitle.trim()) return;
    setSaving(true);
    try {
      await updateBug(editBug.id, {
        title: editTitle.trim(),
        description: editDesc.trim(),
        externalUrl: editUrl.trim(),
        status: editStatus,
      });
      setEditBug(null);
      load();
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
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-3">
        <div className="flex items-center gap-2 text-sm">
          <Link
            href={`/projects/${projectId}`}
            className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            Project
          </Link>
          <span className="text-zinc-300 dark:text-zinc-600">/</span>
          <span className="text-zinc-900 dark:text-zinc-100 font-medium">
            Bugs
          </span>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6">
        {/* Title + Actions */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
              Bugs
            </h1>
            <p className="text-sm text-zinc-500 mt-1">
              {openCount} open · {closedCount} closed · {bugs.length} total
            </p>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="rounded-lg bg-red-600 hover:bg-red-700 text-white px-4 py-2 text-sm font-medium flex items-center gap-2"
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
                d="M12 4v16m8-8H4"
              />
            </svg>
            Report Bug
          </button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 mb-4">
          <input
            type="text"
            placeholder="Search bugs…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm w-64"
          />
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
          >
            <option value="">All Statuses</option>
            <option value="Open">Open</option>
            <option value="In Progress">In Progress</option>
            <option value="Closed">Closed</option>
            <option value="Reopened">Reopened</option>
          </select>
        </div>

        {/* Table */}
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden bg-white dark:bg-zinc-900">
          {filtered.length === 0 ? (
            <div className="text-center py-12 text-zinc-400 text-sm">
              {bugs.length === 0
                ? "No bugs reported yet. Bugs filed from failed test executions will appear here."
                : "No bugs match your filter."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-200 dark:border-zinc-700 text-left text-xs text-zinc-500 uppercase tracking-wider">
                    <th className="px-5 py-3 font-medium">Title</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 font-medium">Test Case</th>
                    <th className="px-5 py-3 font-medium">Test Run</th>
                    <th className="px-5 py-3 font-medium">Reporter</th>
                    <th className="px-5 py-3 font-medium">Reported</th>
                    <th className="px-5 py-3 font-medium w-8"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {filtered.map((b) => (
                    <tr
                      key={b.id}
                      className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50 cursor-pointer"
                      onClick={() => setViewBug(b)}
                    >
                      <td className="px-5 py-3">
                        <div className="flex flex-col gap-0.5 max-w-sm">
                          <span className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline break-words">
                            {b.title}
                          </span>
                          {b.externalUrl && (
                            <a
                              href={b.externalUrl}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="text-xs text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 hover:underline truncate"
                            >
                              {b.externalUrl}
                            </a>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        <BugStatusBadge status={b.status} />
                      </td>
                      <td className="px-5 py-3">
                        {b.tcTitle ? (
                          <div className="flex flex-col gap-0.5">
                            <span className="text-xs font-mono text-zinc-400">
                              {b.tcExternalId}
                            </span>
                            <span className="text-xs text-zinc-600 dark:text-zinc-400 truncate max-w-[180px]">
                              {b.tcTitle}
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-zinc-400">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <span className="text-xs text-zinc-500">
                          {b.cycleName || "—"}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <span className="text-xs text-zinc-500">
                          {b.reporterName || b.reporterEmail || "—"}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-xs text-zinc-400 whitespace-nowrap">
                        {new Date(b.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => openEdit(b)}
                            className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
                            title="Edit"
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
                          </button>
                          <button
                            onClick={() => setDeletingId(b.id)}
                            className="p-1 text-zinc-400 hover:text-red-500 dark:hover:text-red-400"
                            title="Delete"
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
                                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                              />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
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
                <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 break-words leading-snug">
                  {viewBug.title}
                </h3>
                <BugStatusBadge status={viewBug.status} />
              </div>
            </div>

            {/* Description */}
            {viewBug.description && (
              <div>
                <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide mb-1">
                  Description
                </p>
                <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 p-3">
                  <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words">
                    {viewBug.description}
                  </p>
                </div>
              </div>
            )}

            {/* Bug Link */}
            {viewBug.externalUrl && (
              <div>
                <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide mb-1">
                  Bug Link
                </p>
                <a
                  href={viewBug.externalUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:underline break-all"
                >
                  <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  {viewBug.externalUrl}
                </a>
              </div>
            )}

            {/* Metadata grid */}
            <div className="grid grid-cols-2 gap-4">
              {/* Linked Test Case */}
              <div>
                <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide mb-1">
                  Test Case
                </p>
                {viewBug.tcTitle ? (
                  <div className="flex flex-col">
                    <span className="text-xs font-mono text-zinc-400">{viewBug.tcExternalId}</span>
                    <span className="text-sm text-zinc-700 dark:text-zinc-300">{viewBug.tcTitle}</span>
                  </div>
                ) : (
                  <span className="text-sm text-zinc-400">Not linked</span>
                )}
              </div>

              {/* Linked Test Run */}
              <div>
                <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide mb-1">
                  Test Run
                </p>
                <span className="text-sm text-zinc-700 dark:text-zinc-300">
                  {viewBug.cycleName || "Not linked"}
                </span>
              </div>

              {/* Reporter */}
              <div>
                <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide mb-1">
                  Reported By
                </p>
                <span className="text-sm text-zinc-700 dark:text-zinc-300">
                  {viewBug.reporterName || viewBug.reporterEmail || "Unknown"}
                </span>
              </div>

              {/* Created */}
              <div>
                <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide mb-1">
                  Reported On
                </p>
                <span className="text-sm text-zinc-700 dark:text-zinc-300">
                  {new Date(viewBug.createdAt).toLocaleString()}
                </span>
              </div>
            </div>

            {/* Last updated */}
            {viewBug.updatedAt !== viewBug.createdAt && (
              <p className="text-xs text-zinc-400">
                Last updated: {new Date(viewBug.updatedAt).toLocaleString()}
              </p>
            )}

            {/* Actions */}
            <div className="flex items-center justify-between pt-2 border-t border-zinc-200 dark:border-zinc-700">
              <button
                onClick={() => {
                  setDeletingId(viewBug.id);
                  setViewBug(null);
                }}
                className="text-sm text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 font-medium"
              >
                Delete Bug
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => setViewBug(null)}
                  className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  Close
                </button>
                <button
                  onClick={() => {
                    openEdit(viewBug);
                    setViewBug(null);
                  }}
                  className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-sm font-medium flex items-center gap-1.5"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                  Edit
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* ───── Create Bug Modal ───── */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Report a Bug"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Bug Title <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              placeholder="Brief summary of the bug…"
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Description
            </label>
            <textarea
              value={createDesc}
              onChange={(e) => setCreateDesc(e.target.value)}
              rows={3}
              placeholder="Steps to reproduce, expected vs actual behavior…"
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Bug Link (external tracker URL)
            </label>
            <input
              type="url"
              value={createUrl}
              onChange={(e) => setCreateUrl(e.target.value)}
              placeholder="https://jira.example.com/browse/BUG-123"
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={() => setShowCreate(false)}
              className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={creating || !createTitle.trim()}
              className="rounded-lg bg-red-600 hover:bg-red-700 text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {creating ? "Creating…" : "Report Bug"}
            </button>
          </div>
        </div>
      </Modal>

      {/* ───── Edit Bug Modal ───── */}
      <Modal
        open={!!editBug}
        onClose={() => setEditBug(null)}
        title="Edit Bug"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Bug Title <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Description
            </label>
            <textarea
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Bug Link
            </label>
            <input
              type="url"
              value={editUrl}
              onChange={(e) => setEditUrl(e.target.value)}
              placeholder="https://jira.example.com/browse/BUG-123"
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Status
            </label>
            <select
              value={editStatus}
              onChange={(e) => setEditStatus(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
            >
              <option value="Open">Open</option>
              <option value="In Progress">In Progress</option>
              <option value="Closed">Closed</option>
              <option value="Reopened">Reopened</option>
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={() => setEditBug(null)}
              className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              onClick={handleEditSave}
              disabled={saving || !editTitle.trim()}
              className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </div>
      </Modal>

      {/* ───── Delete Confirm Modal ───── */}
      <Modal
        open={!!deletingId}
        onClose={() => setDeletingId(null)}
        title="Delete Bug"
      >
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-6">
          Are you sure you want to delete this bug? This action cannot be undone.
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={() => setDeletingId(null)}
            className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={() => deletingId && handleDelete(deletingId)}
            className="rounded-lg bg-red-600 hover:bg-red-700 text-white px-4 py-2 text-sm font-medium"
          >
            Delete
          </button>
        </div>
      </Modal>
    </div>
  );
}
