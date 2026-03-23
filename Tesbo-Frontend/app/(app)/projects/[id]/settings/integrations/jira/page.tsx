"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  authMe,
  getJiraStatus,
  listJiraProjects,
  connectJiraProjects,
  syncJiraTickets,
  type JiraProject,
  type JiraConnection,
} from "@/lib/api";
import { Button, Card, EmptyStateBlock } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

export default function JiraIntegrationPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [loading, setLoading] = useState(true);
  const [jiraStatus, setJiraStatus] = useState<JiraConnection | null>(null);
  const [jiraProjects, setJiraProjects] = useState<JiraProject[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const me = await authMe();
      if (!me) {
        router.replace("/login");
        return;
      }
      const status = await getJiraStatus(projectId);
      setJiraStatus(status);

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
    } catch {
      setMessage({ type: "error", text: "Failed to sync Jira tickets." });
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
              <Link href={`/projects/${projectId}/settings`} className="text-[var(--brand-primary)] hover:underline">
                &larr; Back to Project Settings
              </Link>
            }
          />
        }
      >
        <EmptyStateBlock
          title="Jira not connected"
          description="Jira is not connected for this project. Go back to project settings and click Connect to start."
          action={
            <Link href={`/projects/${projectId}/settings`}>
              <Button>Go to Settings</Button>
            </Link>
          }
        />
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
            <Link href={`/projects/${projectId}/settings`} className="text-[var(--brand-primary)] hover:underline">
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
