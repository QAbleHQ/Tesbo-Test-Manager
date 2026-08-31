"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComponentType } from "react";
import {
  IconActivity,
  IconArrowRight,
  IconBook,
  IconBug,
  IconClipboardCheck,
  IconClock,
  IconDatabase,
  IconGitCompare,
  IconListCheck,
  IconMessage2Bolt,
  IconSettings2,
  IconShieldCheck,
  IconSparkles,
  IconWand,
  IconX,
} from "@tabler/icons-react";
import { authMe, getZyraAgent, type ZyraAgentState, type ZyraCapabilities, type ZyraTask } from "@/lib/api";
import { Modal, PageLoader, StatusChip } from "@/components/ui";
import { ListWorkspaceLayout, PageHeader } from "@/components/workflows";

type ChipIcon = ComponentType<{ size?: number; stroke?: number; className?: string }>;

const CAPABILITY_META: Record<keyof ZyraCapabilities, { icon: ChipIcon; label: string }> = {
  generation: { icon: IconWand, label: "Test generation" },
  knowledgeBase: { icon: IconBook, label: "Knowledge base" },
  testcaseStorage: { icon: IconDatabase, label: "Testcase storage" },
  suiteOperations: { icon: IconListCheck, label: "Suite operations" },
};

const futureAgents: Array<{
  name: string;
  role: string;
  summary: string;
  icon: ChipIcon;
  chips: Array<{ icon: ChipIcon; label: string }>;
}> = [
  {
    name: "Run Analyst",
    role: "Execution insight agent",
    summary: "Planned for run failure clustering, flaky-test signals, and release risk notes.",
    icon: IconActivity,
    chips: [
      { icon: IconGitCompare, label: "Failure clustering" },
      { icon: IconWand, label: "Flaky signals" },
    ],
  },
  {
    name: "Bug Triage",
    role: "Defect analysis agent",
    summary: "Planned for duplicate bug checks, severity suggestions, and owner recommendations.",
    icon: IconBug,
    chips: [
      { icon: IconGitCompare, label: "Duplicate checks" },
      { icon: IconShieldCheck, label: "Severity scoring" },
    ],
  },
];

const ACTIVE_TASK_STATUSES = new Set(["todo", "in_progress", "in_review"]);

