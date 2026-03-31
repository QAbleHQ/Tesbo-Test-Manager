"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  addJiraComment,
  authMe,
  createTestCase,
  generateAiTestCases,
  getAgentSettings,
  getProject,
  getStoredAgentTasks,
  listJiraTickets,
  listKnowledgeBaseItems,
  trackAiGenerationSaved,
  type AgentTask,
  type AgentTaskQueueSource,
  type AgentTaskStatus,
  type AiGeneratedDraft,
  upsertAgentTask,
} from "@/lib/api";
import { Button, Card, StatusChip } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

type TabKey = "queue" | "in_progress" | "in_review" | "completed";

type TaskPayload = {
  sourceType: "jira" | "knowledge_base" | "manual";
  sourceId: string;
  sourceTitle: string;
  sourceDescription?: string;
  sourceUrl?: string;
  requestId?: string;
  drafts?: AiGeneratedDraft[];
};

type TriggerState = {
  jiraCreatedCursor?: string;
  jiraUpdatedCursor?: string;
  knowledgeCreatedCursor?: string;
  knowledgeUpdatedCursor?: string;
};

const TRIGGER_STATE_PREFIX = "testcase-generator-trigger-state";
const AGENT_ALLOCATION_ERROR = "AI Key is not allocated to this Project, can not utilize the Agents";

function taskStatusTone(status: AgentTaskStatus): "warning" | "success" | "error" | "info" | "neutral" | "ai" {
  if (status === "queued") return "neutral";
  if (status === "in_progress") return "info";
  if (status === "pending_review") return "warning";
  if (status === "needs_revision") return "warning";
  if (status === "approved") return "success";
  if (status === "rejected") return "error";
  return "ai";
}

function taskStatusLabel(status: AgentTaskStatus): string {
  if (status === "queued") return "Queued";
  if (status === "in_progress") return "Generating";
  if (status === "pending_review") return "In Review";
  if (status === "needs_revision") return "Needs Revision";
  if (status === "approved") return "Approved";
  if (status === "rejected") return "Rejected";
  return "Bot Reviewing";
}

function sourceLabel(source?: AgentTaskQueueSource): string {
  if (source === "jira_created") return "Jira Created";
  if (source === "jira_updated") return "Jira Updated";
  if (source === "knowledge_base_created") return "Knowledge Base Created";
  if (source === "knowledge_base_updated") return "Knowledge Base Updated";
  return "Manual";
}

function triggerStateKey(projectId: string): string {
  return `${TRIGGER_STATE_PREFIX}:${projectId}`;
}

function readTriggerState(projectId: string): TriggerState {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(triggerStateKey(projectId));
    return raw ? (JSON.parse(raw) as TriggerState) : {};
  } catch {
    return {};
  }
}

function writeTriggerState(projectId: string, next: TriggerState): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(triggerStateKey(projectId), JSON.stringify(next));
}

function parsePayload(task: AgentTask): TaskPayload | null {
  if (!task.script) return null;
  try {
    const parsed = JSON.parse(task.script) as TaskPayload;
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.sourceId || !parsed.sourceTitle || !parsed.sourceType) return null;
    return parsed;
  } catch {
    return null;
  }
}

function updateTask(projectId: string, task: AgentTask): AgentTask {
  upsertAgentTask(projectId, "testcase_generator", task);
  return task;
}

function appendTaskLog(task: AgentTask, message: string, type: "info" | "success" | "error" | "action"): AgentTask {
  const now = new Date().toISOString();
  return {
    ...task,
    updatedAt: now,
    logs: [...task.logs, { ts: now, message, type }],
  };
}

export default function TestCaseGeneratorAgentPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [loading, setLoading] = useState(true);
  const [agentsEnabled, setAgentsEnabled] = useState(true);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [tab, setTab] = useState<TabKey>("queue");
  const [running, setRunning] = useState(false);
  const [scanning, setScanning] = useState(false);

  const refreshTasks = () => {
    setTasks(getStoredAgentTasks(projectId, "testcase_generator"));
  };

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      getProject(projectId)
        .then((p) => {
          setAgentsEnabled(p.aiConfigured === true);
          refreshTasks();
        })
        .finally(() => setLoading(false));
    });
  }, [projectId, router]);

  const queueTasks = useMemo(() => tasks.filter((t) => t.status === "queued"), [tasks]);
  const inProgressTasks = useMemo(() => tasks.filter((t) => t.status === "in_progress"), [tasks]);
  const inReviewTasks = useMemo(
    () => tasks.filter((t) => t.status === "pending_review" || t.status === "needs_revision"),
    [tasks]
  );
  const completedTasks = useMemo(
    () => tasks.filter((t) => t.status === "approved" || t.status === "rejected"),
    [tasks]
  );

  const openSourceTaskExists = (sourceTaskId: string): boolean => {
    return getStoredAgentTasks(projectId, "testcase_generator").some(
      (task) =>
        task.testcaseId === sourceTaskId &&
        (task.status === "queued" ||
          task.status === "in_progress" ||
          task.status === "pending_review" ||
          task.status === "needs_revision")
    );
  };

  const createQueuedTask = (
    queueSource: AgentTaskQueueSource,
    externalId: string,
    title: string,
    sourceTaskId: string,
    payload: TaskPayload
  ): AgentTask => {
    const now = new Date().toISOString();
    const task: AgentTask = {
      id: `testcase-generator-${Date.now()}-${sourceTaskId}`,
      projectId,
      agentType: "testcase_generator",
      testcaseId: sourceTaskId,
      testcaseTitle: title,
      testcaseExternalId: externalId,
      status: "queued",
      queueSource,
      script: JSON.stringify(payload),
      logs: [{ ts: now, message: `Task queued from ${sourceLabel(queueSource)} trigger.`, type: "info" }],
      feedback: [],
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    return updateTask(projectId, task);
  };

  const scanTriggers = async (): Promise<number> => {
    const settings = getAgentSettings(projectId, "testcase_generator");
    const triggerState = readTriggerState(projectId);
    let queuedCount = 0;

    const jiraEnabled = Boolean(
      settings.autoGenerateOnNewJiraTickets || settings.autoGenerateOnUpdatedJiraTickets
    );
    const kbEnabled = Boolean(
      settings.autoGenerateOnNewKnowledgeBase || settings.autoGenerateOnUpdatedKnowledgeBase
    );

    if (jiraEnabled) {
      const jira = await listJiraTickets(projectId, { limit: 50, offset: 0 });
      let nextCreated = triggerState.jiraCreatedCursor || "";
      let nextUpdated = triggerState.jiraUpdatedCursor || "";
      for (const ticket of jira.list) {
        const sourceTaskId = `jira:${ticket.jiraIssueKey}`;
        const createdAt = ticket.jiraCreatedAt || "";
        const updatedAt = ticket.jiraUpdatedAt || "";
        if (createdAt > nextCreated) nextCreated = createdAt;
        if (updatedAt > nextUpdated) nextUpdated = updatedAt;

        if (settings.autoGenerateOnNewJiraTickets && createdAt && createdAt > (triggerState.jiraCreatedCursor || "")) {
          if (!openSourceTaskExists(sourceTaskId)) {
            createQueuedTask("jira_created", ticket.jiraIssueKey, ticket.summary, sourceTaskId, {
              sourceType: "jira",
              sourceId: ticket.jiraIssueKey,
              sourceTitle: ticket.summary,
              sourceDescription: ticket.description || "",
              sourceUrl: ticket.jiraUrl,
            });
            queuedCount += 1;
          }
        }
        if (settings.autoGenerateOnUpdatedJiraTickets && updatedAt && updatedAt > (triggerState.jiraUpdatedCursor || "")) {
          if (!openSourceTaskExists(sourceTaskId)) {
            createQueuedTask("jira_updated", ticket.jiraIssueKey, ticket.summary, sourceTaskId, {
              sourceType: "jira",
              sourceId: ticket.jiraIssueKey,
              sourceTitle: ticket.summary,
              sourceDescription: ticket.description || "",
              sourceUrl: ticket.jiraUrl,
            });
            queuedCount += 1;
          }
        }
      }
      triggerState.jiraCreatedCursor = nextCreated || triggerState.jiraCreatedCursor;
      triggerState.jiraUpdatedCursor = nextUpdated || triggerState.jiraUpdatedCursor;
    }

    if (kbEnabled) {
      const kb = await listKnowledgeBaseItems(projectId, {});
      let nextCreated = triggerState.knowledgeCreatedCursor || "";
      let nextUpdated = triggerState.knowledgeUpdatedCursor || "";
      for (const item of kb.list) {
        const sourceTaskId = `kb:${item.id}`;
        const createdAt = item.createdAt || "";
        const updatedAt = item.updatedAt || "";
        if (createdAt > nextCreated) nextCreated = createdAt;
        if (updatedAt > nextUpdated) nextUpdated = updatedAt;

        const kbExternalId = `KB-${item.id.slice(0, 8).toUpperCase()}`;
        const basePayload: TaskPayload = {
          sourceType: "knowledge_base",
          sourceId: item.id,
          sourceTitle: item.title,
          sourceDescription: item.content || "",
        };

        if (
          settings.autoGenerateOnNewKnowledgeBase &&
          createdAt &&
          createdAt > (triggerState.knowledgeCreatedCursor || "")
        ) {
          if (!openSourceTaskExists(sourceTaskId)) {
            createQueuedTask("knowledge_base_created", kbExternalId, item.title, sourceTaskId, basePayload);
            queuedCount += 1;
          }
        }
        if (
          settings.autoGenerateOnUpdatedKnowledgeBase &&
          updatedAt &&
          updatedAt > (triggerState.knowledgeUpdatedCursor || "")
        ) {
          if (!openSourceTaskExists(sourceTaskId)) {
            createQueuedTask("knowledge_base_updated", kbExternalId, item.title, sourceTaskId, basePayload);
            queuedCount += 1;
          }
        }
      }
      triggerState.knowledgeCreatedCursor = nextCreated || triggerState.knowledgeCreatedCursor;
      triggerState.knowledgeUpdatedCursor = nextUpdated || triggerState.knowledgeUpdatedCursor;
    }

    writeTriggerState(projectId, triggerState);
    refreshTasks();
    return queuedCount;
  };

  const runGenerator = async () => {
    if (running) return;
    setRunning(true);
    const settings = getAgentSettings(projectId, "testcase_generator");
    const caseCount = Math.max(1, Math.min(15, Number(settings.generatedTestcaseCount || 5)));
    try {
      const queued = getStoredAgentTasks(projectId, "testcase_generator").filter((t) => t.status === "queued");
      for (const queuedTask of queued) {
        let task = appendTaskLog(
          {
            ...queuedTask,
            status: "in_progress",
          },
          "Generation started.",
          "action"
        );
        task = updateTask(projectId, task);
        refreshTasks();

        const payload = parsePayload(task);
        if (!payload) {
          task = appendTaskLog({ ...task, status: "rejected", completedAt: new Date().toISOString() }, "Task payload missing.", "error");
          updateTask(projectId, task);
          continue;
        }

        const story = [
          `Source: ${payload.sourceType === "jira" ? "Jira Ticket" : "Knowledge Base"}`,
          `Title: ${payload.sourceTitle}`,
          payload.sourceDescription ? `Details:\n${payload.sourceDescription.slice(0, 8000)}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");

        try {
          const result = await generateAiTestCases(projectId, {
            userStory: story,
            acceptanceCriteria: "",
            style: "strict",
            count: caseCount,
            includeHappyFlow: true,
            includeNegativeFlow: true,
            includeBoundary: true,
            includeCrossBrowser: false,
            includeMultiTab: false,
          });

          const nextPayload: TaskPayload = {
            ...payload,
            requestId: result.generationRequestId,
            drafts: result.drafts,
          };
          task = appendTaskLog(
            {
              ...task,
              status: "pending_review",
              script: JSON.stringify(nextPayload),
              completedAt: new Date().toISOString(),
              duration: Date.now() - new Date(task.createdAt).getTime(),
            },
            `Generated ${result.generatedCount} draft test case(s). Awaiting review approval.`,
            "success"
          );
          updateTask(projectId, task);
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Generation failed";
          task = appendTaskLog(
            {
              ...task,
              status: "rejected",
              completedAt: new Date().toISOString(),
            },
            msg,
            "error"
          );
          updateTask(projectId, task);
        }
        refreshTasks();
      }
    } finally {
      setRunning(false);
      refreshTasks();
    }
  };

  const approveAndStore = async (task: AgentTask) => {
    const payload = parsePayload(task);
    if (!payload?.drafts || payload.drafts.length === 0) {
      const rejected = appendTaskLog({ ...task, status: "rejected", completedAt: new Date().toISOString() }, "No generated drafts available to approve.", "error");
      updateTask(projectId, rejected);
      refreshTasks();
      return;
    }

    const createdIds: string[] = [];
    const createdTitles: string[] = [];
    try {
      for (const draft of payload.drafts) {
        const created = await createTestCase(projectId, {
          title: draft.title,
          description: `${draft.expectedSummary}\n\nGenerated by Test Case Generator agent from ${payload.sourceType}.`,
          preconditions: draft.preconditions,
          steps: draft.stepsJson,
          priority: draft.priority || "P2",
          type: "Functional",
          status: "Draft",
          automationTags: (draft.tags || []).join(", "),
          ...(payload.sourceType === "jira" ? { jiraIssueKey: payload.sourceId, jiraUrl: payload.sourceUrl || "" } : {}),
        });
        createdIds.push(String(created.id));
        createdTitles.push(draft.title);
      }

      if (payload.requestId) {
        await trackAiGenerationSaved(projectId, payload.requestId, { testcaseIds: createdIds });
      }

      const settings = getAgentSettings(projectId, "testcase_generator");
      if (settings.autoCommentOnJira && payload.sourceType === "jira") {
        await addJiraComment(
          projectId,
          payload.sourceId,
          "",
          createdIds.map((id, index) => ({ id, title: createdTitles[index] }))
        );
      }

      const approved = appendTaskLog(
        {
          ...task,
          status: "approved",
          completedAt: new Date().toISOString(),
        },
        `Approved and saved ${createdIds.length} test case(s) to repository.`,
        "success"
      );
      updateTask(projectId, approved);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Approval save failed";
      const rejected = appendTaskLog(
        {
          ...task,
          status: "rejected",
          completedAt: new Date().toISOString(),
        },
        msg,
        "error"
      );
      updateTask(projectId, rejected);
    }
    refreshTasks();
  };

  const requestChanges = (task: AgentTask) => {
    const now = new Date().toISOString();
    updateTask(projectId, {
      ...appendTaskLog(
        {
          ...task,
          status: "needs_revision",
          updatedAt: now,
          completedAt: null,
        },
        "Reviewer requested changes. Re-queue when ready.",
        "action"
      ),
      feedback: [
        ...task.feedback,
        {
          id: `feedback-${Date.now()}`,
          userId: "reviewer",
          message: "Revise generated cases before approval.",
          createdAt: now,
        },
      ],
    });
    refreshTasks();
  };

  const requeueRevision = (task: AgentTask) => {
    updateTask(projectId, appendTaskLog({ ...task, status: "queued" }, "Task re-queued for regeneration.", "info"));
    refreshTasks();
  };

  const rejectTask = (task: AgentTask) => {
    updateTask(
      projectId,
      appendTaskLog({ ...task, status: "rejected", completedAt: new Date().toISOString() }, "Task rejected by reviewer.", "error")
    );
    refreshTasks();
  };

  useEffect(() => {
    if (!agentsEnabled) return;
    const interval = setInterval(async () => {
      if (running || scanning) return;
      const settings = getAgentSettings(projectId, "testcase_generator");
      const hasAutoTrigger = Boolean(
        settings.autoGenerateOnNewJiraTickets ||
          settings.autoGenerateOnUpdatedJiraTickets ||
          settings.autoGenerateOnNewKnowledgeBase ||
          settings.autoGenerateOnUpdatedKnowledgeBase
      );
      if (!hasAutoTrigger) return;
      setScanning(true);
      try {
        const queued = await scanTriggers();
        if (queued > 0 && settings.autoRunOnTrigger) {
          await runGenerator();
        }
      } finally {
        setScanning(false);
      }
    }, 20000);
    return () => clearInterval(interval);
  }, [agentsEnabled, projectId, running, scanning]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center p-10">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--brand-primary)] border-t-transparent" />
      </div>
    );
  }

  const breadcrumb = (
    <Link href={`/projects/${projectId}/agents`} className="inline-flex items-center gap-1 text-[var(--muted)] hover:text-[var(--brand-primary)]">
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
      </svg>
      Agents
    </Link>
  );

  if (!agentsEnabled) {
    return (
      <StandardPageLayout
        header={
          <PageHeader
            title="Test Case Generator"
            subtitle="Disabled for this project"
            breadcrumb={breadcrumb}
          />
        }
        className="flex-1 p-6 md:p-10 max-w-6xl mx-auto w-full"
      >
        <Card className="p-4">
          <p className="text-sm text-[var(--muted)]">{AGENT_ALLOCATION_ERROR}</p>
        </Card>
      </StandardPageLayout>
    );
  }

  const activeRows =
    tab === "queue"
      ? queueTasks
      : tab === "in_progress"
        ? inProgressTasks
        : tab === "in_review"
          ? inReviewTasks
          : completedTasks;

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Test Case Generator"
          subtitle="Generate from Jira and Knowledge Base, then review, approve, and store."
          breadcrumb={breadcrumb}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => {
                  setScanning(true);
                  try {
                    const queued = await scanTriggers();
                    const settings = getAgentSettings(projectId, "testcase_generator");
                    if (queued > 0 && settings.autoRunOnTrigger) {
                      await runGenerator();
                    }
                  } finally {
                    setScanning(false);
                  }
                }}
              >
                {scanning ? "Scanning..." : "Scan Trigger Sources"}
              </Button>
              <Button size="sm" onClick={() => void runGenerator()} disabled={running || queueTasks.length === 0}>
                {running ? "Generating..." : "Generate Queued Cases"}
              </Button>
              <Link
                href={`/projects/${projectId}/agents/testcase-generator/settings`}
                className="inline-flex items-center justify-center gap-2 h-9 rounded-[10px] px-3 text-xs font-semibold border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
              >
                Settings
              </Link>
              <Link
                href={`/projects/${projectId}/ai-test-script`}
                className="inline-flex items-center justify-center gap-2 h-9 rounded-[10px] px-3 text-xs font-semibold border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
              >
                Manual AI Generate
              </Link>
            </div>
          }
        />
      }
      className="flex-1 p-6 md:p-10 max-w-6xl mx-auto w-full"
    >
      <div className="flex gap-1 mb-5 border-b border-[var(--border)]">
        {[
          { id: "queue" as const, label: "Queue", count: queueTasks.length },
          { id: "in_progress" as const, label: "In Progress", count: inProgressTasks.length },
          { id: "in_review" as const, label: "In Review", count: inReviewTasks.length },
          { id: "completed" as const, label: "Completed", count: completedTasks.length },
        ].map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 ${
              tab === item.id
                ? "border-[var(--brand-primary)] text-[var(--brand-primary)]"
                : "border-transparent text-[var(--muted)]"
            }`}
          >
            {item.label} {item.count > 0 ? `(${item.count})` : ""}
          </button>
        ))}
      </div>

      {activeRows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-12 text-center text-sm text-[var(--muted)]">
          No tasks in this bucket.
        </div>
      ) : (
        <div className="space-y-2">
          {activeRows.map((task) => {
            const payload = parsePayload(task);
            const generatedCount = payload?.drafts?.length || 0;
            return (
              <Card key={task.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-xs text-[var(--muted)]">{task.testcaseExternalId}</span>
                      <StatusChip tone={taskStatusTone(task.status)}>{taskStatusLabel(task.status)}</StatusChip>
                      <span className="text-xs text-[var(--muted)]">{sourceLabel(task.queueSource)}</span>
                    </div>
                    <div className="text-sm font-semibold text-[var(--foreground)] truncate">{task.testcaseTitle}</div>
                    <div className="text-xs text-[var(--muted)] mt-1">
                      {generatedCount > 0 ? `${generatedCount} draft test case(s)` : "Awaiting generation output"}
                    </div>
                    {task.logs.length > 0 && (
                      <div className="text-xs text-[var(--muted)] mt-1">{task.logs[task.logs.length - 1].message}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {task.status === "pending_review" && (
                      <>
                        <Button size="sm" onClick={() => void approveAndStore(task)}>
                          Approve and Save
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => requestChanges(task)}>
                          Request Changes
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => rejectTask(task)}>
                          Reject
                        </Button>
                      </>
                    )}
                    {task.status === "needs_revision" && (
                      <Button size="sm" onClick={() => requeueRevision(task)}>
                        Re-queue Revision
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </StandardPageLayout>
  );
}
