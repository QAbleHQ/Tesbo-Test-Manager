/**
 * The one formula for "Pass Rate" and "Execution Progress" on the frontend, mirroring
 * computeExecutionMetrics in Tesbo-Backend-Nest/src/legacy/legacy.service.ts. Every page that shows
 * either metric — Test Run Details, Test Runs list, Test Plans, the project Dashboard, and Reports —
 * must derive it from here rather than inlining its own division, which is how the same run used to
 * show a 30% pass rate on one page and 43% on another.
 *
 * - Pass Rate = Passed / (Passed + Failed + Blocked). Skipped has no pass/fail verdict, so it sits
 *   outside both sides of this ratio. null when nothing has a settled verdict yet.
 * - Execution Progress = (Passed + Failed + Blocked + Skipped) / Total. Skipped IS "done" for
 *   progress purposes even though it carries no verdict for Pass Rate.
 * - Untested and Retest are never executed for either metric — a case sent back for retest has no
 *   settled result until it is re-run.
 */
export interface SettledCounts {
  passed: number;
  failed: number;
  blocked: number;
}

export interface ExecutedCounts extends SettledCounts {
  skipped: number;
}

export function computeSettled(counts: SettledCounts): number {
  return (counts.passed || 0) + (counts.failed || 0) + (counts.blocked || 0);
}

export function computeExecuted(counts: ExecutedCounts): number {
  return computeSettled(counts) + (counts.skipped || 0);
}

/** Passed / (Passed + Failed + Blocked) as a whole-number percent, or null if nothing has settled. */
export function computePassRate(counts: SettledCounts): number | null {
  const settled = computeSettled(counts);
  return settled > 0 ? Math.round(((counts.passed || 0) / settled) * 100) : null;
}

/** (Passed + Failed + Blocked + Skipped) / Total as a whole-number percent, 0 if total is 0. */
export function computeExecutionProgress(counts: ExecutedCounts, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.round((computeExecuted(counts) / total) * 100);
}
