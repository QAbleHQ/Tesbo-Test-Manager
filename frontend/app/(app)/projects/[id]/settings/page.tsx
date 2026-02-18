"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { authMe, getProject, updateProject, getJiraStatus, getJiraAuthUrl, disconnectJira, type JiraConnection } from "@/lib/api";

const OPENAI_MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
] as const;

const ANTHROPIC_MODELS = [
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-5",
  "claude-sonnet-4-0",
  "claude-opus-4-6",
  "claude-3-7-sonnet-latest",
] as const;

type ProjectSettingsPayload = {
  ai?: {
    provider?: "openai" | "anthropic";
    model?: string;
    openAiApiKey?: string;
    anthropicApiKey?: string;
  };
  jiraAutoComment?: boolean;
  jiraTicketSelector?: boolean;
  [key: string]: unknown;
};

export default function ProjectSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const [project, setProject] = useState<Record<string, unknown> | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [provider, setProvider] = useState<"openai" | "anthropic">("openai");
  const [model, setModel] = useState("");
  const [openAiApiKey, setOpenAiApiKey] = useState("");
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [jiraAutoComment, setJiraAutoComment] = useState(false);
  const [jiraTicketSelector, setJiraTicketSelector] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [jiraStatus, setJiraStatus] = useState<JiraConnection | null>(null);
  const [jiraLoading, setJiraLoading] = useState(false);

  function modelOptionsFor(activeProvider: "openai" | "anthropic") {
    return activeProvider === "openai" ? OPENAI_MODELS : ANTHROPIC_MODELS;
  }

  function parseProjectSettings(raw: unknown): ProjectSettingsPayload {
    if (typeof raw !== "string" || !raw.trim()) return {};
    try {
      const parsed = JSON.parse(raw) as ProjectSettingsPayload;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      getProject(projectId).then((p) => {
        setProject(p);
        setName((p.name as string) ?? "");
        setDescription((p.description as string) ?? "");
        const parsedSettings = parseProjectSettings(p.settings);
        const ai = parsedSettings.ai;
        const aiProvider = ai?.provider === "anthropic" ? "anthropic" : "openai";
        const options = modelOptionsFor(aiProvider);
        const resolvedModel =
          ai?.model && options.includes(ai.model as (typeof options)[number])
            ? ai.model
            : options[0];
        setProvider(aiProvider);
        setModel(resolvedModel);
        setOpenAiApiKey(ai?.openAiApiKey ?? "");
        setAnthropicApiKey(ai?.anthropicApiKey ?? "");
        setJiraAutoComment(parsedSettings.jiraAutoComment === true);
        setJiraTicketSelector(parsedSettings.jiraTicketSelector === true);
      }).catch(() => router.replace("/projects"));
      getJiraStatus(projectId).then(setJiraStatus).catch(() => {});
    });
  }, [projectId, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (provider === "openai" && !openAiApiKey.trim()) {
      setMessage("OpenAI API key is required for OpenAI provider.");
      return;
    }
    if (provider === "anthropic" && !anthropicApiKey.trim()) {
      setMessage("Anthropic API key is required for Anthropic provider.");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const currentSettings = parseProjectSettings(project?.settings);
      const nextSettings: ProjectSettingsPayload = {
        ...currentSettings,
        ai: {
          provider,
          model: model.trim() || undefined,
          openAiApiKey: openAiApiKey.trim(),
          anthropicApiKey: anthropicApiKey.trim(),
        },
        jiraAutoComment,
        jiraTicketSelector,
      };
      await updateProject(projectId, {
        name,
        description,
        settings: JSON.stringify(nextSettings),
      });
      setMessage("Project settings saved.");
    } finally {
      setSaving(false);
    }
  }

  async function handleConnectJira() {
    setJiraLoading(true);
    try {
      const { url } = await getJiraAuthUrl(projectId);
      window.location.href = url;
    } catch {
      setMessage("Failed to initiate Jira authentication.");
      setJiraLoading(false);
    }
  }

  async function handleDisconnectJira() {
    if (!confirm("Disconnect Jira? This will remove all synced tickets.")) return;
    setJiraLoading(true);
    try {
      await disconnectJira(projectId);
      setJiraStatus({ connected: false });
    } catch {
      setMessage("Failed to disconnect Jira.");
    } finally {
      setJiraLoading(false);
    }
  }

  if (!project) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  return (
    <main className="max-w-xl mx-auto px-4 py-8">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Project settings</h1>
        <form onSubmit={handleSubmit} className="mt-6 space-y-5">
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2"
            />
          </div>
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">AI Test Case Generation</h2>
              <p className="mt-1 text-sm text-zinc-500">
                Select provider and API key to enable test script generation for this project.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Provider</label>
              <select
                value={provider}
                onChange={(e) => {
                  const nextProvider = e.target.value as "openai" | "anthropic";
                  setProvider(nextProvider);
                  const options = modelOptionsFor(nextProvider);
                  setModel(options[0]);
                }}
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2"
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Model</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2"
              >
                {modelOptionsFor(provider).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">OpenAI API Key</label>
              <input
                type="password"
                value={openAiApiKey}
                onChange={(e) => setOpenAiApiKey(e.target.value)}
                placeholder="sk-..."
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Anthropic API Key</label>
              <input
                type="password"
                value={anthropicApiKey}
                onChange={(e) => setAnthropicApiKey(e.target.value)}
                placeholder="sk-ant-..."
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2"
              />
            </div>
          </div>
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Jira + AI Generation</h2>
              <p className="mt-1 text-sm text-zinc-500">
                Control how Jira tickets interact with AI test generation.
              </p>
            </div>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={jiraAutoComment}
                onChange={(e) => setJiraAutoComment(e.target.checked)}
                className="mt-0.5"
              />
              <div>
                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Auto-comment on Jira ticket</span>
                <p className="text-xs text-zinc-500 mt-0.5">
                  When test cases are generated from a Jira ticket and saved, automatically add a comment to the Jira ticket listing the created test cases.
                </p>
              </div>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={jiraTicketSelector}
                onChange={(e) => setJiraTicketSelector(e.target.checked)}
                className="mt-0.5"
              />
              <div>
                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Jira ticket selector on AI Generation</span>
                <p className="text-xs text-zinc-500 mt-0.5">
                  Show a Jira ticket search dropdown on the AI Test Generation page so users can pick a ticket directly without going through the Knowledge Base.
                </p>
              </div>
            </label>
          </div>
          {message && (
            <p className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/30 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300">
              {message}
            </p>
          )}
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-blue-600 text-white py-2 px-4 font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </form>

        {/* ─── App Integrations ─── */}
        <div className="mt-10 rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">App Integrations</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Connect external tools and services to enrich your project.
            </p>
          </div>

          {/* Jira Card */}
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-4 flex items-start gap-4">
            {/* Jira icon */}
            <div className="shrink-0 w-10 h-10 rounded-lg bg-blue-600 flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="w-6 h-6 text-white" fill="currentColor">
                <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53ZM6.77 6.8a4.362 4.362 0 0 0 4.34 4.34h1.8v1.72a4.362 4.362 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.84-.84H6.77ZM2 11.6c0 2.4 1.95 4.34 4.35 4.35h1.78v1.71c0 2.4 1.95 4.35 4.35 4.35V12.44a.84.84 0 0 0-.84-.84H2Z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Jira</h3>
              <p className="text-xs text-zinc-500 mt-0.5">
                Import tickets from Jira to use as knowledge base for test generation.
              </p>
              {jiraStatus?.connected && (
                <div className="mt-2 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
                    <span className="text-xs text-green-700 dark:text-green-400 font-medium">Connected</span>
                    <span className="text-xs text-zinc-400">·</span>
                    <a
                      href={jiraStatus.siteUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-600 dark:text-blue-400 hover:underline truncate"
                    >
                      {jiraStatus.siteUrl}
                    </a>
                  </div>
                  {jiraStatus.connectedProjects && jiraStatus.connectedProjects.length > 0 && (
                    <p className="text-xs text-zinc-500">
                      {jiraStatus.connectedProjects.length} project{jiraStatus.connectedProjects.length > 1 ? "s" : ""} linked:{" "}
                      {jiraStatus.connectedProjects.map((p) => p.jiraProjectKey).join(", ")}
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="shrink-0 flex flex-col gap-2">
              {jiraStatus?.connected ? (
                <>
                  <Link
                    href={`/projects/${projectId}/settings/integrations/jira`}
                    className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                  >
                    Manage
                  </Link>
                  <button
                    onClick={handleDisconnectJira}
                    disabled={jiraLoading}
                    className="rounded-lg border border-red-300 dark:border-red-700 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
                  >
                    Disconnect
                  </button>
                </>
              ) : (
                <button
                  onClick={handleConnectJira}
                  disabled={jiraLoading}
                  className="rounded-lg bg-blue-600 text-white px-4 py-1.5 text-xs font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {jiraLoading ? "Connecting…" : "Connect"}
                </button>
              )}
            </div>
          </div>

          {/* Placeholder for future integrations */}
          <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-4 flex items-center gap-4 opacity-60">
            <div className="shrink-0 w-10 h-10 rounded-lg bg-zinc-200 dark:bg-zinc-700 flex items-center justify-center">
              <svg className="w-5 h-5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-medium text-zinc-500">More integrations coming soon</h3>
              <p className="text-xs text-zinc-400 mt-0.5">Slack, GitHub, Azure DevOps and more.</p>
            </div>
          </div>
        </div>
    </main>
  );
}
