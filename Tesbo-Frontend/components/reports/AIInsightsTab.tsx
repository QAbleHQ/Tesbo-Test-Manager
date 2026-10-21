"use client";

import { IconFlame, IconEyeOff, IconAlertCircle, IconMap } from "@tabler/icons-react";
import { useState } from "react";
import { Modal, StatusChip } from "@/components/ui";
import type { FlakyTestRow, ReportsInsights } from "@/lib/api";
import { HealthGauge } from "./charts";
import { statusTone, LoadingBlock } from "./shared";

// A test can have hundreds of runs; the strip shows only the most recent ones so a row stays one line tall.
const RUN_STRIP_MAX = 30;

const FLAKY_TONE = {
  High: { color: "var(--error)", bg: "var(--error-soft)" },
  Medium: { color: "var(--warning)", bg: "var(--warning-soft)" },
  Low: { color: "var(--info)", bg: "var(--info-soft)" },
} as const;

const RUN_DOT: Record<string, string> = {
  Passed: "var(--success)",
  Failed: "var(--error)",
  Blocked: "var(--status-blocked-dot)",
  Skipped: "var(--status-skipped-dot)",
  Retest: "var(--status-retest-dot)",
};

function FlakyRow({ f }: { f: FlakyTestRow }) {
  const tone = FLAKY_TONE[f.flakinessLabel];
  const failed = f.runs.filter((r) => r.status === "Failed").length;
  const shown = f.runs.slice(-RUN_STRIP_MAX);
  const hidden = f.runs.length - shown.length;
  const passed = f.runs.filter((r) => r.status === "Passed").length;
  const [open, setOpen] = useState(false);
  return (
    <li className="flex flex-col gap-3 px-4 py-3.5 md:flex-row md:items-center md:gap-6">
      <div className="min-w-0 md:w-[38%]">
        <div className="flex items-center gap-2">
          <span className="shrink-0 rounded bg-[var(--surface-secondary)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--muted)]">{f.externalId}</span>
          <span className="truncate text-[13px] font-medium text-[var(--foreground)]" title={f.title}>{f.title}</span>
        </div>
        <div className="mt-1 truncate text-[11.5px] text-[var(--muted-soft)]">{f.suiteName}</div>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-[3px]">
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="mr-1 cursor-pointer text-[10.5px] font-medium text-[var(--brand)] underline-offset-2 hover:underline"
            >
              +{hidden} earlier
            </button>
          )}
          {shown.map((r, i) => (
            <span
              key={i}
              title={`${r.runName}: ${r.status}`}
              className="h-3.5 w-3.5 rounded-[3px]"
              style={{ background: RUN_DOT[r.status] ?? "var(--border)" }}
            />
          ))}
        </div>
        <div className="mt-1.5 text-[11px] text-[var(--muted-soft)]">
          {f.runs.length} runs · {passed} passed · {failed} failed · {f.flipCount} changed
        </div>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title={`${f.externalId} · all runs`} className="max-w-[640px]">
        <p className="mb-3 text-[12.5px] text-[var(--muted)]">{f.title}</p>
        <div className="mb-3 text-[11.5px] text-[var(--muted-soft)]">
          {f.runs.length} runs · {passed} passed · {failed} failed · {f.flipCount} changed
        </div>
        <ol className="divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border)]">
          {f.runs.map((r, i) => (
            <li key={i} className="flex items-center gap-3 px-3 py-2">
              <span className="w-8 shrink-0 text-right font-mono text-[11px] text-[var(--muted-soft)]">#{i + 1}</span>
              <span className="h-3 w-3 shrink-0 rounded-[3px]" style={{ background: RUN_DOT[r.status] ?? "var(--border)" }} />
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--foreground)]" title={r.runName}>{r.runName}</span>
              <StatusChip tone={statusTone(r.status)}>{r.status}</StatusChip>
            </li>
          ))}
        </ol>
      </Modal>

      <span
        className="w-fit shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold md:w-[84px] md:text-center"
        style={{ background: tone.bg, color: tone.color }}
      >
        {f.flakinessLabel}
      </span>
    </li>
  );
}

function CoverageHeatmap({ rows }: { rows: ReportsInsights["coverageBySuite"] }) {
  const tone = (pct: number) => (pct >= 70 ? "var(--success)" : pct >= 30 ? "var(--warning)" : "var(--error)");
  const bg = (pct: number) => (pct >= 70 ? "var(--success-soft)" : pct >= 30 ? "var(--warning-soft)" : "var(--error-soft)");
  const label = (pct: number) => (pct >= 70 ? "Good" : pct >= 30 ? "Low" : "Critical");
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.suiteName} className="flex items-center gap-3.5">
          <span className="w-28 shrink-0 truncate text-right text-[12px] text-[var(--muted)]">{r.suiteName}</span>
          <div className="h-4 flex-1 overflow-hidden rounded bg-[var(--surface-secondary)]">
            <div className="h-full rounded" style={{ width: `${r.pct}%`, background: tone(r.pct), opacity: 0.75 }} />
          </div>
          <span className="w-9 shrink-0 text-right font-mono text-[11px]" style={{ color: tone(r.pct) }}>{r.pct}%</span>
          <span
            className="w-[58px] shrink-0 rounded-full px-2 py-0.5 text-center text-[10px] font-semibold"
            style={{ background: bg(r.pct), color: tone(r.pct) }}
          >
            {label(r.pct)}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-[var(--muted-soft)]">{r.covered}/{r.total}</span>
        </div>
      ))}
      {rows.length === 0 && <p className="py-4 text-center text-[13px] text-[var(--muted-soft)]">No suites yet</p>}
    </div>
  );
}

