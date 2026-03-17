"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { getStoredAgentTasks } from "@/lib/api";

const agents = [
  {
    id: "aegis",
    name: "Aegis",
    tagline: "Test Automation Architect",
    description:
      "Autonomously navigates your app, executes test scenarios, and generates clean Playwright scripts. Completed scripts are sent to your review queue for approval.",
    status: "active" as const,
  },
  {
    id: "sentinel",
    name: "Sentinel",
    tagline: "Script Review Specialist",
    description:
      "Dedicated review bot for generated scripts. Reviews only when enabled or triggered, applies custom review instructions, and publishes actionable feedback.",
    status: "active" as const,
  },
];

function ShieldIcon({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M12 2L3 7v6c0 5.25 3.75 10 9 11 5.25-1 9-5.75 9-11V7l-9-5z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M9 12l2 2 4-4"
      />
    </svg>
  );
}

export default function AgentsPage() {
  const params = useParams();
  const projectId = params.id as string;
  const [pendingReviewCount, setPendingReviewCount] = useState(0);

  useEffect(() => {
    const tasks = getStoredAgentTasks(projectId, "aegis");
    setPendingReviewCount(tasks.filter((t) => t.status === "pending_review").length);
  }, [projectId]);

  return (
    <div className="flex-1 p-6 md:p-10 max-w-6xl mx-auto w-full">
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Agents</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Autonomous agents that automate testing workflows for your project.
          </p>
        </div>
        {pendingReviewCount > 0 && (
          <Link
            href={`/projects/${projectId}/agents/aegis/reviews`}
            className="inline-flex items-center gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-4 py-2 text-sm font-medium text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
            {pendingReviewCount} pending review{pendingReviewCount > 1 ? "s" : ""}
          </Link>
        )}
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((agent) => (
          <Link
            key={agent.id}
            href={`/projects/${projectId}/agents/${agent.id}`}
            className="group relative flex flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 transition-all hover:border-[var(--primary)] hover:shadow-md"
          >
            <div className="flex items-start justify-between">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-[#e8f5eb] dark:bg-zinc-800 text-[var(--primary)]">
                <ShieldIcon className="h-7 w-7" />
              </div>
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  agent.status === "active"
                    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                    : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                }`}
              >
                {agent.status === "active" ? "Active" : "Coming Soon"}
              </span>
            </div>

            <h2 className="mt-4 text-lg font-semibold text-[var(--foreground)] group-hover:text-[var(--primary)]">
              {agent.name}
            </h2>
            <p className="mt-0.5 text-sm font-medium text-[var(--primary)]">
              {agent.tagline}
            </p>
            <p className="mt-2 text-sm text-[var(--muted)] leading-relaxed flex-1">
              {agent.description}
            </p>

            <div className="mt-4 flex items-center text-sm font-medium text-[var(--primary)] group-hover:underline">
              Open agent
              <svg
                className="ml-1 h-4 w-4 transition-transform group-hover:translate-x-0.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
