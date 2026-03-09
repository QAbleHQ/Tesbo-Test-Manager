"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { getAgentSettings, saveAgentSettings } from "@/lib/api";

function EyeIcon({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
      <circle cx="12" cy="12" r="3" strokeWidth={1.5} />
    </svg>
  );
}

export default function SentinelSettingsPage() {
  const params = useParams();
  const projectId = params.id as string;
  const [reviewBotEnabled, setReviewBotEnabled] = useState(true);
  const [autoReviewOnScriptReady, setAutoReviewOnScriptReady] = useState(false);
  const [reviewInstruction, setReviewInstruction] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const s = getAgentSettings(projectId, "sentinel");
    setReviewBotEnabled(s.reviewBotEnabled !== false);
    setAutoReviewOnScriptReady(Boolean(s.autoReviewOnScriptReady));
    setReviewInstruction(typeof s.reviewInstruction === "string" ? s.reviewInstruction : "");
  }, [projectId]);

  const onSave = () => {
    saveAgentSettings(projectId, "sentinel", {
      reviewBotEnabled,
      autoReviewOnScriptReady,
      reviewInstruction,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="flex-1 p-6 md:p-10 max-w-3xl mx-auto w-full">
      <Link href={`/projects/${projectId}/agents/sentinel`} className="text-sm text-[var(--muted)] hover:text-[var(--primary)] mb-4 inline-flex items-center gap-1">
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to Sentinel
      </Link>

      <div className="flex items-center gap-3 mb-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#e8f5eb] dark:bg-zinc-800 text-[var(--primary)]">
          <EyeIcon />
        </div>
        <div>
          <h1 className="text-xl font-bold text-[var(--foreground)]">Sentinel Settings</h1>
          <p className="text-sm text-[var(--muted)]">Control when and how the Review Bot runs.</p>
        </div>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 space-y-5">
        <label className="flex items-start gap-3 rounded-lg border border-[var(--border)] p-4">
          <input type="checkbox" className="mt-1" checked={reviewBotEnabled} onChange={(e) => setReviewBotEnabled(e.target.checked)} />
          <div>
            <p className="text-sm font-medium text-[var(--foreground)]">Enable Review Bot</p>
            <p className="text-xs text-[var(--muted)] mt-1">When disabled, Sentinel will not process review tasks.</p>
          </div>
        </label>

        <label className="flex items-start gap-3 rounded-lg border border-[var(--border)] p-4">
          <input
            type="checkbox"
            className="mt-1"
            checked={autoReviewOnScriptReady}
            onChange={(e) => setAutoReviewOnScriptReady(e.target.checked)}
          />
          <div>
            <p className="text-sm font-medium text-[var(--foreground)]">Auto-run review on new scripts</p>
            <p className="text-xs text-[var(--muted)] mt-1">Automatically queue and run review whenever Aegis produces pending-review scripts.</p>
          </div>
        </label>

        <div>
          <label className="text-sm font-medium text-[var(--foreground)] block mb-1.5">Custom Review Instruction</label>
          <textarea
            rows={5}
            value={reviewInstruction}
            onChange={(e) => setReviewInstruction(e.target.value)}
            placeholder="Example: Prioritize security assertions, verify role-based access checks, and ensure error-state assertions are present."
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/40 resize-none"
          />
        </div>

        <div className="flex items-center gap-3">
          <button onClick={onSave} className="rounded-lg bg-[var(--primary)] px-5 py-2 text-sm font-medium text-white hover:opacity-90">
            Save Settings
          </button>
          {saved && <span className="text-sm text-green-600 dark:text-green-400">Settings saved</span>}
        </div>
      </div>
    </div>
  );
}

