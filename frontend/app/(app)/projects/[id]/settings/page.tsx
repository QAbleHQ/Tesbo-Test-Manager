"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  authMe,
  getProject,
  updateProject,
  deleteProject as deleteProjectRequest,
  getJiraStatus,
  getJiraAuthUrl,
  disconnectJira,
  rotateTesboIngestionKey,
  listProjectMembers,
  listWorkspaceMembers,
  addProjectMember,
  removeProjectMember,
  type JiraConnection,
  type TestEnvironmentSetting,
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
  automation?: {
    browserAgent?: "default" | "custom";
    executionProvider?: "default" | "lambdatest" | "browserstack";
    maxParallel?: number;
    providers?: {
      lambdatest?: {
        endpoint?: string;
        username?: string;
        accessKey?: string;
      };
      browserstack?: {
        endpoint?: string;
        username?: string;
        accessKey?: string;
      };
    };
  };
  ai?: {
    provider?: "openai" | "anthropic";
    model?: string;
    openAiApiKey?: string;
    anthropicApiKey?: string;
    autoGenerateTestSteps?: boolean;
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
  testRunEnvironments?: Array<{
    name?: string;
    url?: string;
  }>;
  [key: string]: unknown;
};

type SettingsTab = "general" | "testRuns" | "members" | "ai" | "jira" | "tesbo" | "alerts" | "integrations";
type ProjectMember = { userId: string; email: string; name: string; role: string; joinedAt: string };
type WorkspaceMember = { userId: string; email: string; name: string; role: string; joinedAt: string };

const PLATFORM_ROLES = [
  { value: "owner", label: "Owner" },
  { value: "admin", label: "Admin" },
  { value: "manager", label: "Manager" },
  { value: "member", label: "Member" },
] as const;

function normalizeRole(role: string): (typeof PLATFORM_ROLES)[number]["value"] {
  const normalized = role.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (normalized === "project_admin") return "admin";
  if (normalized === "test_manager") return "manager";
  if (normalized === "qa_member" || normalized === "viewer") return "member";
  if (normalized === "owner" || normalized === "admin" || normalized === "manager" || normalized === "member") {
    return normalized;
  }
  return "member";
}

function roleLabel(role: string): string {
  const normalized = normalizeRole(role);
  const match = PLATFORM_ROLES.find((item) => item.value === normalized);
  return match?.label ?? "Member";
}

