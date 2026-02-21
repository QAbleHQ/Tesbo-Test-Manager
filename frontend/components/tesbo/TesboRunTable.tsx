"use client";

import type { TesboRunSummary } from "@/lib/api";

export function TesboRunTable({ runs }: { runs: TesboRunSummary[] }) {
  if (runs.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-5 text-sm text-zinc-500 dark:text-zinc-400">
        No runs available yet.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden bg-white dark:bg-zinc-900">
      <table className="w-full text-sm">
        <thead className="text-left bg-zinc-50 dark:bg-zinc-800/50 text-zinc-500 dark:text-zinc-400">
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
            <tr key={run.id} className="border-t border-zinc-100 dark:border-zinc-800">
              <td className="px-4 py-3 text-zinc-900 dark:text-zinc-100">{run.name}</td>
              <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">{run.status}</td>
              <td className="px-4 py-3 text-right">{run.total}</td>
              <td className="px-4 py-3 text-right text-green-600">{run.passed}</td>
              <td className="px-4 py-3 text-right text-red-600">{run.failed}</td>
              <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                {new Date(run.createdAt).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
