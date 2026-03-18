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
import {
  Button,
  Card,
  Input,
  Field,
  FieldLabel,
  Modal,
  Textarea,
  Select,
  StatusChip,
} from "@/components/ui";
import { PageHeader, ListWorkspaceLayout } from "@/components/workflows";

/* ───── Status badge ───── */
function BugStatusBadge({ status }: { status: string }) {
  const toneMap: Record<string, "error" | "success" | "info" | "warning"> = {
    Open: "error",
    Closed: "success",
    "In Progress": "info",
    Reopened: "warning",
  };
  return <StatusChip tone={toneMap[status] || "error"}>{status}</StatusChip>;
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
        <p className="text-[var(--muted)]">Loading…</p>
      </div>
    );
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
                <>
                  <Link
                    href={`/projects/${projectId}`}
                    className="text-[var(--muted)] hover:text-[var(--foreground)]"
                  >
                    Project
                  </Link>
                  {" / "}
                  <span className="font-medium text-[var(--foreground)]">Bugs</span>
                </>
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
              <Select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
              >
                <option value="">All Statuses</option>
                <option value="Open">Open</option>
                <option value="In Progress">In Progress</option>
                <option value="Closed">Closed</option>
                <option value="Reopened">Reopened</option>
              </Select>
            </div>
          }
        >
          {/* Table */}
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
                      <th>Test Case</th>
                      <th>Test Run</th>
                      <th>Reporter</th>
                      <th>Reported</th>
                      <th className="w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((b) => (
                      <tr
                        key={b.id}
                        className="cursor-pointer"
                        onClick={() => setViewBug(b)}
                      >
                        <td>
                          <div className="flex flex-col gap-0.5 max-w-sm">
                            <span className="text-sm font-medium text-[var(--brand-primary)] hover:underline break-words">
                              {b.title}
                            </span>
                            {b.externalUrl && (
                              <a
                                href={b.externalUrl}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-xs text-[var(--muted-soft)] hover:text-[var(--brand-primary)] hover:underline truncate"
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
                          {b.tcTitle ? (
                            <div className="flex flex-col gap-0.5">
                              <span className="text-xs font-mono text-[var(--muted-soft)]">
                                {b.tcExternalId}
                              </span>
                              <span className="text-xs text-[var(--muted)] truncate max-w-[180px]">
                                {b.tcTitle}
                              </span>
                            </div>
                          ) : (
                            <span className="text-xs text-[var(--muted-soft)]">—</span>
                          )}
                        </td>
                        <td>
                          <span className="text-xs text-[var(--muted)]">
                            {b.cycleName || "—"}
                          </span>
                        </td>
                        <td>
                          <span className="text-xs text-[var(--muted)]">
                            {b.reporterName || b.reporterEmail || "—"}
                          </span>
                        </td>
                        <td className="text-xs text-[var(--muted-soft)] whitespace-nowrap">
                          {new Date(b.createdAt).toLocaleDateString()}
                        </td>
                        <td>
                          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => openEdit(b)}
                              className="h-8 w-8 min-w-8 p-0"
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
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => setDeletingId(b.id)}
                              className="h-8 w-8 min-w-8 p-0 text-[var(--error)] hover:bg-[var(--error)]/10 hover:text-[var(--error)]"
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
                <BugStatusBadge status={viewBug.status} />
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
                  Bug Link
                </p>
                <a
                  href={viewBug.externalUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-[var(--brand-primary)] hover:underline break-all"
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
              <div>
                <p className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-1">
                  Test Case
                </p>
                {viewBug.tcTitle ? (
                  <div className="flex flex-col">
                    <span className="text-xs font-mono text-[var(--muted-soft)]">{viewBug.tcExternalId}</span>
                    <span className="text-sm text-[var(--foreground)]">{viewBug.tcTitle}</span>
                  </div>
                ) : (
                  <span className="text-sm text-[var(--muted-soft)]">Not linked</span>
                )}
              </div>
              <div>
                <p className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-1">
                  Test Run
                </p>
                <span className="text-sm text-[var(--foreground)]">
                  {viewBug.cycleName || "Not linked"}
                </span>
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
                className="!bg-transparent !text-[var(--error)] hover:!bg-[var(--error)]/10 hover:!opacity-100"
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
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
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
        onClose={() => setShowCreate(false)}
        title="Report a Bug"
      >
        <div className="space-y-4">
          <Field>
            <FieldLabel>
              Bug Title <span className="text-[var(--error)]">*</span>
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
          <Field>
            <FieldLabel>Bug Link (external tracker URL)</FieldLabel>
            <Input
              type="url"
              value={createUrl}
              onChange={(e) => setCreateUrl(e.target.value)}
              placeholder="https://jira.example.com/browse/BUG-123"
            />
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleCreate}
              disabled={creating || !createTitle.trim()}
            >
              {creating ? "Creating…" : "Report Bug"}
            </Button>
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
          <Field>
            <FieldLabel>
              Bug Title <span className="text-[var(--error)]">*</span>
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
          <Field>
            <FieldLabel>Bug Link</FieldLabel>
            <Input
              type="url"
              value={editUrl}
              onChange={(e) => setEditUrl(e.target.value)}
              placeholder="https://jira.example.com/browse/BUG-123"
            />
          </Field>
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
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setEditBug(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleEditSave}
              disabled={saving || !editTitle.trim()}
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
          Are you sure you want to delete this bug? This action cannot be undone.
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
