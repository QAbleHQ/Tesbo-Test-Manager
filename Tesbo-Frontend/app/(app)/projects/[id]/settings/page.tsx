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
  listProjectMembers,
  listWorkspaceMembers,
  addProjectMember,
  removeProjectMember,
  type JiraConnection,
  type TestEnvironmentSetting,
} from "@/lib/api";
import ThemeToggle from "@/components/ThemeToggle";
import {
  Button,
  Input,
  Card,
  Modal,
  Select,
  Textarea,
  Field,
  FieldLabel,
} from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

type ProjectSettingsPayload = {
  ai?: {
    enabled?: boolean;
  };
  jiraAutoComment?: boolean;
  jiraTicketSelector?: boolean;
  testRunEnvironments?: Array<{
    name?: string;
    url?: string;
  }>;
  [key: string]: unknown;
};

type SettingsTab = "general" | "testRuns" | "members" | "jira" | "integrations";
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
  const [jiraAutoComment, setJiraAutoComment] = useState(false);
  const [jiraTicketSelector, setJiraTicketSelector] = useState(false);
  const [testRunEnvironments, setTestRunEnvironments] = useState<TestEnvironmentSetting[]>([]);
  const [newEnvironmentName, setNewEnvironmentName] = useState("");
  const [newEnvironmentUrl, setNewEnvironmentUrl] = useState("");
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
  const [deleteProjectModalOpen, setDeleteProjectModalOpen] = useState(false);
  const [deleteProjectTypedName, setDeleteProjectTypedName] = useState("");
  const jiraTabEnabled = jiraStatus?.connected === true;
  const visibleTabs: Array<{ key: SettingsTab; label: string }> = [
    { key: "general", label: "General" },
    { key: "testRuns", label: "Test Environments" },
    { key: "members", label: "Members" },
    ...(jiraTabEnabled ? [{ key: "jira" as const, label: "Jira" }] : []),
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
        setJiraAutoComment(parsedSettings.jiraAutoComment === true);
        setJiraTicketSelector(parsedSettings.jiraTicketSelector === true);
        setTestRunEnvironments(normalizeTestRunEnvironments(parsedSettings.testRunEnvironments));
      }).catch(() => router.replace("/projects"));
      getJiraStatus(projectId).then(setJiraStatus).catch(() => {});
      loadMembers().catch(() => {});
    });
  }, [loadMembers, projectId, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
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
        jiraAutoComment,
        jiraTicketSelector,
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

  async function handleDeleteProject() {
    const projectName = String(project?.name ?? "").trim();
    if (!projectName) {
      setMessage("Project name is unavailable. Refresh and try again.");
      return;
    }
    if (deleteProjectTypedName.trim() !== projectName) {
      setMessage("Project deletion cancelled. Entered name does not match.");
      return;
    }

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
      setDeleteProjectModalOpen(false);
      setDeleteProjectTypedName("");
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
      <StandardPageLayout header={<PageHeader title="Project settings" />}>
        <div className="flex min-h-[200px] items-center justify-center">
          <p className="text-[var(--muted)]">Loading…</p>
        </div>
      </StandardPageLayout>
    );
  }

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Project settings"
          subtitle="Settings are grouped into tabs so you can edit one area at a time without long scrolling."
          actions={<ThemeToggle />}
        />
      }
    >
      <div className="border-b border-[var(--border)]">
        <div className="flex flex-wrap gap-0">
          {visibleTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key as SettingsTab)}
              className={`px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                activeTab === tab.key
                  ? "border-[var(--brand-primary)] text-[var(--brand-primary)]"
                  : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {(activeTab === "general" || activeTab === "testRuns" || activeTab === "jira") && (
        <form onSubmit={handleSubmit} className="space-y-5">
          {activeTab === "general" && (
            <>
              <Card className="p-4 space-y-4">
                <div>
                  <h2 className="text-base font-semibold text-[var(--foreground)]">General</h2>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    Basic project details shown across the workspace.
                  </p>
                </div>
                <Field>
                  <FieldLabel>Name</FieldLabel>
                  <Input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel>Description</FieldLabel>
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                  />
                </Field>
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </Button>
              </Card>
              <div className="rounded-xl border border-[var(--error)]/30 bg-[color-mix(in_oklab,var(--error)_8%,white)] p-4 space-y-2">
                <h3 className="text-sm font-semibold text-[var(--error)]">Danger zone</h3>
                <p className="text-sm text-[var(--error)]/90">
                  Deleting a project permanently removes its test cases, runs, reports, and integrations.
                </p>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    setDeleteProjectTypedName("");
                    setDeleteProjectModalOpen(true);
                  }}
                  disabled={deletingProject}
                  size="sm"
                >
                  {deletingProject ? "Deleting project…" : "Delete project"}
                </Button>
              </div>
            </>
          )}

          {activeTab === "testRuns" && (
            <Card className="p-4 space-y-4">
              <div>
                <h2 className="text-base font-semibold text-[var(--foreground)]">Test Run Environments</h2>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  Add environment name and URL. Test run creation will require selecting one.
                </p>
              </div>
              <div className="space-y-2">
                {testRunEnvironments.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">No environments added yet.</p>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
                    <table className="tesbo-table min-w-full text-sm">
                      <thead>
                        <tr className="text-left text-[var(--muted)]">
                          <th className="px-3 py-2.5 font-medium">Environment</th>
                          <th className="px-3 py-2.5 font-medium">URL</th>
                          <th className="px-3 py-2.5 font-medium text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {testRunEnvironments.map((env, index) => (
                          <tr key={`${env.name}-${index}`}>
                            <td className="px-3 py-2.5 text-[var(--foreground)]">{env.name}</td>
                            <td className="px-3 py-2.5 text-[var(--muted)] break-all">{env.url}</td>
                            <td className="px-3 py-2.5 text-right">
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                onClick={() => handleRemoveEnvironment(index)}
                                className="text-[var(--error)] text-xs"
                              >
                                Remove
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <Input
                  type="text"
                  value={newEnvironmentName}
                  onChange={(e) => setNewEnvironmentName(e.target.value)}
                  placeholder="Environment name"
                />
                <Input
                  type="url"
                  value={newEnvironmentUrl}
                  onChange={(e) => setNewEnvironmentUrl(e.target.value)}
                  placeholder="https://staging.example.com"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleAddEnvironment}
                >
                  Add
                </Button>
              </div>
            </Card>
          )}

          {activeTab === "jira" && (
            <Card className="p-4 space-y-4">
              <div>
                <h2 className="text-base font-semibold text-[var(--foreground)]">Jira + AI Generation</h2>
                <p className="mt-1 text-sm text-[var(--muted)]">
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
                  <span className="text-sm font-medium text-[var(--foreground)]">Auto-comment on Jira ticket</span>
                  <p className="text-xs text-[var(--muted)] mt-0.5">
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
                  <span className="text-sm font-medium text-[var(--foreground)]">Jira ticket selector on AI Generation</span>
                  <p className="text-xs text-[var(--muted)] mt-0.5">
                    Show a Jira ticket search dropdown on the AI Test Generation page so users can pick a ticket directly without going through the Knowledge Base.
                  </p>
                </div>
              </label>
            </Card>
          )}
          {message && (
            <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 text-sm text-[var(--foreground)]">
              {message}
            </p>
          )}
          {activeTab !== "general" && (
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          )}
        </form>
      )}

      {activeTab === "members" && (
        <section className="space-y-5">
          <Card className="p-4">
            <h2 className="text-base font-semibold text-[var(--foreground)]">Project members</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Members added here can perform actions inside this project based on their project role.
            </p>
            <div className="mt-3 rounded-lg bg-[var(--surface-secondary)] p-3 text-xs text-[var(--muted)] space-y-1">
              <p><strong>Owner:</strong> Full access to all features and can add admins.</p>
              <p><strong>Admin:</strong> Similar to owner, but cannot add or remove owners/admins.</p>
              <p><strong>Manager:</strong> Can invite members and manage project operations.</p>
              <p><strong>Member:</strong> Can work inside assigned projects, but cannot invite or create projects.</p>
            </div>
          </Card>

          {availableToAdd.length > 0 && canManageMembers && (
            <form onSubmit={handleAddMember}>
              <Card className="p-4">
                <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
                  <Field>
                    <FieldLabel>Add workspace member</FieldLabel>
                    <Select
                      value={addUserId}
                      onChange={(e) => setAddUserId(e.target.value)}
                      disabled={addingMember || membersLoading}
                    >
                      <option value="">Select member…</option>
                      {availableToAdd.map((member) => (
                        <option key={member.userId} value={member.userId}>
                          {member.name || member.email} ({member.email})
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel>Role</FieldLabel>
                    <Select
                      value={addRole}
                      onChange={(e) => setAddRole(e.target.value)}
                      disabled={addingMember || membersLoading}
                    >
                      {assignableRoles().map((r) => (
                        <option key={r.value} value={r.value}>{r.label}</option>
                      ))}
                    </Select>
                  </Field>
                  <Button
                    type="submit"
                    disabled={addingMember || !addUserId || membersLoading}
                    size="sm"
                  >
                    {addingMember ? "Adding…" : "Add member"}
                  </Button>
                </div>
              </Card>
            </form>
          )}

          {memberError && (
            <p className="text-sm text-[var(--error)]">{memberError}</p>
          )}

          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="tesbo-table min-w-full text-sm">
                <thead>
                  <tr className="text-left text-[var(--muted)]">
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
                    <tr key={member.userId}>
                      <td className="px-4 py-3 text-[var(--foreground)]">
                        {member.name || "—"}
                        {member.userId === currentUserId && (
                          <span className="ml-1.5 text-xs text-[var(--muted-soft)]">(you)</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-[var(--muted)]">{member.email}</td>
                      <td className="px-4 py-3 text-[var(--muted)]">
                        {editable ? (
                          <Select
                            value={normalizeRole(member.role)}
                            onChange={(e) => handleChangeRole(member.userId, e.target.value)}
                            disabled={changingRoleId === member.userId}
                            className="h-8 w-auto min-w-[100px] px-2 py-1 text-sm"
                          >
                            {assignableRoles().map((r) => (
                              <option key={r.value} value={r.value}>{r.label}</option>
                            ))}
                          </Select>
                        ) : (
                          <span className="inline-flex items-center rounded-md bg-[var(--surface-secondary)] px-2 py-0.5 text-xs font-medium text-[var(--foreground)]">
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
                            className="text-[var(--error)] hover:underline disabled:opacity-50"
                          >
                            {removingMemberId === member.userId ? "Removing…" : "Remove"}
                          </button>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                  {!membersLoading && projectMembers.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-4 py-6 text-center text-[var(--muted)]">
                        No members are assigned to this project yet.
                      </td>
                    </tr>
                  )}
                  {membersLoading && (
                    <tr>
                      <td colSpan={4} className="px-4 py-6 text-center text-[var(--muted)]">
                        Loading members…
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </section>
      )}
      {activeTab === "integrations" && (
        <Card className="p-4 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--foreground)]">App Integrations</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Connect external tools and services to enrich your project.
            </p>
          </div>

          {/* Jira Card */}
          <div className="rounded-lg border border-[var(--border)] p-4 flex items-start gap-4">
            <div className="shrink-0 w-10 h-10 rounded-lg bg-[var(--brand-primary)] flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="w-6 h-6 text-white" fill="currentColor">
                <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53ZM6.77 6.8a4.362 4.362 0 0 0 4.34 4.34h1.8v1.72a4.362 4.362 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.84-.84H6.77ZM2 11.6c0 2.4 1.95 4.34 4.35 4.35h1.78v1.71c0 2.4 1.95 4.35 4.35 4.35V12.44a.84.84 0 0 0-.84-.84H2Z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-[var(--foreground)]">Jira</h3>
              <p className="text-xs text-[var(--muted)] mt-0.5">
                Import tickets from Jira to use as knowledge base for test generation.
              </p>
              {jiraStatus?.connected && (
                <div className="mt-2 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-2 h-2 rounded-full bg-[var(--success)]" />
                    <span className="text-xs text-[var(--success)] font-medium">Connected</span>
                    <span className="text-xs text-[var(--muted-soft)]">·</span>
                    <a
                      href={jiraStatus.siteUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-[var(--brand-primary)] hover:underline truncate"
                    >
                      {jiraStatus.siteUrl}
                    </a>
                  </div>
                  {jiraStatus.connectedProjects && jiraStatus.connectedProjects.length > 0 && (
                    <p className="text-xs text-[var(--muted)]">
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
                    className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)] transition-colors"
                  >
                    Manage
                  </Link>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={handleDisconnectJira}
                    disabled={jiraLoading}
                    className="border-[var(--error)]/50 text-[var(--error)] hover:bg-[color-mix(in_oklab,var(--error)_8%,white)]"
                  >
                    Disconnect
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={handleConnectJira}
                  disabled={jiraLoading}
                >
                  {jiraLoading ? "Connecting…" : "Connect"}
                </Button>
              )}
            </div>
          </div>

          {/* Placeholder for future integrations */}
          <div className="rounded-lg border border-dashed border-[var(--border)] p-4 flex items-center gap-4 opacity-60">
            <div className="shrink-0 w-10 h-10 rounded-lg bg-[var(--surface-tertiary)] flex items-center justify-center">
              <svg className="w-5 h-5 text-[var(--muted-soft)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-medium text-[var(--muted)]">More integrations coming soon</h3>
              <p className="text-xs text-[var(--muted-soft)] mt-0.5">Slack, GitHub, Azure DevOps and more.</p>
            </div>
          </div>
        </Card>
      )}

      {(activeTab === "alerts" || activeTab === "integrations") && message && (
        <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 text-sm text-[var(--foreground)]">
          {message}
        </p>
      )}
      <Modal
        open={deleteProjectModalOpen}
        onClose={() => {
          if (deletingProject) return;
          setDeleteProjectModalOpen(false);
        }}
        title="Confirm project deletion"
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--muted)]">
            This action permanently deletes the project and all related test cases, runs, reports, and integrations.
          </p>
          <Field>
            <FieldLabel>Type project name to confirm</FieldLabel>
            <Input
              type="text"
              value={deleteProjectTypedName}
              onChange={(event) => setDeleteProjectTypedName(event.target.value)}
              placeholder={String(project?.name ?? "")}
              disabled={deletingProject}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setDeleteProjectModalOpen(false);
                setDeleteProjectTypedName("");
              }}
              disabled={deletingProject}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => handleDeleteProject().catch(() => {})}
              disabled={deletingProject}
            >
              {deletingProject ? "Deleting project…" : "Delete project permanently"}
            </Button>
          </div>
        </div>
      </Modal>
    </StandardPageLayout>
  );
}
