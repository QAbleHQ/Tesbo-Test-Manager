"use client";

import { useMemo } from "react";
import { IconChartBar, IconTable } from "@tabler/icons-react";
import { Input, Select } from "@/components/ui";
import type { ExecutionReportRow, SuiteNode } from "@/lib/api";
import { computePassRate } from "@/lib/executionMetrics";
import { DonutChart, StackedBarChart, Legend, STATUS_COLORS, STATUS_KEYS } from "./charts";
import { MetricCard, LoadingBlock } from "./shared";

const FILTER_OPTIONS = [
  { value: "overall", label: "Overall (by Test Run)" },
  { value: "person", label: "By Person" },
  { value: "plan", label: "By Test Plan" },
  { value: "run", label: "By Test Run" },
  { value: "suite", label: "By Test Suite" },
  { value: "tags", label: "By Tags" },
  { value: "priority", label: "By Priority" },
] as const;

export function ExecutionReportTab({
  rows,
  loading,
  filterBy,
  filterValue,
  onFilterByChange,
  onFilterValueChange,
  view,
  onViewChange,
  plans,
  runs,
  suites,
  members,
}: {
  rows: ExecutionReportRow[];
  loading: boolean;
  filterBy: string;
  filterValue: string;
  onFilterByChange: (v: string) => void;
  onFilterValueChange: (v: string) => void;
  view: "chart" | "table";
  onViewChange: (v: "chart" | "table") => void;
  plans: { id: string; name: string }[];
  runs: { id: string; name: string }[];
  suites: SuiteNode[];
  members: { userId: string; name: string; email: string }[];
}) {
  const totals = useMemo(() => {
    const t: Record<string, number> & { total: number } = { Passed: 0, Failed: 0, Blocked: 0, Skipped: 0, Untested: 0, Retest: 0, total: 0 };
    rows.forEach((r) => {
      STATUS_KEYS.forEach((s) => { t[s] += r[s] || 0; });
      t.total += r.total;
    });
    return t;
  }, [rows]);

  return (
    <div className="fade-in">
      <div className="mb-4">
        <div className="mb-0.5 text-[15px] font-semibold text-[var(--foreground)]">Execution Report</div>
        <div className="text-[12px] text-[var(--muted-soft)]">{runs.length} run{runs.length === 1 ? "" : "s"} · {totals.total} total executions</div>
      </div>

      {/* Filter bar */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-[12px] font-medium text-[var(--muted)]">Group by</label>
          <Select value={filterBy} onChange={(e) => onFilterByChange(e.target.value)} className="w-auto min-w-[150px]">
            {FILTER_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </Select>
        </div>
        {filterBy === "plan" && plans.length > 0 && (
          <Select value={filterValue} onChange={(e) => onFilterValueChange(e.target.value)} className="min-w-[140px]">
            <option value="">All Plans</option>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        )}
        {filterBy === "run" && runs.length > 0 && (
          <Select value={filterValue} onChange={(e) => onFilterValueChange(e.target.value)} className="min-w-[140px]">
            <option value="">All Runs</option>
            {runs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        )}
        {filterBy === "suite" && suites.length > 0 && (
          <Select value={filterValue} onChange={(e) => onFilterValueChange(e.target.value)} className="min-w-[140px]">
            <option value="">All Suites</option>
            {suites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
        {filterBy === "person" && members.length > 0 && (
          <Select value={filterValue} onChange={(e) => onFilterValueChange(e.target.value)} className="min-w-[140px]">
            <option value="">All Members</option>
            {members.map((m) => <option key={m.userId} value={m.userId}>{m.name || m.email}</option>)}
          </Select>
        )}
        {filterBy === "priority" && (
          <Select value={filterValue} onChange={(e) => onFilterValueChange(e.target.value)} className="min-w-[140px]">
            <option value="">All Priorities</option>
            <option value="P0">P0 - Critical</option>
            <option value="P1">P1 - High</option>
            <option value="P2">P2 - Medium</option>
            <option value="P3">P3 - Low</option>
          </Select>
        )}
        {filterBy === "tags" && (
          <Input type="text" value={filterValue} onChange={(e) => onFilterValueChange(e.target.value)} placeholder="Enter tag to filter…" className="w-48" />
        )}

        <div className="ml-auto flex items-center overflow-hidden rounded-[6px] border border-[var(--border)]">
          <button
            onClick={() => onViewChange("chart")}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium ${view === "chart" ? "bg-[var(--brand-primary)] text-white" : "bg-[var(--surface)] text-[var(--muted)] hover:bg-[var(--surface-secondary)]"}`}
          >
            <IconChartBar size={14} stroke={1.75} /> Chart
          </button>
          <button
            onClick={() => onViewChange("table")}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium ${view === "table" ? "bg-[var(--brand-primary)] text-white" : "bg-[var(--surface)] text-[var(--muted)] hover:bg-[var(--surface-secondary)]"}`}
          >
            <IconTable size={14} stroke={1.75} /> Table
          </button>
        </div>
      </div>

      {loading ? (
        <LoadingBlock label="Loading report…" />
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            <MetricCard label="Total" value={totals.total} />
            {STATUS_KEYS.map((s) => (
              <MetricCard key={s} label={s} value={totals[s]} color={STATUS_COLORS[s]} />
            ))}
          </div>

          {view === "chart" ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 lg:col-span-2">
                <h3 className="mb-4 text-[13px] font-semibold text-[var(--foreground)]">
                  Execution status by {FILTER_OPTIONS.find((o) => o.value === filterBy)?.label.replace("By ", "").replace("Overall (by Test Run)", "test run")}
                </h3>
                <StackedBarChart rows={rows} />
                <div className="mt-4 border-t border-[var(--border-subtle)] pt-4">
                  <Legend items={STATUS_KEYS.map((s) => ({ label: s, color: STATUS_COLORS[s] }))} />
                </div>
              </div>
              <div className="flex flex-col items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
                <h3 className="mb-4 self-start text-[13px] font-semibold text-[var(--foreground)]">Distribution</h3>
                <DonutChart data={STATUS_KEYS.map((s) => ({ label: s, value: totals[s], color: STATUS_COLORS[s] }))} size={160} />
                <div className="mt-4">
                  <Legend items={STATUS_KEYS.filter((s) => totals[s] > 0).map((s) => ({ label: `${s} (${totals[s]})`, color: STATUS_COLORS[s] }))} />
                </div>
              </div>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-left text-[10px] uppercase tracking-wider text-[var(--muted-soft)]">
                      <th className="px-4 py-2.5 font-medium">Group</th>
                      {STATUS_KEYS.map((s) => <th key={s} className="px-3 py-2.5 text-center font-medium">{s}</th>)}
                      <th className="px-3 py-2.5 text-center font-medium">Total</th>
                      <th className="px-3 py-2.5 text-center font-medium">Pass Rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-subtle)]">
                    {rows.length === 0 ? (
                      <tr><td colSpan={9} className="px-4 py-8 text-center text-[13px] text-[var(--muted-soft)]">No data available</td></tr>
                    ) : (
                      <>
                        {rows.map((row) => {
                          // Passed / (Passed + Failed + Blocked) — Untested/Retest/Skipped are
                          // excluded from this denominator, matching every other Pass Rate in the
                          // app (lib/executionMetrics). This used to divide by row.total, which
                          // includes those statuses and read lower than the rest of the product.
                          const passRate = computePassRate({ passed: row.Passed, failed: row.Failed, blocked: row.Blocked });
                          return (
                            <tr key={row.groupId} className="hover:bg-[var(--surface-secondary)]">
                              <td className="px-4 py-2.5 text-[13px] font-medium text-[var(--foreground)]">{row.groupName}</td>
                              {STATUS_KEYS.map((s) => (
                                <td key={s} className="px-3 py-2.5 text-center text-[13px] text-[var(--muted)]">{row[s] || 0}</td>
                              ))}
                              <td className="px-3 py-2.5 text-center text-[13px] font-semibold text-[var(--foreground)]">{row.total}</td>
                              <td
                                className="px-3 py-2.5 text-center text-[13px] font-semibold"
                                style={{
                                  color:
                                    passRate === null
                                      ? "var(--muted-soft)"
                                      : passRate >= 80
                                      ? "var(--status-pass-text)"
                                      : passRate >= 50
                                      ? "var(--status-blocked-text)"
                                      : "var(--status-fail-text)"
                                }}
                              >
                                {passRate !== null ? `${passRate}%` : "—"}
                              </td>
                            </tr>
                          );
                        })}
                        {(() => {
                          const totalPassRate = computePassRate({ passed: totals.Passed, failed: totals.Failed, blocked: totals.Blocked });
                          return (
                            <tr className="bg-[var(--surface-secondary)] font-semibold">
                              <td className="px-4 py-2.5 text-[13px] text-[var(--foreground)]">Total</td>
                              {STATUS_KEYS.map((s) => <td key={s} className="px-3 py-2.5 text-center text-[13px] text-[var(--muted)]">{totals[s]}</td>)}
                              <td className="px-3 py-2.5 text-center text-[13px] text-[var(--foreground)]">{totals.total}</td>
                              <td className="px-3 py-2.5 text-center text-[13px]">{totalPassRate !== null ? `${totalPassRate}%` : "—"}</td>
                            </tr>
                          );
                        })()}
                      </>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
