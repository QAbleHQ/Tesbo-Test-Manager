"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconApi,
  IconCamera,
  IconDownload,
  IconFileText,
  IconPaperclip,
  IconTrash,
  IconTimeline,
  IconUpload,
  IconVideo,
} from "@tabler/icons-react";
import { Button, ConfirmModal } from "@/components/ui";
import TraceViewerPanel from "@/components/TraceViewerPanel";
import ApiEvidenceViewer from "@/components/ApiEvidenceViewer";
import {
  API_BASE,
  deleteExecutionEvidence,
  listExecutionEvidence,
  uploadExecutionEvidence,
  type EvidenceKind,
  type ExecutionEvidence,
} from "@/lib/api";
import {
  EVIDENCE_ACCEPT_ATTRIBUTE,
  formatFileSizeShort,
  validateEvidenceFile,
} from "@/lib/validation";

/*
 * Evidence for one result — screenshots, video, Playwright traces and logs.
 *
 * This is the viewer half of Basecamp 10189985971 §5. The backend has served
 * POST/GET /api/cycles/:cycleId/executions/:executionId/attachments since the bug-evidence work,
 * and nothing in the frontend has ever called either, so evidence was storable and billed against
 * the workspace's storage allowance while being invisible in the product. Without this component
 * the automation ingest's screenshots and traces would be write-only.
 *
 * Rendered in both the run detail drawer and the full-page execute screen, which is why it owns its
 * own fetch rather than taking a list as a prop: the run table only carries `evidenceCount` (an
 * integer per row), deliberately, so a 500-case run does not ship every attachment's metadata just
 * to decide whether to draw a paperclip.
 */

const KIND_ICON: Record<EvidenceKind, typeof IconCamera> = {
  screenshot: IconCamera,
  video: IconVideo,
  trace: IconTimeline,
  log: IconFileText,
  api: IconApi,
};

const KIND_LABEL: Record<EvidenceKind, string> = {
  screenshot: "Screenshot",
  video: "Video",
  trace: "Trace",
  log: "Log",
  api: "API call",
};

/** Order the groups appear in: what you look at first when a test failed. */
const KIND_ORDER: EvidenceKind[] = ["screenshot", "video", "trace", "api", "log"];

function inferKind(file: ExecutionEvidence): EvidenceKind {
  // evidence_kind is NULL for anything uploaded through the human path before/outside the ingest,
  // so fall back to the content type rather than showing an unlabelled row.
  if (file.kind) return file.kind;
  const type = file.contentType ?? "";
  if (type.startsWith("image/")) return "screenshot";
  if (type.startsWith("video/")) return "video";
  if (type === "application/zip" || file.fileName.toLowerCase().endsWith(".zip")) return "trace";
  return "log";
}

export function evidenceDownloadUrl(
  cycleId: string,
  executionId: string,
  attachmentId: string,
  inline = false
): string {
  const suffix = inline ? "?inline=1" : "";
  return `${API_BASE}/api/cycles/${cycleId}/executions/${executionId}/attachments/${attachmentId}/download${suffix}`;
}

function RemoveEvidenceButton({
  file,
  onRemove,
  className = "",
}: {
  file: ExecutionEvidence;
  onRemove: (file: ExecutionEvidence) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onRemove(file)}
      aria-label={`Delete ${file.fileName}`}
      title="Delete"
      data-testid="evidence-delete"
      className={`shrink-0 text-[var(--muted)] hover:text-[var(--error-foreground)] ${className}`}
    >
      <IconTrash size={13} />
    </button>
  );
}

/*
 * A video row: the download link it always was, plus a View toggle that plays it in place. The
 * backend already serves `?inline=1` for video (it refuses inline for logs and archives on purpose),
 * so this is the only kind besides screenshots that can be viewed rather than downloaded. The
 * <video> mounts only once View is pressed so a run with several recordings doesn't preload them.
 */
function VideoEvidenceRow({
  cycleId,
  executionId,
  file,
  onRemove,
}: {
  cycleId: string;
  executionId: string;
  file: ExecutionEvidence;
  onRemove?: (file: ExecutionEvidence) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="space-y-1.5">
      <div className="flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-2.5 py-1.5 text-[12.5px]">
        <span className="truncate text-[var(--foreground)]">{file.fileName}</span>
        {file.fileSize != null && (
          <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--muted-soft)]">
            {formatFileSizeShort(file.fileSize)}
          </span>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-testid="evidence-view-video"
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[11.5px] text-[var(--accent-light)] hover:underline"
        >
          {open ? "Hide" : "View"}
        </button>
        <a
          href={evidenceDownloadUrl(cycleId, executionId, file.id)}
          aria-label={`Download ${file.fileName}`}
          title="Download"
          className="shrink-0 text-[var(--muted)] hover:text-[var(--foreground)]"
        >
          <IconDownload size={13} />
        </a>
        {onRemove && <RemoveEvidenceButton file={file} onRemove={onRemove} />}
      </div>
      {open && (
        <video
          controls
          autoPlay
          src={evidenceDownloadUrl(cycleId, executionId, file.id, true)}
          data-testid="evidence-video-player"
          className="max-h-[360px] w-full rounded-lg border border-[var(--border-subtle)] bg-black"
        />
      )}
    </li>
  );
}

