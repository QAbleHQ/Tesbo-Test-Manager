"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { getProject } from "@/lib/api";
import { getActiveRuns, onRunsChanged, type AegisBackgroundRun } from "@/lib/aegis-runner";

export function AegisBackgroundIndicator() {
  const params = useParams();
  const projectId = typeof params?.id === "string" ? params.id : "";
  const [runs, setRuns] = useState<AegisBackgroundRun[]>(() => getActiveRuns());
  const [agentsEnabled, setAgentsEnabled] = useState(true);

  useEffect(() => {
    if (!projectId) return;
    const refreshAgentAvailability = () => {
      getProject(projectId)
        .then((project) => {
          setAgentsEnabled(project.aiConfigured === true);
        })
        .catch(() => setAgentsEnabled(false));
    };
    refreshAgentAvailability();
    const id = setInterval(refreshAgentAvailability, 5000);
    return () => clearInterval(id);
  }, [projectId]);

  useEffect(() => {
    if (!agentsEnabled) return;
    return onRunsChanged(() => setRuns(getActiveRuns()));
  }, [agentsEnabled]);

  if (!agentsEnabled || runs.length === 0) return null;

  const running = runs.filter((r) => r.status === "running");
  const completed = runs.filter((r) => r.status === "completed");
  const failed = runs.filter((r) => r.status === "failed");

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {running.map((r) => (
        <div key={r.testcaseId} className="flex items-center gap-3 rounded-xl border border-[var(--ai-border)] bg-[var(--ai-soft)] px-4 py-3 shadow-[var(--shadow-elevated)]">
          <div className="flex h-5 w-5 items-center justify-center">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--ai-primary)] border-t-transparent" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-[var(--ai-primary)]">Aegis working...</p>
            <p className="text-xs text-[var(--muted)] truncate">{r.title}</p>
          </div>
        </div>
      ))}
      {completed.map((r) => (
        <div key={r.testcaseId} className="flex items-center gap-3 rounded-xl border border-[var(--success-border)] bg-[var(--success-soft)] px-4 py-3 shadow-[var(--shadow-elevated)]">
          <svg className="h-5 w-5 text-[var(--success)]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-[var(--success-foreground)]">Ready for review</p>
            <p className="text-xs text-[var(--success)] truncate">{r.title}</p>
          </div>
        </div>
      ))}
      {failed.map((r) => (
        <div key={r.testcaseId} className="flex items-center gap-3 rounded-xl border border-[var(--error-border)] bg-[var(--error-soft)] px-4 py-3 shadow-[var(--shadow-elevated)]">
          <svg className="h-5 w-5 text-[var(--error)]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-[var(--error-foreground)]">Aegis run failed</p>
            <p className="text-xs text-[var(--error)] truncate">{r.title}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
