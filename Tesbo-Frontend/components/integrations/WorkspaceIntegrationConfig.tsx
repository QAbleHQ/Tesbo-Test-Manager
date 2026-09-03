"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import {
  authMe,
  getWorkspace,
  getIntegrationConfig,
  getIntegrationStatus,
  disconnectIntegration,
  type IntegrationOAuthConfig,
  type IntegrationConnectionStatus,
  type IntegrationProvider,
} from "@/lib/api";
import { Button, Card } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";
import { useIntegrationOAuthConnect } from "@/lib/useIntegrationOAuthConnect";

function isValidProjectId(value: string | null): value is string {
  return !!value && /^[a-zA-Z0-9-]+$/.test(value);
}

/**
 * Workspace-level connect/disconnect screen for an issue tracker.
 *
 * There is exactly one way to connect: the OAuth app registered for this deployment via
 * `<PROVIDER>_CLIENT_ID` / `<PROVIDER>_CLIENT_SECRET`. Owners click Connect and approve access —
 * nothing is configurable from the UI. Tesbo Cloud and a self-hosted install run the identical
 * flow; they differ only in whose OAuth app the environment credentials belong to.
 */
function WorkspaceIntegrationConfigInner({
  provider,
  label,
  consoleName,
}: {
  provider: IntegrationProvider;
  label: string;
  consoleName: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnProjectIdParam = searchParams.get("returnProjectId");
  const returnProjectId = isValidProjectId(returnProjectIdParam) ? returnProjectIdParam : null;

  const [loading, setLoading] = useState(true);
  const [canManage, setCanManage] = useState(false);
  const [status, setStatus] = useState<IntegrationConnectionStatus | null>(null);
  const [config, setConfig] = useState<IntegrationOAuthConfig | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [workspace, statusRes, configRes] = await Promise.all([
        getWorkspace(),
        getIntegrationStatus(provider),
        getIntegrationConfig(provider).catch(() => null),
      ]);
      setCanManage((workspace.role || "member").toLowerCase() === "owner");
      setStatus(statusRes);
      setConfig(configRes);
    } catch {
      setMessage({ type: "error", text: `Failed to load ${label} integration data.` });
    } finally {
      setLoading(false);
    }
  }, [provider, label]);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      void loadData();
    });
  }, [loadData, router]);

  const handleConnected = useCallback(() => {
    setMessage({ type: "success", text: `${label} connected.` });
    void loadData();
    if (returnProjectId) router.replace(`/projects/${returnProjectId}/settings/integrations/${provider}`);
  }, [label, loadData, returnProjectId, router, provider]);

  const { connect, phase: connectPhase, error: connectError } = useIntegrationOAuthConnect(provider, handleConnected);
  const connecting = connectPhase === "opening" || connectPhase === "waiting";

  async function handleDisconnect() {
    setDisconnecting(true);
    setMessage(null);
    try {
      await disconnectIntegration(provider);
      await loadData();
      setMessage({ type: "success", text: `${label} disconnected.` });
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : `Failed to disconnect ${label}.` });
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <StandardPageLayout header={<PageHeader title={`${label} Integration`} />}>
        <div className="flex min-h-[200px] items-center justify-center">
          <p className="text-[var(--muted)]">Loading…</p>
        </div>
      </StandardPageLayout>
    );
  }

  const breadcrumb = (
    <Link href="/settings?tab=integrations" className="text-[var(--accent-light)] hover:underline">
      &larr; Back to Integrations
    </Link>
  );

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title={`${label} Integration`}
          subtitle={
            status?.connected && status.siteUrl ? (
              <>
                Connected to{" "}
                <a href={status.siteUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--accent-light)] hover:underline">
                  {status.siteUrl}
                </a>
              </>
            ) : (
              `Connect ${label} once for this workspace, then map remote projects to Tesbo projects from each project's Settings → Integrations tab.`
            )
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

      {!canManage && (
        <Card className="p-4">
          <p className="text-sm text-[var(--muted)]">Only the workspace owner can connect {label}.</p>
        </Card>
      )}

      {status?.connected ? (
        <Card className="p-4 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--foreground)]">Connected</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {status.connectedProjects && status.connectedProjects.length > 0
                ? `${status.connectedProjects.length} project(s) currently map to this ${label} connection.`
                : `No Tesbo project is mapped to this ${label} connection yet.`}
            </p>
          </div>
          {status.connectedProjects && status.connectedProjects.length > 0 && (
            <ul className="space-y-1 text-sm text-[var(--foreground)]">
              {status.connectedProjects.map((p) => (
                <li key={p.projectId} className="flex items-center gap-2">
                  <span className="font-mono text-xs text-[var(--muted)]">{p.projectKey}</span>
                  <span>{p.projectName}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm text-[var(--muted)]">
            To pick which {provider === "jira" ? "Jira project" : "Linear team"} feeds a Tesbo project, open that project&apos;s Settings → Integrations tab.
          </p>
          {canManage && (
            <Button
              type="button"
              variant="secondary"
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="border-[var(--error)]/50 text-[var(--error-foreground)] hover:bg-[color-mix(in_oklab,var(--error)_8%,white)]"
            >
              {disconnecting ? "Disconnecting..." : `Disconnect ${label}`}
            </Button>
          )}
        </Card>
      ) : (
        canManage && (
          <Card className="p-4 space-y-3">
            <div>
              <h2 className="text-base font-semibold text-[var(--foreground)]">Connect {label}</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">
                {config?.configured
                  ? `Sign in with ${label} and approve access — there's nothing to set up.`
                  : `${label} isn't set up on this deployment yet.`}
              </p>
            </div>

            {config?.configured ? (
              <>
                <Button type="button" onClick={connect} disabled={connecting}>
                  {connectPhase === "opening"
                    ? `Redirecting to ${label}...`
                    : connectPhase === "waiting"
                      ? "Waiting for you to finish in the new tab…"
                      : `Connect ${label}`}
                </Button>
                <p
                  className={`text-xs ${
                    connectPhase === "blocked" || connectPhase === "timeout" || connectError
                      ? "text-[var(--error-foreground)]"
                      : "text-[var(--muted)]"
                  }`}
                >
                  {connectPhase === "blocked"
                    ? "Your browser blocked the popup — allow popups for this site and try again."
                    : connectPhase === "timeout"
                      ? "This took too long and the request may have expired. Try again."
                      : connectError || `You'll be taken to ${label} in a new tab to approve access — this tab stays right here and picks it up automatically.`}
                </p>
                {returnProjectId && (
                  <p className="text-xs text-[var(--muted)]">
                    You&apos;ll be brought straight to finish mapping your project after connecting.
                  </p>
                )}
              </>
            ) : (
              // Self-hosted install with no credentials set. This is an operator task, not something
              // a workspace owner can fix from the UI, so say what has to happen and where.
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3 text-sm">
                <p className="text-[var(--foreground)]">
                  Whoever runs this Tesbo instance needs to register an OAuth app in the {consoleName} and set these
                  in the backend environment, then restart it:
                </p>
                <ul className="mt-2 space-y-1 pl-5 text-[var(--muted)] list-disc">
                  <li>
                    <span className="font-mono text-[var(--foreground)]">{provider.toUpperCase()}_CLIENT_ID</span>
                  </li>
                  <li>
                    <span className="font-mono text-[var(--foreground)]">{provider.toUpperCase()}_CLIENT_SECRET</span>
                  </li>
                </ul>
                {config?.redirectUri && (
                  <p className="mt-3 text-[var(--muted)]">
                    Register this as the app&apos;s callback URL:{" "}
                    <span className="font-mono text-[var(--foreground)]">{config.redirectUri}</span>
                  </p>
                )}
              </div>
            )}
          </Card>
        )
      )}
    </StandardPageLayout>
  );
}

export function WorkspaceIntegrationConfig(props: {
  provider: IntegrationProvider;
  label: string;
  consoleName: string;
}) {
  return (
    <Suspense
      fallback={
        <StandardPageLayout header={<PageHeader title={`${props.label} Integration`} />}>
          <div className="flex min-h-[200px] items-center justify-center">
            <p className="text-[var(--muted)]">Loading…</p>
          </div>
        </StandardPageLayout>
      }
    >
      <WorkspaceIntegrationConfigInner {...props} />
    </Suspense>
  );
}
