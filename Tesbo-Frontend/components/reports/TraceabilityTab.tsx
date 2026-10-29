"use client";

import { useCallback, useMemo, useState } from "react";
import { IconSearch, IconX } from "@tabler/icons-react";
import { Modal, StatusChip, PriorityBadge, type Priority } from "@/components/ui";
import type { RequirementMatrixRow } from "@/lib/api";
import { formatDate } from "@/lib/date";
import { statusTone, LoadingBlock } from "./shared";

const MATRIX_COLUMNS = [
  { key: "tcId", label: "Test Case ID", defaultWidth: 110, minWidth: 80 },
  { key: "title", label: "Title", defaultWidth: 260, minWidth: 140 },
  // Wide enough for a chip, not just "P2": rows can carry "Medium" and the table is fixed-layout, so a
  // chip wider than its column spills into the neighbouring cell instead of growing it.
  { key: "priority", label: "Priority", defaultWidth: 110, minWidth: 90 },
  { key: "tcStatus", label: "Status", defaultWidth: 120, minWidth: 100 },
  { key: "suite", label: "Suite", defaultWidth: 120, minWidth: 70 },
  { key: "run", label: "Run", defaultWidth: 150, minWidth: 90 },
  { key: "runStatus", label: "Result", defaultWidth: 90, minWidth: 70 },
  { key: "executedAt", label: "Executed", defaultWidth: 100, minWidth: 80 },
  { key: "bug", label: "Bug", defaultWidth: 170, minWidth: 80 },
] as const;

function useResizableColumns(columns: readonly { key: string; defaultWidth: number; minWidth: number }[]) {
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    const w: Record<string, number> = {};
    columns.forEach((c) => { w[c.key] = c.defaultWidth; });
    return w;
  });
  const onMouseDown = useCallback(
    (key: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const minW = columns.find((c) => c.key === key)?.minWidth ?? 50;
      const startX = e.clientX;
      const startW = widths[key];
      const onMouseMove = (ev: MouseEvent) => {
        const diff = ev.clientX - startX;
        setWidths((prev) => ({ ...prev, [key]: Math.max(minW, startW + diff) }));
      };
      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [widths, columns]
  );
  return { widths, onMouseDown };
}

