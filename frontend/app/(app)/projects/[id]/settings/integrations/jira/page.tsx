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
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  if (!jiraStatus?.connected) {
    return (
      <main className="max-w-xl mx-auto px-4 py-8">
        <Link
          href={`/projects/${projectId}/settings`}
          className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
        >
          &larr; Back to Project Settings
        </Link>
        <h1 className="mt-4 text-xl font-semibold text-zinc-900 dark:text-zinc-100">Jira Integration</h1>
        <div className="mt-6 rounded-xl border border-zinc-200 dark:border-zinc-700 p-6 text-center">
          <p className="text-sm text-zinc-500">
            Jira is not connected for this project. Go back to project settings and click &quot;Connect&quot; to start.
          </p>
          <Link
            href={`/projects/${projectId}/settings`}
            className="mt-4 inline-block rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-medium hover:bg-blue-700"
          >
            Go to Settings
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-2xl mx-auto px-4 py-8">
      <Link
        href={`/projects/${projectId}/settings`}
        className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
      >
        &larr; Back to Project Settings
      </Link>

      <h1 className="mt-4 text-xl font-semibold text-zinc-900 dark:text-zinc-100">Jira Integration</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Connected to{" "}
        <a href={jiraStatus.siteUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">
          {jiraStatus.siteUrl}
        </a>
      </p>

      {/* Message */}
      {message && (
        <div
          className={`mt-4 rounded-lg border px-3 py-2 text-sm ${
            message.type === "success"
              ? "border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400"
              : "border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400"
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Project selection */}
      <div className="mt-6 rounded-xl border border-zinc-200 dark:border-zinc-700 p-4">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Select Jira Projects</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Choose which Jira projects to link. Tickets from selected projects will be available in the Knowledge Base.
        </p>

        {projectsLoading ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-zinc-500">
            <div className="w-4 h-4 rounded-full border-2 border-blue-600 border-t-transparent animate-spin" />
            Loading Jira projects…
          </div>
        ) : jiraProjects.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500">No projects found in your Jira site.</p>
        ) : (
          <div className="mt-4 space-y-2 max-h-80 overflow-y-auto">
            {jiraProjects.map((jp) => (
              <label
                key={jp.id}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
                  selected.has(jp.id)
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20 dark:border-blue-600"
                    : "border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                }`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(jp.id)}
                  onChange={() => toggleProject(jp.id)}
                  className="rounded border-zinc-300 dark:border-zinc-600 text-blue-600 focus:ring-blue-500"
                />
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{jp.name}</span>
                  <span className="ml-2 text-xs text-zinc-500 font-mono">{jp.key}</span>
                </div>
              </label>
            ))}
          </div>
        )}

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={handleSaveProjects}
            disabled={saving || selected.size === 0}
            className="rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : `Link ${selected.size} Project${selected.size !== 1 ? "s" : ""}`}
          </button>
          <span className="text-xs text-zinc-400">
            {selected.size} selected
          </span>
        </div>
      </div>

      {/* Sync section */}
      {jiraStatus.connectedProjects && jiraStatus.connectedProjects.length > 0 && (
        <div className="mt-6 rounded-xl border border-zinc-200 dark:border-zinc-700 p-4">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Sync Tickets</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Pull the latest tickets from your linked Jira projects into the Knowledge Base.
          </p>
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium hover:bg-zinc-800 dark:hover:bg-zinc-200 disabled:opacity-50 transition-colors"
            >
              {syncing ? "Syncing…" : "Sync Now"}
            </button>
            <Link
              href={`/projects/${projectId}/knowledge-base`}
              className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
            >
              View Knowledge Base →
            </Link>
          </div>
        </div>
      )}
    </main>
  );
}
