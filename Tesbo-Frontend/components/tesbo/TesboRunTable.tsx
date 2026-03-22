"use client";

import type { TesboRunSummary } from "@/lib/api";

export function TesboRunTable({ runs }: { runs: TesboRunSummary[] }) {
  if (runs.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--border)] p-5 text-sm text-[var(--muted)]">
        No runs available yet.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--border)] overflow-hidden bg-[var(--surface)]">
      <table className="w-full text-sm">
        <thead className="text-left bg-[var(--surface-secondary)] text-[var(--muted)]">
          <tr>
            <th className="px-4 py-3 font-medium">Run</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium text-right">Total</th>
            <th className="px-4 py-3 font-medium text-right">Passed</th>
            <th className="px-4 py-3 font-medium text-right">Failed</th>
            <th className="px-4 py-3 font-medium">Created</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} className="border-t border-[var(--border-subtle)]">
              <td className="px-4 py-3 text-[var(--foreground)]">{run.name}</td>
              <td className="px-4 py-3 text-[var(--muted)]">{run.status}</td>
              <td className="px-4 py-3 text-right">{run.total}</td>
              <td className="px-4 py-3 text-right text-green-600">{run.passed}</td>
              <td className="px-4 py-3 text-right text-red-600">{run.failed}</td>
              <td className="px-4 py-3 text-[var(--muted)]">
                {new Date(run.createdAt).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
