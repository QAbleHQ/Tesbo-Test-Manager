"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { getTesboAnalytics, type TesboAnalytics } from "@/lib/api";

export default function TesboAnalyticsPage() {
  const params = useParams();
  const projectId = params.id as string;
  const [analytics, setAnalytics] = useState<TesboAnalytics | null>(null);

  useEffect(() => {
    getTesboAnalytics(projectId).then(setAnalytics).catch(() => setAnalytics(null));
  }, [projectId]);

  return (
    <main className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Tesbo Analytics</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Quality and execution analytics for Tesbo reporting.
          </p>
        </div>
        <Link href={`/projects/${projectId}/tesbo-reports`} className="text-sm text-blue-600 hover:underline">
          Back to Tesbo Reports
        </Link>
      </div>
      <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 bg-white dark:bg-zinc-900">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Total Runs</p>
          <p className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
            {analytics?.totalRuns ?? 0}
          </p>
        </div>
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 bg-white dark:bg-zinc-900">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Total Tests</p>
          <p className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
            {analytics?.totalTests ?? 0}
          </p>
        </div>
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 bg-white dark:bg-zinc-900">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Pass Rate</p>
          <p className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
            {analytics?.passRate ?? 0}%
          </p>
        </div>
      </div>
      <div className="mt-4 rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 bg-white dark:bg-zinc-900">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Status breakdown</p>
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
          {Object.entries(analytics?.byStatus ?? {}).map(([status, count]) => (
            <div key={status} className="rounded border border-zinc-200 dark:border-zinc-700 px-3 py-2">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{status}</p>
              <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{count}</p>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
