"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { getTesboAnalytics, type TesboAnalytics } from "@/lib/api";
import { Card } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

export default function TesboAnalyticsPage() {
  const params = useParams();
  const projectId = params.id as string;
  const [analytics, setAnalytics] = useState<TesboAnalytics | null>(null);

  useEffect(() => {
    getTesboAnalytics(projectId).then(setAnalytics).catch(() => setAnalytics(null));
  }, [projectId]);

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
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="p-4">
            <p className="text-sm text-[var(--muted)]">Total Runs</p>
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
        <Card className="p-4">
          <p className="text-sm font-medium text-[var(--foreground)]">Status breakdown</p>
          <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
            {Object.entries(analytics?.byStatus ?? {}).map(([status, count]) => (
              <div key={status} className="rounded border border-[var(--border-subtle)] px-3 py-2">
                <p className="text-xs text-[var(--muted)]">{status}</p>
                <p className="text-lg font-semibold text-[var(--foreground)]">{count}</p>
              </div>
            ))}
          </div>
        </Card>
      </StandardPageLayout>
    </main>
  );
}
