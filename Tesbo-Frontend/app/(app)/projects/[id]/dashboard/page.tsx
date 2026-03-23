"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  authMe,
  getProject,
  listTestCases,
  listSuites,
  listPlans,
  listCycles,
} from "@/lib/api";
import { Card } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

export default function ProjectDashboardPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const [project, setProject] = useState<Record<string, unknown> | null>(null);
  const [stats, setStats] = useState<{
    testCaseCount: number;
    suiteCount: number;
    planCount: number;
    cycleCount: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      getProject(projectId)
        .then((p) => {
          setProject(p);
          return Promise.all([
            listTestCases(projectId, { limit: 1 }),
            listSuites(projectId),
            listPlans(projectId),
            listCycles(projectId),
          ]);
        })
        .then(([tcRes, suites, plans, cycles]) => {
          setStats({
            testCaseCount: tcRes.total,
            suiteCount: suites.length,
            planCount: Array.isArray(plans) ? plans.length : 0,
            cycleCount: Array.isArray(cycles) ? cycles.length : 0,
          });
        })
        .catch(() => router.replace("/projects"))
        .finally(() => setLoading(false));
    });
  }, [projectId, router]);

  if (loading || !project) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-[var(--muted)]">Loading…</p>
      </div>
    );
  }

  const name = (project.name as string) ?? "";
  const key = (project.key as string) ?? "";
  const description = (project.description as string) ?? "";

  return (
    <StandardPageLayout
      header={(
        <PageHeader
          title="Dashboard"
          subtitle={description || undefined}
          breadcrumb={(
            <div className="flex items-center gap-2">
              <Link href="/projects" className="hover:text-[var(--foreground)]">Projects</Link>
              <span>/</span>
              <span className="text-[var(--foreground)]">{name}</span>
            </div>
          )}
        />
      )}
    >
      <p className="mb-4 font-mono text-sm text-[var(--muted)]">{key}</p>

      {stats ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Card className="p-4">
            <p className="text-2xl font-semibold text-[var(--foreground)]">{stats.testCaseCount}</p>
            <p className="text-sm text-[var(--muted)]">Test cases</p>
          </Card>
          <Card className="p-4">
            <p className="text-2xl font-semibold text-[var(--foreground)]">{stats.suiteCount}</p>
            <p className="text-sm text-[var(--muted)]">Suites</p>
          </Card>
          <Card className="p-4">
            <p className="text-2xl font-semibold text-[var(--foreground)]">{stats.planCount}</p>
            <p className="text-sm text-[var(--muted)]">Plans</p>
          </Card>
          <Card className="p-4">
            <p className="text-2xl font-semibold text-[var(--foreground)]">{stats.cycleCount}</p>
            <p className="text-sm text-[var(--muted)]">Cycles</p>
          </Card>
        </div>
      ) : null}
    </StandardPageLayout>
  );
}
