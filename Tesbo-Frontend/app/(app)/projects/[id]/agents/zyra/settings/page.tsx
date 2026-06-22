"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { authMe, getZyraAgent, updateZyraSettings, testZyraAiConnection, type ZyraAgentState, type ZyraCapabilities } from "@/lib/api";
import { Button, Card, StatusChip } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

type ConnectionResult = { ok: boolean; provider: string; model: string; error?: string; latencyMs: number } | null;

type TestcaseRange = "minimum" | "1-10" | "10-30" | "all";

const RANGE_OPTIONS: { value: TestcaseRange; label: string; description: string }[] = [
  { value: "minimum",  label: "Minimum possible", description: "1–3 critical path scenarios only" },
  { value: "1-10",     label: "1 – 10",            description: "Focused, high-quality coverage" },
  { value: "10-30",    label: "10 – 30",            description: "Broad coverage with edge cases" },
  { value: "all",      label: "All possible cases", description: "Exhaustive — every scenario Zyra can find" },
];

const DEFAULT_CAPABILITIES: ZyraCapabilities = { generation: true, knowledgeBase: true, testcaseStorage: true, suiteOperations: true };

const CAPABILITY_FIELDS: { key: keyof ZyraCapabilities; label: string; description: string }[] = [
  { key: "generation", label: "Test case generation", description: "Author and generate new test cases in chat and on the task board. Core feature." },
  { key: "knowledgeBase", label: "Knowledge base access", description: "Let Zyra read this project's knowledge base for richer, grounded answers." },
  { key: "testcaseStorage", label: "Test case storage operations", description: "Create, update, delete/archive, and bulk-edit test cases from chat." },
  { key: "suiteOperations", label: "Suite operations", description: "Create suites and move/assign existing test cases into suites." },
];

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${on ? "bg-[var(--foreground)]" : "bg-[var(--border)]"} ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-[var(--surface)] shadow transition-transform ${on ? "translate-x-[22px]" : "translate-x-0.5"}`} />
    </button>
  );
}

export default function ZyraSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const [state, setState] = useState<ZyraAgentState | null>(null);
  const [testcaseRange, setTestcaseRange] = useState<TestcaseRange>("1-10");
  const [capabilities, setCapabilities] = useState<ZyraCapabilities>(DEFAULT_CAPABILITIES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [connectionResult, setConnectionResult] = useState<ConnectionResult>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const data = await getZyraAgent(projectId);
      setState(data);
      setTestcaseRange((data.settings.testcaseRange as TestcaseRange) || "1-10");
      setCapabilities({ ...DEFAULT_CAPABILITIES, ...(data.settings.capabilities || {}) });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Zyra settings.");
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

  async function handleSaveSettings() {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      await updateZyraSettings(projectId, { testcaseRange, capabilities });
      setMessage("Zyra settings saved.");
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save Zyra settings.");
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    setTesting(true);
    setConnectionResult(null);
    try {
      const result = await testZyraAiConnection(projectId);
      setConnectionResult(result);
    } catch (err) {
      setConnectionResult({ ok: false, provider: "unknown", model: "unknown", error: err instanceof Error ? err.message : "Connection test failed.", latencyMs: 0 });
    } finally {
      setTesting(false);
    }
  }

  if (loading || !state) {
    return (
      <StandardPageLayout header={<PageHeader title="Zyra settings" />}>
        <div className="flex min-h-[220px] items-center justify-center text-sm text-[var(--muted)]">Loading Zyra settings...</div>
      </StandardPageLayout>
    );
  }

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Zyra settings"
          subtitle="Configure Zyra defaults and verify AI key connectivity for this project."
          actions={
            <Link
              href={`/projects/${projectId}/agents/zyra`}
              className="rounded-xl px-4 py-2 text-sm font-semibold"
              style={{ backgroundColor: "var(--foreground)", color: "var(--surface)" }}
            >
              Open Zyra chat
            </Link>
          }
        />
      }
    >
      {message && <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 text-sm">{message}</p>}
      {error && <p className="rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error)]">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        {/* AI key status */}
        <Card className="p-5 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-[var(--foreground)]">AI key status</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">{state.agent.activationReason}</p>
            </div>
            <StatusChip tone={state.agent.active ? "success" : "warning"}>
              {state.agent.active ? "Ready" : "Needs key"}
            </StatusChip>
          </div>

          {!state.agent.active && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
              <p className="font-semibold text-amber-700 dark:text-amber-400">AI provider not connected</p>
              <p className="mt-1 text-amber-700/80 dark:text-amber-400/80">
                Add an Anthropic or OpenAI key in workspace settings, then allocate it to this project.
              </p>
              <Link href="/settings/integrations" className="mt-3 inline-flex items-center gap-1 font-medium text-amber-700 underline underline-offset-2 hover:opacity-80 dark:text-amber-400">
                Go to workspace integrations →
              </Link>
            </div>
          )}

          {state.aiKey && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-4 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold text-[var(--foreground)]">{state.aiKey.name}</span>
                <span className="rounded-full bg-[var(--surface)] px-2 py-0.5 text-xs font-medium text-[var(--muted)] border border-[var(--border)]">
                  {state.aiKey.provider.toUpperCase()}
                </span>
              </div>
              {state.aiKey.defaultModel && (
                <div className="text-sm text-[var(--muted)]">{state.aiKey.defaultModel}</div>
              )}
              <div className="font-mono text-xs text-[var(--muted)]">{state.aiKey.maskedKey}</div>
            </div>
          )}

          {/* Test connection */}
          {state.agent.active && (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Button variant="secondary" disabled={testing} onClick={() => void handleTestConnection()}>
                  {testing ? "Testing..." : "Test connection"}
                </Button>
                <span className="text-xs text-[var(--muted)]">Sends a minimal request to verify the AI key works</span>
              </div>

              {connectionResult && (
                <div className={`rounded-lg border p-3 text-sm ${connectionResult.ok ? "border-green-500/30 bg-green-500/10" : "border-[var(--error)]/40 bg-[var(--error-soft)]"}`}>
                  {connectionResult.ok ? (
                    <div className="space-y-1">
                      <p className="font-semibold text-green-700 dark:text-green-400">Connection successful</p>
                      <p className="text-green-700/80 dark:text-green-400/80">
                        {connectionResult.provider.toUpperCase()} · {connectionResult.model} · {connectionResult.latencyMs}ms
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <p className="font-semibold text-[var(--error)]">Connection failed</p>
                      <p className="text-[var(--error)]/80">{connectionResult.error}</p>
                      <p className="text-xs text-[var(--muted)]">Check the API key value in workspace integrations.</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </Card>

        {/* Defaults + usage */}
        <div className="space-y-4">
          <Card className="p-4 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-[var(--foreground)]">Capabilities</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">Control what Zyra is allowed to do in this project. Disabled capabilities are refused in chat and on the task board.</p>
            </div>
            <div className="divide-y divide-[var(--border)]">
              {CAPABILITY_FIELDS.map((field) => (
                <div key={field.key} className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[var(--foreground)]">{field.label}</div>
                    <div className="mt-0.5 text-xs text-[var(--muted)]">{field.description}</div>
                  </div>
                  <Toggle on={capabilities[field.key]} onChange={(value) => setCapabilities((prev) => ({ ...prev, [field.key]: value }))} />
                </div>
              ))}
            </div>

            <div className="border-t border-[var(--border)] pt-4 space-y-3">
              <div>
                <div className="text-sm font-medium text-[var(--foreground)]">Test cases per task</div>
                <div className="mt-0.5 text-xs text-[var(--muted)]">How many test cases Zyra should aim to generate for each task.</div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {RANGE_OPTIONS.map((option) => {
                  const active = testcaseRange === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setTestcaseRange(option.value)}
                      className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                        active
                          ? "border-[var(--brand-primary)] bg-[var(--surface-secondary)]"
                          : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--brand-primary)]/50 hover:bg-[var(--surface-secondary)]"
                      }`}
                    >
                      <div className={`flex items-center gap-2`}>
                        <span className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border-2 flex items-center justify-center ${active ? "border-[var(--brand-primary)]" : "border-[var(--border-strong)]"}`}>
                          {active && <span className="h-1.5 w-1.5 rounded-full bg-[var(--brand-primary)]" />}
                        </span>
                        <span className={`text-sm font-medium ${active ? "text-[var(--foreground)]" : "text-[var(--muted)]"}`}>
                          {option.label}
                        </span>
                      </div>
                      <p className="mt-1 pl-5 text-[11px] text-[var(--muted-soft)]">{option.description}</p>
                    </button>
                  );
                })}
              </div>
            </div>
            <Button onClick={handleSaveSettings} disabled={saving}>{saving ? "Saving..." : "Save settings"}</Button>
          </Card>

          <Card className="p-4 space-y-2">
            <h2 className="text-sm font-semibold text-[var(--foreground)]">Token usage</h2>
            <div className="rounded-lg bg-[var(--surface-secondary)] p-3">
              <div className="text-2xl font-bold text-[var(--foreground)]">{new Intl.NumberFormat().format(state.tokenUsage.total || 0)}</div>
              <div className="mt-0.5 text-xs text-[var(--muted)]">tokens used by Zyra in this project</div>
            </div>
          </Card>
        </div>
      </div>
    </StandardPageLayout>
  );
}
