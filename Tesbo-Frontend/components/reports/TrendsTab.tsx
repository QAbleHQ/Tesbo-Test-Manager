"use client";

import { IconTrendingUp, IconTrendingDown } from "@tabler/icons-react";
import type { ReportsTrends } from "@/lib/api";
import { TrendLineChart, VerticalBarChart } from "./charts";
import { LoadingBlock } from "./shared";

export function TrendsTab({ trends, loading }: { trends: ReportsTrends | null; loading: boolean }) {
  if (loading) return <LoadingBlock label="Loading trends…" />;
  if (!trends) return <LoadingBlock label="No data available." />;

  const trendPositive = trends.trendDelta >= 0;
  const validCount = trends.passRateTrend.filter((p) => p.passRate !== null).length;
  const points = trends.passRateTrend.map((p) => p.passRate);
  const labels = trends.passRateTrend.map((p) => new Date(p.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }));

  return (
    <div className="fade-in">
      <div className="mb-4">
        <div className="mb-0.5 text-[15px] font-semibold text-[var(--foreground)]">Trends</div>
        <div className="text-[12px] text-[var(--muted-soft)]">Pass rate and execution velocity over time</div>
      </div>

      <div className="mb-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-[13px] font-semibold text-[var(--foreground)]">Pass rate over time</div>
            <div className="text-[11px] text-[var(--muted-soft)]">Based on the last {trends.passRateTrend.length} test run{trends.passRateTrend.length === 1 ? "" : "s"}</div>
          </div>
          {validCount >= 2 && (
            <span
              className="flex items-center gap-1 text-[13px] font-medium"
              style={{ color: trendPositive ? "var(--status-pass-text)" : "var(--status-fail-text)" }}
            >
              {trendPositive ? <IconTrendingUp size={15} stroke={1.75} /> : <IconTrendingDown size={15} stroke={1.75} />}
              {trendPositive ? "+" : ""}{trends.trendDelta}% vs first run
            </span>
          )}
        </div>
        <TrendLineChart points={points} labels={labels} height={160} color="var(--brand-primary)" />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <h3 className="mb-3.5 text-[13px] font-semibold text-[var(--foreground)]">Execution velocity</h3>
          <VerticalBarChart
            data={trends.executionVelocity.map((v) => ({ label: v.name, value: v.count }))}
            color="var(--brand-primary)"
            fitLabels
          />
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <h3 className="mb-3.5 text-[13px] font-semibold text-[var(--foreground)]">Bug discovery rate</h3>
          <VerticalBarChart
            data={trends.bugDiscoveryRate.map((b) => ({ label: b.week.slice(5), value: b.count }))}
            color="var(--error)"
          />
        </div>
      </div>
    </div>
  );
}
