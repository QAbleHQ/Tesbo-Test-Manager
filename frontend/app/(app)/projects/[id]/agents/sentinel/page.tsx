"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  getProject,
  getAgentSettings,
  getStoredAgentTasks,
  getTestCase,
  startAutomationSession,
  runAutomationPlaywrightScript,
  cancelAutomationSession,
  reviewAutomationScriptWithAi,
  type AgentTask,
  type AgentReviewFeedback,
  type BotReviewResult,
  type TestEnvironmentSetting,
  upsertAgentTask,
} from "@/lib/api";
import { runAegisInBackground } from "@/lib/aegis-runner";
import { Button, Card, StatusChip } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

type Tab = "queue" | "in_progress" | "needs_approval" | "completed";
const AGENT_ALLOCATION_ERROR = "AI Key is not allocated to this Project, can not utilize the Agents";

function EyeIcon({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
      <circle cx="12" cy="12" r="3" strokeWidth={1.5} />
    </svg>
  );
}

function parseProjectSettings(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeTestRunEnvironments(raw: unknown): TestEnvironmentSetting[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const candidate = item as { name?: unknown; url?: unknown };
      const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
      const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
      if (!name || !url) return null;
      return { name, url };
    })
    .filter((item): item is TestEnvironmentSetting => item !== null);
}