export function TraceabilityTab({
  rows,
  loading,
  search,
  onSearchChange,
  total,
  offset,
  pageSize,
  onOffsetChange,
}: {
  rows: RequirementMatrixRow[];
  loading: boolean;
  search: string;
  onSearchChange: (v: string) => void;
  /** Test cases matching the search across all pages; `rows` holds only the current page's. */
  total: number;
  offset: number;
  pageSize: number;
  onOffsetChange: (v: number) => void;
}) {
  const { widths, onMouseDown } = useResizableColumns(MATRIX_COLUMNS);

  // Search is applied by the server (so it covers every page), so the rows arrive already filtered.
  const filteredRows = rows;

  const groupedRows = useMemo(() => {
    const groups: { testcaseId: string; externalId: string; testcaseTitle: string; priority: string; testcaseStatus: string; suiteName: string | null; runs: RequirementMatrixRow[] }[] = [];
    const map = new Map<string, (typeof groups)[number]>();
    for (const row of filteredRows) {
      let group = map.get(row.testcaseId);
      if (!group) {
        group = { testcaseId: row.testcaseId, externalId: row.externalId, testcaseTitle: row.testcaseTitle, priority: row.priority, testcaseStatus: row.testcaseStatus, suiteName: row.suiteName, runs: [] };
        map.set(row.testcaseId, group);
        groups.push(group);
      }
      group.runs.push(row);
    }
    return groups;
  }, [filteredRows]);

  const [selectedTestcaseId, setSelectedTestcaseId] = useState<string | null>(null);
  const selectedGroup = groupedRows.find((g) => g.testcaseId === selectedTestcaseId) ?? null;
  // A run can appear on several rows when it has several bugs; list each run once and gather its bugs.
  const selectedRuns = useMemo(() => {
    if (!selectedGroup) return [];
    const byRun = new Map<string, { row: RequirementMatrixRow; bugs: { title: string; url?: string | null }[] }>();
    for (const r of selectedGroup.runs) {
      const key = r.runId ?? `none-${byRun.size}`;
      let entry = byRun.get(key);
      if (!entry) {
        entry = { row: r, bugs: [] };
        byRun.set(key, entry);
      }
      if (r.bugTitle) entry.bugs.push({ title: r.bugTitle, url: r.bugUrl });
    }
    return Array.from(byRun.values()).filter((e) => e.row.runId || e.row.runName);
  }, [selectedGroup]);

  return (
    <div className="fade-in">
      <Modal
        open={selectedGroup !== null}
        onClose={() => setSelectedTestcaseId(null)}
        className="max-w-[720px]"
      >
        {selectedGroup && (
          <>
            {/* Header is rendered here, not via Modal's `title`, so the close button can sit beside it. */}
            <div className="mb-3 flex items-start justify-between gap-4">
              <h2 className="text-[24px] font-semibold leading-[1.2] tracking-[-0.02em] text-[var(--ink-800)]">{selectedGroup.externalId} · Runs</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setSelectedTestcaseId(null)}
                className="shrink-0 rounded-[6px] p-1 text-[var(--muted-soft)] hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
              >
                <IconX size={18} stroke={1.75} />
              </button>
            </div>
            <div className="mb-4 text-[14px] text-[var(--foreground)]">{selectedGroup.testcaseTitle}</div>
            {selectedRuns.length === 0 ? (
              <div className="py-6 text-center text-[13px] text-[var(--muted-soft)]">This test case has not been run yet.</div>
            ) : (
              <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">
                {selectedRuns.map(({ row, bugs }, i) => (
                  <li key={`${row.runId}-${i}`} className="flex items-start justify-between gap-4 px-4 py-3">
                    <div className="min-w-0">
                      <div className="break-words text-[13px] text-[var(--foreground)]">{row.runName || "—"}</div>
                      <div className="mt-0.5 text-[11px] text-[var(--muted-soft)]">{row.executedAt ? formatDate(row.executedAt) : "Not executed"}</div>
                      {bugs.map((b, bi) =>
                        b.url ? (
                          <a key={bi} href={b.url} target="_blank" rel="noreferrer" className="mt-1 block break-words text-[12px] text-[var(--accent-light)] hover:underline">{b.title}</a>
                        ) : (
                          <span key={bi} className="mt-1 block break-words text-[12px] text-[var(--muted)]">{b.title}</span>
                        )
                      )}
                    </div>
                    <StatusChip tone={statusTone(row.executionStatus)}>{row.executionStatus || "—"}</StatusChip>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Modal>
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <div className="mb-0.5 text-[15px] font-semibold text-[var(--foreground)]">Traceability Matrix</div>
          <div className="text-[12px] text-[var(--muted-soft)]">Requirements → test cases → runs → bugs</div>
        </div>
        <label className="flex h-[30px] w-64 items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2.5 text-[12px] text-[var(--muted-soft)] focus-within:border-[var(--brand-primary)]">
          <IconSearch size={13} stroke={1.75} className="shrink-0" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search by ID, title, run, bug…"
            className="min-w-0 flex-1 bg-transparent text-[var(--foreground)] outline-none focus-visible:outline-none placeholder:text-[var(--muted-soft)]"
          />
        </label>
      </div>

      {loading ? (
        <LoadingBlock label="Loading matrix…" />
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="overflow-x-auto">
            <table className="border-collapse" style={{ minWidth: "100%", tableLayout: "fixed", width: Object.values(widths).reduce((a, b) => a + b, 0) }}>
              <colgroup>
                {MATRIX_COLUMNS.map((col) => <col key={col.key} style={{ width: widths[col.key] }} />)}
              </colgroup>
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[10px] uppercase tracking-wider text-[var(--muted-soft)]">
                  {MATRIX_COLUMNS.map((col) => (
                    <th key={col.key} className="relative select-none px-3 py-2.5 font-medium" style={{ width: widths[col.key] }}>
                      <span>{col.label}</span>
                      <span
                        onMouseDown={(e) => onMouseDown(col.key, e)}
                        className="absolute right-0 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-[var(--brand-soft)]"
                        style={{ touchAction: "none" }}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groupedRows.length === 0 ? (
                  <tr><td colSpan={9} className="px-3 py-8 text-center text-[13px] text-[var(--muted-soft)]">{search ? "No matching rows found." : "No test case data available."}</td></tr>
                ) : (
                  groupedRows.map((group) => {
                    // Only the latest run is shown inline; the full list opens from the title.
                    const visibleRuns = group.runs.slice(0, 1);
                    const rowCount = visibleRuns.length;
                    return visibleRuns.map((row, ri) => (
                      <tr key={`${row.testcaseId}-${row.runId}-${row.bugId}-${ri}`} title="Click to view full backlog" onClick={() => setSelectedTestcaseId(group.testcaseId)} className={`cursor-pointer hover:bg-[var(--brand-soft)] ${ri < rowCount - 1 ? "" : "border-b border-[var(--border)]"}`}>
                        {ri === 0 && (
                          <>
                            <td rowSpan={rowCount} className="border-b border-[var(--border)] px-3 py-2.5 align-top font-mono text-[11px] text-[var(--muted)]">{group.externalId}</td>
                            <td rowSpan={rowCount} className="border-b border-[var(--border)] px-3 py-2.5 align-top text-[13px] text-[var(--foreground)]">
                              <button
                                type="button"
                                onClick={() => setSelectedTestcaseId(group.testcaseId)}
                                className="whitespace-normal break-words text-left"
                              >
                                {group.testcaseTitle}
                              </button>
                            </td>
                            <td rowSpan={rowCount} className="border-b border-[var(--border)] px-3 py-2.5 align-top">
                              {group.priority ? <PriorityBadge priority={group.priority as Priority} /> : <span className="text-[var(--muted-soft)]">—</span>}
                            </td>
                            <td rowSpan={rowCount} className="border-b border-[var(--border)] px-3 py-2.5 align-top">
                              <StatusChip tone={statusTone(group.testcaseStatus)}>{group.testcaseStatus || "—"}</StatusChip>
                            </td>
                            <td rowSpan={rowCount} className="border-b border-[var(--border)] px-3 py-2.5 align-top text-[12px] text-[var(--muted)]">
                              <span className="whitespace-normal break-words">{group.suiteName || "—"}</span>
                            </td>
                          </>
                        )}
                        <td className={`px-3 py-2 text-[13px] text-[var(--muted)] ${ri > 0 ? "border-t border-dashed border-[var(--border-subtle)]" : ""}`}>
                          <span className="whitespace-normal break-words">{row.runName || "—"}</span>
                        </td>
                        <td className={`px-3 py-2 ${ri > 0 ? "border-t border-dashed border-[var(--border-subtle)]" : ""}`}>
                          <StatusChip tone={statusTone(row.executionStatus)}>{row.executionStatus || "—"}</StatusChip>
                        </td>
                        <td className={`whitespace-nowrap px-3 py-2 text-[11px] text-[var(--muted-soft)] ${ri > 0 ? "border-t border-dashed border-[var(--border-subtle)]" : ""}`}>
                          {row.executedAt ? formatDate(row.executedAt) : "—"}
                        </td>
                        <td className={`px-3 py-2 text-[13px] ${ri > 0 ? "border-t border-dashed border-[var(--border-subtle)]" : ""}`}>
                          {row.bugTitle ? (
                            row.bugUrl ? (
                              <a onClick={(e) => e.stopPropagation()} href={row.bugUrl} target="_blank" rel="noreferrer" className="break-words text-[12px] text-[var(--accent-light)] hover:underline">{row.bugTitle}</a>
                            ) : (
                              <span className="break-words text-[12px] text-[var(--muted)]">{row.bugTitle}</span>
                            )
                          ) : (
                            <span className="text-[12px] text-[var(--muted-soft)]">—</span>
                          )}
                        </td>
                      </tr>
                    ));
                  })
                )}
              </tbody>
            </table>
          </div>
          {groupedRows.length > 0 && (
            <div className="flex items-center justify-between gap-4 border-t border-[var(--border)] px-4 py-2.5 text-[11px] text-[var(--muted-soft)]">
              <span>
                Test cases {offset + 1}–{offset + groupedRows.length} of {total}
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  disabled={offset === 0}
                  onClick={() => onOffsetChange(Math.max(0, offset - pageSize))}
                  className="rounded-[6px] border border-[var(--border)] px-2.5 py-1 disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={offset + pageSize >= total}
                  onClick={() => onOffsetChange(offset + pageSize)}
                  className="rounded-[6px] border border-[var(--border)] px-2.5 py-1 disabled:opacity-40"
                >
                  Next
                </button>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
