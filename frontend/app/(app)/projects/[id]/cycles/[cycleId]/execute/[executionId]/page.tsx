"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { authMe, listCycleExecutions, updateExecution, type ExecutionItem } from "@/lib/api";

const STATUSES = ["Untested", "Passed", "Failed", "Skipped", "Blocked", "Retest"];

function StatusBadge({ status }: { status: string }) {
  const cls: Record<string, string> = {
    Passed: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    Failed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
    Skipped: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
    Blocked: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
    Retest: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
    Untested: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${cls[status] || cls.Untested}`}>
      {status}
    </span>
  );
}

export default function ExecutionDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const cycleId = params.cycleId as string;
  const executionId = params.executionId as string;
  const [execution, setExecution] = useState<ExecutionItem | null>(null);
  const [status, setStatus] = useState("");
  const [actualResult, setActualResult] = useState("");
  const [defectKey, setDefectKey] = useState("");
  const [defectUrl, setDefectUrl] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      listCycleExecutions(cycleId)
        .then((list) => {
          const e = list.find((x) => x.id === executionId);
          if (e) {
            setExecution(e);
            setStatus(e.status || "Untested");
            setActualResult(e.actualResult || "");
            setDefectKey(e.defectKey || "");
            setDefectUrl(e.defectUrl || "");
          }
        })
        .catch(() => router.replace("/projects"));
    });
  }, [cycleId, executionId, router]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await updateExecution(cycleId, executionId, {
        status,
        actualResult,
        defectKey: defectKey || undefined,
        defectUrl: defectUrl || undefined,
      });
      router.push(`/projects/${projectId}/cycles/${cycleId}`);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  if (!execution) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-3">
        <div className="flex items-center gap-2 text-sm">
          <Link href={`/projects/${projectId}/cycles`} className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
            Test Runs
          </Link>
          <span className="text-zinc-300 dark:text-zinc-600">/</span>
          <Link href={`/projects/${projectId}/cycles/${cycleId}`} className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
            Run Detail
          </Link>
          <span className="text-zinc-300 dark:text-zinc-600">/</span>
          <span className="text-zinc-900 dark:text-zinc-100 font-medium">Execute</span>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-8">
        <div className="flex items-center gap-3 mb-6">
          <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
            {execution.title}
          </h1>
          <StatusBadge status={status} />
        </div>

        {execution.externalId && (
          <p className="text-xs text-zinc-400 font-mono mb-4">{execution.externalId}</p>
        )}

        <form onSubmit={handleSave} className="space-y-5">
          {/* Status buttons */}
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
              Status
            </label>
            <div className="flex flex-wrap gap-2">
              {STATUSES.map((s) => {
                const active = status === s;
                const colors: Record<string, string> = {
                  Passed: active ? "bg-green-600 text-white" : "border-green-200 text-green-700 hover:bg-green-50 dark:border-green-800 dark:text-green-400 dark:hover:bg-green-900/20",
                  Failed: active ? "bg-red-600 text-white" : "border-red-200 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20",
                  Skipped: active ? "bg-yellow-500 text-white" : "border-yellow-200 text-yellow-700 hover:bg-yellow-50 dark:border-yellow-800 dark:text-yellow-400 dark:hover:bg-yellow-900/20",
                  Blocked: active ? "bg-orange-500 text-white" : "border-orange-200 text-orange-700 hover:bg-orange-50 dark:border-orange-800 dark:text-orange-400 dark:hover:bg-orange-900/20",
                  Retest: active ? "bg-purple-600 text-white" : "border-purple-200 text-purple-700 hover:bg-purple-50 dark:border-purple-800 dark:text-purple-400 dark:hover:bg-purple-900/20",
                  Untested: active ? "bg-zinc-600 text-white" : "border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800",
                };
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStatus(s)}
                    className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${colors[s]}`}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Actual Result / Notes
            </label>
            <textarea
              value={actualResult}
              onChange={(e) => setActualResult(e.target.value)}
              rows={4}
              placeholder="Describe what actually happened…"
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                Defect Key
              </label>
              <input
                type="text"
                value={defectKey}
                onChange={(e) => setDefectKey(e.target.value)}
                placeholder="e.g. PROJ-123"
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                Defect URL
              </label>
              <input
                type="url"
                value={defectUrl}
                onChange={(e) => setDefectUrl(e.target.value)}
                placeholder="https://…"
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white py-2 px-5 text-sm font-medium disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <Link
              href={`/projects/${projectId}/cycles/${cycleId}`}
              className="rounded-lg border border-zinc-300 dark:border-zinc-600 py-2 px-5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              Cancel
            </Link>
          </div>
        </form>
      </main>
    </div>
  );
}
