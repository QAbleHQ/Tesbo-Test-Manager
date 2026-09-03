"use client";

import { useCallback, useMemo, useState } from "react";
import { IconSearch } from "@tabler/icons-react";
import { StatusChip } from "@/components/ui";
import type { RequirementMatrixRow } from "@/lib/api";
import { PRIORITY_COLORS } from "./charts";
import { statusTone, LoadingBlock } from "./shared";

const MATRIX_COLUMNS = [
  { key: "tcId", label: "Test Case ID", defaultWidth: 110, minWidth: 80 },
  { key: "title", label: "Title", defaultWidth: 260, minWidth: 140 },
  { key: "priority", label: "Priority", defaultWidth: 70, minWidth: 60 },
  { key: "tcStatus", label: "Status", defaultWidth: 90, minWidth: 70 },
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
}: {
  rows: RequirementMatrixRow[];
  loading: boolean;
  search: string;
  onSearchChange: (v: string) => void;
}) {
  const { widths, onMouseDown } = useResizableColumns(MATRIX_COLUMNS);

  const filteredRows = useMemo(() => {
    if (!search) return rows;
    const q = search.toLowerCase();
    return rows.filter(
      (r) =>
        r.externalId?.toLowerCase().includes(q) ||
        r.testcaseTitle?.toLowerCase().includes(q) ||
        r.runName?.toLowerCase().includes(q) ||
        r.bugTitle?.toLowerCase().includes(q)
    );
  }, [rows, search]);

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

  return (
    <div className="fade-in">
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
            className="min-w-0 flex-1 bg-transparent text-[var(--foreground)] outline-none placeholder:text-[var(--muted-soft)]"
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
                    const rowCount = group.runs.length;
                    return group.runs.map((row, ri) => (
                      <tr key={`${row.testcaseId}-${row.runId}-${row.bugId}-${ri}`} className={`hover:bg-[var(--surface-secondary)] ${ri < rowCount - 1 ? "" : "border-b border-[var(--border)]"}`}>
                        {ri === 0 && (
                          <>
                            <td rowSpan={rowCount} className="border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 align-top font-mono text-[11px] text-[var(--muted)]">{group.externalId}</td>
                            <td rowSpan={rowCount} className="border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 align-top text-[13px] text-[var(--foreground)]">
                              <span className="whitespace-normal break-words">{group.testcaseTitle}</span>
                            </td>
                            <td rowSpan={rowCount} className="border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 align-top">
                              <span className="text-[12px] font-medium" style={{ color: PRIORITY_COLORS[group.priority] || "var(--muted-soft)" }}>{group.priority}</span>
                            </td>
                            <td rowSpan={rowCount} className="border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 align-top">
                              <StatusChip tone={statusTone(group.testcaseStatus)}>{group.testcaseStatus || "—"}</StatusChip>
                            </td>
                            <td rowSpan={rowCount} className="border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 align-top text-[12px] text-[var(--muted)]">
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
                          {row.executedAt ? new Date(row.executedAt).toLocaleDateString() : "—"}
                        </td>
                        <td className={`px-3 py-2 text-[13px] ${ri > 0 ? "border-t border-dashed border-[var(--border-subtle)]" : ""}`}>
                          {row.bugTitle ? (
                            row.bugUrl ? (
                              <a href={row.bugUrl} target="_blank" rel="noreferrer" className="break-words text-[12px] text-[var(--accent-light)] hover:underline">{row.bugTitle}</a>
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
            <div className="border-t border-[var(--border)] px-4 py-2.5 text-[11px] text-[var(--muted-soft)]">
              {groupedRows.length} test case{groupedRows.length !== 1 ? "s" : ""} across {filteredRows.length} row{filteredRows.length !== 1 ? "s" : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
