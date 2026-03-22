"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui";
import type { TestCaseListItem } from "@/lib/api";

export const REPO_TC_AI_DISABLED_TITLE =
  "AI Key is not allocated to this project, so AI-assisted automation is unavailable.";

export type RepoTcColumnId =
  | "select"
  | "id"
  | "title"
  | "suite"
  | "automate"
  | "run"
  | "jira"
  | "priority"
  | "status"
  | "updated"
  | "type"
  | "automationFeasibility";

type RepoDataColumnId = Exclude<RepoTcColumnId, "select">;

const DATA_COLUMN_IDS: RepoDataColumnId[] = [
  "id",
  "title",
  "suite",
  "automate",
  "run",
  "jira",
  "priority",
  "status",
  "updated",
  "type",
  "automationFeasibility",
];

const COLUMN_LABELS: Record<RepoTcColumnId, string> = {
  select: "Bulk select",
  id: "ID",
  title: "Test case title",
  suite: "Suite",
  automate: "Automate",
  run: "Run this test case",
  jira: "Jira",
  priority: "Priority",
  status: "Status",
  updated: "Updated",
  type: "Type",
  automationFeasibility: "Automation feasibility",
};

const FIELD_IDS: Record<RepoDataColumnId, string> = {
  id: "id",
  title: "title",
  suite: "suite",
  automate: "automate",
  run: "run",
  jira: "jira",
  priority: "priority",
  status: "status",
  updated: "updated",
  type: "type",
  automationFeasibility: "automationStatus",
};

const DEFAULT_DATA_ORDER: RepoDataColumnId[] = [
  "id",
  "title",
  "suite",
  "automate",
  "run",
  "jira",
  "priority",
  "status",
  "updated",
  "type",
  "automationFeasibility",
];

/** First five data columns shown by default; remainder off until the user enables them (saved in localStorage). */
const DEFAULT_ON_DATA_COLUMNS: ReadonlySet<RepoDataColumnId> = new Set([
  "id",
  "title",
  "suite",
  "automate",
  "run",
]);

const DEFAULT_VISIBLE: Record<RepoDataColumnId, boolean> = {
  id: true,
  title: true,
  suite: true,
  automate: true,
  run: true,
  jira: false,
  priority: false,
  status: false,
  updated: false,
  type: false,
  automationFeasibility: false,
};

/** When exactly these five (+ row select) are visible, the table uses full width and percentage columns to fit the screen. */
function isDefaultFiveOnlyView(visible: Record<RepoDataColumnId, boolean>): boolean {
  for (const id of DATA_COLUMN_IDS) {
    const shouldShow = DEFAULT_ON_DATA_COLUMNS.has(id);
    if (visible[id] !== shouldShow) return false;
  }
  return true;
}

/** Percent widths for select + default five; must sum to 100. */
const FIT_LAYOUT_PCT: Record<RepoTcColumnId, number> = {
  select: 4,
  id: 9,
  title: 34,
  suite: 17,
  automate: 14,
  run: 22,
  jira: 0,
  priority: 0,
  status: 0,
  updated: 0,
  type: 0,
  automationFeasibility: 0,
};

const DEFAULT_WIDTHS: Record<RepoTcColumnId, number> = {
  select: 44,
  id: 112,
  title: 240,
  suite: 160,
  automate: 108,
  run: 148,
  jira: 112,
  priority: 88,
  status: 112,
  updated: 108,
  type: 120,
  automationFeasibility: 168,
};

const MIN_WIDTHS: Record<RepoTcColumnId, number> = {
  select: 40,
  id: 72,
  title: 140,
  suite: 96,
  automate: 88,
  run: 120,
  jira: 80,
  priority: 72,
  status: 88,
  updated: 96,
  type: 88,
  automationFeasibility: 120,
};

const MAX_WIDTH = 560;

type TablePrefs = {
  dataOrder: RepoDataColumnId[];
  visible: Record<RepoDataColumnId, boolean>;
  widths: Partial<Record<RepoTcColumnId, number>>;
};

function storageKey(projectId: string) {
  return `bettercases-repo-tc-table:v1:${projectId}`;
}

function normalizeDataOrder(raw: unknown): RepoDataColumnId[] {
  const set = new Set(DATA_COLUMN_IDS);
  const seen = new Set<string>();
  const out: RepoDataColumnId[] = [];
  if (Array.isArray(raw)) {
    for (const id of raw) {
      if (typeof id === "string" && set.has(id as RepoDataColumnId) && !seen.has(id)) {
        seen.add(id);
        out.push(id as RepoDataColumnId);
      }
    }
  }
  for (const id of DEFAULT_DATA_ORDER) {
    if (!seen.has(id)) out.push(id);
  }
  return out;
}