interface Props {
  cycleId: string;
  executionId: string;
  /** Hides the upload control on screens where the caller is read-only (a closed automated run). */
  readOnly?: boolean;
  /** Lets the parent keep its own row badge in step after an upload. */
  onCountChange?: (count: number) => void;
}

export default function ExecutionEvidencePanel({ cycleId, executionId, readOnly, onCountChange }: Props) {
  const [files, setFiles] = useState<ExecutionEvidence[]>([]);
  const [loading, setLoading] = useState(true);
  /*
   * Whether the panel has completed at least one fetch (success or failure) for this
   * cycleId/executionId. Gates the full-panel "Loading evidence…" placeholder to the very first
   * load only — see the note above `load` for why every later call also flips `loading` back to
   * true and would otherwise tear the already-rendered grid down and rebuild it.
   */
  const [hasLoaded, setHasLoaded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingDelete, setPendingDelete] = useState<ExecutionEvidence | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /*
   * The count callback is held in a ref, and deliberately kept out of `load`'s dependencies.
   *
   * It used to be a dependency, which made the panel unusable in the run drawer: that caller passes
   * an inline arrow that calls setExecutions(prev => prev.map(...)), so every reported count
   * re-rendered the parent, produced a new callback identity, produced a new `load`, re-fired the
   * effect below, and fetched again — for ever. The panel never left "Loading evidence…" and the
   * attachments endpoint took a request per render. The full-page execute screen passes no callback
   * at all, which is the only reason evidence ever appeared there.
   *
   * A ref fixes it here rather than asking every caller to remember useCallback, since forgetting
   * cost the feature entirely and failed loudly nowhere.
   */
  const onCountChangeRef = useRef(onCountChange);
  useEffect(() => {
    onCountChangeRef.current = onCountChange;
  }, [onCountChange]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listExecutionEvidence(cycleId, executionId);
      setFiles(res.list ?? []);
      onCountChangeRef.current?.(res.list?.length ?? 0);
    } catch {
      // A failed evidence fetch must not blank the panel it lives in — the status picker and the
      // test case body around it are still usable, so this reports and stops.
      setError("Couldn't load evidence for this result.");
    } finally {
      setLoading(false);
      setHasLoaded(true);
    }
  }, [cycleId, executionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => {
    const map = new Map<EvidenceKind, ExecutionEvidence[]>();
    for (const file of files) {
      const kind = inferKind(file);
      const bucket = map.get(kind);
      if (bucket) bucket.push(file);
      else map.set(kind, [file]);
    }
    return KIND_ORDER.filter((kind) => map.has(kind)).map((kind) => ({ kind, items: map.get(kind)! }));
  }, [files]);

  async function handlePick(picked: FileList | null) {
    if (!picked || !picked.length) return;
    // Checked as they're picked, like BugEvidenceField: naming the offending file here means the
    // person never waits through a full upload to be told. Valid files in the same selection are
    // still sent, so one wrong file doesn't discard the other four.
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const file of Array.from(picked)) {
      const problem = validateEvidenceFile(file);
      if (problem) rejected.push(problem);
      else accepted.push(file);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
    setError(rejected.length ? rejected.join(" ") : null);
    if (!accepted.length) return;

    setUploading(true);
    try {
      await uploadExecutionEvidence(cycleId, executionId, accepted);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteExecutionEvidence(cycleId, executionId, pendingDelete.id);
      setPendingDelete(null);
      await load();
    } catch (err) {
      // Kept open on failure with the confirm button live, so a transient error can be retried.
      setDeleteError(err instanceof Error ? err.message : "Couldn't delete this file.");
    } finally {
      setDeleting(false);
    }
  }

  // Undefined on a read-only screen, which hides every delete control, same as the Add button.
  const askRemove = readOnly
    ? undefined
    : (file: ExecutionEvidence) => {
        setDeleteError(null);
        setPendingDelete(file);
      };

  return (
    <div>
      <ConfirmModal
        open={pendingDelete !== null}
        title="Delete evidence?"
        message={`"${pendingDelete?.fileName ?? ""}" will be permanently deleted from this result.`}
        confirmLabel="Delete"
        loading={deleting}
        loadingLabel="Deleting…"
        error={deleteError}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--muted)]">
          <IconPaperclip size={13} />
          Evidence
          {files.length > 0 && <span className="text-[var(--muted-soft)]">({files.length})</span>}
        </p>
        {!readOnly && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={EVIDENCE_ACCEPT_ATTRIBUTE}
              className="hidden"
              onChange={(e) => void handlePick(e.target.files)}
            />
            <Button
              variant="secondary"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="!px-2 !py-1 !text-[11.5px]"
            >
              <IconUpload size={13} />
              {uploading ? "Uploading…" : "Add"}
            </Button>
          </>
        )}
      </div>

      {error && (
        <p className="mb-2 rounded-lg border border-[var(--error)] bg-[var(--error-soft,transparent)] px-2.5 py-1.5 text-[12px] text-[var(--error-foreground,var(--error))]">
          {error}
        </p>
      )}

      {loading && !hasLoaded ? (
        // Only the very first fetch shows this placeholder. A later refetch — after an upload, or
        // a retry following an error — must not tear down evidence that is already on screen just
        // to show the same text again; see the note on `hasLoaded` above.
        <p className="text-[12.5px] text-[var(--muted)]">Loading evidence…</p>
      ) : files.length === 0 ? (
        <p className="text-[12.5px] text-[var(--muted)]">
          No evidence attached. Automated runs attach screenshots and traces on failure; you can add files here too.
        </p>
      ) : (
        <div className="space-y-3">
          {grouped.map(({ kind, items }) => {
            const Icon = KIND_ICON[kind];
            return (
              <div key={kind}>
                <p className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--muted)]">
                  <Icon size={13} />
                  {KIND_LABEL[kind]}
                </p>
                {/*
                  * Three shapes, by what the file is worth: screenshots show themselves, a trace
                  * gets an inline viewer (a .zip download is useless without a terminal), and
                  * everything else stays a named download row.
                  */}
                {kind === "trace" ? (
                  <div className="space-y-2">
                    {items.map((file) => (
                      <div key={file.id} className="space-y-1">
                        <TraceViewerPanel cycleId={cycleId} executionId={executionId} file={file} />
                        {/* The raw archive stays one click away — `npx playwright show-trace` and
                            attaching it to a bug report both still want the file itself. */}
                        <a
                          href={evidenceDownloadUrl(cycleId, executionId, file.id)}
                          className="inline-flex items-center gap-1.5 pl-1 text-[11px] text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
                        >
                          <IconDownload size={12} />
                          Download .zip
                        </a>
                        {askRemove && <RemoveEvidenceButton file={file} onRemove={askRemove} className="ml-3 align-middle" />}
                      </div>
                    ))}
                  </div>
                ) : kind === "screenshot" ? (
                  <div className="flex flex-wrap gap-2">
                    {items.map((file) => (
                      <div key={file.id} className="relative">
                      <a
                        href={evidenceDownloadUrl(cycleId, executionId, file.id, true)}
                        target="_blank"
                        rel="noreferrer"
                        title={`${file.fileName}${file.fileSize ? ` — ${formatFileSizeShort(file.fileSize)}` : ""}`}
                        className="block overflow-hidden rounded-lg border border-[var(--border-subtle)] transition-colors hover:border-[var(--accent-light)]"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={evidenceDownloadUrl(cycleId, executionId, file.id, true)}
                          alt={file.fileName}
                          className="h-24 w-auto max-w-[180px] object-cover"
                        />
                      </a>
                      {askRemove && (
                        <RemoveEvidenceButton
                          file={file}
                          onRemove={askRemove}
                          className="absolute right-1 top-1 rounded-md bg-[var(--surface-secondary)] p-1"
                        />
                      )}
                      </div>
                    ))}
                  </div>
                ) : kind === "video" ? (
                  <ul className="space-y-1">
                    {items.map((file) => (
                      <VideoEvidenceRow key={file.id} cycleId={cycleId} executionId={executionId} file={file} onRemove={askRemove} />
                    ))}
                  </ul>
                ) : kind === "api" ? (
                  <ul className="space-y-1">
                    {items.map((file) => (
                      <ApiEvidenceViewer
                        key={file.id}
                        cycleId={cycleId}
                        executionId={executionId}
                        file={file}
                        downloadUrl={evidenceDownloadUrl(cycleId, executionId, file.id)}
                        removeButton={askRemove && <RemoveEvidenceButton file={file} onRemove={askRemove} />}
                      />
                    ))}
                  </ul>
                ) : (
                  <ul className="space-y-1">
                    {items.map((file) => (
                      <li key={file.id} className="flex items-center gap-1.5">
                        <a
                          href={evidenceDownloadUrl(cycleId, executionId, file.id)}
                          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-2.5 py-1.5 text-[12.5px] transition-colors hover:border-[var(--accent-light)]"
                        >
                          <IconDownload size={13} className="shrink-0 text-[var(--muted)]" />
                          <span className="truncate text-[var(--foreground)]">{file.fileName}</span>
                          {file.fileSize != null && (
                            <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--muted-soft)]">
                              {formatFileSizeShort(file.fileSize)}
                            </span>
                          )}
                        </a>
                        {askRemove && <RemoveEvidenceButton file={file} onRemove={askRemove} />}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
