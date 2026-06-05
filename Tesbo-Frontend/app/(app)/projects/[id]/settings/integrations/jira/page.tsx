"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback, type FormEvent } from "react";
import Link from "next/link";
import {
  authMe,
  getJiraAuthUrl,
  getJiraConfig,
  getJiraStatus,
  listJiraProjects,
  connectJiraProjects,
  syncJiraTickets,
  updateJiraConfig,
  type JiraOAuthConfig,
  type JiraProject,
  type JiraConnection,
} from "@/lib/api";
import { Button, Card, Field, FieldLabel, Input } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

export default function JiraIntegrationPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [loading, setLoading] = useState(true);
  const [jiraStatus, setJiraStatus] = useState<JiraConnection | null>(null);
  const [jiraConfig, setJiraConfig] = useState<JiraOAuthConfig | null>(null);
  const [jiraProjects, setJiraProjects] = useState<JiraProject[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState("");

  const loadData = useCallback(async () => {
    try {
      const me = await authMe();
      if (!me) {
        router.replace("/login");
        return;
      }
      const [status, config] = await Promise.all([
        getJiraStatus(projectId),
        getJiraConfig(projectId).catch(() => null),
      ]);
      setJiraStatus(status);
      setJiraConfig(config);
      if (config) {
        setClientId(config.clientId || "");
        setRedirectUri(config.redirectUri || "");
      }

      if (status.connected) {
        setProjectsLoading(true);
        const projects = await listJiraProjects(projectId);
        setJiraProjects(projects);
        // Pre-select already connected projects
        const connectedIds = new Set(projects.filter((p) => p.connected).map((p) => p.id));
        setSelected(connectedIds);
        setProjectsLoading(false);
      }
    } catch {
      setMessage({ type: "error", text: "Failed to load Jira integration data." });
    } finally {
      setLoading(false);
    }
  }, [projectId, router]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function toggleProject(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function handleSaveConfig(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const config = await updateJiraConfig(projectId, {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        redirectUri: redirectUri.trim(),
      });
      setJiraConfig(config);
      setClientSecret("");
      setMessage({ type: "success", text: "Jira configuration saved. You can connect Jira now." });
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : "Failed to save Jira configuration." });
    } finally {
      setSaving(false);
    }
  }

  async function handleConnectJira() {
    setConnecting(true);
    setMessage(null);
    try {
      const { url } = await getJiraAuthUrl(projectId);
      window.location.href = url;
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : "Failed to initiate Jira authentication." });
      setConnecting(false);
    }
  }

  async function handleSaveProjects() {
    setSaving(true);
    setMessage(null);
    try {
      const projectsToConnect = jiraProjects
        .filter((p) => selected.has(p.id))
        .map((p) => ({ id: p.id, key: p.key, name: p.name }));
      await connectJiraProjects(projectId, projectsToConnect);
      setMessage({ type: "success", text: "Jira projects linked successfully." });
      // Refresh connection status
      const status = await getJiraStatus(projectId);
      setJiraStatus(status);
    } catch {
      setMessage({ type: "error", text: "Failed to save Jira project selection." });
    } finally {
      setSaving(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setMessage(null);
    try {
      const result = await syncJiraTickets(projectId);
      setMessage({ type: "success", text: `Synced ${result.synced} tickets from Jira.` });
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : "Failed to sync Jira tickets." });
    } finally {
      setSyncing(false);
    }
  }

  if (loading) {
    return (
      <StandardPageLayout header={<PageHeader title="Jira Integration" />}>
        <div className="flex min-h-[200px] items-center justify-center">
          <p className="text-[var(--muted)]">Loading…</p>
        </div>
      </StandardPageLayout>
    );
  }

  if (!jiraStatus?.connected) {
    return (
      <StandardPageLayout
        header={
          <PageHeader
            title="Jira Integration"
            breadcrumb={
              <Link href={`/projects/${projectId}/settings?tab=integrations`} className="text-[var(--brand-primary)] hover:underline">
                &larr; Back to Project Settings
              </Link>
            }
          />
        }
      >
        {message && (
          <div
            className={`rounded-lg border px-3 py-2 text-sm ${
              message.type === "success"
                ? "border-[var(--success)]/30 bg-[color-mix(in_oklab,var(--success)_8%,white)] text-[var(--success)]"
                : "border-[var(--error)]/30 bg-[color-mix(in_oklab,var(--error)_8%,white)] text-[var(--error)]"
            }`}
          >
            {message.text}
          </div>
        )}

        <Card className="p-4">
          <h2 className="text-base font-semibold text-[var(--foreground)]">Configure Jira OAuth</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Add the OAuth app values from Atlassian Developer Console. These values are used only for this project&apos;s Jira connection.
          </p>

          <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3 text-sm text-[var(--foreground)]">
            <p className="font-medium">In Atlassian Developer Console:</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-[var(--muted)]">
              <li>Create an OAuth 2.0 integration.</li>
              <li>Add this callback URL under Authorization callback URLs.</li>
              <li>Enable scopes: <span className="font-mono text-[var(--foreground)]">read:jira-work</span>, <span className="font-mono text-[var(--foreground)]">read:jira-user</span>, <span className="font-mono text-[var(--foreground)]">write:jira-work</span>, and <span className="font-mono text-[var(--foreground)]">offline_access</span>.</li>
              <li>Copy the Client ID and Client Secret into the form below.</li>
            </ol>
          </div>

          <form onSubmit={handleSaveConfig} className="mt-4 space-y-4">
            <Field>
              <FieldLabel>Authorization callback URL</FieldLabel>
              <Input
                type="url"
                value={redirectUri}
                onChange={(event) => setRedirectUri(event.target.value)}
                placeholder="http://localhost:1010/jira/callback"
              />
              <p className="mt-1 text-xs text-[var(--muted)]">
                Paste this exact value into Atlassian. For this app, the callback page is <span className="font-mono text-[var(--foreground)]">/jira/callback</span>.
              </p>
            </Field>
            <Field>
              <FieldLabel>Client ID</FieldLabel>
              <Input
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                placeholder="Paste Atlassian OAuth client ID"
              />
            </Field>
            <Field>
              <FieldLabel>Client Secret</FieldLabel>
              <Input
                type="password"
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
                placeholder={jiraConfig?.hasClientSecret ? "Saved. Enter a new secret only to replace it." : "Paste Atlassian OAuth client secret"}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={saving}>
                {saving ? "Saving..." : "Save Jira Configuration"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={handleConnectJira}
                disabled={connecting || !jiraConfig?.configured}
              >
                {connecting ? "Connecting..." : "Connect Jira"}
              </Button>
              {jiraConfig?.configured && (
                <span className="text-xs text-[var(--success)]">
                  Configuration saved from {jiraConfig.source === "environment" ? "environment variables" : "project settings"}.
                </span>
              )}
            </div>
          </form>
        </Card>
      </StandardPageLayout>
    );
  }

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Jira Integration"
          subtitle={
            <>
              Connected to{" "}
              <a href={jiraStatus.siteUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--brand-primary)] hover:underline">
                {jiraStatus.siteUrl}
              </a>
            </>
          }
          breadcrumb={
            <Link href={`/projects/${projectId}/settings?tab=integrations`} className="text-[var(--brand-primary)] hover:underline">
              &larr; Back to Project Settings
            </Link>
          }
        />
      }
    >
      {/* Message */}
      {message && (
        <div
          className={`rounded-lg border px-3 py-2 text-sm ${
            message.type === "success"
              ? "border-[var(--success)]/30 bg-[color-mix(in_oklab,var(--success)_8%,white)] text-[var(--success)]"
              : "border-[var(--error)]/30 bg-[color-mix(in_oklab,var(--error)_8%,white)] text-[var(--error)]"
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Project selection */}
      <Card className="p-4">
        <h2 className="text-base font-semibold text-[var(--foreground)]">Select Jira Projects</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Choose which Jira projects to link. Tickets from selected projects will be available in the Knowledge Base.
        </p>

        {projectsLoading ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-[var(--muted)]">
            <div className="w-4 h-4 rounded-full border-2 border-[var(--brand-primary)] border-t-transparent animate-spin" />
            Loading Jira projects…
          </div>
        ) : jiraProjects.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--muted)]">No projects found in your Jira site.</p>
        ) : (
          <div className="mt-4 space-y-2 max-h-80 overflow-y-auto">
            {jiraProjects.map((jp) => (
              <label
                key={jp.id}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
                  selected.has(jp.id)
                    ? "border-[var(--brand-primary)] bg-[var(--brand-soft)]"
                    : "border-[var(--border)] hover:bg-[var(--surface-secondary)]"
                }`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(jp.id)}
                  onChange={() => toggleProject(jp.id)}
                  className="rounded border-[var(--border)] text-[var(--brand-primary)] focus:ring-[var(--brand-soft)]"
                />
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-[var(--foreground)]">{jp.name}</span>
                  <span className="ml-2 text-xs text-[var(--muted)] font-mono">{jp.key}</span>
                </div>
              </label>
            ))}
          </div>
        )}

        <div className="mt-4 flex items-center gap-3">
          <Button
            onClick={handleSaveProjects}
            disabled={saving || selected.size === 0}
          >
            {saving ? "Saving…" : `Link ${selected.size} Project${selected.size !== 1 ? "s" : ""}`}
          </Button>
          <span className="text-xs text-[var(--muted-soft)]">
            {selected.size} selected
          </span>
        </div>
      </Card>

      {/* Sync section */}
      {jiraStatus.connectedProjects && jiraStatus.connectedProjects.length > 0 && (
        <Card className="p-4">
          <h2 className="text-base font-semibold text-[var(--foreground)]">Sync Tickets</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Pull the latest tickets from your linked Jira projects into the Knowledge Base.
          </p>
          <div className="mt-3 flex items-center gap-3">
            <Button
              variant="secondary"
              onClick={handleSync}
              disabled={syncing}
            >
              {syncing ? "Syncing…" : "Sync Now"}
            </Button>
            <Link
              href={`/projects/${projectId}/knowledge-base`}
              className="text-sm text-[var(--brand-primary)] hover:underline"
            >
              View Knowledge Base →
            </Link>
          </div>
        </Card>
      )}
    </StandardPageLayout>
  );
}