function parseSteps(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((step) => {
        const s = step as { action?: unknown; expectedResult?: unknown };
        const action = typeof s.action === "string" ? s.action.trim() : "";
        const expected = typeof s.expectedResult === "string" ? s.expectedResult.trim() : "";
        if (action && expected) return `${action} -> Expect: ${expected}`;
        return action || expected || "";
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export default function SentinelPage() {
  const params = useParams();
  const projectId = params.id as string;
  const [tab, setTab] = useState<Tab>("queue");
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [busy, setBusy] = useState(false);
  const [autoTick, setAutoTick] = useState(false);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [agentsEnabled, setAgentsEnabled] = useState(true);
  const processingRef = useRef(false);

  const load = () => setTasks(getStoredAgentTasks(projectId, "sentinel"));

  useEffect(() => {
    load();
    getProject(projectId)
      .then((project) => {
        const parsed = parseProjectSettings(project.settings);
        const aiRaw = (parsed.ai ?? {}) as Record<string, unknown>;
        const aiEnabled = aiRaw.enabled !== false;
        setAgentsEnabled(project.aiConfigured === true && aiEnabled);
      })
      .catch(() => setAgentsEnabled(false));
    const t = setInterval(load, 1000);
    return () => clearInterval(t);
  }, [projectId]);

  const queueFromAegis = () => {
    const aegisTasks = getStoredAgentTasks(projectId, "aegis").filter((t) => t.status === "pending_review" && !!t.script);
    const sentinelTasks = getStoredAgentTasks(projectId, "sentinel");
    const existing = new Set(sentinelTasks.map((t) => t.runId || ""));
    const now = new Date().toISOString();
    for (const source of aegisTasks) {
      if (existing.has(source.id)) continue;
      const task: AgentTask = {
        id: `sentinel-${Date.now()}-${source.id}`,
        projectId,
        agentType: "sentinel",
        testcaseId: source.testcaseId,
        testcaseTitle: source.testcaseTitle,
        testcaseExternalId: source.testcaseExternalId,
        status: "queued",
        queueSource: "manual",
        script: source.script || null,
        sessionId: source.sessionId || null,
        logs: [{ ts: now, message: "Queued for review bot.", type: "info" }],
        feedback: [],
        runId: source.id,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      };
      upsertAgentTask(projectId, "sentinel", task);
    }
    load();
  };

  const buildFeedbackEntries = (messages: string[]): AgentReviewFeedback[] => {
    const now = new Date().toISOString();
    return messages
      .filter(Boolean)
      .map((message, idx) => ({
        id: `sentinel-fb-${Date.now()}-${idx}`,
        userId: "sentinel-bot",
        message,
        createdAt: now,
      }));
  };

  const resolveEnvironmentUrl = async (): Promise<string | null> => {
    const aegisSettings = getAgentSettings(projectId, "aegis");
    if (aegisSettings.defaultEnvironmentUrl) return aegisSettings.defaultEnvironmentUrl;
    try {
      const project = await getProject(projectId);
      const parsed = parseProjectSettings(project.settings);
      const envs = normalizeTestRunEnvironments((parsed.automation as { testRunEnvironments?: unknown } | undefined)?.testRunEnvironments);
      return envs.length > 0 ? envs[0].url : null;
    } catch {
      return null;
    }
  };

  const normalizeSentinelCategories = (botReview: BotReviewResult, rerunPassed: boolean): NonNullable<BotReviewResult["categories"]> => {
    const aiMap = new Map((botReview.categories || []).map((c) => [c.key, c]));
    const hasImprovements = (botReview.assertionSuggestions?.length || 0) > 0;
    return [
      {
        key: "code_quality",
        passed: aiMap.get("code_quality")?.passed ?? aiMap.get("assertion_validation")?.passed ?? (botReview.status === "passed"),
        detail: aiMap.get("code_quality")?.detail ?? "Playwright structure and assertion quality checked.",
      },
      {
        key: "rerun_execution",
        passed: rerunPassed,
        detail: aiMap.get("rerun_execution")?.detail ?? (rerunPassed ? "Rerun passed without runtime failure." : "Rerun failed during execution."),
      },
      {
        key: "goal_assertion_coverage",
        passed: aiMap.get("goal_assertion_coverage")?.passed ?? aiMap.get("goal_validation")?.passed ?? (botReview.validatedSteps?.every((s) => s.passed) ?? false),
        detail: aiMap.get("goal_assertion_coverage")?.detail ?? "Checked goal fulfillment and assertion coverage per steps.",
      },
      {
        key: "minimum_criteria",
        passed: rerunPassed && botReview.status === "passed",
        detail: rerunPassed && botReview.status === "passed"
          ? "Minimum criteria met."
          : "Minimum criteria not met (rerun and/or quality checks failed).",
      },
      {
        key: "improvement_opportunities",
        passed: !hasImprovements,
        detail: hasImprovements
          ? `Found ${botReview.assertionSuggestions?.length || 0} improvement suggestion(s).`
          : "No major improvement opportunities detected.",
      },
    ];
  };

  const runReviewBot = async () => {
    if (processingRef.current) return;
    const settings = getAgentSettings(projectId, "sentinel");
    if (settings.reviewBotEnabled === false) return;
    processingRef.current = true;
    setBusy(true);
    try {
      const latest = getStoredAgentTasks(projectId, "sentinel");
      const queued = latest.filter((t) => t.status === "queued");
      for (const task of queued) {
        const now = new Date().toISOString();
        const runLogs = [...task.logs, { ts: now, message: "Review started.", type: "action" as const }];
        upsertAgentTask(projectId, "sentinel", {
          ...task,
          status: "in_progress",
          updatedAt: now,
          logs: runLogs,
        });

        const source = getStoredAgentTasks(projectId, "aegis").find((t) => t.id === task.runId);
        if (!source || !source.script) {
          const failAt = new Date().toISOString();
          upsertAgentTask(projectId, "sentinel", {
            ...task,
            status: "rejected",
            updatedAt: failAt,
            completedAt: failAt,
            logs: [...runLogs, { ts: failAt, message: "Source script not found in Aegis task.", type: "error" }],
          });
          continue;
        }

        try {
          runLogs.push({ ts: new Date().toISOString(), message: "Loaded source script from Aegis task.", type: "info" });
          const tc = await getTestCase(projectId, task.testcaseId);
          const steps = parseSteps(tc.steps);
          runLogs.push({ ts: new Date().toISOString(), message: `Fetched test case with ${steps.length} step(s).`, type: "info" });
          const envUrl = await resolveEnvironmentUrl();
          let rerunPassed = false;
          let rerunError: string | null = null;
          if (!envUrl) {
            rerunError = "No environment URL configured for rerun.";
            runLogs.push({ ts: new Date().toISOString(), message: `Rerun skipped: ${rerunError}`, type: "error" });
          } else {
            try {
              runLogs.push({ ts: new Date().toISOString(), message: `Starting rerun on ${envUrl}`, type: "action" });
              const { id: reviewSessionId } = await startAutomationSession(projectId, task.testcaseId, { startUrl: envUrl });
              const rerun = await runAutomationPlaywrightScript(projectId, reviewSessionId, {
                script: source.script,
                startUrl: envUrl,
                actionDelayMs: 500,
              });
              rerunPassed = String(rerun.status || "").toLowerCase() === "passed";
              rerunError = rerunPassed ? null : (rerun.errorMessage || "Rerun failed");
              runLogs.push({
                ts: new Date().toISOString(),
                message: rerunPassed ? "Rerun completed successfully." : `Rerun failed: ${rerunError}`,
                type: rerunPassed ? "success" : "error",
              });
              try { await cancelAutomationSession(projectId, reviewSessionId); } catch {}
            } catch (err) {
              rerunPassed = false;
              rerunError = err instanceof Error ? err.message : "Rerun failed to start";
              runLogs.push({ ts: new Date().toISOString(), message: `Rerun execution error: ${rerunError}`, type: "error" });
            }
          }

          const userInstruction = getAgentSettings(projectId, "sentinel").reviewInstruction || "";
          const categoryInstruction =
            "Apply these categories: (1) code quality, (2) rerun execution result, (3) goal + assertion coverage, (4) minimum criteria pass/fail, (5) improvement opportunities.";
          const ai = await reviewAutomationScriptWithAi(projectId, {
            testcaseId: task.testcaseId,
            testcaseTitle: task.testcaseTitle,
            testcaseDescription: typeof tc.description === "string" ? tc.description : "",
            steps,
            script: source.script,
            rerunPassed,
            rerunError,
            reviewInstruction: `${categoryInstruction}\n${userInstruction}`.trim(),
          });
          runLogs.push({ ts: new Date().toISOString(), message: "AI review completed and response received.", type: "info" });

          const now2 = new Date().toISOString();
          let botReview: BotReviewResult = {
            status: ai.status === "passed" ? "passed" : "failed",
            feedback: Array.isArray(ai.feedback) ? ai.feedback : [],
            validatedSteps: Array.isArray(ai.validatedSteps) ? ai.validatedSteps : [],
            categories: Array.isArray(ai.categories) ? ai.categories : [],
            assertionSuggestions: Array.isArray(ai.assertionSuggestions) ? ai.assertionSuggestions : [],
            reviewedAt: now2,
            scriptRanSuccessfully: rerunPassed,
          };
          botReview = { ...botReview, categories: normalizeSentinelCategories(botReview, rerunPassed) };
          for (const category of botReview.categories || []) {
            runLogs.push({
              ts: new Date().toISOString(),
              message: `Category ${category.key}: ${category.passed ? "PASS" : "FAIL"} — ${category.detail}`,
              type: category.passed ? "success" : "error",
            });
          }
          const minimumCriteriaMet = rerunPassed && botReview.status === "passed";
          const improvementSuggestions = botReview.assertionSuggestions || [];
          const improvementFeedbackMessages = improvementSuggestions.map(
            (s) => `Step "${s.step}": ${s.suggestion} (${s.reason})`,
          );

          upsertAgentTask(projectId, "aegis", {
            ...source,
            botReview,
            updatedAt: now2,
          });

          if (!minimumCriteriaMet) {
            const feedback = buildFeedbackEntries(botReview.feedback);
            runLogs.push({ ts: now2, message: "Decision: REJECTED (minimum criteria not met).", type: "error" });
            runLogs.push({ ts: now2, message: "Action: sending task back to Aegis for auto-fix.", type: "action" });
            upsertAgentTask(projectId, "sentinel", {
              ...task,
              status: "rejected",
              updatedAt: now2,
              completedAt: now2,
              botReview,
              feedback,
              logs: runLogs,
            });
            runAegisInBackground(
              projectId,
              source.testcaseId,
              source.testcaseTitle,
              source.testcaseExternalId,
              "failed_fix",
              { botFeedback: botReview.feedback },
            );
          } else if (improvementFeedbackMessages.length > 0) {
            runLogs.push({ ts: now2, message: `Decision: NEEDS USER APPROVAL (${improvementFeedbackMessages.length} improvement suggestion(s)).`, type: "info" });
            upsertAgentTask(projectId, "sentinel", {
              ...task,
              status: "pending_review",
              updatedAt: now2,
              completedAt: null,
              botReview,
              feedback: buildFeedbackEntries(improvementFeedbackMessages),
              logs: runLogs,
            });
          } else {
            runLogs.push({ ts: now2, message: "Decision: APPROVED (minimum criteria met, no improvements required).", type: "success" });
            upsertAgentTask(projectId, "sentinel", {
              ...task,
              status: "approved",
              updatedAt: now2,
              completedAt: now2,
              botReview,
              logs: runLogs,
            });
          }
        } catch (e) {
          const now2 = new Date().toISOString();
          const failLogs = [...runLogs, { ts: now2, message: `Review failed: ${e instanceof Error ? e.message : "unknown error"}`, type: "error" as const }];
          upsertAgentTask(projectId, "sentinel", {
            ...task,
            status: "rejected",
            updatedAt: now2,
            completedAt: now2,
            logs: failLogs,
          });
        }
      }
    } finally {
      processingRef.current = false;
      setBusy(false);
      load();
    }
  };

  useEffect(() => {
    const s = getAgentSettings(projectId, "sentinel");
    const enabled = s.reviewBotEnabled !== false && Boolean(s.autoReviewOnScriptReady);
    setAutoTick(enabled);
    if (!enabled) return;
    const interval = setInterval(() => {
      queueFromAegis();
      runReviewBot();
    }, 5000);
    return () => clearInterval(interval);
  }, [projectId]);

  const approveImprovements = (task: AgentTask) => {
    const source = getStoredAgentTasks(projectId, "aegis").find((t) => t.id === task.runId);
    if (!source) return;
    const feedback = task.feedback.map((f) => f.message);
    runAegisInBackground(
      projectId,
      source.testcaseId,
      source.testcaseTitle,
      source.testcaseExternalId,
      "revision",
      { botFeedback: feedback },
    );
    const now = new Date().toISOString();
    upsertAgentTask(projectId, "sentinel", {
      ...task,
      status: "approved",
      updatedAt: now,
      completedAt: now,
      logs: [...task.logs, { ts: now, message: "User approved improvements. Sent to Aegis.", type: "action" }],
    });
    load();
  };

  const dismissImprovements = (task: AgentTask) => {
    const now = new Date().toISOString();
    upsertAgentTask(projectId, "sentinel", {
      ...task,
      status: "approved",
      updatedAt: now,
      completedAt: now,
      logs: [...task.logs, { ts: now, message: "User dismissed improvements.", type: "info" }],
    });
    load();
  };

  const queued = tasks.filter((t) => t.status === "queued");
  const inProgress = tasks.filter((t) => t.status === "in_progress");
  const needsApproval = tasks.filter((t) => t.status === "pending_review");
  const completed = tasks.filter((t) => t.status === "approved" || t.status === "rejected");
  const rows = tab === "queue" ? queued : tab === "in_progress" ? inProgress : tab === "needs_approval" ? needsApproval : completed;

  const breadcrumb = (
    <Link href={`/projects/${projectId}/agents`} className="inline-flex items-center gap-1 text-[var(--muted)] hover:text-[var(--brand-primary)]">
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
      Agents
    </Link>
  );

  if (!agentsEnabled) {
    return (
      <StandardPageLayout
        header={
          <PageHeader
            title="Sentinel"
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

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Sentinel"
          subtitle="Review Bot for generated scripts"
          breadcrumb={breadcrumb}
          actions={
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={queueFromAegis}>
                Queue from Aegis
              </Button>
              <Button size="sm" onClick={runReviewBot} disabled={busy}>
                {busy ? "Reviewing..." : "Run Review Bot"}
              </Button>
              <Link
                href={`/projects/${projectId}/agents/sentinel/settings`}
                className="inline-flex items-center justify-center gap-2 h-9 rounded-[10px] px-3 text-xs font-semibold border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
              >
                Settings
              </Link>
            </div>
          }
        />
      }
      className="flex-1 p-6 md:p-10 max-w-6xl mx-auto w-full"
    >
      {autoTick && <p className="mb-5 text-xs text-[var(--brand-primary)]">Auto-review is enabled. Sentinel checks for new scripts every 5s.</p>}

      <div className="flex gap-1 mb-5 border-b border-[var(--border)]">
        {[
          { key: "queue", label: "Queue", count: queued.length },
          { key: "in_progress", label: "In Progress", count: inProgress.length },
          { key: "needs_approval", label: "Needs Approval", count: needsApproval.length },
          { key: "completed", label: "Completed", count: completed.length },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key as Tab)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 ${tab === t.key ? "border-[var(--brand-primary)] text-[var(--brand-primary)]" : "border-transparent text-[var(--muted)]"}`}
          >
            {t.label} {t.count > 0 ? `(${t.count})` : ""}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--border)] p-12 text-center text-sm text-[var(--muted)]">
            No tasks in this bucket.
          </div>
        ) : (
          rows.map((task) => (
            <Card key={task.id} className="p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-[var(--foreground)]">{task.testcaseTitle}</div>
                  <div className="text-xs text-[var(--muted)]">{task.testcaseExternalId}</div>
                </div>
                <StatusChip tone="neutral">{task.status}</StatusChip>
              </div>
              {task.botReview && (
                <div className="mt-2 text-xs text-[var(--foreground)]">
                  Review result: <span className={task.botReview.status === "passed" ? "text-[var(--success)]" : "text-[var(--error)]"}>{task.botReview.status}</span>
                </div>
              )}
              {task.botReview?.categories && task.botReview.categories.length > 0 && (
                <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-1">
                  {task.botReview.categories.map((c, idx) => (
                    <div key={idx} className={`text-[11px] rounded border px-2 py-1 ${c.passed ? "border-[var(--success)]/30 text-[var(--success)]" : "border-[var(--error)]/30 text-[var(--error)]"}`}>
                      {c.key}: {c.passed ? "PASS" : "FAIL"}
                    </div>
                  ))}
                </div>
              )}
              {task.status === "pending_review" && task.feedback.length > 0 && (
                <div className="mt-3 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning-soft)] p-3">
                  <p className="text-xs font-semibold text-[var(--warning)] mb-1">Improvement suggestions</p>
                  <ul className="text-xs text-[var(--foreground)] space-y-1">
                    {task.feedback.map((f) => <li key={f.id}>- {f.message}</li>)}
                  </ul>
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" onClick={() => approveImprovements(task)}>
                      Approve & Send to Aegis
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => dismissImprovements(task)}>
                      Approve Without Re-run
                    </Button>
                  </div>
                </div>
              )}
              {task.logs.length > 0 && (
                <div className="mt-2 text-xs text-[var(--muted)]">{task.logs[task.logs.length - 1].message}</div>
              )}
              <div className="mt-3">
                <button
                  onClick={() => setExpandedTaskId((prev) => (prev === task.id ? null : task.id))}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--brand-primary)] hover:underline"
                >
                  <svg
                    className={`h-3.5 w-3.5 transition-transform ${expandedTaskId === task.id ? "rotate-180" : ""}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                  {expandedTaskId === task.id ? "Hide Review Reasoning" : "Show Review Reasoning"}
                </button>
              </div>
              {expandedTaskId === task.id && (
                <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3 space-y-3">
                  <div>
                    <p className="text-xs font-semibold text-[var(--muted)] mb-1">Decision Summary</p>
                    <p className="text-xs text-[var(--foreground)]">
                      {task.status === "approved" && "Approved. Script meets minimum criteria and no mandatory fix is required."}
                      {task.status === "rejected" && "Rejected. Minimum criteria failed, task was sent back to Aegis automatically."}
                      {task.status === "pending_review" && "Minimum criteria passed, but improvement suggestions need user decision."}
                    </p>
                  </div>

                  {task.botReview?.categories && task.botReview.categories.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-[var(--muted)] mb-1">Category Reasoning</p>
                      <div className="space-y-1">
                        {task.botReview.categories.map((c, idx) => (
                          <div key={idx} className="text-xs">
                            <span className={c.passed ? "text-[var(--success)]" : "text-[var(--error)]"}>{c.passed ? "PASS" : "FAIL"}</span>
                            <span className="ml-1 font-medium text-[var(--foreground)]">{c.key}</span>
                            <span className="text-[var(--muted)]"> — {c.detail}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {task.botReview?.validatedSteps && task.botReview.validatedSteps.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-[var(--muted)] mb-1">Step-by-step Review</p>
                      <div className="space-y-1">
                        {task.botReview.validatedSteps.map((s, idx) => (
                          <div key={idx} className="text-xs">
                            <span className={s.passed ? "text-[var(--success)]" : "text-[var(--error)]"}>{s.passed ? "PASS" : "FAIL"}</span>
                            <span className="ml-1 text-[var(--foreground)]">{s.step}</span>
                            {s.detail ? <span className="text-[var(--muted)]"> — {s.detail}</span> : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {task.botReview?.feedback && task.botReview.feedback.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-[var(--muted)] mb-1">Why It Was Marked</p>
                      <ul className="space-y-1">
                        {task.botReview.feedback.map((f, idx) => (
                          <li key={idx} className="text-xs text-[var(--foreground)]">- {f}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {task.botReview?.assertionSuggestions && task.botReview.assertionSuggestions.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-[var(--muted)] mb-1">Improvement Suggestions</p>
                      <ul className="space-y-1">
                        {task.botReview.assertionSuggestions.map((s, idx) => (
                          <li key={idx} className="text-xs text-[var(--foreground)]">
                            - <span className="font-medium">{s.step}:</span> {s.suggestion}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div>
                    <p className="text-xs font-semibold text-[var(--muted)] mb-1">Sentinel Thinking Log</p>
                    <div className="max-h-48 overflow-y-auto rounded border border-[var(--border)] bg-[var(--surface)] p-2 space-y-1">
                      {task.logs.map((entry, idx) => (
                        <div key={idx} className="text-[11px]">
                          <span className="text-[var(--muted)]">{new Date(entry.ts).toLocaleTimeString()} </span>
                          <span className={
                            entry.type === "success" ? "text-[var(--success)]" :
                            entry.type === "error" ? "text-[var(--error)]" :
                            entry.type === "action" ? "text-[var(--brand-primary)]" :
                            "text-[var(--foreground)]"
                          }>
                            {entry.message}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </Card>
          ))
        )}
      </div>
    </StandardPageLayout>
  );
}