export default function ProjectSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.id as string;
  const [project, setProject] = useState<Record<string, unknown> | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [provider, setProvider] = useState<"openai" | "anthropic">("openai");
  const [model, setModel] = useState("");
  const [openAiApiKey, setOpenAiApiKey] = useState("");
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [autoGenerateTestSteps, setAutoGenerateTestSteps] = useState(true);
  const [jiraAutoComment, setJiraAutoComment] = useState(false);
  const [jiraTicketSelector, setJiraTicketSelector] = useState(false);
  const [tesboKeepTrace, setTesboKeepTrace] = useState(true);
  const [tesboTraceRetentionDays, setTesboTraceRetentionDays] = useState(14);
  const [tesboIngestionApiKey, setTesboIngestionApiKey] = useState("");
  const [tesboAlertsEnabled, setTesboAlertsEnabled] = useState(true);
  const [tesboShareByDefault, setTesboShareByDefault] = useState(false);
  const [testRunEnvironments, setTestRunEnvironments] = useState<TestEnvironmentSetting[]>([]);
  const [executionProvider, setExecutionProvider] = useState<"default" | "lambdatest" | "browserstack">("default");
  const [maxParallel, setMaxParallel] = useState(1);
  const [lambdaTestEndpoint, setLambdaTestEndpoint] = useState("");
  const [lambdaTestUsername, setLambdaTestUsername] = useState("");
  const [lambdaTestAccessKey, setLambdaTestAccessKey] = useState("");
  const [browserStackEndpoint, setBrowserStackEndpoint] = useState("");
  const [browserStackUsername, setBrowserStackUsername] = useState("");
  const [browserStackAccessKey, setBrowserStackAccessKey] = useState("");
  const [browserAgent, setBrowserAgent] = useState<"default" | "custom">("default");
  const [newEnvironmentName, setNewEnvironmentName] = useState("");
  const [newEnvironmentUrl, setNewEnvironmentUrl] = useState("");
  const [rotatingTesboKey, setRotatingTesboKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [jiraStatus, setJiraStatus] = useState<JiraConnection | null>(null);
  const [jiraLoading, setJiraLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [addUserId, setAddUserId] = useState("");
  const [addRole, setAddRole] = useState<string>("member");
  const [addingMember, setAddingMember] = useState(false);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [changingRoleId, setChangingRoleId] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const jiraTabEnabled = jiraStatus?.connected === true;

  const visibleTabs: Array<{ key: SettingsTab; label: string }> = [
    { key: "general", label: "General" },
    { key: "testRuns", label: "Test Environments" },
    { key: "members", label: "Members" },
    { key: "ai", label: "AI" },
    ...(jiraTabEnabled ? [{ key: "jira" as const, label: "Jira" }] : []),
    { key: "tesbo", label: "Automation Reports" },
    { key: "alerts", label: "Alerts" },
    { key: "integrations", label: "Integrations" },
  ];

  useEffect(() => {
    const tab = searchParams.get("tab");
    if (!tab) return;
    const allowed: SettingsTab[] = visibleTabs.map((item) => item.key);
    if (allowed.includes(tab as SettingsTab)) {
      setActiveTab(tab as SettingsTab);
    }
  }, [searchParams, visibleTabs]);

  useEffect(() => {
    if (activeTab === "jira" && !jiraTabEnabled) {
      setActiveTab("integrations");
    }
  }, [activeTab, jiraTabEnabled]);

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

  function normalizeTestRunEnvironments(raw: unknown): TestEnvironmentSetting[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => {
        const candidate = item as { name?: unknown; url?: unknown };
        const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
        const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
        if (!name || !url) return null;
        return { name, url };
      })
      .filter((item): item is TestEnvironmentSetting => item !== null);
  }

  const loadMembers = useCallback(async () => {
    try {
      const [projectList, workspaceList] = await Promise.all([
        listProjectMembers(projectId),
        listWorkspaceMembers().catch(() => []),
      ]);
      setProjectMembers(projectList as ProjectMember[]);
      setWorkspaceMembers(workspaceList as WorkspaceMember[]);
      setMemberError(null);
    } catch {
      setMemberError("Failed to load project members.");
    } finally {
      setMembersLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      setCurrentUserId(me.userId);
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
        setAutoGenerateTestSteps(ai?.autoGenerateTestSteps !== false);
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
        setTestRunEnvironments(normalizeTestRunEnvironments(parsedSettings.testRunEnvironments));
        const automation = parsedSettings.automation;
        const resolvedProvider =
          automation?.executionProvider === "lambdatest" || automation?.executionProvider === "browserstack"
            ? automation.executionProvider
            : "default";
        setExecutionProvider(resolvedProvider);
        setMaxParallel(
          typeof automation?.maxParallel === "number" && automation.maxParallel > 0
            ? Math.min(50, Math.floor(automation.maxParallel))
            : 1
        );
        setLambdaTestEndpoint(automation?.providers?.lambdatest?.endpoint ?? "");
        setLambdaTestUsername(automation?.providers?.lambdatest?.username ?? "");
        setLambdaTestAccessKey(automation?.providers?.lambdatest?.accessKey ?? "");
        setBrowserStackEndpoint(automation?.providers?.browserstack?.endpoint ?? "");
        setBrowserStackUsername(automation?.providers?.browserstack?.username ?? "");
        setBrowserStackAccessKey(automation?.providers?.browserstack?.accessKey ?? "");
        setBrowserAgent(automation?.browserAgent === "custom" ? "custom" : "default");
      }).catch(() => router.replace("/projects"));
      getJiraStatus(projectId).then(setJiraStatus).catch(() => {});
      loadMembers().catch(() => {});
    });
  }, [loadMembers, projectId, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const shouldValidateAiCredentials = activeTab === "ai";
    if (shouldValidateAiCredentials && provider === "openai" && !openAiApiKey.trim()) {
      setMessage("OpenAI API key is required for OpenAI provider.");
      return;
    }
    if (shouldValidateAiCredentials && provider === "anthropic" && !anthropicApiKey.trim()) {
      setMessage("Anthropic API key is required for Anthropic provider.");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const draftName = newEnvironmentName.trim();
      const draftUrl = newEnvironmentUrl.trim();
      if (activeTab === "testRuns" && (draftName || draftUrl)) {
        if (!draftName || !draftUrl) {
          setMessage("Environment name and URL are required.");
          return;
        }
      }
      const environmentsToSave = [...testRunEnvironments];
      if (
        activeTab === "testRuns" &&
        draftName &&
        draftUrl &&
        !environmentsToSave.some((item) => item.name.toLowerCase() === draftName.toLowerCase())
      ) {
        environmentsToSave.push({ name: draftName, url: draftUrl });
      }
      const currentSettings = parseProjectSettings(project?.settings);
      const nextSettings: ProjectSettingsPayload = {
        ...currentSettings,
        ai: {
          provider,
          model: model.trim() || undefined,
          openAiApiKey: openAiApiKey.trim(),
          anthropicApiKey: anthropicApiKey.trim(),
          autoGenerateTestSteps,
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
        automation: {
          browserAgent,
          executionProvider,
          maxParallel: Math.max(1, Math.min(50, Math.floor(maxParallel || 1))),
          providers: {
            lambdatest: {
              endpoint: lambdaTestEndpoint.trim(),
              username: lambdaTestUsername.trim(),
              accessKey: lambdaTestAccessKey.trim(),
            },
            browserstack: {
              endpoint: browserStackEndpoint.trim(),
              username: browserStackUsername.trim(),
              accessKey: browserStackAccessKey.trim(),
            },
          },
        },
        testRunEnvironments: environmentsToSave.map((item) => ({
          name: item.name.trim(),
          url: item.url.trim(),
        })),
      };
      await updateProject(projectId, {
        name,
        description,
        settings: JSON.stringify(nextSettings),
      });
      const refreshed = await getProject(projectId);
      setProject(refreshed);
      const refreshedSettings = parseProjectSettings(refreshed.settings);
      setTestRunEnvironments(normalizeTestRunEnvironments(refreshedSettings.testRunEnvironments));
      setNewEnvironmentName("");
      setNewEnvironmentUrl("");
      setMessage("Project settings saved.");
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to save project settings.";
      setMessage(text);
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
      setMessage("Automation Reports ingestion key rotated. Save project settings to persist other changes.");
    } catch {
      setMessage("Failed to rotate Automation Reports ingestion key.");
    } finally {
      setRotatingTesboKey(false);
    }
  }

  async function handleDeleteProject() {
    const projectName = String(project?.name ?? "").trim();
    if (!projectName) {
      setMessage("Project name is unavailable. Refresh and try again.");
      return;
    }
    const typedName = window.prompt(`Type "${projectName}" to confirm project deletion.`);
    if (typedName === null) return;
    if (typedName.trim() !== projectName) {
      setMessage("Project deletion cancelled. Entered name does not match.");
      return;
    }
    if (!window.confirm("Delete this project permanently? This action cannot be undone.")) return;

    setDeletingProject(true);
    setMessage(null);
    try {
      await deleteProjectRequest(projectId);
      router.replace("/projects");
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to delete project.";
      setMessage(text);
    } finally {
      setDeletingProject(false);
    }
  }

  function handleAddEnvironment() {
    const name = newEnvironmentName.trim();
    const url = newEnvironmentUrl.trim();
    if (!name || !url) {
      setMessage("Environment name and URL are required.");
      return;
    }
    if (testRunEnvironments.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
      setMessage("Environment name already exists.");
      return;
    }
    setTestRunEnvironments((prev) => [...prev, { name, url }]);
    setNewEnvironmentName("");
    setNewEnvironmentUrl("");
    setMessage(null);
  }

  function handleRemoveEnvironment(index: number) {
    setTestRunEnvironments((prev) => prev.filter((_, i) => i !== index));
  }

  const memberIds = new Set(projectMembers.map((member) => member.userId));
  const availableToAdd = workspaceMembers.filter((member) => !memberIds.has(member.userId));

  const currentUserRole = currentUserId
    ? normalizeRole(projectMembers.find((m) => m.userId === currentUserId)?.role ?? "member")
    : "member";
  const canManageMembers = currentUserRole === "owner" || currentUserRole === "admin" || currentUserRole === "manager";

  function assignableRoles(): { value: string; label: string }[] {
    if (currentUserRole === "owner") return [{ value: "owner", label: "Owner" }, { value: "admin", label: "Admin" }, { value: "manager", label: "Manager" }, { value: "member", label: "Member" }];
    if (currentUserRole === "admin") return [{ value: "manager", label: "Manager" }, { value: "member", label: "Member" }];
    if (currentUserRole === "manager") return [{ value: "member", label: "Member" }];
    return [];
  }

  function canChangeRole(member: ProjectMember): boolean {
    if (!canManageMembers) return false;
    if (member.userId === currentUserId) return false;
    const targetRole = normalizeRole(member.role);
    if (targetRole === "owner") return false;
    if (currentUserRole === "manager" && targetRole === "admin") return false;
    if (currentUserRole === "admin" && targetRole === "admin") return false;
    return true;
  }

  async function handleAddMember(e: React.FormEvent) {
    e.preventDefault();
    if (!addUserId) {
      setMemberError("Select a workspace member");
      return;
    }
    setAddingMember(true);
    setMemberError(null);
    try {
      await addProjectMember(projectId, { userId: addUserId, role: addRole });
      setAddUserId("");
      setAddRole("member");
      await loadMembers();
    } catch {
      setMemberError("Failed to add project member.");
    } finally {
      setAddingMember(false);
    }
  }

  async function handleChangeRole(userId: string, newRole: string) {
    setChangingRoleId(userId);
    setMemberError(null);
    try {
      await addProjectMember(projectId, { userId, role: newRole });
      await loadMembers();
    } catch (err) {
      const text = err instanceof Error ? err.message : "Failed to change member role.";
      setMemberError(text);
    } finally {
      setChangingRoleId(null);
    }
  }

  async function handleRemoveMember(userId: string) {
    setRemovingMemberId(userId);
    setMemberError(null);
    try {
      await removeProjectMember(projectId, userId);
      setProjectMembers((prev) => prev.filter((member) => member.userId !== userId));
    } catch {
      setMemberError("Failed to remove project member.");
    } finally {
      setRemovingMemberId(null);
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
    <main className="w-full max-w-none px-4 py-8">
      <div className="flex items-start justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Project settings</h1>
        <ThemeToggle />
      </div>
      <p className="mt-1 text-sm text-zinc-500">
        Settings are grouped into tabs so you can edit one area at a time without long scrolling.
      </p>

      <div className="mt-6 border-b border-zinc-200 dark:border-zinc-700">
        <div className="flex flex-wrap gap-0">
          {visibleTabs.map((tab) => (
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

      {(activeTab === "general" || activeTab === "testRuns" || activeTab === "ai" || activeTab === "jira" || activeTab === "tesbo") && (
        <form onSubmit={handleSubmit} className="mt-6 space-y-5">
          {activeTab === "general" && (
            <>
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
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-blue-600 text-white py-2 px-4 font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
              <div className="rounded-xl border border-red-200 dark:border-red-800/70 bg-red-50/70 dark:bg-red-900/20 p-4 space-y-2">
                <h3 className="text-sm font-semibold text-red-700 dark:text-red-300">Danger zone</h3>
                <p className="text-sm text-red-700/90 dark:text-red-200/90">
                  Deleting a project permanently removes its test cases, runs, reports, and integrations.
                </p>
                <button
                  type="button"
                  onClick={() => handleDeleteProject().catch(() => {})}
                  disabled={deletingProject}
                  className="rounded-lg bg-red-600 text-white py-2 px-4 text-sm font-medium hover:bg-red-700 disabled:opacity-50"
                >
                  {deletingProject ? "Deleting project…" : "Delete project"}
                </button>
              </div>
            </>
          )}

          {activeTab === "testRuns" && (
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 space-y-4">
              <div>
                <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Test Run Environments</h2>
                <p className="mt-1 text-sm text-zinc-500">
                  Add environment name and URL. Test run creation will require selecting one.
                </p>
              </div>
              <div className="space-y-2">
                {testRunEnvironments.length === 0 ? (
                  <p className="text-sm text-zinc-500">No environments added yet.</p>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-700">
                    <table className="min-w-full text-sm">
                      <thead className="bg-zinc-50 dark:bg-zinc-800/60">
                        <tr className="text-left text-zinc-600 dark:text-zinc-300">
                          <th className="px-3 py-2.5 font-medium">Environment</th>
                          <th className="px-3 py-2.5 font-medium">URL</th>
                          <th className="px-3 py-2.5 font-medium text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {testRunEnvironments.map((env, index) => (
                          <tr
                            key={`${env.name}-${index}`}
                            className="border-t border-zinc-200 dark:border-zinc-700"
                          >
                            <td className="px-3 py-2.5 text-zinc-900 dark:text-zinc-100">{env.name}</td>
                            <td className="px-3 py-2.5 text-zinc-600 dark:text-zinc-300 break-all">{env.url}</td>
                            <td className="px-3 py-2.5 text-right">
                              <button
                                type="button"
                                onClick={() => handleRemoveEnvironment(index)}
                                className="rounded-md border border-red-200 dark:border-red-800 px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                              >
                                Remove
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <input
                  type="text"
                  value={newEnvironmentName}
                  onChange={(e) => setNewEnvironmentName(e.target.value)}
                  placeholder="Environment name"
                  className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
                />
                <input
                  type="url"
                  value={newEnvironmentUrl}
                  onChange={(e) => setNewEnvironmentUrl(e.target.value)}
                  placeholder="https://staging.example.com"
                  className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
                />
                <button
                  type="button"
                  onClick={handleAddEnvironment}
                  className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  Add
                </button>
              </div>
              <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3 space-y-3">
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Automation Execution</h3>
                  <p className="mt-1 text-xs text-zinc-500">
                    Configure how automated test cases execute in parallel and which provider is used.
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-sm text-zinc-700 dark:text-zinc-300">
                    Execution provider
                    <select
                      value={executionProvider}
                      onChange={(e) => setExecutionProvider(e.target.value as "default" | "lambdatest" | "browserstack")}
                      className="mt-1 w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2"
                    >
                      <option value="default">Default</option>
                      <option value="lambdatest">LambdaTest</option>
                      <option value="browserstack">BrowserStack</option>
                    </select>
                  </label>
                  <label className="text-sm text-zinc-700 dark:text-zinc-300">
                    Max parallel jobs
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={maxParallel}
                      onChange={(e) => setMaxParallel(Number(e.target.value || 1))}
                      className="mt-1 w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2"
                    />
                  </label>
                </div>
                {executionProvider === "lambdatest" && (
                  <div className="grid gap-2 sm:grid-cols-3">
                    <input
                      type="url"
                      value={lambdaTestEndpoint}
                      onChange={(e) => setLambdaTestEndpoint(e.target.value)}
                      placeholder="LambdaTest endpoint"
                      className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
                    />
                    <input
                      type="text"
                      value={lambdaTestUsername}
                      onChange={(e) => setLambdaTestUsername(e.target.value)}
                      placeholder="LambdaTest username"
                      className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
                    />
                    <input
                      type="password"
                      value={lambdaTestAccessKey}
                      onChange={(e) => setLambdaTestAccessKey(e.target.value)}
                      placeholder="LambdaTest access key"
                      className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
                    />
                  </div>
                )}
                {executionProvider === "browserstack" && (
                  <div className="grid gap-2 sm:grid-cols-3">
                    <input
                      type="url"
                      value={browserStackEndpoint}
                      onChange={(e) => setBrowserStackEndpoint(e.target.value)}
                      placeholder="BrowserStack endpoint"
                      className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
                    />
                    <input
                      type="text"
                      value={browserStackUsername}
                      onChange={(e) => setBrowserStackUsername(e.target.value)}
                      placeholder="BrowserStack username"
                      className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
                    />
                    <input
                      type="password"
                      value={browserStackAccessKey}
                      onChange={(e) => setBrowserStackAccessKey(e.target.value)}
                      placeholder="BrowserStack access key"
                      className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
                    />
                  </div>
                )}
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
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                  {provider === "openai" ? "OpenAI API Key" : "Anthropic API Key"}
                </label>
                <input
                  type="password"
                  value={provider === "openai" ? openAiApiKey : anthropicApiKey}
                  onChange={(e) => {
                    if (provider === "openai") {
                      setOpenAiApiKey(e.target.value);
                      return;
                    }
                    setAnthropicApiKey(e.target.value);
                  }}
                  placeholder={provider === "openai" ? "sk-..." : "sk-ant-..."}
                  className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2"
                />
              </div>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoGenerateTestSteps}
                  onChange={(e) => setAutoGenerateTestSteps(e.target.checked)}
                  className="mt-0.5"
                />
                <div>
                  <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    Auto-generate Test Steps from Automate
                  </span>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    When enabled, saving an Automate session updates both Playwright script and Test Steps. When
                    disabled, only the Playwright script is updated.
                  </p>
                </div>
              </label>
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
                <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Automation Reports</h2>
                <p className="mt-1 text-sm text-zinc-500">
                  Controls for embedded Automation Reports features in this project.
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
                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Enable Automation Reports alerts</span>
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
                Automation Reports alert rules are managed in the Alerts tab.
              </p>
            </div>
          )}

          {message && (
            <p className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/30 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300">
              {message}
            </p>
          )}
          {activeTab !== "general" && (
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-blue-600 text-white py-2 px-4 font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          )}
        </form>
      )}

      {activeTab === "members" && (
        <section className="mt-6 space-y-5">
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4">
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Project members</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Members added here can perform actions inside this project based on their project role.
            </p>
            <div className="mt-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/50 p-3 text-xs text-zinc-600 dark:text-zinc-300 space-y-1">
              <p><strong>Owner:</strong> Full access to all features and can add admins.</p>
              <p><strong>Admin:</strong> Similar to owner, but cannot add or remove owners/admins.</p>
              <p><strong>Manager:</strong> Can invite members and manage project operations.</p>
              <p><strong>Member:</strong> Can work inside assigned projects, but cannot invite or create projects.</p>
            </div>
          </div>

          {availableToAdd.length > 0 && canManageMembers && (
            <form onSubmit={handleAddMember} className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
                <div>
                  <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                    Add workspace member
                  </label>
                  <select
                    value={addUserId}
                    onChange={(e) => setAddUserId(e.target.value)}
                    className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-zinc-900 dark:text-zinc-100"
                    disabled={addingMember || membersLoading}
                  >
                    <option value="">Select member…</option>
                    {availableToAdd.map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {member.name || member.email} ({member.email})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                    Role
                  </label>
                  <select
                    value={addRole}
                    onChange={(e) => setAddRole(e.target.value)}
                    className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-zinc-900 dark:text-zinc-100"
                    disabled={addingMember || membersLoading}
                  >
                    {assignableRoles().map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                </div>
                <button
                  type="submit"
                  disabled={addingMember || !addUserId || membersLoading}
                  className="rounded-lg bg-blue-600 text-white py-2 px-4 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  {addingMember ? "Adding…" : "Add member"}
                </button>
              </div>
            </form>
          )}

          {memberError && (
            <p className="text-sm text-red-600 dark:text-red-400">{memberError}</p>
          )}

          <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-zinc-50 dark:bg-zinc-800/60">
                  <tr className="text-left text-zinc-600 dark:text-zinc-300">
                    <th className="px-4 py-3 font-medium">Name</th>
                    <th className="px-4 py-3 font-medium">Email</th>
                    <th className="px-4 py-3 font-medium">Role</th>
                    <th className="px-4 py-3 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {projectMembers.map((member) => {
                    const editable = canChangeRole(member);
                    return (
                    <tr key={member.userId} className="border-t border-zinc-200 dark:border-zinc-700">
                      <td className="px-4 py-3 text-zinc-900 dark:text-zinc-100">
                        {member.name || "—"}
                        {member.userId === currentUserId && (
                          <span className="ml-1.5 text-xs text-zinc-400">(you)</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">{member.email}</td>
                      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">
                        {editable ? (
                          <select
                            value={normalizeRole(member.role)}
                            onChange={(e) => handleChangeRole(member.userId, e.target.value)}
                            disabled={changingRoleId === member.userId}
                            className="rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2 py-1 text-sm text-zinc-900 dark:text-zinc-100 disabled:opacity-50"
                          >
                            {assignableRoles().map((r) => (
                              <option key={r.value} value={r.value}>{r.label}</option>
                            ))}
                          </select>
                        ) : (
                          <span className="inline-flex items-center rounded-md bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                            {roleLabel(member.role)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {canManageMembers && member.userId !== currentUserId && normalizeRole(member.role) !== "owner" && (
                          <button
                            type="button"
                            onClick={() => handleRemoveMember(member.userId)}
                            disabled={removingMemberId === member.userId}
                            className="text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
                          >
                            {removingMemberId === member.userId ? "Removing…" : "Remove"}
                          </button>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                  {!membersLoading && projectMembers.length === 0 && (
                    <tr className="border-t border-zinc-200 dark:border-zinc-700">
                      <td colSpan={4} className="px-4 py-6 text-center text-zinc-500 dark:text-zinc-400">
                        No members are assigned to this project yet.
                      </td>
                    </tr>
                  )}
                  {membersLoading && (
                    <tr className="border-t border-zinc-200 dark:border-zinc-700">
                      <td colSpan={4} className="px-4 py-6 text-center text-zinc-500 dark:text-zinc-400">
                        Loading members…
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
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
