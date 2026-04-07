"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  getTesboAnalytics,
  listTesboRuns,
  listTesboSpecs,
  listTesboTests,
  type TesboAnalytics,
  type TesboProjectTest,
  type TesboRunSummary,
  type TesboSpecSummary,
} from "@/lib/api";
import { Card } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

type TimeWindow = "7D" | "14D" | "30D" | "90D" | "ALL";

const WINDOW_OPTIONS: { value: TimeWindow; label: string }[] = [
  { value: "7D", label: "7D" },
  { value: "14D", label: "14D" },
  { value: "30D", label: "30D" },
  { value: "90D", label: "90D" },
  { value: "ALL", label: "All" },
];

export default function TesboAnalyticsPage() {
  const params = useParams();
  const projectId = params.id as string;
  const [analytics, setAnalytics] = useState<TesboAnalytics | null>(null);
  const [runs, setRuns] = useState<TesboRunSummary[]>([]);
  const [specs, setSpecs] = useState<TesboSpecSummary[]>([]);
  const [tests, setTests] = useState<TesboProjectTest[]>([]);
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("30D");
  const [loading, setLoading] = useState(true);
  const cutoffTs = useMemo(() => {
    if (timeWindow === "ALL") return null;
    const now = Date.now();
    const days = Number(timeWindow.replace("D", ""));
    return now - days * 24 * 60 * 60 * 1000;
  }, [timeWindow]);
  const filteredRuns = useMemo(
    () =>
      cutoffTs == null
        ? runs
        : runs.filter((run) => {
            const ts = getRunTimestamp(run);
            return ts != null && ts >= cutoffTs;
          }),
    [runs, cutoffTs]
  );
  const filteredSpecs = useMemo(
    () =>
      cutoffTs == null
        ? specs
        : specs.filter((spec) => {
            if (!spec.latestRunAt) return false;
            const ts = new Date(spec.latestRunAt).getTime();
            return !Number.isNaN(ts) && ts >= cutoffTs;
          }),
    [specs, cutoffTs]
  );
  const filteredTests = useMemo(
    () =>
      cutoffTs == null
        ? tests
        : tests.filter((test) => {
            if (!test.latestRunAt) return false;
            const ts = new Date(test.latestRunAt).getTime();
            return !Number.isNaN(ts) && ts >= cutoffTs;
          }),
    [tests, cutoffTs]
  );
  const filteredRunsByDay = useMemo(() => {
    const source = analytics?.runsByDay ?? [];
    if (cutoffTs == null) return source;
    return source.filter((item) => {
      const ts = new Date(item.day).getTime();
      return !Number.isNaN(ts) && ts >= cutoffTs;
    });
  }, [analytics?.runsByDay, cutoffTs]);
  const windowOutcomeTotals = useMemo(
    () =>
      filteredRuns.reduce(
        (acc, run) => {
          acc.passed += run.passed || 0;
          acc.failed += run.failed || 0;
          acc.skipped += run.skipped || 0;
          return acc;
        },
        { passed: 0, failed: 0, skipped: 0 }
      ),
    [filteredRuns]
  );
  const windowOutcomeTotalCount = windowOutcomeTotals.passed + windowOutcomeTotals.failed + windowOutcomeTotals.skipped;
  const windowOutcomeRates = useMemo(() => {
    if (windowOutcomeTotalCount === 0) return { passRate: 0, failureRate: 0, skipRate: 0 };
    return {
      passRate: Math.round((windowOutcomeTotals.passed / windowOutcomeTotalCount) * 1000) / 10,
      failureRate: Math.round((windowOutcomeTotals.failed / windowOutcomeTotalCount) * 1000) / 10,
      skipRate: Math.round((windowOutcomeTotals.skipped / windowOutcomeTotalCount) * 1000) / 10,
    };
  }, [windowOutcomeTotalCount, windowOutcomeTotals]);

  const buildComparisonItems = useMemo(
    () =>
      [...filteredRuns]
        .sort((a, b) => {
          const aTs = new Date(a.startedAt || a.createdAt).getTime();
          const bTs = new Date(b.startedAt || b.createdAt).getTime();
          return bTs - aTs;
        })
        .slice(0, 14)
        .reverse()
        .map((run) => ({
          label: run.runNumber ? `#${run.runNumber}` : run.name || run.id.slice(0, 8),
          title: run.name || run.id,
          passed: run.passed || 0,
          failed: run.failed || 0,
          skipped: run.skipped || 0,
          total: Math.max(1, (run.passed || 0) + (run.failed || 0) + (run.skipped || 0)),
        })),
    [filteredRuns]
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.allSettled([
      getTesboAnalytics(projectId),
      listTesboRuns(projectId),
      listTesboSpecs(projectId),
      listTesboTests(projectId),
    ])
      .then(([analyticsResult, runsResult, specsResult, testsResult]) => {
        if (!active) return;
        setAnalytics(analyticsResult.status === "fulfilled" ? analyticsResult.value : null);
        setRuns(runsResult.status === "fulfilled" ? runsResult.value : []);
        setSpecs(specsResult.status === "fulfilled" ? specsResult.value : []);
        setTests(testsResult.status === "fulfilled" ? testsResult.value : []);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const mostFailures = useMemo(
    () =>
      [...filteredSpecs]
        .map((spec) => ({
          ...spec,
          failureRate: spec.totalRuns > 0 ? Math.round((spec.failed / spec.totalRuns) * 1000) / 10 : 0,
        }))
        .sort((a, b) => {
          if (b.failed !== a.failed) return b.failed - a.failed;
          return b.failureRate - a.failureRate;
        })
        .slice(0, 8),
    [filteredSpecs]
  );

  const topStable = useMemo(
    () =>
      [...filteredSpecs]
        .filter((spec) => spec.totalRuns >= 15)
        .map((spec) => ({
          ...spec,
          passRate: spec.totalRuns > 0 ? Math.round((spec.passed / spec.totalRuns) * 1000) / 10 : 0,
        }))
        .sort((a, b) => {
          if (b.passRate !== a.passRate) return b.passRate - a.passRate;
          return b.totalRuns - a.totalRuns;
        })
        .slice(0, 8),
    [filteredSpecs]
  );

  const mostFlaky = useMemo(
    () =>
      [...filteredTests]
        .map((test) => ({
          ...test,
          flakiness: test.totalRuns > 0 ? Math.round((test.failed / test.totalRuns) * 1000) / 10 : 0,
          passRate: test.totalRuns > 0 ? Math.round((test.passed / test.totalRuns) * 1000) / 10 : 0,
        }))
        .sort((a, b) => {
          if (b.flakiness !== a.flakiness) return b.flakiness - a.flakiness;
          return b.failed - a.failed;
        })
        .slice(0, 10),
    [filteredTests]
  );

  const comparisonRows = useMemo(
    () =>
      [...filteredSpecs]
        .map((spec) => {
          const passRate = spec.totalRuns > 0 ? Math.round((spec.passed / spec.totalRuns) * 1000) / 10 : 0;
          const failureRate = spec.totalRuns > 0 ? Math.round((spec.failed / spec.totalRuns) * 1000) / 10 : 0;
          const flakiness = failureRate;
          const risk = failureRate >= 20 ? "High" : failureRate >= 10 ? "Medium" : "Low";
          return { ...spec, passRate, failureRate, flakiness, risk };
        })
        .sort((a, b) => {
          if (b.failureRate !== a.failureRate) return b.failureRate - a.failureRate;
          return b.totalRuns - a.totalRuns;
        })
        .slice(0, 20),
    [filteredSpecs]
  );

  const aiInsights = useMemo(() => {
    const insights: { id: string; title: string; body: string; actionHref: string; actionLabel: string }[] = [];
    const topFailure = mostFailures[0];
    const topFlakyTest = mostFlaky[0];
    const stableSpec = topStable[0];

    if (topFailure) {
      insights.push({
        id: `failure-${topFailure.specName}`,
        title: "Failure spike candidate",
        body: `${topFailure.specName} has ${topFailure.failed} failed runs (${topFailure.failureRate}% failure). Prioritize defect triage for this spec.`,
        actionHref: `/projects/${projectId}/tesbo-reports/specs/${encodeURIComponent(topFailure.specName)}`,
        actionLabel: "Open spec failures",
      });
    }
    if (topFlakyTest) {
      insights.push({
        id: `flaky-${topFlakyTest.specName}-${topFlakyTest.testName}`,
        title: "Flaky test risk",
        body: `${topFlakyTest.testName} in ${topFlakyTest.specName} shows ${topFlakyTest.flakiness}% flakiness. Monitor traces and consider quarantine if it keeps toggling.`,
        actionHref: `/projects/${projectId}/tesbo-reports/tests/${encodeURIComponent(topFlakyTest.specName)}/${encodeURIComponent(topFlakyTest.testName)}`,
        actionLabel: "Inspect flaky history",
      });
    }
    if (stableSpec) {
      insights.push({
        id: `stable-${stableSpec.specName}`,
        title: "Release confidence signal",
        body: `${stableSpec.specName} holds ${stableSpec.passRate}% pass rate over ${stableSpec.totalRuns} runs. Use it as a stable baseline during release validation.`,
        actionHref: `/projects/${projectId}/tesbo-reports/specs/${encodeURIComponent(stableSpec.specName)}`,
        actionLabel: "Use as baseline",
      });
    }

    return insights;
  }, [mostFailures, mostFlaky, topStable, projectId]);

  const runDurations = useMemo(() => {
    const sorted = [...filteredRuns].sort((a, b) => {
      const aTs = new Date(a.startedAt || a.createdAt).getTime();
      const bTs = new Date(b.startedAt || b.createdAt).getTime();
      return bTs - aTs;
    });

    return sorted.map((run, index) => {
      const durationMs = getRunDurationMs(run);
      const previousDurationMs = index < sorted.length - 1 ? getRunDurationMs(sorted[index + 1]) : null;
      const deltaMs =
        durationMs != null && previousDurationMs != null
          ? durationMs - previousDurationMs
          : null;
      return {
        run,
        durationMs,
        deltaMs,
      };
    });
  }, [filteredRuns]);

  const avgRunDurationMs = useMemo(() => {
    const values = runDurations
      .map((item) => item.durationMs)
      .filter((value): value is number => value != null);
    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }, [runDurations]);

  const recentDurationItems = useMemo(
    () =>
      [...runDurations]
        .slice(0, 20)
        .reverse()
        .map((item) => ({
          label: getBuildLabel(item.run),
          count: item.durationMs != null ? Math.round(item.durationMs / 1000) : 0,
        })),
    [runDurations]
  );

  return (
    <main className="tesbo-page max-w-6xl mx-auto">
      <StandardPageLayout
        header={
          <PageHeader
            title="Tesbo Analytics"
            subtitle="Quality and execution analytics for Tesbo reporting."
            actions={<Link href={`/projects/${projectId}/tesbo-reports`} className="text-sm hover:underline">Back to Tesbo Reports</Link>}
          />
        }
      >
        <Card className="p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium text-[var(--foreground)]">Duration window</p>
            <div className="flex flex-wrap items-center gap-2">
              {WINDOW_OPTIONS.map((option) => {
                const active = option.value === timeWindow;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setTimeWindow(option.value)}
                    className={`rounded-full px-3 py-1 text-xs border transition-colors ${
                      active
                        ? "border-[var(--brand-primary)] bg-[var(--brand-soft)] text-[var(--brand-primary)]"
                        : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        </Card>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="p-4">
            <p className="text-sm text-[var(--muted)]">Total Runs (all-time)</p>
            <p className="mt-2 text-2xl font-semibold text-[var(--foreground)]">
              {analytics?.totalRuns ?? 0}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-sm text-[var(--muted)]">Total Tests</p>
            <p className="mt-2 text-2xl font-semibold text-[var(--foreground)]">
              {analytics?.totalTests ?? 0}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-sm text-[var(--muted)]">Pass Rate</p>
            <p className="mt-2 text-2xl font-semibold text-[var(--foreground)]">
              {analytics?.passRate ?? 0}%
            </p>
          </Card>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Card className="p-4">
            <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Failure rate ticker</p>
            <p className="mt-2 text-2xl font-semibold text-rose-600">{windowOutcomeRates.failureRate}%</p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              {windowOutcomeTotals.failed} failed of {windowOutcomeTotalCount} outcomes ({timeWindow === "ALL" ? "all time" : `last ${timeWindow}`})
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Skip rate ticker</p>
            <p className="mt-2 text-2xl font-semibold text-amber-600">{windowOutcomeRates.skipRate}%</p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              {windowOutcomeTotals.skipped} skipped of {windowOutcomeTotalCount} outcomes ({timeWindow === "ALL" ? "all time" : `last ${timeWindow}`})
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Outcome mix</p>
            {windowOutcomeTotalCount === 0 ? (
              <p className="mt-3 text-sm text-[var(--muted)]">No outcome data for this window.</p>
            ) : (
              <OutcomePieChart
                passRate={windowOutcomeRates.passRate}
                failureRate={windowOutcomeRates.failureRate}
                skipRate={windowOutcomeRates.skipRate}
                passCount={windowOutcomeTotals.passed}
                failCount={windowOutcomeTotals.failed}
                skipCount={windowOutcomeTotals.skipped}
              />
            )}
          </Card>
        </div>
        <Card className="p-4">
          <p className="text-sm font-medium text-[var(--foreground)]">Build quality trends</p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Trend of pass, fail, and skip rates across recent builds.
          </p>
          <p className="mt-1 text-xs text-[var(--muted)]">Window: {timeWindow === "ALL" ? "All time" : `Last ${timeWindow}`}</p>
          {buildComparisonItems.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--muted)]">No run comparison data available.</p>
          ) : (
            <BuildOutcomeTrendChart items={buildComparisonItems} />
          )}
        </Card>
        <Card className="p-4">
          <p className="text-sm font-medium text-[var(--foreground)]">Runs by day</p>
          {filteredRunsByDay.length ? (
            <SingleSeriesBarChart
              items={filteredRunsByDay.map((item) => ({ label: item.day, count: item.count }))}
              shortLabel={(label) => {
                const d = new Date(label);
                if (Number.isNaN(d.getTime())) return label;
                return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
              }}
              valueSuffix="runs"
              colorForLabel={() => "bg-[var(--brand-primary)]"}
            />
          ) : (
            <p className="mt-3 text-sm text-[var(--muted)]">No day-level run data for this window.</p>
          )}
        </Card>
        <Card className="p-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-medium text-[var(--foreground)]">Run duration comparison</p>
              <p className="mt-1 text-xs text-[var(--muted)]">
                Compare time taken for every run and detect runtime slowdowns quickly.
              </p>
            </div>
            <p className="text-xs text-[var(--muted)]">
              Avg duration ({timeWindow === "ALL" ? "all time" : `last ${timeWindow}`}):{" "}
              <span className="font-semibold text-[var(--foreground)]">
                {avgRunDurationMs != null ? formatDuration(avgRunDurationMs) : "N/A"}
              </span>
            </p>
          </div>
          {loading ? (
            <p className="mt-3 text-sm text-[var(--muted)]">Loading run durations...</p>
          ) : runDurations.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--muted)]">No run data available.</p>
          ) : (
            <>
              {recentDurationItems.length > 1 && (
                <div className="mt-3">
                  <DurationLineChart items={recentDurationItems} />
                </div>
              )}
            </>
          )}
        </Card>
        <Card className="p-4 border-[var(--ai-primary)]/30 bg-[var(--ai-surface)]">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-semibold text-[var(--ai-primary)]">Decision intelligence</p>
              <p className="mt-1 text-xs text-[var(--muted)]">
                AI-prioritized recommendations from failures, stability, and flakiness signals.
              </p>
            </div>
            <Link href={`/projects/${projectId}/tesbo-reports/tests`} className="text-xs text-[var(--ai-primary)] hover:underline">
              Open test intelligence
            </Link>
          </div>
          {aiInsights.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--muted)]">No recommendation signals yet.</p>
          ) : (
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {aiInsights.map((insight) => (
                <div key={insight.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ai-primary)]">{insight.title}</p>
                  <p className="mt-2 text-sm text-[var(--foreground)]">{insight.body}</p>
                  <Link href={insight.actionHref} className="mt-3 inline-block text-xs text-[var(--ai-primary)] hover:underline">
                    {insight.actionLabel}
                  </Link>
                </div>
              ))}
            </div>
          )}
        </Card>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-[var(--foreground)]">Most failures</p>
              <Link href={`/projects/${projectId}/tesbo-reports/specs`} className="text-xs text-[var(--brand-primary)] hover:underline">
                Open specs
              </Link>
            </div>
            {loading ? (
              <p className="mt-3 text-sm text-[var(--muted)]">Loading failure ranking...</p>
            ) : mostFailures.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--muted)]">No failure data available.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {mostFailures.map((item) => (
                  <Link
                    key={item.specName}
                    href={`/projects/${projectId}/tesbo-reports/specs/${encodeURIComponent(item.specName)}`}
                    className="block rounded-lg border border-[var(--border)] p-2 hover:border-[var(--brand-primary)]"
                  >
                    <p className="truncate text-sm font-medium text-[var(--foreground)]">{item.specName}</p>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      {item.failed} failures of {item.totalRuns} runs ({item.failureRate}%)
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </Card>
          <Card className="p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-[var(--foreground)]">Top stable</p>
              <span className="text-xs text-[var(--muted)]">Min 15 runs</span>
            </div>
            {loading ? (
              <p className="mt-3 text-sm text-[var(--muted)]">Loading stability ranking...</p>
            ) : topStable.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--muted)]">No stable specs meet minimum runs.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {topStable.map((item) => (
                  <Link
                    key={item.specName}
                    href={`/projects/${projectId}/tesbo-reports/specs/${encodeURIComponent(item.specName)}`}
                    className="block rounded-lg border border-[var(--border)] p-2 hover:border-[var(--brand-primary)]"
                  >
                    <p className="truncate text-sm font-medium text-[var(--foreground)]">{item.specName}</p>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      {item.passRate}% pass rate across {item.totalRuns} runs
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </Card>
          <Card className="p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-[var(--foreground)]">Most flaky</p>
              <Link href={`/projects/${projectId}/tesbo-reports/tests`} className="text-xs text-[var(--brand-primary)] hover:underline">
                Open tests
              </Link>
            </div>
            {loading ? (
              <p className="mt-3 text-sm text-[var(--muted)]">Loading flaky ranking...</p>
            ) : mostFlaky.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--muted)]">No flakiness data available.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {mostFlaky.map((item) => (
                  <Link
                    key={`${item.specName}-${item.testName}`}
                    href={`/projects/${projectId}/tesbo-reports/tests/${encodeURIComponent(item.specName)}/${encodeURIComponent(item.testName)}`}
                    className="block rounded-lg border border-[var(--border)] p-2 hover:border-[var(--brand-primary)]"
                  >
                    <p className="truncate text-sm font-medium text-[var(--foreground)]">{item.testName}</p>
                    <p className="truncate text-xs text-[var(--muted)]">{item.specName}</p>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      {item.flakiness}% flaky ({item.failed}/{item.totalRuns} failed)
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </Card>
        </div>
        <Card className="p-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-medium text-[var(--foreground)]">Spec comparison board</p>
              <p className="mt-1 text-xs text-[var(--muted)]">
                Compare quality risk and stability across top specs to decide triage priority.
              </p>
            </div>
            <span className="text-xs text-[var(--muted)]">{timeWindow === "ALL" ? "All time" : `Last ${timeWindow}`}</span>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-[900px] w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--muted)]">
                  <th className="px-3 py-2 text-left font-medium">Spec</th>
                  <th className="px-3 py-2 text-right font-medium">Pass %</th>
                  <th className="px-3 py-2 text-right font-medium">Failure %</th>
                  <th className="px-3 py-2 text-right font-medium">Flakiness %</th>
                  <th className="px-3 py-2 text-right font-medium">Runs</th>
                  <th className="px-3 py-2 text-left font-medium">Risk</th>
                  <th className="px-3 py-2 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-[var(--muted)]">
                      Loading comparison board...
                    </td>
                  </tr>
                ) : comparisonRows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-[var(--muted)]">
                      No spec comparison data available.
                    </td>
                  </tr>
                ) : (
                  comparisonRows.map((row) => (
                    <tr key={row.specName} className="border-b border-[var(--border-subtle)]">
                      <td className="px-3 py-2">
                        <p className="max-w-[340px] truncate text-[var(--foreground)]" title={row.specName}>
                          {row.specName}
                        </p>
                      </td>
                      <td className="px-3 py-2 text-right">{row.passRate}%</td>
                      <td className="px-3 py-2 text-right">{row.failureRate}%</td>
                      <td className="px-3 py-2 text-right">{row.flakiness}%</td>
                      <td className="px-3 py-2 text-right">{row.totalRuns}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            row.risk === "High"
                              ? "bg-rose-100 text-rose-700"
                              : row.risk === "Medium"
                              ? "bg-amber-100 text-amber-700"
                              : "bg-emerald-100 text-emerald-700"
                          }`}
                        >
                          {row.risk}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Link
                          href={`/projects/${projectId}/tesbo-reports/specs/${encodeURIComponent(row.specName)}`}
                          className="text-xs text-[var(--brand-primary)] hover:underline"
                        >
                          Open spec
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </StandardPageLayout>
    </main>
  );
}

function SingleSeriesBarChart({
  items,
  shortLabel,
  valueSuffix = "runs",
  colorForLabel,
}: {
  items: { label: string; count: number }[];
  shortLabel: (label: string) => string;
  valueSuffix?: string;
  colorForLabel: (label: string) => string;
}) {
  const CHART_HEIGHT = 190;
  const BAR_WIDTH = 44;
  const BAR_GAP = 10;
  const maxValue = Math.max(...items.map((item) => item.count), 1);
  const gridLines = 4;
  const stepValue = Math.max(1, Math.ceil(maxValue / gridLines));
  const ticks = Array.from({ length: gridLines + 1 }, (_, i) => i * stepValue);
  const scaleMax = ticks[ticks.length - 1] || 1;
  const chartWidth = items.length * (BAR_WIDTH + BAR_GAP) + BAR_GAP;

  return (
    <div className="mt-3 flex">
      <div className="flex flex-col justify-between shrink-0 pr-2 pb-[44px]" style={{ height: CHART_HEIGHT }}>
        {[...ticks].reverse().map((tick) => (
          <span key={tick} className="text-[10px] leading-none text-[var(--muted)] text-right tabular-nums">
            {tick}
          </span>
        ))}
      </div>
      <div className="flex-1 overflow-x-auto" style={{ scrollbarWidth: "thin" }}>
        <div style={{ width: chartWidth, minWidth: "100%" }}>
          <div className="relative border-l border-b border-[var(--border)]" style={{ height: CHART_HEIGHT }}>
            {ticks.map((tick) => {
              const y = CHART_HEIGHT - (tick / scaleMax) * CHART_HEIGHT;
              return (
                <div
                  key={tick}
                  className="absolute left-0 right-0 border-t border-[var(--border)] opacity-40"
                  style={{ top: y }}
                />
              );
            })}
            <div className="absolute inset-0 flex items-end" style={{ gap: BAR_GAP, padding: `0 ${BAR_GAP / 2}px` }}>
              {items.map((item) => {
                const barHeight = (item.count / scaleMax) * CHART_HEIGHT;
                return (
                  <div key={`${item.label}-${item.count}`} className="group relative" style={{ width: BAR_WIDTH }}>
                    <div className="pointer-events-none absolute -top-2 left-1/2 z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs opacity-0 transition-opacity group-hover:opacity-100 whitespace-nowrap">
                      <p className="font-medium text-[var(--foreground)]">{item.label}</p>
                      <p className="text-[var(--muted)]">{item.count} {valueSuffix}</p>
                    </div>
                    <div className={`rounded-t-sm ${colorForLabel(item.label)}`} style={{ height: barHeight, width: BAR_WIDTH }} />
                    <p className="mt-1 truncate text-[10px] leading-tight text-[var(--muted)] text-center" title={item.label}>
                      {shortLabel(item.label)}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function BuildOutcomeTrendChart({
  items,
}: {
  items: { label: string; title: string; passed: number; failed: number; skipped: number; total: number }[];
}) {
  const CHART_HEIGHT = 190;
  const chartWidth = Math.max(640, items.length * 56);
  const ticks = [0, 25, 50, 75, 100];
  const points = items.map((item, index) => {
    const x = (index / Math.max(1, items.length - 1)) * 100;
    const passRate = Math.round((item.passed / item.total) * 1000) / 10;
    const failRate = Math.round((item.failed / item.total) * 1000) / 10;
    const skipRate = Math.max(0, Math.round((100 - passRate - failRate) * 10) / 10);
    return { x, passRate, failRate, skipRate };
  });
  const passLine = points.map((p) => `${p.x},${100 - p.passRate}`).join(" ");
  const failLine = points.map((p) => `${p.x},${100 - p.failRate}`).join(" ");
  const skipLine = points.map((p) => `${p.x},${100 - p.skipRate}`).join(" ");

  return (
    <div className="mt-3">
      <div className="mb-2 flex items-center gap-3 text-xs text-[var(--muted)]">
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" />Pass %</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-rose-500" />Fail %</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-400" />Skip %</span>
      </div>
      <div className="flex gap-2">
        <div className="flex flex-col justify-between shrink-0 pr-2 py-[4px]" style={{ height: CHART_HEIGHT }}>
          {[...ticks].reverse().map((tick) => (
            <span key={tick} className="text-[10px] leading-none text-[var(--muted)] text-right tabular-nums">
              {tick}%
            </span>
          ))}
        </div>
        <div className="flex-1 overflow-x-auto" style={{ scrollbarWidth: "thin" }}>
          <div style={{ width: chartWidth, minWidth: "100%" }}>
            <div className="relative border-l border-b border-[var(--border)]" style={{ height: CHART_HEIGHT }}>
              {ticks.map((tick) => (
                <div
                  key={tick}
                  className="absolute left-0 right-0 border-t border-[var(--border)] opacity-30"
                  style={{ top: CHART_HEIGHT - (tick / 100) * CHART_HEIGHT }}
                />
              ))}
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
                <polyline fill="none" stroke="rgb(34 197 94)" strokeWidth="1.8" points={passLine} />
                <polyline fill="none" stroke="rgb(244 63 94)" strokeWidth="1.8" points={failLine} />
                <polyline fill="none" stroke="rgb(251 191 36)" strokeWidth="1.8" points={skipLine} />
              </svg>
              <div className="absolute inset-0 flex" style={{ padding: "0 8px" }}>
                {items.map((item, index) => {
                  const p = points[index];
                  return (
                    <div key={item.label + item.title} className="group relative flex-1">
                      <div className="pointer-events-none absolute left-1/2 top-0 z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs opacity-0 transition-opacity group-hover:opacity-100 whitespace-nowrap">
                        <p className="font-medium text-[var(--foreground)]">{item.title}</p>
                        <p className="text-emerald-600">{p.passRate}% pass</p>
                        <p className="text-rose-600">{p.failRate}% fail</p>
                        <p className="text-amber-600">{p.skipRate}% skip</p>
                      </div>
                      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent group-hover:bg-[var(--border)]/60" />
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="mt-1 flex">
              {items.map((item) => (
                <p
                  key={item.label + item.title + "-label"}
                  className="flex-1 truncate text-[10px] leading-tight text-[var(--muted)] text-center"
                  title={item.title}
                >
                  {item.label}
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="mt-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-2 py-1 text-xs text-[var(--muted)]">
        Higher pass trend and downward fail trend indicate improving build stability.
      </div>
    </div>
  );
}

function DurationLineChart({
  items,
}: {
  items: { label: string; count: number }[];
}) {
  const CHART_HEIGHT = 190;
  const chartWidth = Math.max(640, items.length * 56);
  const maxValue = Math.max(...items.map((item) => item.count), 1);
  const ticks = [0, 25, 50, 75, 100];
  const points = items.map((item, index) => {
    const x = (index / Math.max(1, items.length - 1)) * 100;
    const y = 100 - (item.count / maxValue) * 100;
    return { x, y };
  });
  const line = points.map((p) => `${p.x},${p.y}`).join(" ");

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs text-[var(--muted)]">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-[var(--brand-primary)]" />
          Duration trend (seconds)
        </span>
      </div>
      <div className="flex gap-2">
        <div className="flex flex-col justify-between shrink-0 pr-2 py-[4px]" style={{ height: CHART_HEIGHT }}>
          {[...ticks].reverse().map((tick) => (
            <span key={tick} className="text-[10px] leading-none text-[var(--muted)] text-right tabular-nums">
              {Math.round((tick / 100) * maxValue)}s
            </span>
          ))}
        </div>
        <div className="flex-1 overflow-x-auto" style={{ scrollbarWidth: "thin" }}>
          <div style={{ width: chartWidth, minWidth: "100%" }}>
            <div className="relative border-l border-b border-[var(--border)]" style={{ height: CHART_HEIGHT }}>
              {ticks.map((tick) => (
                <div
                  key={tick}
                  className="absolute left-0 right-0 border-t border-[var(--border)] opacity-30"
                  style={{ top: CHART_HEIGHT - (tick / 100) * CHART_HEIGHT }}
                />
              ))}
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
                <polyline fill="none" stroke="var(--brand-primary)" strokeWidth="2" points={line} />
                {points.map((p, index) => (
                  <circle key={`${items[index].label}-${index}`} cx={p.x} cy={p.y} r="1.1" fill="var(--brand-primary)" />
                ))}
              </svg>
              <div className="absolute inset-0 flex" style={{ padding: "0 8px" }}>
                {items.map((item) => (
                  <div key={`${item.label}-${item.count}`} className="group relative flex-1">
                    <div className="pointer-events-none absolute left-1/2 top-0 z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs opacity-0 transition-opacity group-hover:opacity-100 whitespace-nowrap">
                      <p className="font-medium text-[var(--foreground)]">{item.label}</p>
                      <p className="text-[var(--muted)]">{item.count}s</p>
                    </div>
                    <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent group-hover:bg-[var(--border)]/60" />
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-1 flex">
              {items.map((item) => (
                <p
                  key={item.label + "-duration-label"}
                  className="flex-1 truncate text-[10px] leading-tight text-[var(--muted)] text-center"
                  title={item.label}
                >
                  {item.label}
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function OutcomePieChart({
  passRate,
  failureRate,
  skipRate,
  passCount,
  failCount,
  skipCount,
}: {
  passRate: number;
  failureRate: number;
  skipRate: number;
  passCount: number;
  failCount: number;
  skipCount: number;
}) {
  const passAngle = (passRate / 100) * 360;
  const failAngle = (failureRate / 100) * 360;
  const gradient = `conic-gradient(
    rgb(34 197 94) 0deg ${passAngle}deg,
    rgb(244 63 94) ${passAngle}deg ${passAngle + failAngle}deg,
    rgb(251 191 36) ${passAngle + failAngle}deg 360deg
  )`;

  return (
    <div className="mt-3 flex items-center gap-4">
      <div
        className="relative h-28 w-28 rounded-full border border-[var(--border)]"
        style={{ background: gradient }}
      >
        <div className="absolute inset-4 rounded-full bg-[var(--surface)]" />
      </div>
      <div className="space-y-1.5 text-xs">
        <p className="text-emerald-600">Pass: {passRate}% ({passCount})</p>
        <p className="text-rose-600">Fail: {failureRate}% ({failCount})</p>
        <p className="text-amber-600">Skip: {skipRate}% ({skipCount})</p>
      </div>
    </div>
  );
}

function getRunTimestamp(run: TesboRunSummary): number | null {
  const raw = run.startedAt || run.endedAt || run.createdAt;
  if (!raw) return null;
  const ts = new Date(raw).getTime();
  return Number.isNaN(ts) ? null : ts;
}

function getBuildLabel(run: TesboRunSummary): string {
  const runNumber = (run.runNumber || "").trim();
  if (runNumber) return `#${runNumber}`;

  const githubRunId = (run.githubRunId || "").trim();
  if (githubRunId) return `#${githubRunId}`;

  const name = run.name || "";
  const match = name.match(/\b\d{3,}\b/g);
  if (match && match.length > 0) {
    return `#${match[match.length - 1]}`;
  }

  return `#${run.id.slice(0, 8)}`;
}

function getRunDurationMs(run: TesboRunSummary): number | null {
  if (!run.startedAt || !run.endedAt) return null;
  const startedTs = new Date(run.startedAt).getTime();
  const endedTs = new Date(run.endedAt).getTime();
  if (Number.isNaN(startedTs) || Number.isNaN(endedTs)) return null;
  const diff = endedTs - startedTs;
  return diff >= 0 ? diff : null;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
