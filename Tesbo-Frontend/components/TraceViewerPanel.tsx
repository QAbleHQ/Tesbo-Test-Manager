"use client";

import { useEffect, useState } from "react";
import { IconExternalLink, IconPlayerPlay, IconTimeline, IconX } from "@tabler/icons-react";
import {
  createExecutionTraceLink,
  playwrightTraceViewerUrl,
  publicTraceUrl,
  type ExecutionEvidence,
} from "@/lib/api";
import { formatFileSizeShort } from "@/lib/validation";

/*
 * A Playwright trace, opened in place instead of downloaded.
 *
 * Before this, a trace was a link that put a .zip in your Downloads folder — from where opening it
 * means `npx playwright show-trace` at a terminal, which is not something the QA lead reading a
 * failed run is going to do. The whole point of attaching a trace on failure is being able to look
 * at it, so it is shown here and, for a full-screen read, in its own tab.
 *
 * The renderer is Playwright's own viewer (trace.playwright.dev) in an iframe: it is a static page
 * that runs entirely in this browser, fetches the archive itself and uploads nothing. Same approach
 * as Tesbo Grid's run report.
 *
 * What differs from Grid is the link it is given. Grid's artifacts are public-read objects with
 * permanent URLs; Test Manager's evidence is private and served behind the session, which a
 * third-party origin fetching cross-origin cannot present. So the URL here is a signed, single-
 * attachment, one-hour grant minted by the API — see createExecutionTraceLink in lib/api.ts.
 */

/** Re-mint this long before expiry, so a panel left open doesn't hand the viewer a dead link. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface Props {
  cycleId: string;
  executionId: string;
  file: ExecutionEvidence;
}

export default function TraceViewerPanel({ cycleId, executionId, file }: Props) {
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // Bumped by the refresh timer below; re-runs the mint effect and nothing else.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const link = await createExecutionTraceLink(cycleId, executionId, file.id);
        if (cancelled) return;
        setViewerUrl(playwrightTraceViewerUrl(publicTraceUrl(link.token)));
        setExpiresAt(link.expiresAt);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't open this trace.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cycleId, executionId, file.id, attempt]);

  /*
   * Re-minted on a timer rather than at click time: re-minting inside a click handler means
   * awaiting before window.open, which popup blockers treat as a non-user gesture and block. This
   * way the href on the tab link is always one a fresh click can follow.
   */
  useEffect(() => {
    if (!expiresAt) return;
    const dueIn = new Date(expiresAt).getTime() - Date.now() - REFRESH_MARGIN_MS;
    if (!Number.isFinite(dueIn) || dueIn <= 0) return;
    const timer = setTimeout(() => setAttempt((n) => n + 1), dueIn);
    return () => clearTimeout(timer);
  }, [expiresAt]);

  const subtitle = error
    ? error
    : `${file.fileName}${file.fileSize != null ? ` — ${formatFileSizeShort(file.fileSize)}` : ""}`;

  return (
    <div
      data-testid="trace-viewer"
      className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)]"
    >
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <IconTimeline size={16} className="shrink-0 text-[var(--accent-light)]" />
          <div className="min-w-0">
            <p className="text-[12.5px] font-medium text-[var(--foreground)]">Playwright Trace</p>
            <p
              className={`truncate text-[11px] ${error ? "text-[var(--error)]" : "text-[var(--muted)]"}`}
              title={subtitle}
            >
              {viewerUrl || error ? subtitle : "Preparing trace…"}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!open && (
            <button
              type="button"
              data-testid="trace-view"
              onClick={() => setOpen(true)}
              disabled={!viewerUrl}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--foreground)] transition-colors hover:border-[var(--accent-light)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <IconPlayerPlay size={13} />
              View trace
            </button>
          )}
          {/*
           * An <a>, not a scripted window.open: the href is already current (the timer above keeps
           * it that way), so the tab opens on the click itself and is never taken for a popup.
           */}
          {viewerUrl && (
            <a
              href={viewerUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="trace-open-tab"
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--foreground)] transition-colors hover:border-[var(--accent-light)]"
            >
              Open in new tab
              <IconExternalLink size={12} className="text-[var(--muted)]" />
            </a>
          )}
          {open && (
            <button
              type="button"
              data-testid="trace-close"
              onClick={() => setOpen(false)}
              aria-label="Close trace viewer"
              className="rounded p-1 text-[var(--muted)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--foreground)]"
            >
              <IconX size={15} />
            </button>
          )}
        </div>
      </div>

      {open && viewerUrl && (
        <iframe
          src={viewerUrl}
          title="Playwright Trace Viewer"
          data-testid="trace-iframe"
          className="w-full border-0 border-t border-[var(--border)]"
          style={{ height: "600px" }}
          /*
           * allow-same-origin here is the *iframe's* own origin (trace.playwright.dev), not ours —
           * it lets the viewer register the service worker it needs to read the archive, and gives
           * it no reach into this page.
           */
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        />
      )}
    </div>
  );
}
