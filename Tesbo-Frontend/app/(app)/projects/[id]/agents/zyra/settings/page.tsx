"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { authMe, getZyraAgent, updateZyraSettings, type ZyraAgentState } from "@/lib/api";
import { Button, Card, Field, FieldLabel, Input, StatusChip } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value || 0);
}

export default function ZyraSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const [state, setState] = useState<ZyraAgentState | null>(null);
  const [testcaseCount, setTestcaseCount] = useState(5);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const data = await getZyraAgent(projectId);
      setState(data);
      setTestcaseCount(data.settings.testcaseCount || 5);
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
      await updateZyraSettings(projectId, { testcaseCount });
      setMessage("Zyra settings saved.");
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save Zyra settings.");
    } finally {
      setSaving(false);
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
          subtitle="Configure Zyra defaults and AI key readiness for this project."
          actions={
            <Link
              href={`/projects/${projectId}/agents/tasks`}
              className="rounded-xl px-4 py-2 text-sm font-semibold"
              style={{ backgroundColor: "var(--foreground)", color: "var(--surface)" }}
            >
              Open Zyra board
            </Link>
          }
        />
      }
    >
      {message && <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 text-sm">{message}</p>}
      {error && <p className="rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error)]">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <Card className="p-4 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-[var(--foreground)]">Zyra setup</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">{state.agent.activationReason}</p>
            </div>
            <StatusChip tone={state.agent.active ? "success" : "warning"}>{state.agent.active ? "Ready" : "Needs key"}</StatusChip>
          </div>

          {!state.agent.active && (
            <Link href="/settings/integrations" className="inline-flex text-sm font-medium text-[var(--brand-primary)] hover:underline">
              Add and allocate an AI key
            </Link>
          )}

          {state.aiKey && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3 text-sm">
              <div className="font-semibold text-[var(--foreground)]">{state.aiKey.name}</div>
              <div className="mt-1 text-[var(--muted)]">{state.aiKey.provider.toUpperCase()} {state.aiKey.defaultModel ? `- ${state.aiKey.defaultModel}` : ""}</div>
              <div className="mt-1 font-mono text-xs text-[var(--muted)]">{state.aiKey.maskedKey}</div>
            </div>
          )}
        </Card>

        <Card className="p-4 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--foreground)]">Zyra defaults</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">Used when a user allocates a new task.</p>
          </div>
          <Field>
            <FieldLabel>Testcases per task</FieldLabel>
            <Input type="number" min={1} max={50} value={testcaseCount} onChange={(event) => setTestcaseCount(Number(event.target.value))} />
          </Field>
          <Button onClick={handleSaveSettings} disabled={saving}>{saving ? "Saving..." : "Save settings"}</Button>
          <div className="rounded-lg bg-[var(--surface-secondary)] p-3 text-sm text-[var(--muted)]">
            <span className="font-semibold text-[var(--foreground)]">{formatNumber(state.tokenUsage.total)}</span> tokens used by Zyra
          </div>
        </Card>
      </div>
    </StandardPageLayout>
  );
}