function normalizeVisible(raw: unknown): Record<RepoDataColumnId, boolean> {
  const next = { ...DEFAULT_VISIBLE };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const id of DATA_COLUMN_IDS) {
      const v = (raw as Record<string, unknown>)[id];
      if (typeof v === "boolean") next[id] = v;
    }
  }
  return next;
}

function loadPrefs(projectId: string): Omit<TablePrefs, "widths"> & { widths: Record<RepoTcColumnId, number> } {
  const widths: Record<RepoTcColumnId, number> = { ...DEFAULT_WIDTHS };
  let dataOrder = DEFAULT_DATA_ORDER;
  let visible = DEFAULT_VISIBLE;
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return { dataOrder, visible, widths };
    const parsed = JSON.parse(raw) as Partial<TablePrefs>;
    dataOrder = normalizeDataOrder(parsed.dataOrder);
    visible = normalizeVisible(parsed.visible);
    if (parsed.widths && typeof parsed.widths === "object") {
      for (const id of Object.keys(DEFAULT_WIDTHS) as RepoTcColumnId[]) {
        const w = (parsed.widths as Record<string, unknown>)[id];
        if (typeof w === "number" && w >= MIN_WIDTHS[id] && w <= MAX_WIDTH) {
          widths[id] = w;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return { dataOrder, visible, widths };
}

export type RepositoryTestCaseTableProps = {
  projectId: string;
  suiteNameMap: Map<string, string>;
  cases: TestCaseListItem[];
  aiConfigured: boolean;
  rowHighlightId: string | null;
  selectedCaseIdSet: Set<string>;
  areAllCasesSelected: boolean;
  onToggleSelectAll: () => void;
  onToggleCase: (id: string) => void;
  onOpenRow: (id: string) => void;
  onRunSingle: (id: string) => void;
};

export function RepositoryTestCaseTable({
  projectId,
  suiteNameMap,
  cases,
  aiConfigured,
  rowHighlightId,
  selectedCaseIdSet,
  areAllCasesSelected,
  onToggleSelectAll,
  onToggleCase,
  onOpenRow,
  onRunSingle,
}: RepositoryTestCaseTableProps) {
  const [dataOrder, setDataOrder] = useState<RepoDataColumnId[]>(DEFAULT_DATA_ORDER);
  const [visible, setVisible] = useState<Record<RepoDataColumnId, boolean>>(DEFAULT_VISIBLE);
  const [widths, setWidths] = useState<Record<RepoTcColumnId, number>>(DEFAULT_WIDTHS);
  const [prefsReady, setPrefsReady] = useState(false);
  const [dragOverId, setDragOverId] = useState<RepoDataColumnId | null>(null);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const columnsMenuRef = useRef<HTMLDivElement>(null);

  const resizeRef = useRef<{ col: RepoTcColumnId; startX: number; startW: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = window.setTimeout(() => {
      if (cancelled) return;
      const p = loadPrefs(projectId);
      setDataOrder(p.dataOrder);
      setVisible(p.visible);
      setWidths(p.widths);
      setPrefsReady(true);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [projectId]);

  useEffect(() => {
    if (!prefsReady) return;
    try {
      const payload: TablePrefs = { dataOrder, visible, widths };
      localStorage.setItem(storageKey(projectId), JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }, [prefsReady, projectId, dataOrder, visible, widths]);

  useEffect(() => {
    if (!columnsMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (columnsMenuRef.current && !columnsMenuRef.current.contains(e.target as Node)) {
        setColumnsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [columnsMenuOpen]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const delta = e.clientX - r.startX;
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTHS[r.col], r.startW + delta));
      setWidths((prev) => ({ ...prev, [r.col]: next }));
    };
    const onUp = () => {
      resizeRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const startResize = useCallback((col: RepoTcColumnId, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { col, startX: e.clientX, startW: widths[col] };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [widths]);

  const visibleDataColumns = useMemo(
    () => dataOrder.filter((id) => visible[id]),
    [dataOrder, visible],
  );

  const orderedColumns: RepoTcColumnId[] = useMemo(
    () => ["select", ...visibleDataColumns],
    [visibleDataColumns],
  );

  /** Full-width percentage layout only when the five default data columns are exactly what is shown. */
  const fitDefaultFiveToScreen = useMemo(() => isDefaultFiveOnlyView(visible), [visible]);

  const totalWidth = useMemo(
    () => orderedColumns.reduce((sum, id) => sum + widths[id], 0),
    [orderedColumns, widths],
  );

  const moveColumn = useCallback((from: RepoDataColumnId, to: RepoDataColumnId) => {
    if (from === to) return;
    setDataOrder((prev) => {
      const next = [...prev];
      const i = next.indexOf(from);
      const j = next.indexOf(to);
      if (i === -1 || j === -1) return prev;
      next.splice(i, 1);
      next.splice(j, 0, from);
      return next;
    });
  }, []);

  const toggleColumnVisible = useCallback((id: RepoDataColumnId) => {
    setVisible((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  function renderHeaderCell(col: RepoTcColumnId) {
    const w = widths[col];
    const label = COLUMN_LABELS[col];
    const isData = col !== "select";
    const thSizing = fitDefaultFiveToScreen
      ? { width: `${FIT_LAYOUT_PCT[col]}%`, position: "relative" as const }
      : { width: w, minWidth: w, maxWidth: w, position: "relative" as const };

    return (
      <th
        key={col}
        style={thSizing}
        className="align-middle"
        draggable={isData}
        onDragStart={
          isData
            ? (e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", col);
              }
            : undefined
        }
        onDragOver={
          isData
            ? (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }
            : undefined
        }
        onDragEnter={
          isData
            ? () => {
                setDragOverId(col);
              }
            : undefined
        }
        onDragLeave={
          isData
            ? () => {
                setDragOverId((cur) => (cur === col ? null : cur));
              }
            : undefined
        }
        onDrop={
          isData
            ? (e) => {
                e.preventDefault();
                const from = e.dataTransfer.getData("text/plain") as RepoDataColumnId;
                setDragOverId(null);
                if (from && DATA_COLUMN_IDS.includes(from)) moveColumn(from, col);
              }
            : undefined
        }
        onDragEnd={() => setDragOverId(null)}
      >
        <div
          className={`flex items-center gap-1.5 pr-2 ${dragOverId === col && isData ? "rounded-md bg-[var(--brand-soft)]" : ""}`}
        >
          {isData && (
            <span className="cursor-grab text-[var(--muted-soft)] select-none active:cursor-grabbing" aria-hidden="true">
              <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" className="opacity-60">
                <circle cx="3" cy="3" r="1.25" />
                <circle cx="7" cy="3" r="1.25" />
                <circle cx="3" cy="7" r="1.25" />
                <circle cx="7" cy="7" r="1.25" />
                <circle cx="3" cy="11" r="1.25" />
                <circle cx="7" cy="11" r="1.25" />
              </svg>
            </span>
          )}
          {col === "select" ? (
            <input
              type="checkbox"
              checked={areAllCasesSelected}
              onChange={onToggleSelectAll}
              aria-label="Select all test cases on this page"
              className="mx-auto block"
            />
          ) : (
            <span className="truncate">{label}</span>
          )}
        </div>
        {!fitDefaultFiveToScreen && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize ${label} column`}
            className="absolute right-0 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-[var(--brand-primary)]/15"
            onMouseDown={(e) => startResize(col, e)}
          />
        )}
      </th>
    );
  }

  function renderBodyCell(col: RepoTcColumnId, tc: TestCaseListItem) {
    const w = widths[col];
    const tdStyle = fitDefaultFiveToScreen
      ? { width: `${FIT_LAYOUT_PCT[col]}%` }
      : { width: w };
    const cellClass = "min-w-0 align-middle";
    const innerTruncate = "block max-w-full truncate whitespace-nowrap";

    switch (col) {
      case "select":
        return (
          <td key={col} style={tdStyle} className={cellClass}>
            <input
              type="checkbox"
              checked={selectedCaseIdSet.has(tc.id)}
              onChange={() => onToggleCase(tc.id)}
              aria-label={`Select ${tc.title}`}
            />
          </td>
        );
      case "id":
        return (
          <td key={col} style={tdStyle} className={cellClass}>
            <button
              type="button"
              onClick={() => void onOpenRow(tc.id)}
              className={`${innerTruncate} text-left font-mono text-sm text-[var(--brand-primary)] hover:underline`}
            >
              {tc.externalId}
            </button>
          </td>
        );
      case "title":
        return (
          <td key={col} style={tdStyle} className={cellClass}>
            <button type="button" onClick={() => void onOpenRow(tc.id)} className={`${innerTruncate} text-left hover:underline`}>
              {tc.title}
            </button>
          </td>
        );
      case "suite":
        return (
          <td key={col} style={tdStyle} className={`${cellClass} text-[var(--muted)]`}>
            <span className={innerTruncate}>{tc.suiteId ? suiteNameMap.get(tc.suiteId) ?? "—" : "—"}</span>
          </td>
        );
      case "automate":
        return (
          <td key={col} style={tdStyle} className={cellClass}>
            <Button
              variant="ai"
              size="sm"
              disabled={!aiConfigured}
              title={!aiConfigured ? REPO_TC_AI_DISABLED_TITLE : "Open AI-assisted automation for this test case"}
              onClick={(e) => {
                e.stopPropagation();
                if (!aiConfigured) return;
                window.open(
                  `/projects/${projectId}/testcases/${tc.id}/automate`,
                  "_blank",
                  "noopener,noreferrer",
                );
              }}
            >
              Automate
            </Button>
          </td>
        );
      case "run":
        return (
          <td key={col} style={tdStyle} className={cellClass}>
            <Button
              variant="secondary"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onRunSingle(tc.id);
              }}
              className="border-[var(--success)] text-[var(--success)] hover:bg-[var(--brand-soft)]"
              title="Run this test case in live preview"
            >
              Run this test case
            </Button>
          </td>
        );
      case "jira":
        return (
          <td key={col} style={tdStyle} className={cellClass}>
            {tc.jiraIssueKey && tc.jiraUrl ? (
              <a
                href={tc.jiraUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className={`${innerTruncate} inline-flex items-center gap-1 font-mono text-xs text-[var(--brand-primary)] hover:underline`}
              >
                <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="currentColor" aria-hidden="true">
                  <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53ZM6.77 6.8a4.362 4.362 0 0 0 4.34 4.34h1.8v1.72a4.362 4.362 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.84-.84H6.77ZM2 11.6c0 2.4 1.95 4.34 4.35 4.35h1.78v1.71c0 2.4 1.95 4.35 4.35 4.35V12.44a.84.84 0 0 0-.84-.84H2Z" />
                </svg>
                <span className="truncate">{tc.jiraIssueKey}</span>
              </a>
            ) : tc.jiraIssueKey ? (
              <span className={`${innerTruncate} font-mono text-xs text-[var(--muted)]`}>{tc.jiraIssueKey}</span>
            ) : (
              <span className="text-[var(--muted-soft)]">—</span>
            )}
          </td>
        );
      case "priority":
        return (
          <td key={col} style={tdStyle} className={cellClass}>
            <span className={innerTruncate}>{tc.priority}</span>
          </td>
        );
      case "status":
        return (
          <td key={col} style={tdStyle} className={cellClass}>
            <span className={innerTruncate}>{tc.status}</span>
          </td>
        );
      case "updated":
        return (
          <td key={col} style={tdStyle} className={`${cellClass} text-[var(--muted)]`}>
            <span className={innerTruncate}>{new Date(tc.updatedAt).toLocaleDateString()}</span>
          </td>
        );
      case "type":
        return (
          <td key={col} style={tdStyle} className={cellClass}>
            <span className={innerTruncate}>{tc.type}</span>
          </td>
        );
      case "automationFeasibility":
        return (
          <td key={col} style={tdStyle} className={cellClass}>
            <span className={innerTruncate}>{tc.automationStatus}</span>
          </td>
        );
      default:
        return null;
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <div ref={columnsMenuRef} className="relative">
          <Button variant="secondary" size="sm" type="button" onClick={() => setColumnsMenuOpen((o) => !o)}>
            Column visibility
          </Button>
          {columnsMenuOpen && (
            <div className="absolute right-0 top-full z-30 mt-1 w-72 max-h-80 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] py-2 shadow-lg">
              <p className="px-3 pb-2 text-xs font-medium uppercase tracking-wide text-[var(--muted-soft)]">
                Show fields (field id)
              </p>
              {DATA_COLUMN_IDS.map((id) => (
                <label
                  key={id}
                  className="flex cursor-pointer items-start gap-2 px-3 py-1.5 text-sm hover:bg-[var(--surface-secondary)]"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={visible[id]}
                    onChange={() => toggleColumnVisible(id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="text-[var(--foreground)]">{COLUMN_LABELS[id]}</span>
                    <span className="mt-0.5 block font-mono text-[11px] text-[var(--muted)]">{FIELD_IDS[id]}</span>
                  </span>
                </label>
              ))}
              <p className="mt-2 border-t border-[var(--border-subtle)] px-3 pt-2 text-[11px] text-[var(--muted)]">
                {
                  "With only the first five fields visible (ID through Run), the table fills the screen width. Adding or removing fields switches to fixed widths and horizontal scroll when needed. The selection column stays first. Drag headers to reorder; drag header edges to resize when not in full-width mode."
                }
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="w-full min-w-0 overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        <table
          className="tesbo-table max-w-full text-sm"
          style={{
            width: fitDefaultFiveToScreen ? "100%" : totalWidth,
            tableLayout: "fixed",
          }}
        >
          <colgroup>
            {orderedColumns.map((col) => (
              <col
                key={col}
                style={
                  fitDefaultFiveToScreen
                    ? { width: `${FIT_LAYOUT_PCT[col]}%` }
                    : { width: widths[col] }
                }
              />
            ))}
          </colgroup>
          <thead>
            <tr>{orderedColumns.map((col) => renderHeaderCell(col))}</tr>
          </thead>
          <tbody>
            {cases.map((tc) => (
              <tr
                key={tc.id}
                className={rowHighlightId === tc.id ? "bg-[var(--brand-soft)]" : ""}
              >
                {orderedColumns.map((col) => renderBodyCell(col, tc))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
