"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  authMe,
  getProject,
  getAgentSettings,
  saveAgentSettings,
  type TestEnvironmentSetting,
} from "@/lib/api";

function ShieldIcon({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 2L3 7v6c0 5.25 3.75 10 9 11 5.25-1 9-5.75 9-11V7l-9-5z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4" />
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

export default function AegisSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [environments, setEnvironments] = useState<TestEnvironmentSetting[]>([]);
  const [selectedUrl, setSelectedUrl] = useState("");
  const [selectedName, setSelectedName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [autoStartOnReady, setAutoStartOnReady] = useState(true);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) { router.replace("/login"); return; }
      getProject(projectId).then((p) => {
        const parsed = parseProjectSettings(typeof p.settings === "string" ? p.settings : "");
        const envs = normalizeTestRunEnvironments(parsed.testRunEnvironments);
        setEnvironments(envs);

        const current = getAgentSettings(projectId, "aegis");
        setAutoStartOnReady(current.autoStartOnReady !== false);
        if (current.defaultEnvironmentUrl) {
          setSelectedUrl(current.defaultEnvironmentUrl);
          setSelectedName(current.defaultEnvironmentName || "");
        } else if (envs.length > 0) {
          setSelectedUrl(envs[0].url);
          setSelectedName(envs[0].name);
        }
        setLoading(false);
      }).catch(() => setLoading(false));
    });
  }, [projectId, router]);

  const handleSave = () => {
    saveAgentSettings(projectId, "aegis", {
      defaultEnvironmentUrl: selectedUrl,
      defaultEnvironmentName: selectedName,
      autoStartOnReady,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center p-10">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex-1 p-6 md:p-10 max-w-3xl mx-auto w-full">
      <Link
        href={`/projects/${projectId}/agents/aegis`}
        className="text-sm text-[var(--muted)] hover:text-[var(--primary)] mb-4 inline-flex items-center gap-1"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to Aegis
      </Link>

      <div className="flex items-center gap-3 mb-8">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#e8f5eb] dark:bg-zinc-800 text-[var(--primary)]">
          <ShieldIcon className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-[var(--foreground)]">Aegis Settings</h1>
          <p className="text-sm text-[var(--muted)]">Configure default behavior for the Aegis agent</p>
        </div>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <h2 className="text-base font-semibold text-[var(--foreground)] mb-1">Default Environment</h2>
        <p className="text-sm text-[var(--muted)] mb-5">
          Aegis will automatically use this environment when launching runs. Environments are configured in{" "}
          <Link href={`/projects/${projectId}/settings`} className="text-[var(--primary)] hover:underline">
            Project Settings
          </Link>.
        </p>

        {environments.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--border)] p-6 text-center">
            <p className="text-sm text-[var(--muted)] mb-2">No environments configured yet.</p>
            <Link
              href={`/projects/${projectId}/settings`}
              className="text-sm font-medium text-[var(--primary)] hover:underline"
            >
              Configure environments in Project Settings
            </Link>
          </div>
        ) : (
          <div className="space-y-2 mb-6">
            {environments.map((env) => (
              <label
                key={env.url}
                className={`flex items-center gap-3 rounded-lg border p-4 cursor-pointer transition-colors ${
                  selectedUrl === env.url
                    ? "border-[var(--primary)] bg-[#e8f5eb]/50 dark:bg-zinc-800"
                    : "border-[var(--border)] hover:border-[var(--primary)]/50"
                }`}
              >
                <input
                  type="radio"
                  name="default-env"
                  value={env.url}
                  checked={selectedUrl === env.url}
                  onChange={() => { setSelectedUrl(env.url); setSelectedName(env.name); }}
                  className="text-[var(--primary)] focus:ring-[var(--primary)]"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-[var(--foreground)]">{env.name}</div>
                  <div className="text-xs text-[var(--muted)] truncate">{env.url}</div>
                </div>
                {selectedUrl === env.url && (
                  <span className="shrink-0 inline-flex items-center rounded-full bg-[var(--primary)]/10 px-2.5 py-0.5 text-xs font-medium text-[var(--primary)]">
                    Default
                  </span>
                )}
              </label>
            ))}
          </div>
        )}

        <div className="flex items-center gap-3 pt-4 border-t border-[var(--border)]">
          <button
            onClick={handleSave}
            disabled={!selectedUrl}
            className="rounded-lg bg-[var(--primary)] px-5 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            Save Settings
          </button>
          {saved && (
            <span className="text-sm text-green-600 dark:text-green-400 flex items-center gap-1">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Settings saved
            </span>
          )}
        </div>
      </div>

      <div className="mt-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <h2 className="text-base font-semibold text-[var(--foreground)] mb-1">Auto-Start Behavior</h2>
        <p className="text-sm text-[var(--muted)] mb-5">
          Control whether Aegis automatically starts when test cases are marked as &quot;Ready for Automation&quot;.
        </p>

        <label className="flex items-start gap-3 rounded-lg border border-[var(--border)] p-4 cursor-pointer hover:border-[var(--primary)]/50 transition-colors">
          <div className="pt-0.5">
            <input
              type="checkbox"
              checked={autoStartOnReady}
              onChange={(e) => setAutoStartOnReady(e.target.checked)}
              className="rounded border-zinc-300 dark:border-zinc-600 text-[var(--primary)] focus:ring-[var(--primary)]"
            />
          </div>
          <div className="flex-1">
            <div className="text-sm font-medium text-[var(--foreground)]">Auto-start on &quot;Ready for Automation&quot;</div>
            <div className="text-xs text-[var(--muted)] mt-0.5">
              When a test case&apos;s automation status is set to &quot;Ready for Automation&quot;, Aegis will automatically
              start working on it in the background. The generated script will appear in the review queue when ready.
            </div>
          </div>
          {autoStartOnReady && (
            <span className="shrink-0 inline-flex items-center rounded-full bg-[var(--primary)]/10 px-2.5 py-0.5 text-xs font-medium text-[var(--primary)]">
              Default
            </span>
          )}
        </label>

        <div className="flex items-center gap-3 pt-4 mt-4 border-t border-[var(--border)]">
          <button
            onClick={handleSave}
            className="rounded-lg bg-[var(--primary)] px-5 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
          >
            Save Settings
          </button>
          {saved && (
            <span className="text-sm text-green-600 dark:text-green-400 flex items-center gap-1">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Settings saved
            </span>
          )}
        </div>
      </div>

      <div className="mt-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <h2 className="text-base font-semibold text-[var(--foreground)] mb-1">About Aegis</h2>
        <p className="text-sm text-[var(--muted)] leading-relaxed">
          Aegis is a Test Automation Architect agent. It autonomously navigates your application,
          executes test scenarios, and generates clean Playwright scripts. Completed scripts are
          sent to the review queue for your approval before being saved to the respective test case.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-4">
          <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/50 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)] mb-1">Agent Type</div>
            <div className="text-sm font-medium text-[var(--foreground)]">Test Automation Architect</div>
          </div>
          <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/50 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)] mb-1">Output</div>
            <div className="text-sm font-medium text-[var(--foreground)]">Playwright Scripts</div>
          </div>
          <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/50 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)] mb-1">Review</div>
            <div className="text-sm font-medium text-[var(--foreground)]">User Approval Required</div>
          </div>
          <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/50 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)] mb-1">Feedback</div>
            <div className="text-sm font-medium text-[var(--foreground)]">Iterative Refinement</div>
          </div>
        </div>
      </div>
    </div>
  );
}
