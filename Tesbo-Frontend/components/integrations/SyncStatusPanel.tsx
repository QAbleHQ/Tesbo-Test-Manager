"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getIntegrationSyncStatus,
  isSyncRunActive,
  syncJiraTickets,
  syncLinearTickets,
  type IntegrationProvider,
  type SyncRun,
} from "@/lib/api";

const POLL_INTERVAL_MS = 2000;

const STAGE_LABELS: Record<string, string> = {
  queued: "Queued…",
  connecting: "Connecting…",
  fetching_tickets: "Pulling tickets",
  building_documents: "Building documents",
  done: "Done",
  failed: "Failed",
};

/**
 * Owns one project+provider sync run: fetches the latest on mount, starts new ones, and polls
 * while a run is in flight. Polling stops the moment the run settles, so an idle Requirements
 * page makes no repeat requests.
 */
export function useSyncRun(projectId: string, provider: IntegrationProvider, enabled = true) {
  const [run, setRun] = useState<SyncRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ref rather than state: the poll loop reads it without re-subscribing the interval.
  const activeRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!enabled) return null;
    try {
      const { run: latest } = await getIntegrationSyncStatus(projectId, provider);
      setRun(latest);
      activeRef.current = isSyncRunActive(latest);
      return latest;
    } catch {
      // A failed poll is not worth surfacing — the next tick usually succeeds, and the run row
      // is the source of truth either way.
      return null;
    }
  }, [projectId, provider, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;
    if (!isSyncRunActive(run)) return;
    const timer = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, run, refresh]);

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      const result = provider === "jira" ? await syncJiraTickets(projectId) : await syncLinearTickets(projectId);
      setRun(result.run);
      activeRef.current = isSyncRunActive(result.run);
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start sync.");
      return null;
    } finally {
      setStarting(false);
    }
  }, [projectId, provider]);

  const clearError = useCallback(() => setError(null), []);

  return { run, starting, error, start, refresh, clearError, isActive: isSyncRunActive(run) };
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function SyncStatusPanel({ run, label, className = "" }: { run: SyncRun | null; label: string; className?: string }) {
  if (!run) return null;

  const active = isSyncRunActive(run);
  const pct = run.totalTickets > 0
    ? Math.min(100, Math.round(((run.processedTickets + run.failedTickets) / run.totalTickets) * 100))
    : 0;

  const tone = run.status === "failed"
    ? { border: "var(--error)", text: "var(--error)", bg: "var(--error-soft)" }
    : run.status === "partial"
      ? { border: "var(--warning)", text: "var(--warning)", bg: "var(--warning-soft)" }
      : active
        ? { border: "var(--brand-primary)", text: "var(--brand-primary)", bg: "var(--brand-soft)" }
        : { border: "var(--success)", text: "var(--success)", bg: "var(--success-soft)" };

  const headline = run.status === "failed"
    ? `${label} sync failed`
    : run.status === "partial"
      ? `${label} sync finished with ${run.failedTickets} problem${run.failedTickets === 1 ? "" : "s"}`
      : active
        ? `${label} sync — ${STAGE_LABELS[run.stage] || run.stage}`
        : `${label} sync complete`;

  const stats: string[] = [];
  if (run.documentsCreated) stats.push(`${run.documentsCreated} document${run.documentsCreated === 1 ? "" : "s"} created`);
  if (run.documentsUpdated) stats.push(`${run.documentsUpdated} updated`);
  if (run.commentsSynced) stats.push(`${run.commentsSynced} comment${run.commentsSynced === 1 ? "" : "s"} synced`);
  if (run.decisionSummaries) stats.push(`${run.decisionSummaries} decision summar${run.decisionSummaries === 1 ? "y" : "ies"}`);

  return (
    <div
      className={`rounded-lg border px-4 py-3 ${className}`}
      style={{ borderColor: `color-mix(in oklab, ${tone.border} 35%, transparent)`, background: tone.bg }}
      // Announced to screen readers as it changes, so a long sync isn't a silent wait.
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {active && (
            <span
              className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-t-transparent"
              style={{ borderColor: tone.text, borderTopColor: "transparent" }}
            />
          )}
          <span className="text-sm font-semibold" style={{ color: tone.text }}>
            {headline}
          </span>
          {/* A Linear Project's key is an opaque slugId, so Linear shows the mapped name and keeps the
              key as the tooltip. Runs recorded before the name was stored fall back to the key. */}
          {run.provider === "linear" && run.remoteProjectName ? (
            <span
              data-testid="sync-run-remote"
              title={run.remoteProjectKey || undefined}
              className="rounded bg-[var(--surface)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]"
            >
              {run.remoteProjectName}
            </span>
          ) : run.remoteProjectKey && (
            <span data-testid="sync-run-remote" className="rounded bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--muted)]">{run.remoteProjectKey}</span>
          )}
        </div>
        <span className="text-xs text-[var(--muted)]">
          {run.totalTickets > 0 && (
            <>
              {run.processedTickets + run.failedTickets} of {run.totalTickets} tickets
              {active ? ` · ${pct}%` : ""}
            </>
          )}
        </span>
      </div>

      {active && run.totalTickets > 0 && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-tertiary)]">
          <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: tone.text }} />
        </div>
      )}

      {/* Two things the user asked to always be able to see: who ran it, and what it produced —
          so an empty-looking document has a visible explanation. */}
      <p className="mt-2 text-xs text-[var(--muted)]">
        {run.triggeredByName ? `Started by ${run.triggeredByName}` : "Started automatically"}
        {run.startedAt ? ` · ${relativeTime(run.startedAt)}` : ""}
        {run.finishedAt && !active ? ` · finished ${relativeTime(run.finishedAt)}` : ""}
        {stats.length ? ` · ${stats.join(" · ")}` : ""}
      </p>

      {run.error && (
        <p className="mt-1.5 text-xs" style={{ color: run.status === "failed" ? "var(--error)" : "var(--muted)" }}>
          {run.error}
        </p>
      )}
    </div>
  );
}
