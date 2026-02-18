"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import {
  authMe,
  getJiraStatus,
  listJiraTickets,
  listLinkedJiraKeys,
  syncJiraTickets,
  listKnowledgeBaseItems,
  createKnowledgeBaseNote,
  uploadKnowledgeBaseFile,
  updateKnowledgeBaseItem,
  deleteKnowledgeBaseItem,
  getKnowledgeBaseFileUrl,
  type JiraTicket,
  type JiraConnection,
  type KnowledgeBaseItem,
} from "@/lib/api";

type Tab = "documents" | "jira";
const PAGE_SIZE = 25;

// ─── Shared small components ────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const color = (() => {
    const s = status.toLowerCase();
    if (s === "done" || s === "closed" || s === "resolved")
      return "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400";
    if (s === "in progress" || s === "in review")
      return "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400";
    if (s === "to do" || s === "open" || s === "new" || s === "backlog")
      return "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400";
    return "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400";
  })();
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {status}
    </span>
  );
}

function PriorityIcon({ priority }: { priority: string }) {
  const p = priority?.toLowerCase() ?? "";
  let color = "text-zinc-400";
  if (p === "highest" || p === "critical") color = "text-red-500";
  else if (p === "high") color = "text-orange-500";
  else if (p === "medium") color = "text-yellow-500";
  else if (p === "low") color = "text-blue-400";
  else if (p === "lowest") color = "text-zinc-400";
  return (
    <span className={`text-xs font-medium ${color}`} title={priority}>
      {priority || "—"}
    </span>
  );
}

