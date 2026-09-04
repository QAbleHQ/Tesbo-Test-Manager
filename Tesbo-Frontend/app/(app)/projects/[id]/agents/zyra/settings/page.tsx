"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconDeviceFloppy,
  IconKey,
  IconLoader2,
  IconMessage2Bolt,
  IconPlug,
  IconSparkles,
} from "@tabler/icons-react";
import { authMe, getProject, getZyraAgent, updateZyraSettings, testZyraAiConnection, type ZyraAgentState, type ZyraCapabilities } from "@/lib/api";
import { Button, Card, PageLoader, StatusChip } from "@/components/ui";
import { PageHeader, StandardPageLayout, Breadcrumbs } from "@/components/workflows";

type ConnectionResult = { ok: boolean; provider: string; model: string; error?: string; latencyMs: number } | null;

type TestcaseRange = "minimum" | "1-10" | "10-30" | "all";

const RANGE_OPTIONS: { value: TestcaseRange; num: string; label: string; description: string }[] = [
  { value: "minimum", num: "1–3",   label: "Minimum",    description: "Critical path scenarios only" },
  { value: "1-10",    num: "1–10",  label: "Focused",    description: "High-quality coverage" },
  { value: "10-30",   num: "10–30", label: "Broad",      description: "Coverage with edge cases" },
  { value: "all",     num: "All",   label: "Exhaustive", description: "Every scenario Zyra can find" },
];

const DEFAULT_TESTCASE_RANGE: TestcaseRange = "1-10";
const DEFAULT_CAPABILITIES: ZyraCapabilities = { generation: true, knowledgeBase: true, testcaseStorage: true, suiteOperations: true };

const CAPABILITY_FIELDS: { key: keyof ZyraCapabilities; label: string; description: string }[] = [
  { key: "generation", label: "Test case generation", description: "Author and generate new test cases in chat and on the task board. Core feature." },
  { key: "knowledgeBase", label: "Knowledge base access", description: "Let Zyra read this project's knowledge base for richer, grounded answers." },
  { key: "testcaseStorage", label: "Test case storage operations", description: "Create, update, delete/archive, and bulk-edit test cases from chat." },
  { key: "suiteOperations", label: "Suite operations", description: "Create suites and move/assign existing test cases into suites." },
];

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

