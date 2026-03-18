"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getStoredAgentTasks } from "@/lib/api";
import { Button, Card, StatusChip } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

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
  const router = useRouter();
  const projectId = params.id as string;
  const [pendingReviewCount, setPendingReviewCount] = useState(0);

  useEffect(() => {
    const tasks = getStoredAgentTasks(projectId, "aegis");
    setPendingReviewCount(tasks.filter((t) => t.status === "pending_review").length);
  }, [projectId]);

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Agents"
          subtitle="Autonomous agents that automate testing workflows for your project."
          actions={
            pendingReviewCount > 0 ? (
              <Button
                variant="secondary"
                size="md"
                className="border-[var(--warning)]/30 bg-[var(--warning)]/10 text-[var(--warning)] hover:bg-[var(--warning)]/20"
                onClick={() => router.push(`/projects/${projectId}/agents/aegis/reviews`)}
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                </svg>
                {pendingReviewCount} pending review{pendingReviewCount > 1 ? "s" : ""}
              </Button>
            ) : undefined
          }
        />
      }
    >
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((agent) => (
          <Link key={agent.id} href={`/projects/${projectId}/agents/${agent.id}`} className="group block">
            <Card className="flex flex-col p-6 transition-all hover:border-[var(--brand-primary)] hover:shadow-md h-full">
              <div className="flex items-start justify-between">
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-[var(--brand-soft)] text-[var(--brand-primary)]">
                  <ShieldIcon className="h-7 w-7" />
                </div>
                <StatusChip tone={agent.status === "active" ? "success" : "neutral"}>
                  {agent.status === "active" ? "Active" : "Coming Soon"}
                </StatusChip>
              </div>

              <h2 className="mt-4 text-lg font-semibold text-[var(--foreground)] group-hover:text-[var(--brand-primary)]">
                {agent.name}
              </h2>
              <p className="mt-0.5 text-sm font-medium text-[var(--brand-primary)]">{agent.tagline}</p>
              <p className="mt-2 text-sm text-[var(--muted)] leading-relaxed flex-1">{agent.description}</p>

              <div className="mt-4 flex items-center text-sm font-medium text-[var(--brand-primary)] group-hover:underline">
                Open agent
                <svg className="ml-1 h-4 w-4 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </StandardPageLayout>
  );
}