function IssueTypeIcon({ type }: { type: string }) {
  const t = type?.toLowerCase() ?? "";
  let color = "bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-400";
  if (t === "bug") color = "bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400";
  else if (t === "story" || t === "user story")
    color = "bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400";
  else if (t === "epic")
    color = "bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400";
  else if (t === "task" || t === "sub-task")
    color = "bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400";
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${color}`}>
      {type || "—"}
    </span>
  );
}

function SearchBar({
  value,
  onChange,
  onSearch,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSearch: () => void;
  placeholder?: string;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSearch();
      }}
      className="flex items-center gap-2"
    >
      <div className="relative flex-1">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
        </svg>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <button
        type="submit"
        className="rounded-lg bg-zinc-200 dark:bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-300 dark:hover:bg-zinc-600 transition-colors"
      >
        Search
      </button>
    </form>
  );
}

function formatFileSize(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(contentType: string | null) {
  if (!contentType) return "📄";
  if (contentType.startsWith("image/")) return "🖼️";
  if (contentType.includes("pdf")) return "📕";
  if (contentType.includes("json")) return "{ }";
  if (contentType.includes("csv") || contentType.includes("spreadsheet")) return "📊";
  return "📄";
}

// ─── Note Modal ─────────────────────────────────────────────────────────────

function NoteModal({
  open,
  initial,
  onClose,
  onSave,
  saving,
}: {
  open: boolean;
  initial?: { title: string; content: string };
  onClose: () => void;
  onSave: (title: string, content: string) => void;
  saving: boolean;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [content, setContent] = useState(initial?.content ?? "");

  useEffect(() => {
    if (open) {
      setTitle(initial?.title ?? "");
      setContent(initial?.content ?? "");
    }
  }, [open, initial]);

  if (!open) return null;

  const isEdit = !!initial;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-zinc-200 dark:border-zinc-700 w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-700">
          <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            {isEdit ? "Edit Note" : "Add Note"}
          </h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Login Module Requirements"
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Content</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={12}
              placeholder="Write your notes, requirements, acceptance criteria, or any project context here…"
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-zinc-200 dark:border-zinc-700">
          <button
            onClick={onClose}
            className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(title.trim(), content)}
            disabled={saving || !title.trim()}
            className="rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : isEdit ? "Save Changes" : "Add Note"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Documents & Notes Tab ──────────────────────────────────────────────────

function DocumentsTab({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<KnowledgeBaseItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [noteModalOpen, setNoteModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<KnowledgeBaseItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<{ url: string; name: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (query: string) => {
      try {
        const data = await listKnowledgeBaseItems(projectId, {
          search: query || undefined,
        });
        setItems(data.list);
        setTotal(data.total);
      } catch {
        /* ignore */
      } finally {
        setLoading(false);
      }
    },
    [projectId]
  );

  useEffect(() => {
    load(search);
  }, [search, load]);

  async function handleSaveNote(title: string, content: string) {
    setSaving(true);
    try {
      if (editingItem) {
        await updateKnowledgeBaseItem(projectId, editingItem.id, { title, content });
      } else {
        await createKnowledgeBaseNote(projectId, title, content);
      }
      setNoteModalOpen(false);
      setEditingItem(null);
      await load(search);
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (let i = 0; i < files.length; i++) {
        await uploadKnowledgeBaseFile(projectId, files[i]);
      }
      await load(search);
    } catch {
      /* ignore */
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDelete(itemId: string) {
    setDeletingId(itemId);
    try {
      await deleteKnowledgeBaseItem(projectId, itemId);
      setItems((prev) => prev.filter((it) => it.id !== itemId));
      setTotal((prev) => prev - 1);
    } catch {
      /* ignore */
    } finally {
      setDeletingId(null);
    }
  }

  if (loading) {
    return (
      <div className="py-12 text-center">
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  return (
    <>
      <NoteModal
        open={noteModalOpen}
        initial={editingItem ? { title: editingItem.title, content: editingItem.content } : undefined}
        onClose={() => {
          setNoteModalOpen(false);
          setEditingItem(null);
        }}
        onSave={handleSaveNote}
        saving={saving}
      />

      {/* Image preview overlay */}
      {imagePreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setImagePreview(null)}
        >
          <div className="relative max-w-4xl max-h-[85vh] mx-4" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setImagePreview(null)}
              className="absolute -top-10 right-0 text-white/80 hover:text-white text-sm"
            >
              Close
            </button>
            <img
              src={imagePreview.url}
              alt={imagePreview.name}
              className="max-w-full max-h-[80vh] rounded-xl shadow-2xl object-contain"
            />
            <p className="mt-2 text-center text-sm text-white/70">{imagePreview.name}</p>
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        accept=".txt,.md,.csv,.json,.xml,.yaml,.yml,.pdf,.png,.jpg,.jpeg,.gif,.webp"
        onChange={handleFileUpload}
      />

      {/* Actions row */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setEditingItem(null);
              setNoteModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Note
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            {uploading ? "Uploading…" : "Upload File"}
          </button>
        </div>
        <span className="text-sm text-zinc-500">
          {total} item{total !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Search */}
      <SearchBar
        value={searchInput}
        onChange={setSearchInput}
        onSearch={() => setSearch(searchInput)}
        placeholder="Search notes and files…"
      />

      {search && (
        <div className="mt-2 text-sm text-zinc-500">
          Showing results for &quot;{search}&quot;
          <button
            onClick={() => {
              setSearch("");
              setSearchInput("");
            }}
            className="ml-2 text-blue-600 dark:text-blue-400 hover:underline"
          >
            Clear
          </button>
        </div>
      )}

      {/* Empty state */}
      {items.length === 0 && !search && (
        <div className="mt-8 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center">
          <div className="mx-auto w-14 h-14 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
            <svg className="w-7 h-7 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <h2 className="mt-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            No Documents or Notes Yet
          </h2>
          <p className="mt-2 text-sm text-zinc-500 max-w-md mx-auto">
            Add notes with requirements, acceptance criteria, or project context. Upload text files
            and images to build your project&apos;s knowledge base for AI-powered test generation.
          </p>
          <div className="mt-5 flex items-center justify-center gap-3">
            <button
              onClick={() => {
                setEditingItem(null);
                setNoteModalOpen(true);
              }}
              className="rounded-lg bg-blue-600 text-white px-5 py-2 text-sm font-medium hover:bg-blue-700 transition-colors"
            >
              Add Your First Note
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-5 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
            >
              Upload a File
            </button>
          </div>
        </div>
      )}

      {items.length === 0 && search && (
        <div className="mt-8 text-center py-12">
          <p className="text-zinc-500">No items match your search.</p>
        </div>
      )}

      {/* Items list */}
      {items.length > 0 && (
        <div className="mt-4 space-y-2">
          {items.map((item) => {
            const isNote = item.itemType === "note";
            const isImage = item.fileContentType?.startsWith("image/");
            const isExpanded = expandedId === item.id;

            return (
              <div
                key={item.id}
                className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden transition-shadow hover:shadow-sm"
              >
                {/* Item header */}
                <div
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer"
                  onClick={() => setExpandedId(isExpanded ? null : item.id)}
                >
                  {/* Type indicator */}
                  <div
                    className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 text-sm ${
                      isNote
                        ? "bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400"
                        : isImage
                          ? "bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400"
                          : "bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400"
                    }`}
                  >
                    {isNote ? (
                      <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    ) : (
                      <span>{fileIcon(item.fileContentType)}</span>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                      {item.title}
                    </h4>
                    <div className="flex items-center gap-2 mt-0.5 text-xs text-zinc-500">
                      <span className={`inline-block rounded-full px-1.5 py-0.5 font-medium ${
                        isNote
                          ? "bg-amber-100 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400"
                          : "bg-blue-100 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400"
                      }`}>
                        {isNote ? "Note" : "File"}
                      </span>
                      {!isNote && item.fileSize != null && (
                        <span>{formatFileSize(item.fileSize)}</span>
                      )}
                      {item.creatorName && <span>by {item.creatorName}</span>}
                      <span>{new Date(item.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    {isNote && (
                      <button
                        onClick={() => {
                          setEditingItem(item);
                          setNoteModalOpen(true);
                        }}
                        title="Edit"
                        className="rounded-lg p-1.5 text-zinc-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                        </svg>
                      </button>
                    )}
                    {!isNote && isImage && (
                      <button
                        onClick={() =>
                          setImagePreview({
                            url: getKnowledgeBaseFileUrl(projectId, item.id),
                            name: item.fileName || item.title,
                          })
                        }
                        title="Preview"
                        className="rounded-lg p-1.5 text-zinc-400 hover:text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-900/20 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                      </button>
                    )}
                    {!isNote && (
                      <a
                        href={getKnowledgeBaseFileUrl(projectId, item.id)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Download"
                        className="rounded-lg p-1.5 text-zinc-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                      </a>
                    )}
                    <button
                      onClick={() => handleDelete(item.id)}
                      disabled={deletingId === item.id}
                      title="Delete"
                      className="rounded-lg p-1.5 text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                    <svg
                      className={`w-4 h-4 text-zinc-400 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>

                {/* Expanded content */}
                {isExpanded && (
                  <div className="px-4 pb-4 border-t border-zinc-100 dark:border-zinc-800">
                    {isNote && item.content && (
                      <p className="mt-3 text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap max-h-64 overflow-y-auto">
                        {item.content}
                      </p>
                    )}
                    {!isNote && isImage && (
                      <div className="mt-3">
                        <img
                          src={getKnowledgeBaseFileUrl(projectId, item.id)}
                          alt={item.fileName || item.title}
                          className="max-w-full max-h-64 rounded-lg border border-zinc-200 dark:border-zinc-700 object-contain cursor-pointer"
                          onClick={() =>
                            setImagePreview({
                              url: getKnowledgeBaseFileUrl(projectId, item.id),
                              name: item.fileName || item.title,
                            })
                          }
                        />
                      </div>
                    )}
                    {!isNote && !isImage && item.content && (
                      <pre className="mt-3 text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap max-h-64 overflow-y-auto bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-3 font-mono text-xs">
                        {item.content}
                      </pre>
                    )}
                    {!isNote && !item.content && !isImage && (
                      <p className="mt-3 text-sm text-zinc-400 italic">
                        Binary file — no text preview available.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ─── Jira Tickets Tab ───────────────────────────────────────────────────────

function JiraTab({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [jiraStatus, setJiraStatus] = useState<JiraConnection | null>(null);
  const [tickets, setTickets] = useState<JiraTicket[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [linkedJiraKeys, setLinkedJiraKeys] = useState<Set<string>>(new Set());
  const [jiraKeyCounts, setJiraKeyCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  const loadTickets = useCallback(
    async (pageNum: number, query: string) => {
      try {
        const data = await listJiraTickets(projectId, {
          limit: PAGE_SIZE,
          offset: pageNum * PAGE_SIZE,
          search: query || undefined,
        });
        setTickets(data.list);
        setTotal(data.total);
      } catch {
        /* ignore */
      }
    },
    [projectId]
  );

  useEffect(() => {
    (async () => {
      const status = await getJiraStatus(projectId).catch(() => ({ connected: false }) as JiraConnection);
      setJiraStatus(status);
      await loadTickets(0, "");
      const jiraKeysRes = await listLinkedJiraKeys(projectId).catch(() => ({ keys: [], counts: {} }));
      setLinkedJiraKeys(new Set(jiraKeysRes.keys));
      setJiraKeyCounts(jiraKeysRes.counts ?? {});
      setLoading(false);
    })();
  }, [projectId, loadTickets]);

  useEffect(() => {
    if (!loading) loadTickets(page, search);
  }, [page, search, loadTickets, loading]);

  async function handleSync() {
    setSyncing(true);
    try {
      await syncJiraTickets(projectId);
      await loadTickets(page, search);
    } catch {
      /* ignore */
    } finally {
      setSyncing(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (loading) {
    return (
      <div className="py-12 text-center">
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  return (
    <>
      {/* Actions row for Jira */}
      {jiraStatus?.connected && (
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-3 py-1.5 text-sm font-medium hover:bg-zinc-800 dark:hover:bg-zinc-200 disabled:opacity-50 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {syncing ? "Syncing…" : "Sync Jira"}
            </button>
            <Link
              href={`/projects/${projectId}/settings/integrations/jira`}
              className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
            >
              Manage
            </Link>
          </div>
          <span className="text-sm text-zinc-500">
            {total} ticket{total !== 1 ? "s" : ""}
          </span>
        </div>
      )}

      {/* Not connected */}
      {!jiraStatus?.connected && tickets.length === 0 && (
        <div className="mt-4 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center">
          <div className="mx-auto w-14 h-14 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-7 h-7 text-blue-600 dark:text-blue-400" fill="currentColor">
              <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53ZM6.77 6.8a4.362 4.362 0 0 0 4.34 4.34h1.8v1.72a4.362 4.362 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.84-.84H6.77ZM2 11.6c0 2.4 1.95 4.34 4.35 4.35h1.78v1.71c0 2.4 1.95 4.35 4.35 4.35V12.44a.84.84 0 0 0-.84-.84H2Z" />
            </svg>
          </div>
          <h2 className="mt-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            Connect Jira to Get Started
          </h2>
          <p className="mt-2 text-sm text-zinc-500 max-w-sm mx-auto">
            Link your Jira account to automatically import tickets and use them as context for generating test cases.
          </p>
          <Link
            href={`/projects/${projectId}/settings`}
            className="mt-4 inline-block rounded-lg bg-blue-600 text-white px-5 py-2 text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            Go to Project Settings
          </Link>
        </div>
      )}

      {/* Connected but no tickets */}
      {jiraStatus?.connected && tickets.length === 0 && !search && (
        <div className="mt-4 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">No Tickets Synced Yet</h2>
          <p className="mt-2 text-sm text-zinc-500 max-w-sm mx-auto">
            Click &quot;Sync Jira&quot; to pull tickets from your connected projects.
          </p>
          <div className="mt-4 flex items-center justify-center gap-3">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="rounded-lg bg-blue-600 text-white px-5 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {syncing ? "Syncing…" : "Sync Jira Tickets"}
            </button>
            <Link
              href={`/projects/${projectId}/settings/integrations/jira`}
              className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
            >
              Manage Jira Projects
            </Link>
          </div>
        </div>
      )}

      {/* Ticket list */}
      {(tickets.length > 0 || search) && (
        <>
          <SearchBar
            value={searchInput}
            onChange={setSearchInput}
            onSearch={() => {
              setPage(0);
              setSearch(searchInput);
            }}
            placeholder="Search tickets by key or summary…"
          />

          {search && (
            <div className="mt-2 text-sm text-zinc-500">
              Showing results for &quot;{search}&quot;
              <button
                onClick={() => {
                  setSearch("");
                  setSearchInput("");
                  setPage(0);
                }}
                className="ml-2 text-blue-600 dark:text-blue-400 hover:underline"
              >
                Clear
              </button>
            </div>
          )}

          <div className="mt-3 flex items-center justify-between text-sm text-zinc-500">
            <span>
              {total} ticket{total !== 1 ? "s" : ""}
              {search && <> matching &quot;{search}&quot;</>}
            </span>
            <span>
              Page {page + 1} of {totalPages}
            </span>
          </div>

          <div className="mt-3 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-50 dark:bg-zinc-800/50 border-b border-zinc-200 dark:border-zinc-700">
                  <th className="text-left px-4 py-2.5 font-medium text-zinc-600 dark:text-zinc-400 w-28">Key</th>
                  <th className="text-left px-4 py-2.5 font-medium text-zinc-600 dark:text-zinc-400">Summary</th>
                  <th className="text-left px-4 py-2.5 font-medium text-zinc-600 dark:text-zinc-400 w-24">Type</th>
                  <th className="text-left px-4 py-2.5 font-medium text-zinc-600 dark:text-zinc-400 w-28">Status</th>
                  <th className="text-left px-4 py-2.5 font-medium text-zinc-600 dark:text-zinc-400 w-20">Priority</th>
                  <th className="text-left px-4 py-2.5 font-medium text-zinc-600 dark:text-zinc-400 w-32">Assignee</th>
                  <th className="text-right px-4 py-2.5 font-medium text-zinc-600 dark:text-zinc-400 w-52">Action</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((ticket) => (
                  <React.Fragment key={ticket.id}>
                    <tr
                      onClick={() => setExpandedId(expandedId === ticket.id ? null : ticket.id)}
                      className="border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/30 cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-2.5">
                        <a
                          href={ticket.jiraUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="font-mono text-xs text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          {ticket.jiraIssueKey}
                        </a>
                      </td>
                      <td className="px-4 py-2.5 text-zinc-900 dark:text-zinc-100 truncate max-w-xs">
                        {ticket.summary}
                      </td>
                      <td className="px-4 py-2.5">
                        <IssueTypeIcon type={ticket.issueType} />
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={ticket.status} />
                      </td>
                      <td className="px-4 py-2.5">
                        <PriorityIcon priority={ticket.priority} />
                      </td>
                      <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400 text-xs truncate">
                        {ticket.assignee || "Unassigned"}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="inline-flex items-center gap-2">
                          {linkedJiraKeys.has(ticket.jiraIssueKey) && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-green-100 dark:bg-green-900/30 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-400">
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              {jiraKeyCounts[ticket.jiraIssueKey] || 0} saved
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              const qp = new URLSearchParams({
                                jiraKey: ticket.jiraIssueKey,
                                jiraUrl: ticket.jiraUrl || "",
                                summary: ticket.summary,
                                description: ticket.description || "",
                              });
                              router.push(`/projects/${projectId}/ai-test-script?${qp.toString()}`);
                            }}
                            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                              linkedJiraKeys.has(ticket.jiraIssueKey)
                                ? "border border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                                : "bg-blue-600 text-white hover:bg-blue-700"
                            }`}
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              {linkedJiraKeys.has(ticket.jiraIssueKey) ? (
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                              ) : (
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                              )}
                            </svg>
                            {linkedJiraKeys.has(ticket.jiraIssueKey) ? "Re-Generate" : "Generate"}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expandedId === ticket.id && (
                      <tr key={`${ticket.id}-detail`} className="bg-zinc-50 dark:bg-zinc-800/20">
                        <td colSpan={7} className="px-4 py-4">
                          <div className="space-y-3">
                            {ticket.description && (
                              <div>
                                <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1">
                                  Description
                                </h4>
                                <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap max-h-48 overflow-y-auto">
                                  {ticket.description}
                                </p>
                              </div>
                            )}
                            <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-zinc-500">
                              {ticket.reporter && (
                                <span>Reporter: <span className="text-zinc-700 dark:text-zinc-300">{ticket.reporter}</span></span>
                              )}
                              {ticket.labels && (
                                <span>Labels: <span className="text-zinc-700 dark:text-zinc-300">{ticket.labels}</span></span>
                              )}
                              {ticket.jiraCreatedAt && (
                                <span>Created: <span className="text-zinc-700 dark:text-zinc-300">{new Date(ticket.jiraCreatedAt).toLocaleDateString()}</span></span>
                              )}
                              {ticket.jiraUpdatedAt && (
                                <span>Updated: <span className="text-zinc-700 dark:text-zinc-300">{new Date(ticket.jiraUpdatedAt).toLocaleDateString()}</span></span>
                              )}
                            </div>
                            <a
                              href={ticket.jiraUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-block text-xs text-blue-600 dark:text-blue-400 hover:underline"
                            >
                              Open in Jira →
                            </a>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-40 transition-colors"
              >
                Previous
              </button>
              <span className="text-sm text-zinc-500">
                {page + 1} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-40 transition-colors"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

import React from "react";

export default function KnowledgeBasePage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("documents");

  useEffect(() => {
    (async () => {
      const me = await authMe();
      if (!me) {
        router.replace("/login");
        return;
      }
      setLoading(false);
    })();
  }, [router]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    {
      key: "documents",
      label: "Documents & Notes",
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      ),
    },
    {
      key: "jira",
      label: "Jira Tickets",
      icon: (
        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
          <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53ZM6.77 6.8a4.362 4.362 0 0 0 4.34 4.34h1.8v1.72a4.362 4.362 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.84-.84H6.77ZM2 11.6c0 2.4 1.95 4.34 4.35 4.35h1.78v1.71c0 2.4 1.95 4.35 4.35 4.35V12.44a.84.84 0 0 0-.84-.84H2Z" />
        </svg>
      ),
    },
  ];

  return (
    <main className="max-w-6xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Knowledge Base</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Centralized project knowledge for AI-powered test generation. Add notes, upload documents,
          or sync Jira tickets to provide context.
        </p>
      </div>

      {/* Tab navigation */}
      <div className="border-b border-zinc-200 dark:border-zinc-700 mb-6">
        <div className="flex gap-0">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
                activeTab === tab.key
                  ? "border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400"
                  : "border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:border-zinc-300 dark:hover:border-zinc-600"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {activeTab === "documents" && <DocumentsTab projectId={projectId} />}
      {activeTab === "jira" && <JiraTab projectId={projectId} />}
    </main>
  );
}
