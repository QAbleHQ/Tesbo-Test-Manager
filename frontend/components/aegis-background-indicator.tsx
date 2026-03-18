"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { getProject } from "@/lib/api";
import { getActiveRuns, onRunsChanged, type AegisBackgroundRun } from "@/lib/aegis-runner";

function parseProjectSettings(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function AegisBackgroundIndicator() {
  const params = useParams();
  const projectId = typeof params?.id === "string" ? params.id : "";
  const [runs, setRuns] = useState<AegisBackgroundRun[]>([]);
  const [agentsEnabled, setAgentsEnabled] = useState(true);

  useEffect(() => {
    if (!projectId) {
      setAgentsEnabled(true);
      return;
    }
    const refreshAgentAvailability = () => {
      getProject(projectId)
        .then((project) => {
          const parsedSettings = parseProjectSettings(project.settings);
          const aiRaw = (parsedSettings.ai ?? {}) as Record<string, unknown>;
          const aiEnabled = aiRaw.enabled !== false;
          setAgentsEnabled(project.aiConfigured === true && aiEnabled);
        })
        .catch(() => setAgentsEnabled(false));
    };
    refreshAgentAvailability();
    const id = setInterval(refreshAgentAvailability, 5000);
    return () => clearInterval(id);
  }, [projectId]);

  useEffect(() => {
    if (!agentsEnabled) {
      setRuns([]);
      return;
    }
    setRuns(getActiveRuns());
    return onRunsChanged(() => setRuns(getActiveRuns()));
  }, [agentsEnabled]);

  if (!agentsEnabled || runs.length === 0) return null;

  const running = runs.filter((r) => r.status === "running");
  const completed = runs.filter((r) => r.status === "completed");
  const failed = runs.filter((r) => r.status === "failed");

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {running.map((r) => (
        <div key={r.testcaseId} className="flex items-center gap-3 rounded-lg border border-blue-200 bg-[var(--brand-soft)] px-4 py-3 shadow-lg">
          <div className="flex h-5 w-5 items-center justify-center">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-[var(--brand-primary)]">Aegis working...</p>
            <p className="text-xs text-[var(--muted)] truncate">{r.title}</p>
          </div>
        </div>
      ))}
      {completed.map((r) => (
        <div key={r.testcaseId} className="flex items-center gap-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 shadow-lg">
          <svg className="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-green-600">Ready for review</p>
            <p className="text-xs text-green-500 truncate">{r.title}</p>
          </div>
        </div>
      ))}
      {failed.map((r) => (
        <div key={r.testcaseId} className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 shadow-lg">
          <svg className="h-5 w-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-red-600">Aegis run failed</p>
            <p className="text-xs text-red-500 truncate">{r.title}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