// Absolute date only — this card must not read "Nd ago" again (it used to go stale
// silently whenever activity came from Zyra chat instead of the task board; see
// `agent.lastUsedAt` on the backend, which now accounts for both). This formatter is local
// to the Agents tab card; the Conversations list on the Zyra chat screen has its own
// `formatTime` and is intentionally left on its existing "24 Aug, 08:08 pm" format.
function formatLastUsedDate(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getFullYear()}`;
}

/*
 * `testcasesCreated` comes from the API rather than being summed here.
 *
 * Basecamp 10212918496: this summed task.generatedCount, a number only the task-board draft flow
 * produces. Chat mode creates test cases directly and records no generation row, so a project whose
 * 33 cases were all made through the chat reported "0 tests generated". The backend now counts the
 * `zyra_created` audit action, which both modes write.
 */
function deriveZyraStats(tasks: ZyraTask[], testcasesCreated: number) {
  const testsGenerated = testcasesCreated;
  const activeTasks = tasks.filter((t) => ACTIVE_TASK_STATUSES.has(t.taskStatus)).length;
  const decided = tasks.filter((t) => t.taskStatus === "accepted" || t.taskStatus === "rejected");
  const approvalRate =
    decided.length > 0
      ? Math.round((decided.filter((t) => t.taskStatus === "accepted").length / decided.length) * 100)
      : null;
  return { testsGenerated, activeTasks, approvalRate };
}

export default function AgentsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const [state, setState] = useState<ZyraAgentState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

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

  const stats = useMemo(() => (state ? deriveZyraStats(state.tasks, state.testcasesCreated ?? 0) : null), [state]);
  const capabilityChips = useMemo(() => {
    if (!state) return [];
    return (Object.keys(CAPABILITY_META) as Array<keyof ZyraCapabilities>)
      .filter((key) => state.settings.capabilities[key])
      .map((key) => CAPABILITY_META[key]);
  }, [state]);

  if (loading) {
    return (
      <ListWorkspaceLayout header={<PageHeader title="Agents" />}>
        <PageLoader label="Loading agents…" />
      </ListWorkspaceLayout>
    );
  }

  if (!state || !stats) {
    return (
      <ListWorkspaceLayout header={<PageHeader title="Agents" />}>
        <p className="rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error-foreground)]">
          {error ?? "Failed to load agents."}
        </p>
      </ListWorkspaceLayout>
    );
  }

  const totalAgentCount = 1 + futureAgents.length;

  return (
    <ListWorkspaceLayout
      header={
        <PageHeader
          title="Agents"
          subtitle="Select an AI agent to work with. Each agent has its own workspace, memory, and settings — open one to get started."
        />
      }
    >
      {error && (
        <p className="rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error-foreground)]">{error}</p>
      )}

      <div className="mb-4 flex items-center gap-2">
        <IconSparkles size={15} stroke={1.75} className="text-[var(--muted-soft)]" />
        <span className="text-xs font-medium uppercase tracking-[0.06em] text-[var(--muted)]">Available agents</span>
        <span className="rounded-full bg-[var(--surface-secondary)] px-2 py-0.5 text-[11px] font-medium text-[var(--muted)]">{totalAgentCount}</span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="group flex h-full flex-col overflow-hidden rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface)] text-left transition hover:border-[var(--brand-primary)] hover:shadow-[var(--shadow-card)]"
        >
          <div className="h-[3px] shrink-0" style={{ background: "linear-gradient(90deg, var(--brand-primary), var(--accent-light))" }} />
          <div className="flex flex-1 flex-col p-5">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
                style={{ background: "linear-gradient(135deg, var(--brand-primary), var(--accent-light))" }}
              >
                <IconSparkles size={22} stroke={1.75} className="text-white" />
              </div>
              <StatusChip tone={state.agent.active ? "success" : "neutral"}>{state.agent.active ? "Active" : "Inactive"}</StatusChip>
            </div>

            <h3 className="text-[15px] font-semibold text-[var(--foreground)]">{state.agent.name}</h3>
            <p className="mt-0.5 text-xs text-[var(--muted-soft)]">{state.agent.role}</p>

            <p className="mt-3 flex-1 text-[13px] leading-6 text-[var(--muted)]">
              Generates detailed testcases from stories, knowledge, Jira tickets, existing testcases, and Zyra memory.
            </p>

            {capabilityChips.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {capabilityChips.map(({ icon: Icon, label }) => (
                  <span key={label} className="inline-flex items-center gap-1.5 rounded-full bg-[var(--surface-secondary)] px-2.5 py-1 text-[11px] text-[var(--muted)]">
                    <Icon size={12} stroke={1.75} />
                    {label}
                  </span>
                ))}
              </div>
            )}

            <div className="mt-4 flex items-center justify-between border-t border-[var(--border-subtle)] pt-3">
              <span className="flex items-center gap-1.5 text-[11px] text-[var(--muted-soft)]">
                {(() => {
                  const lastUsedDate = state.agent.lastUsedAt ? formatLastUsedDate(state.agent.lastUsedAt) : null;
                  if (!lastUsedDate) return null;
                  return (
                    <>
                      <IconClock size={13} stroke={1.75} />
                      {`Last used on ${lastUsedDate}`}
                    </>
                  );
                })()}
              </span>
              <span className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--accent-light)] group-hover:text-[var(--accent-light)]">
                Open agent
                <IconArrowRight size={13} stroke={1.75} />
              </span>
            </div>
          </div>
        </button>

        {futureAgents.map((agent) => (
          <div key={agent.name} className="flex h-full flex-col overflow-hidden rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface)] opacity-70">
            <div className="h-[3px] shrink-0 bg-[var(--border-subtle)]" />
            <div className="flex flex-1 flex-col p-5">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-secondary)]">
                  <agent.icon size={22} stroke={1.75} className="text-[var(--muted-soft)]" />
                </div>
                <StatusChip tone="neutral">Coming soon</StatusChip>
              </div>

              <h3 className="text-[15px] font-semibold text-[var(--foreground)]">{agent.name}</h3>
              <p className="mt-0.5 text-xs text-[var(--muted-soft)]">{agent.role}</p>
              <p className="mt-3 flex-1 text-[13px] leading-6 text-[var(--muted)]">{agent.summary}</p>

              <div className="mt-4 flex flex-wrap gap-1.5">
                {agent.chips.map(({ icon: Icon, label }) => (
                  <span key={label} className="inline-flex items-center gap-1.5 rounded-full bg-[var(--surface-secondary)] px-2.5 py-1 text-[11px] text-[var(--muted-soft)]">
                    <Icon size={12} stroke={1.75} />
                    {label}
                  </span>
                ))}
              </div>

              <div className="mt-4 border-t border-[var(--border-subtle)] pt-3 text-[11px] text-[var(--muted-soft)]">Not yet available</div>
            </div>
          </div>
        ))}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)}>
        <div className="-m-6">
          <div className="flex items-center gap-3.5 border-b border-[var(--border-subtle)] p-6">
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"
              style={{ background: "linear-gradient(135deg, var(--brand-primary), var(--accent-light))" }}
            >
              <IconSparkles size={22} stroke={1.75} className="text-white" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[17px] font-semibold text-[var(--foreground)]">{state.agent.name}</span>
                <StatusChip tone={state.agent.active ? "success" : "neutral"}>{state.agent.active ? "Active" : "Inactive"}</StatusChip>
              </div>
              <div className="text-[13px] text-[var(--muted)]">{state.agent.role}</div>
            </div>
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              aria-label="Close"
              className="rounded-md p-1.5 text-[var(--muted-soft)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
            >
              <IconX size={16} stroke={1.75} />
            </button>
          </div>

          <div className="grid grid-cols-3 divide-x divide-[var(--border-subtle)] border-b border-[var(--border-subtle)]">
            <div className="p-4 text-center">
              <div className="font-mono text-xl font-semibold text-[var(--foreground)]">{stats.testsGenerated}</div>
              <div className="mt-0.5 text-[11px] text-[var(--muted-soft)]">Tests generated</div>
            </div>
            <div className="p-4 text-center">
              <div className="font-mono text-xl font-semibold text-[var(--foreground)]">{stats.activeTasks}</div>
              <div className="mt-0.5 text-[11px] text-[var(--muted-soft)]">Active tasks</div>
            </div>
            <div className="p-4 text-center">
              <div
                className="font-mono text-xl font-semibold"
                style={{ color: stats.approvalRate === null ? "var(--muted-soft)" : "var(--success)" }}
              >
                {stats.approvalRate === null ? "—" : `${stats.approvalRate}%`}
              </div>
              <div className="mt-0.5 text-[11px] text-[var(--muted-soft)]">Approval rate</div>
            </div>
          </div>

          <div className="space-y-2 p-5">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--muted-soft)]">Open in</p>
            <Link
              href={`/projects/${projectId}/agents/zyra`}
              className="group flex items-center justify-between rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-4 py-3 transition hover:border-[var(--brand-primary)]"
            >
              <div className="flex items-center gap-3">
                <IconMessage2Bolt size={20} stroke={1.75} className="text-[var(--accent-light)]" />
                <div>
                  <div className="text-[13px] font-medium text-[var(--foreground)]">Agent workspace</div>
                  <div className="text-[12px] text-[var(--muted)]">Chat with {state.agent.name} and manage pending tasks</div>
                </div>
              </div>
              <IconArrowRight size={16} stroke={1.75} className="text-[var(--muted-soft)] transition-colors group-hover:text-[var(--accent-light)]" />
            </Link>
            <Link
              href={`/projects/${projectId}/agents/tasks`}
              className="group flex items-center justify-between rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-4 py-3 transition hover:border-[var(--brand-primary)]"
            >
              <div className="flex items-center gap-3">
                <IconClipboardCheck size={20} stroke={1.75} className="text-[var(--accent-light)]" />
                <div>
                  <div className="text-[13px] font-medium text-[var(--foreground)]">Task board</div>
                  <div className="text-[12px] text-[var(--muted)]">Review and approve generated test cases</div>
                </div>
              </div>
              <IconArrowRight size={16} stroke={1.75} className="text-[var(--muted-soft)] transition-colors group-hover:text-[var(--accent-light)]" />
            </Link>
            <Link
              href={`/projects/${projectId}/agents/zyra/settings`}
              className="group flex items-center justify-between rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-4 py-3 transition hover:border-[var(--brand-primary)]"
            >
              <div className="flex items-center gap-3">
                <IconSettings2 size={20} stroke={1.75} className="text-[var(--muted-soft)]" />
                <div>
                  <div className="text-[13px] font-medium text-[var(--foreground)]">Settings</div>
                  <div className="text-[12px] text-[var(--muted)]">Configure sources, memory, and behaviour</div>
                </div>
              </div>
              <IconArrowRight size={16} stroke={1.75} className="text-[var(--muted-soft)] transition-colors group-hover:text-[var(--accent-light)]" />
            </Link>
          </div>
        </div>
      </Modal>
    </ListWorkspaceLayout>
  );
}
