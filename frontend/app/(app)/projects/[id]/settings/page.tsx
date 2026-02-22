"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  authMe,
  getProject,
  updateProject,
  getJiraStatus,
  getJiraAuthUrl,
  disconnectJira,
  rotateTesboIngestionKey,
  type JiraConnection,
} from "@/lib/api";
import { TesboAlertSettings } from "@/components/tesbo/TesboAlertSettings";
import ThemeToggle from "@/components/ThemeToggle";

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
  tesboReports?: {
    keepTrace?: boolean;
    traceRetentionDays?: number;
    ingestionApiKey?: string;
    alertsEnabled?: boolean;
    shareByDefault?: boolean;
  };
  [key: string]: unknown;
};

type SettingsTab = "general" | "ai" | "jira" | "tesbo" | "alerts" | "integrations";

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
  const [tesboKeepTrace, setTesboKeepTrace] = useState(true);
  const [tesboTraceRetentionDays, setTesboTraceRetentionDays] = useState(14);
  const [tesboIngestionApiKey, setTesboIngestionApiKey] = useState("");
  const [tesboAlertsEnabled, setTesboAlertsEnabled] = useState(true);
  const [tesboShareByDefault, setTesboShareByDefault] = useState(false);
  const [rotatingTesboKey, setRotatingTesboKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [jiraStatus, setJiraStatus] = useState<JiraConnection | null>(null);
  const [jiraLoading, setJiraLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");

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
        const optionList: readonly string[] = options;
        const aiModel = typeof ai?.model === "string" ? ai.model : "";
        const resolvedModel =
          aiModel && optionList.includes(aiModel)
            ? aiModel
            : optionList[0] ?? "";
        setProvider(aiProvider);
        setModel(resolvedModel);
        setOpenAiApiKey(ai?.openAiApiKey ?? "");
        setAnthropicApiKey(ai?.anthropicApiKey ?? "");
        setJiraAutoComment(parsedSettings.jiraAutoComment === true);
        setJiraTicketSelector(parsedSettings.jiraTicketSelector === true);
        const tesbo = parsedSettings.tesboReports;
        setTesboKeepTrace(tesbo?.keepTrace !== false);
        setTesboTraceRetentionDays(
          typeof tesbo?.traceRetentionDays === "number" && tesbo.traceRetentionDays > 0
            ? tesbo.traceRetentionDays
            : 14
        );
        setTesboIngestionApiKey(tesbo?.ingestionApiKey ?? "");
        setTesboAlertsEnabled(tesbo?.alertsEnabled !== false);
        setTesboShareByDefault(tesbo?.shareByDefault === true);
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
        tesboReports: {
          keepTrace: tesboKeepTrace,
          traceRetentionDays: tesboTraceRetentionDays,
          ingestionApiKey: tesboIngestionApiKey.trim(),
          alertsEnabled: tesboAlertsEnabled,
          shareByDefault: tesboShareByDefault,
        },
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

  async function handleRotateTesboKey() {
    setRotatingTesboKey(true);
    setMessage(null);
    try {
      const result = await rotateTesboIngestionKey(projectId);
      setTesboIngestionApiKey(result.ingestionApiKey ?? "");
      setMessage("Tesbo ingestion key rotated. Save project settings to persist other changes.");
    } catch {
      setMessage("Failed to rotate Tesbo ingestion key.");
    } finally {
      setRotatingTesboKey(false);
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
      <div className="flex items-start justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Project settings</h1>
        <ThemeToggle />
      </div>
      <p className="mt-1 text-sm text-zinc-500">
        Settings are grouped into tabs so you can edit one area at a time without long scrolling.
      </p>

      <div className="mt-6 border-b border-zinc-200 dark:border-zinc-700">
        <div className="flex flex-wrap gap-0">
          {[
            { key: "general", label: "General" },
            { key: "ai", label: "AI" },
            { key: "jira", label: "Jira" },
            { key: "tesbo", label: "Tesbo" },
            { key: "alerts", label: "Alerts" },
            { key: "integrations", label: "Integrations" },
          ].map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key as SettingsTab)}
              className={`px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                activeTab === tab.key
                  ? "border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400"
                  : "border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {(activeTab === "general" || activeTab === "ai" || activeTab === "jira" || activeTab === "tesbo") && (
        <form onSubmit={handleSubmit} className="mt-6 space-y-5">
          {activeTab === "general" && (
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 space-y-4">
              <div>
                <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">General</h2>
                <p className="mt-1 text-sm text-zinc-500">
                  Basic project details shown across the workspace.
                </p>
              </div>
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
            </div>
          )}

          {activeTab === "ai" && (
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
          )}

          {activeTab === "jira" && (
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
          )}

          {activeTab === "tesbo" && (
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 space-y-4">
              <div>
                <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Tesbo Reports</h2>
                <p className="mt-1 text-sm text-zinc-500">
                  Controls for embedded Tesbo reporting features in this project.
                </p>
              </div>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={tesboKeepTrace}
                  onChange={(e) => setTesboKeepTrace(e.target.checked)}
                />
                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Keep trace artifacts</span>
              </label>
              <div>
                <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Project access key</h3>
                <div className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-zinc-50 dark:bg-zinc-800 px-3 py-2 font-mono text-sm break-all">
                  {tesboIngestionApiKey || "No key generated yet."}
                </div>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => navigator.clipboard.writeText(tesboIngestionApiKey || "")}
                    className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-xs font-medium"
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRotateTesboKey().catch(() => {})}
                    disabled={rotatingTesboKey}
                    className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                  >
                    {rotatingTesboKey ? "Rotating…" : "Rotate key"}
                  </button>
                </div>
              </div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Trace retention
                <select
                  value={tesboTraceRetentionDays}
                  onChange={(e) => setTesboTraceRetentionDays(Number(e.target.value || 14))}
                  className="mt-1 w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2"
                  disabled={!tesboKeepTrace}
                >
                  <option value={2}>2 days</option>
                  <option value={14}>2 weeks</option>
                  <option value={30}>1 month</option>
                  <option value={180}>6 months</option>
                  <option value={365}>12 months</option>
                </select>
              </label>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={tesboAlertsEnabled}
                  onChange={(e) => setTesboAlertsEnabled(e.target.checked)}
                />
                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Enable Tesbo alerts</span>
              </label>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={tesboShareByDefault}
                  onChange={(e) => setTesboShareByDefault(e.target.checked)}
                />
                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Share runs by default</span>
              </label>
              <p className="text-xs text-zinc-500">
                Tesbo alert rules are managed in the Alerts tab.
              </p>
            </div>
          )}

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
      )}

      {activeTab === "alerts" && (
        <div className="mt-6">
          <TesboAlertSettings projectId={projectId} />
        </div>
      )}

      {activeTab === "integrations" && (
        <div className="mt-6 rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 space-y-4">
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
      )}

      {(activeTab === "alerts" || activeTab === "integrations") && message && (
        <p className="mt-4 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/30 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300">
          {message}
        </p>
      )}
    </main>
  );
}
