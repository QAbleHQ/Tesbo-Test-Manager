"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

const sections = [
  { href: "runs", title: "Runs", description: "Execution runs with status and drill-down." },
  { href: "specs", title: "Specs", description: "Spec-level quality insights." },
  { href: "tests", title: "Tests", description: "Test-level history and outcomes." },
  { href: "analytics", title: "Analytics", description: "Quality trends and aggregated metrics." },
] as const;

export default function TesboReportsOverviewPage() {
  const params = useParams();
  const projectId = params.id as string;

  return (
    <main className="max-w-5xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Tesbo Reports</h1>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        Tesbo reporting capabilities embedded inside your BetterCases project.
      </p>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Tesbo configuration is now available in Project settings.
      </p>

      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
        {sections.map((section) => (
          <Link
            key={section.href}
            href={`/projects/${projectId}/tesbo-reports/${section.href}`}
            className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
          >
            <h2 className="font-medium text-zinc-900 dark:text-zinc-100">{section.title}</h2>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{section.description}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}
