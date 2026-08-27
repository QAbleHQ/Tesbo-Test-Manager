"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  authMe,
  getWorkspace,
  getIntegrationConfig,
  isSyncRunActive,
  type IntegrationProvider,
} from "@/lib/api";
import { Button, Card } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";
import { SyncStatusPanel, useSyncRun } from "@/components/integrations/SyncStatusPanel";
import { useIntegrationOAuthConnect } from "@/lib/useIntegrationOAuthConnect";

interface RemoteItem {
  id: string;
  key: string;
  name: string;
  connected: boolean;
}

interface ConnectionStatus {
  connected: boolean;
  siteUrl?: string;
  connectedProjects?: { id: string }[];
}

export function ProjectIntegrationMapping({
  provider,
  label,
  remoteUnitLabel,
  workspaceConfigHref,
  fetchStatus,
  fetchRemoteList,
  saveMapping,
  settingsPanel,
}: {
  provider: IntegrationProvider;
  label: string;
  remoteUnitLabel: string;
  workspaceConfigHref: string;
  fetchStatus: (projectId: string) => Promise<ConnectionStatus>;
  fetchRemoteList: (projectId: string) => Promise<RemoteItem[]>;
  saveMapping: (projectId: string, items: { id: string; key: string; name: string }[]) => Promise<void>;
  /**
   * Settings that only make sense for this provider — Jira's AI-generation toggles, say. Rendered
   * below the mapping and sync cards, so each integration owns its settings on its own page instead
   * of adding a tab to the project settings rail.
   */
  settingsPanel?: React.ReactNode;
}) {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [loading, setLoading] = useState(true);
  const [canManage, setCanManage] = useState(false);
  const [oauthConfigured, setOauthConfigured] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [remoteItems, setRemoteItems] = useState<RemoteItem[]>([]);
  // Exactly one remote project/team per Tesbo project, so this is a single id rather than a Set.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [itemsLoading, setItemsLoading] = useState(false);
  const { run, starting, error: syncError, start: startSync } = useSyncRun(projectId, provider, !!status?.connected);

  const loadData = useCallback(async () => {
    try {
      const me = await authMe();
      if (!me) {
        router.replace("/login");
        return;
      }
      const [workspace, statusRes] = await Promise.all([getWorkspace(), fetchStatus(projectId)]);
      setCanManage((workspace.role || "member").toLowerCase() === "owner");
      setStatus(statusRes);

      if (statusRes.connected) {
        setItemsLoading(true);
        const items = await fetchRemoteList(projectId);
        setRemoteItems(items);
        setSelectedId(items.find((item) => item.connected)?.id ?? null);
        setItemsLoading(false);
      } else {
        const config = await getIntegrationConfig(provider).catch(() => null);
        setOauthConfigured(!!config?.configured);
      }
    } catch {
      setMessage({ type: "error", text: `Failed to load ${label} integration data.` });
    } finally {
      setLoading(false);
    }
  }, [projectId, router, fetchStatus, fetchRemoteList, label, provider]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleConnected = useCallback(() => {
    setMessage({ type: "success", text: `${label} connected.` });
    void loadData();
  }, [label, loadData]);

  const { connect, phase: connectPhase, error: connectError } = useIntegrationOAuthConnect(provider, handleConnected);
  const connecting = connectPhase === "opening" || connectPhase === "waiting";
  const connectHint =
    connectPhase === "blocked"
      ? "Your browser blocked the popup — allow popups for this site and try again."
      : connectPhase === "timeout"
        ? "This took too long and the request may have expired. Try again."
        : connectError;

  async function handleSaveMapping() {
    setSaving(true);
    setMessage(null);
    try {
      const item = remoteItems.find((candidate) => candidate.id === selectedId);
      await saveMapping(projectId, item ? [{ id: item.id, key: item.key, name: item.name }] : []);
      setMessage({
        type: "success",
        text: item ? `${item.name} linked to this project.` : `${remoteUnitLabel} unlinked from this project.`,
      });
      setStatus(await fetchStatus(projectId));
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : `Failed to save ${remoteUnitLabel} mapping.` });
    } finally {
      setSaving(false);
    }
  }

  async function handleSync() {
    setMessage(null);
    const result = await startSync();
    if (result?.alreadyRunning) {
      setMessage({ type: "success", text: `A ${label} sync is already running — showing its progress below.` });
    }
  }

  const breadcrumb = (
    <Link href={`/projects/${projectId}/settings?tab=integrations`} className="text-[var(--accent-light)] hover:underline">
      &larr; Back to Project Settings
    </Link>
  );

  if (loading) {
    return (
      <StandardPageLayout header={<PageHeader title={`${label} Integration`} />}>
        <div className="flex min-h-[200px] items-center justify-center">
          <p className="text-[var(--muted)]">Loading…</p>
        </div>
      </StandardPageLayout>
    );
  }

  if (!status?.connected) {
    return (
      <StandardPageLayout header={<PageHeader title={`${label} Integration`} breadcrumb={breadcrumb} />}>
        {message && (
          <div className="rounded-lg border border-[var(--error)]/30 bg-[color-mix(in_oklab,var(--error)_8%,white)] px-3 py-2 text-sm text-[var(--error-foreground)]">
            {message.text}
          </div>
        )}
        <Card className="p-4">
          <h2 className="text-base font-semibold text-[var(--foreground)]">{label} is not connected for this workspace</h2>
          {canManage ? (
            oauthConfigured ? (
              <>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  Connect {label} for this workspace, then pick which {remoteUnitLabel.toLowerCase()} feeds this project — right here, in one flow.
                </p>
                <Button type="button" onClick={connect} disabled={connecting} className="mt-4">
                  {connectPhase === "opening"
                    ? "Redirecting…"
                    : connectPhase === "waiting"
                      ? "Waiting for you to finish in the new tab…"
                      : `Connect ${label}`}
                </Button>
                {connectHint && <p className="mt-2 text-xs text-[var(--error-foreground)]">{connectHint}</p>}
              </>
            ) : (
              <>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  Set up {label} in Workspace Settings, then you&apos;ll land right back here to pick which {remoteUnitLabel.toLowerCase()} feeds this project.
                </p>
                <Link
                  href={`${workspaceConfigHref}?returnProjectId=${projectId}`}
                  className="mt-4 inline-flex h-9 items-center justify-center rounded-[10px] border border-transparent bg-[var(--brand-primary)] px-3.5 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-[var(--brand-hover)]"
                >
                  Go to Workspace Settings → Integrations
                </Link>
              </>
            )
          ) : (
            <p className="mt-1 text-sm text-[var(--muted)]">
              Ask a workspace owner to connect {label} once for the whole workspace, then come back here to pick which {remoteUnitLabel.toLowerCase()} feeds this project.
            </p>
          )}
        </Card>
      </StandardPageLayout>
    );
  }

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title={`${label} Integration`}
          subtitle={
            status.siteUrl ? (
              <>
                Connected to{" "}
                <a href={status.siteUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--accent-light)] hover:underline">
                  {status.siteUrl}
                </a>
              </>
            ) : undefined
          }
          breadcrumb={breadcrumb}
        />
      }
    >
      {message && (
        <div
          className={`rounded-lg border px-3 py-2 text-sm ${
            message.type === "success"
              ? "border-[var(--success)]/30 bg-[color-mix(in_oklab,var(--success)_8%,white)] text-[var(--success-foreground)]"
              : "border-[var(--error)]/30 bg-[color-mix(in_oklab,var(--error)_8%,white)] text-[var(--error-foreground)]"
          }`}
        >
          {message.text}
        </div>
      )}

      <Card className="p-4">
        <h2 className="text-base font-semibold text-[var(--foreground)]">Select a {remoteUnitLabel}</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          One {remoteUnitLabel.toLowerCase()} feeds this project. Its tickets are mirrored into the{" "}
          <span className="font-medium text-[var(--foreground)]">{label}</span> folder of the Knowledge Base, where Zyra can use them as
          context. Picking a different {remoteUnitLabel.toLowerCase()} replaces the link — already-synced documents are left in place.
        </p>

        {itemsLoading ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-[var(--muted)]">
            <div className="w-4 h-4 rounded-full border-2 border-[var(--brand-primary)] border-t-transparent animate-spin" />
            Loading {remoteUnitLabel.toLowerCase()}s…
          </div>
        ) : remoteItems.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--muted)]">No {remoteUnitLabel.toLowerCase()}s found in your {label} workspace.</p>
        ) : (
          <div className="mt-4 space-y-2 max-h-80 overflow-y-auto" role="radiogroup" aria-label={`${label} ${remoteUnitLabel}`}>
            {remoteItems.map((item) => (
              <label
                key={item.id}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
                  selectedId === item.id
                    ? "border-[var(--brand-primary)] bg-[var(--brand-soft)]"
                    : "border-[var(--border)] hover:bg-[var(--surface-secondary)]"
                }`}
              >
                <input
                  type="radio"
                  name="remote-item"
                  checked={selectedId === item.id}
                  onChange={() => setSelectedId(item.id)}
                  className="border-[var(--border)] text-[var(--accent-light)] focus:ring-[var(--brand-soft)]"
                />
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-[var(--foreground)]">{item.name}</span>
                  <span className="ml-2 text-xs text-[var(--muted)] font-mono">{item.key}</span>
                </div>
              </label>
            ))}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={handleSaveMapping} disabled={saving || !selectedId}>
            {saving ? "Saving…" : `Link ${remoteUnitLabel}`}
          </Button>
          {selectedId && (
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="text-xs text-[var(--muted)] underline hover:text-[var(--foreground)]"
            >
              Clear selection
            </button>
          )}
        </div>
      </Card>

      {status.connectedProjects && status.connectedProjects.length > 0 && (
        <Card className="p-4">
          <h2 className="text-base font-semibold text-[var(--foreground)]">Sync Tickets</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Pulls every ticket from the linked {remoteUnitLabel.toLowerCase()} — description, comments, and an AI summary of the decisions
            in each thread — into the {label} folder of the Knowledge Base. Runs in the background, so you can leave this page.
          </p>
          <div className="mt-3 flex items-center gap-3">
            <Button variant="secondary" onClick={handleSync} disabled={starting || isSyncRunActive(run)}>
              {starting ? "Starting…" : isSyncRunActive(run) ? "Syncing…" : "Sync Now"}
            </Button>
            <Link href={`/projects/${projectId}/knowledge-base`} className="text-sm text-[var(--accent-light)] hover:underline">
              View Knowledge Base →
            </Link>
          </div>
          {syncError && <p className="mt-3 text-sm text-[var(--error-foreground)]">{syncError}</p>}
          <SyncStatusPanel run={run} label={label} className="mt-3" />
        </Card>
      )}

      {settingsPanel}
    </StandardPageLayout>
  );
}