export function AIInsightsTab({ insights, loading }: { insights: ReportsInsights | null; loading: boolean }) {
  if (loading) return <LoadingBlock label="Loading insights…" />;
  if (!insights) return <LoadingBlock label="No data available." />;

  return (
    <div className="fade-in">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[15px] font-semibold text-[var(--foreground)]">AI Insights</span>
        <span className="rounded-full bg-[var(--ai-soft)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ai-primary)]">AI</span>
      </div>
      <p className="mb-4 text-[12px] text-[var(--muted-soft)]">Automated intelligence from your execution data</p>

      <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-[180px_1fr]">
        <div className="flex flex-col items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="mb-2.5 text-center text-[10px] font-semibold uppercase tracking-wide text-[var(--muted-soft)]">Health score</div>
          <div className="h-[110px] w-[140px]"><HealthGauge score={insights.healthScore} /></div>
          <div
            className="mt-1.5 text-[12px] font-medium"
            style={{ color: insights.healthScore >= 70 ? "var(--success)" : insights.healthScore >= 40 ? "var(--warning)" : "var(--error)" }}
          >
            {insights.healthLabel}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          <div className="rounded-xl border border-[var(--status-fail-text)]/30 bg-[var(--surface)] p-3.5">
            <div className="mb-2 flex items-center gap-1.5">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--status-fail-fill)]">
                <IconFlame size={14} stroke={1.75} className="text-[var(--status-fail-text)]" />
              </div>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--status-fail-text)]">Flaky tests</span>
            </div>
            <div className="text-[22px] font-bold leading-none text-[var(--status-fail-text)]">{insights.flakyTests.length}</div>
            <div className="mt-1 text-[11px] leading-snug text-[var(--muted-soft)]">
              {insights.flakyTests[0] ? `${insights.flakyTests[0].externalId} alternated results across runs` : "None detected"}
            </div>
          </div>
          <div className="rounded-xl border border-[var(--status-blocked-text)]/30 bg-[var(--surface)] p-3.5">
            <div className="mb-2 flex items-center gap-1.5">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--status-blocked-fill)]">
                <IconEyeOff size={14} stroke={1.75} className="text-[var(--status-blocked-text)]" />
              </div>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--status-blocked-text)]">Coverage gaps</span>
            </div>
            <div className="text-[22px] font-bold leading-none text-[var(--status-blocked-text)]">{insights.coverageGaps.length}</div>
            <div className="mt-1 text-[11px] leading-snug text-[var(--muted-soft)]">
              {insights.coverageGaps.length > 0 ? insights.coverageGaps.map((c) => c.suiteName).join(" & ") + " below 70%" : "All suites well covered"}
            </div>
          </div>
          <div className="rounded-xl border border-[var(--info)]/30 bg-[var(--surface)] p-3.5">
            <div className="mb-2 flex items-center gap-1.5">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--info-soft)]">
                <IconAlertCircle size={14} stroke={1.75} className="text-[var(--info-foreground)]" />
              </div>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--info-foreground)]">Untested P1s</span>
            </div>
            <div className="text-[22px] font-bold leading-none text-[var(--info-foreground)]">{insights.untestedP1Count}</div>
            <div className="mt-1 text-[11px] leading-snug text-[var(--muted-soft)]">High-priority cases never executed</div>
          </div>
        </div>
      </div>

      {/* Flaky test detector */}
      <div className="mb-4 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div className="flex items-center gap-1.5">
            <IconFlame size={15} stroke={1.75} className="text-[var(--status-fail-text)]" />
            <span className="text-[13px] font-semibold text-[var(--foreground)]">Flaky test detector</span>
          </div>
          <span className="text-[11px] text-[var(--muted-soft)]">Inconsistent results across runs</span>
        </div>
        {insights.flakyTests.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--border-subtle)] px-4 py-2 text-[11px] text-[var(--muted-soft)]">
            <span className="font-medium uppercase tracking-wide">Legend</span>
            {Object.entries(RUN_DOT).map(([status, color]) => (
              <span key={status} className="flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-[3px]" style={{ background: color }} />
                {status}
              </span>
            ))}
          </div>
        )}
        {insights.flakyTests.length === 0 ? (
          <p className="py-8 text-center text-[13px] text-[var(--muted-soft)]">No flaky tests detected yet</p>
        ) : (
          <ul className="divide-y divide-[var(--border-subtle)]">
            {insights.flakyTests.map((f) => <FlakyRow key={f.testcaseId} f={f} />)}
          </ul>
        )}
      </div>

      {/* Coverage heatmap */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="mb-3.5 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <IconMap size={15} stroke={1.75} className="text-[var(--warning-foreground)]" />
            <span className="text-[13px] font-semibold text-[var(--foreground)]">Coverage by suite</span>
          </div>
          <span className="text-[11px] text-[var(--muted-soft)]">% of cases executed at least once</span>
        </div>
        <CoverageHeatmap rows={insights.coverageBySuite} />
      </div>
    </div>
  );
}
