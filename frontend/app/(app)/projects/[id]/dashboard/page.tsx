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
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  const name = (project.name as string) ?? "";
  const key = (project.key as string) ?? "";
  const description = (project.description as string) ?? "";

  return (
    <main className="max-w-3xl mx-auto px-4 py-8">
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <Link href="/projects" className="hover:text-zinc-700 dark:hover:text-zinc-300">
            Projects
          </Link>
          <span>/</span>
          <span className="text-zinc-900 dark:text-zinc-100">{name}</span>
        </div>
        <h1 className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
          Dashboard
        </h1>
        <p className="mt-1 font-mono text-sm text-zinc-500 dark:text-zinc-400">
          {key}
        </p>
      </div>

      {description ? (
        <p className="mb-8 text-zinc-600 dark:text-zinc-300">{description}</p>
      ) : null}

      {stats ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
            <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
              {stats.testCaseCount}
            </p>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Test cases
            </p>
          </div>
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
            <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
              {stats.suiteCount}
            </p>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Suites</p>
          </div>
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
            <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
              {stats.planCount}
            </p>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Plans</p>
          </div>
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
            <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
              {stats.cycleCount}
            </p>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Cycles</p>
          </div>
        </div>
      ) : null}
    </main>
  );
}
