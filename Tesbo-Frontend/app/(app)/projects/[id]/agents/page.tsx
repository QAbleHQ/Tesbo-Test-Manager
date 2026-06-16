"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { authMe, getZyraAgent, type ZyraAgentState } from "@/lib/api";
import { StatusChip } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

const futureAgents = [
  {
    name: "Run Analyst",
    role: "Execution insight agent",
    summary: "Planned for run failure clustering, flaky-test signals, and release risk notes.",
  },
  {
    name: "Bug Triage",
    role: "Defect analysis agent",
    summary: "Planned for duplicate bug checks, severity suggestions, and owner recommendations.",
  },
];

export default function AgentsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const [state, setState] = useState<ZyraAgentState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const data = await getZyraAgent(projectId);
      setState(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agents.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) router.replace("/login");
      else void loadData();
    });
  }, [loadData, router]);

  if (loading || !state) {
    return (
      <StandardPageLayout header={<PageHeader title="Agents" />}>
        <div className="flex min-h-[220px] items-center justify-center text-sm text-[var(--muted)]">Loading agents...</div>
      </StandardPageLayout>
    );
  }

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Agents"
          subtitle="Select the AI agent you want to work with. Each agent has its own workspace and settings."
        />
      }
    >
      {error && <p className="rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error)]">{error}</p>}

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-[var(--foreground)]">Available agents</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">Open an agent first, then use that agent&apos;s settings page when configuration is needed.</p>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <article className="rounded-lg border border-[var(--brand-primary)] bg-[var(--surface)] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-[var(--foreground)]">{state.agent.name}</h3>
                <p className="mt-1 text-sm text-[var(--muted)]">{state.agent.role}</p>
              </div>
              <StatusChip tone={state.agent.active ? "success" : "warning"}>{state.agent.active ? "Active" : "Inactive"}</StatusChip>
            </div>
            <p className="mt-3 text-sm text-[var(--muted)]">Generates detailed testcases from stories, knowledge, Jira tickets, existing testcases, and Zyra memory.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                href={`/projects/${projectId}/agents/zyra`}
                className="inline-flex items-center rounded-lg px-3 py-2 text-sm font-semibold"
                style={{ backgroundColor: "var(--foreground)", color: "var(--surface)" }}
              >
                Work with Zyra
              </Link>
              <Link href={`/projects/${projectId}/agents/tasks`} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]">Task board</Link>
              <Link href={`/projects/${projectId}/agents/zyra/settings`} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]">Settings</Link>
            </div>
          </article>

          {futureAgents.map((agent) => (
            <article key={agent.name} className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] p-4 opacity-80">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-[var(--foreground)]">{agent.name}</h3>
                  <p className="mt-1 text-sm text-[var(--muted)]">{agent.role}</p>
                </div>
                <StatusChip tone="neutral">Coming soon</StatusChip>
              </div>
              <p className="mt-3 text-sm text-[var(--muted)]">{agent.summary}</p>
              <button type="button" disabled className="mt-4 rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-medium text-[var(--muted)]">Unavailable</button>
            </article>
          ))}
        </div>
      </section>
    </StandardPageLayout>
  );
}