// ─── Zyra icon badge — gradient sparkle mark, matches agents/zyra chat page ────
function ZyraMark({ size = 24 }: { size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-[7px]"
      style={{ width: size, height: size, background: "linear-gradient(135deg, #7C5FCC 0%, #4F46E5 100%)" }}
    >
      <IconSparkles size={Math.round(size * 0.58)} stroke={1.9} className="text-white" />
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="mb-2 pl-0.5 text-[10px] font-bold uppercase tracking-[0.09em] text-[var(--muted)]">{children}</div>;
}

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${on ? "bg-[var(--brand-primary)]" : "bg-[var(--border)]"} ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? "translate-x-[22px]" : "translate-x-0.5"}`} />
    </button>
  );
}

export default function ZyraSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const [state, setState] = useState<ZyraAgentState | null>(null);
  const [testcaseRange, setTestcaseRange] = useState<TestcaseRange>(DEFAULT_TESTCASE_RANGE);
  const [capabilities, setCapabilities] = useState<ZyraCapabilities>(DEFAULT_CAPABILITIES);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [connectionResult, setConnectionResult] = useState<ConnectionResult>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");

  const loadData = useCallback(async () => {
    try {
      const data = await getZyraAgent(projectId);
      setState(data);
      setTestcaseRange((data.settings.testcaseRange as TestcaseRange) || DEFAULT_TESTCASE_RANGE);
      setCapabilities({ ...DEFAULT_CAPABILITIES, ...(data.settings.capabilities || {}) });
      setDirty(false);
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
    getProject(projectId).then((p) => setProjectName(String(p.name || ""))).catch(() => setProjectName(""));
  }, [loadData, router, projectId]);

  function updateCapability(key: keyof ZyraCapabilities, value: boolean) {
    setCapabilities((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  function selectTestcaseRange(value: TestcaseRange) {
    setTestcaseRange(value);
    setDirty(true);
  }

  function handleResetDefaults() {
    setCapabilities(DEFAULT_CAPABILITIES);
    setTestcaseRange(DEFAULT_TESTCASE_RANGE);
    setDirty(true);
  }

  async function handleSaveSettings() {
    setSaving(true);
    setSaveError(null);
    try {
      await updateZyraSettings(projectId, { testcaseRange, capabilities });
      await loadData();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save Zyra settings.");
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

  const header = (
    <PageHeader
      title={<><ZyraMark size={28} />Zyra settings</>}
      subtitle="Configure Zyra defaults and verify AI key connectivity for this project."
      breadcrumb={
        <Breadcrumbs
          items={[
            { label: "Projects", href: "/projects" },
            { label: projectName || "Project", href: `/projects/${projectId}/dashboard` },
            { label: "Agents", href: `/projects/${projectId}/agents` },
            { label: "Zyra settings" },
          ]}
        />
      }
      actions={
        <Link
          href={`/projects/${projectId}/agents/zyra`}
          className="inline-flex h-9 items-center gap-1.5 rounded-[6px] border border-[var(--border)] px-4 text-[13px] font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
        >
          <IconMessage2Bolt size={15} stroke={1.9} />
          Open Zyra chat
        </Link>
      }
    />
  );

  if (loading || !state) {
    return (
      <StandardPageLayout header={header}>
        {error ? (
          <div className="flex min-h-[220px] items-center justify-center text-sm text-[var(--muted)]">{error}</div>
        ) : (
          <PageLoader label="Loading Zyra settings…" />
        )}
      </StandardPageLayout>
    );
  }

  const taskTokenTotal = state.tasks.reduce((sum, task) => sum + (task.tokenUsage?.total || 0), 0);
  const avgPerTask = state.tasks.length > 0 ? Math.round(taskTokenTotal / state.tasks.length) : 0;
  const fmt = (value: number) => new Intl.NumberFormat().format(value);

  return (
    <StandardPageLayout header={header}>
      <div className="max-w-3xl space-y-8">

        {/* ── AI Connection ── */}
        <section>
          <SectionLabel>AI Connection</SectionLabel>
          <Card className="overflow-hidden !p-0">
            {!state.agent.active ? (
              <div className="p-5">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border border-[var(--border)] bg-[var(--surface-secondary)]">
                      <IconKey size={16} stroke={1.8} className="text-[var(--muted)]" />
                    </div>
                    <div>
                      <div className="text-[13px] font-semibold text-[var(--foreground)]">No AI key connected</div>
                      <div className="text-xs text-[var(--muted)]">{state.agent.activationReason}</div>
                    </div>
                  </div>
                  <StatusChip tone="warning" dot>Needs key</StatusChip>
                </div>
                <div className="mt-4 rounded-[6px] border border-[var(--warning-border)] bg-[var(--warning-soft)] p-4 text-sm">
                  <p className="flex items-center gap-1.5 font-semibold text-[var(--warning-foreground)]">
                    <IconAlertTriangle size={15} stroke={1.9} />
                    AI provider not connected
                  </p>
                  <p className="mt-1 text-[var(--warning-foreground)] opacity-80">
                    Add an Anthropic or OpenAI key in workspace settings, then allocate it to this project.
                  </p>
                  <Link href="/settings?tab=ai" className="mt-3 inline-flex items-center gap-1 font-medium text-[var(--warning-foreground)] underline underline-offset-2 hover:opacity-80">
                    Go to workspace AI providers →
                  </Link>
                </div>
              </div>
            ) : (
              <>
                <div className="border-b border-[var(--border)] p-5">
                  <div className="mb-3.5 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border border-[var(--border)] bg-[var(--surface-secondary)]">
                        <IconKey size={16} stroke={1.8} className="text-[var(--muted)]" />
                      </div>
                      <div>
                        <div className="text-[13px] font-semibold text-[var(--foreground)]">{state.aiKey?.name}</div>
                        <div className="text-xs text-[var(--muted)]">Workspace AI key · {capitalize(state.aiKey?.provider || "")}</div>
                      </div>
                    </div>
                    <StatusChip tone="success" dot>Ready</StatusChip>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-3.5 py-2.5">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">Model</div>
                      <div className="mt-1 truncate font-mono text-[13px] font-medium text-[var(--foreground)]">{state.aiKey?.defaultModel || "—"}</div>
                    </div>
                    <div className="rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-3.5 py-2.5">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">API Key</div>
                      <div className="mt-1 truncate font-mono text-[13px] font-medium tracking-widest text-[var(--foreground)]">{state.aiKey?.maskedKey}</div>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-4 p-5">
                  <div>
                    <div className="text-[13px] font-medium text-[var(--foreground)]">Test connection</div>
                    <div className="text-xs text-[var(--muted)]">Send a minimal request to verify the AI key works</div>
                  </div>
                  <Button variant="secondary" disabled={testing} onClick={() => void handleTestConnection()}>
                    {testing ? <IconLoader2 size={14} stroke={1.9} className="animate-spin" /> : <IconPlug size={14} stroke={1.9} />}
                    {testing ? "Testing…" : "Test connection"}
                  </Button>
                </div>

                {connectionResult && (
                  <div
                    className={`mx-5 mb-5 flex items-start gap-2 rounded-[6px] border p-3 text-[12px] ${
                      connectionResult.ok
                        ? "border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success-foreground)]"
                        : "border-[var(--error-border)] bg-[var(--error-soft)] text-[var(--error-foreground)]"
                    }`}
                  >
                    {connectionResult.ok ? (
                      <IconCircleCheck size={15} stroke={1.9} className="mt-0.5 shrink-0" />
                    ) : (
                      <IconAlertTriangle size={15} stroke={1.9} className="mt-0.5 shrink-0" />
                    )}
                    <div>
                      {connectionResult.ok ? (
                        <>
                          <p className="font-semibold">Connection successful</p>
                          <p className="mt-0.5 opacity-80">
                            {capitalize(connectionResult.provider)} · {connectionResult.model} · {connectionResult.latencyMs}ms
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="font-semibold">Connection failed</p>
                          <p className="mt-0.5 opacity-80">{connectionResult.error}</p>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </Card>
        </section>

        {/* ── Capabilities ── */}
        <section>
          <SectionLabel>Capabilities</SectionLabel>
          <p className="mb-3 text-xs text-[var(--muted)]">
            Control what Zyra is allowed to do. Disabled capabilities are refused in chat and on the task board.
          </p>
          <Card className="overflow-hidden !p-0">
            {CAPABILITY_FIELDS.map((field, i) => (
              <div
                key={field.key}
                className={`flex items-center justify-between gap-6 p-5 ${i !== CAPABILITY_FIELDS.length - 1 ? "border-b border-[var(--border)]" : ""}`}
              >
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-[var(--foreground)]">{field.label}</div>
                  <div className="mt-0.5 text-xs text-[var(--muted)]">{field.description}</div>
                </div>
                <Toggle on={capabilities[field.key]} onChange={(value) => updateCapability(field.key, value)} />
              </div>
            ))}
          </Card>
        </section>

        {/* ── Generation behaviour ── */}
        <section>
          <SectionLabel>Generation behaviour</SectionLabel>
          <Card className="space-y-4 p-5">
            <div>
              <div className="text-[13px] font-semibold text-[var(--foreground)]">Test cases per task</div>
              <div className="mt-0.5 text-xs text-[var(--muted)]">How many test cases Zyra should aim to generate for each task.</div>
            </div>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {RANGE_OPTIONS.map((option) => {
                const active = testcaseRange === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    // Which of the four is chosen was conveyed by border and background colour
                    // alone, so nothing but a sighted user could tell — and a colour-only state is
                    // the same defect class the theme pass fixed elsewhere.
                    aria-pressed={active}
                    onClick={() => selectTestcaseRange(option.value)}
                    className={`rounded-[8px] border p-3.5 text-left transition-colors ${
                      active
                        ? "border-[var(--brand-primary)] bg-[var(--brand-soft)]"
                        : "border-[var(--border)] bg-[var(--surface-secondary)] hover:border-[var(--brand-border)]"
                    }`}
                  >
                    <div className={`font-mono text-[15px] font-semibold ${active ? "text-[var(--accent-light)]" : "text-[var(--foreground)]"}`}>
                      {option.num}
                    </div>
                    <div className="mt-0.5 text-xs font-semibold text-[var(--muted)]">{option.label}</div>
                    <p className="mt-0.5 text-[11px] leading-snug text-[var(--muted-soft)]">{option.description}</p>
                  </button>
                );
              })}
            </div>
          </Card>
        </section>

        {/* ── Token usage ── */}
        <section>
          <SectionLabel>Token usage</SectionLabel>
          <Card className="p-5">
            <div className={`grid gap-3 ${state.tasks.length > 0 ? "sm:grid-cols-2" : ""}`}>
              <div className="rounded-[8px] border border-[var(--border)] bg-[var(--background)] px-4 py-3.5">
                <div className="text-[10px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">Used this project</div>
                <div className="mt-1.5 font-mono text-[22px] font-semibold text-[var(--foreground)]">{fmt(state.tokenUsage.total || 0)}</div>
                <div className="mt-0.5 text-[11px] text-[var(--muted)]">tokens consumed</div>
              </div>
              {state.tasks.length > 0 && (
                <div className="rounded-[8px] border border-[var(--border)] bg-[var(--background)] px-4 py-3.5">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">Avg per task</div>
                  <div className="mt-1.5 font-mono text-[22px] font-semibold text-[var(--foreground)]">{fmt(avgPerTask)}</div>
                  <div className="mt-0.5 text-[11px] text-[var(--muted)]">across {state.tasks.length} recent task{state.tasks.length === 1 ? "" : "s"}</div>
                </div>
              )}
            </div>
          </Card>
        </section>

        {/* ── Save / actions bar ── */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4">
          <span className="text-xs text-[var(--muted)]">
            {saveError ? <span className="text-[var(--error-foreground)]">{saveError}</span> : dirty ? "You have unsaved changes." : "All changes saved."}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={handleResetDefaults} disabled={saving}>Reset to defaults</Button>
            <Button onClick={() => void handleSaveSettings()} disabled={saving}>
              <IconDeviceFloppy size={14} stroke={1.9} />
              {saving ? "Saving…" : "Save settings"}
            </Button>
          </div>
        </div>

      </div>
    </StandardPageLayout>
  );
}
