"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { IconChevronRight, IconKey, IconSettings, IconStack2, IconTrash } from "@tabler/icons-react";
import {
  authMe,
  getProject,
  updateProject,
  deleteProject as deleteProjectRequest,
  getJiraStatus,
  getBillingInfo,
  getLinearStatus,
  listProjectMembers,
  listWorkspaceMembers,
  addProjectMember,
  removeProjectMember,
  listApiKeys,
  listCustomFieldDefinitions,
  type JiraConnection,
  type LinearConnection,
  type ProjectIcon,
  type TestEnvironmentSetting,
} from "@/lib/api";
import { useTopBarSlots } from "@/components/TopBarSlots";
import {
  Button,
  Input,
  Card,
  Modal,
  ConfirmModal,
  Select,
  Textarea,
  Field,
  FieldError,
  FieldLabel,
  PageLoader,
} from "@/components/ui";
import { ProjectIconPicker, type ProjectIconValue } from "@/components/ProjectIconPicker";
import { avatarColor } from "@/lib/avatarColors";
import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  ENVIRONMENT_NAME_MAX_LENGTH,
  ENVIRONMENT_URL_MAX_LENGTH,
  validateProjectDescription,
  validateProjectIconGlyph,
  validateProjectName,
  validateEnvironmentName,
  validateEnvironmentUrl,
} from "@/lib/validation";

const EMPTY_ICON: ProjectIconValue = { color: null, glyph: null };

function extractProjectIcon(raw: unknown): ProjectIcon | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const icon = (raw as { icon?: unknown }).icon;
  if (!icon || typeof icon !== "object" || Array.isArray(icon)) return null;
  const color = (icon as { color?: unknown }).color;
  const glyph = (icon as { glyph?: unknown }).glyph;
  return {
    color: typeof color === "string" ? color : null,
    glyph: typeof glyph === "string" ? glyph : null,
  };
}

type ProjectSettingsPayload = {
  ai?: {
    enabled?: boolean;
  };
  testcaseIdPrefix?: string;
  testRunEnvironments?: Array<{
    name?: string;
    url?: string;
  }>;
  [key: string]: unknown;
};

type SettingsTab = "general" | "testRuns" | "members" | "apiTokens" | "customFields" | "integrations";
type ProjectMember = { userId: string; email: string; name: string; role: string; joinedAt: string };
type WorkspaceMember = { userId: string; email: string; name: string; role: string; joinedAt: string };

const PLATFORM_ROLES = [
  { value: "owner", label: "Owner" },
  { value: "manager", label: "Manager" },
  { value: "qa_engineer", label: "QA Engineer" },
] as const;

function normalizeRole(role: string): "owner" | "manager" | "qa_engineer" {
  const n = (role ?? "").trim().toLowerCase().replace(/-/g, "_").replace(/ /g, "_");
  if (n === "owner") return "owner";
  if (["manager", "admin", "test_manager"].includes(n)) return "manager";
  return "qa_engineer";
}

function roleLabel(role: string): string {
  const n = normalizeRole(role);
  if (n === "owner") return "Owner";
  if (n === "manager") return "Manager";
  return "QA Engineer";
}

export default function ProjectSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.id as string;
  const [project, setProject] = useState<Record<string, unknown> | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nameError, setNameError] = useState("");
  const [descriptionError, setDescriptionError] = useState("");
  const [icon, setIcon] = useState<ProjectIconValue>(EMPTY_ICON);
  const [iconGlyphError, setIconGlyphError] = useState("");
  const [testcaseIdPrefix, setTestcaseIdPrefix] = useState("");
  const [testRunEnvironments, setTestRunEnvironments] = useState<TestEnvironmentSetting[]>([]);
  const [newEnvironmentName, setNewEnvironmentName] = useState("");
  const [newEnvironmentUrl, setNewEnvironmentUrl] = useState("");
  const [newEnvironmentNameError, setNewEnvironmentNameError] = useState("");
  const [newEnvironmentUrlError, setNewEnvironmentUrlError] = useState("");
  const [deleteProjectError, setDeleteProjectError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [jiraStatus, setJiraStatus] = useState<JiraConnection | null>(null);
  const [linearStatus, setLinearStatus] = useState<LinearConnection | null>(null);
  /*
   * Basecamp 10191178824 — "Linear is restricted behind a Pro upgrade in Workspace Settings, but the
   * same integration is available in Project Settings → Integrations".
   *
   * The workspace tab locks its Linear card with `proOnly && !isPro && !connected`; this screen had no
   * plan awareness at all, so a Launch workspace saw a plain "Connect in Workspace Settings" button
   * here and a Pro lock there. The server does enforce the gate — integrationCallback calls
   * assertIntegrationAllowed — so this was never a bypass; the user just did not learn about the
   * restriction until after following the button, which is why the two screens read as contradicting.
   *
   * Mirrors the workspace tab's condition rather than inventing a second rule. `null` means "not known
   * yet", so the card never flashes a lock it may not need.
   */
  const [linearIsPro, setLinearIsPro] = useState<boolean | null>(null);
  const linearLocked = linearIsPro === false && !linearStatus?.connected;
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [addMemberError, setAddMemberError] = useState<string | null>(null);
  const [addUserId, setAddUserId] = useState("");
  const [addRole, setAddRole] = useState<string>("qa_engineer");
  const [addingMember, setAddingMember] = useState(false);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [pendingMemberRemoval, setPendingMemberRemoval] = useState<{ userId: string; label: string } | null>(null);
  const [changingRoleId, setChangingRoleId] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [apiTokenCount, setApiTokenCount] = useState<number | null>(null);
  const [customFieldCount, setCustomFieldCount] = useState<number | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const [deleteProjectModalOpen, setDeleteProjectModalOpen] = useState(false);
  const [deleteProjectTypedName, setDeleteProjectTypedName] = useState("");
  const [toast, setToast] = useState("");
  const { startEl: topBarStartEl, setFilled: setTopBarFilled } = useTopBarSlots();
  // Hoisted above visibleTabs (rather than computed further down with the rest of the
  // members logic) because the Custom Fields tab needs the role check to decide whether
  // to even appear — unlike every other tab, which stays visible with only in-tab actions
  // gated, this one must be absent (not just read-only) for non-owner/manager roles.
  const currentUserRole = currentUserId
    ? normalizeRole(projectMembers.find((m) => m.userId === currentUserId)?.role ?? "qa_engineer")
    : "qa_engineer";
  const canManageCustomFields = currentUserRole === "owner" || currentUserRole === "manager";
  const visibleTabs = useMemo<Array<{ key: SettingsTab; label: string }>>(
    () => [
      { key: "general", label: "General" },
      { key: "testRuns", label: "Test Environments" },
      { key: "members", label: "Team Members" },
      { key: "apiTokens", label: "API & MCP" },
      ...(canManageCustomFields ? [{ key: "customFields" as const, label: "Custom Fields" }] : []),
      { key: "integrations", label: "Integrations" },
    ],
    [canManageCustomFields]
  );

  useEffect(() => {
    const tab = searchParams.get("tab");
    if (!tab) return;
    const tabAliases: Record<string, SettingsTab> = {
      environments: "testRuns",
      testEnvironments: "testRuns",
      team: "members",
      teamMembers: "members",
      // Jira no longer has its own tab — its settings live on the Jira integration page, which is
      // one click away from the Integrations tab. Keeps old ?tab=jira links from landing nowhere.
      jira: "integrations",
    };
    const normalizedTab = tabAliases[tab] ?? tab;
    const allowed: SettingsTab[] = visibleTabs.map((item) => item.key);
    if (allowed.includes(normalizedTab as SettingsTab)) {
      setActiveTab(normalizedTab as SettingsTab);
    }
  }, [searchParams, visibleTabs]);

  useEffect(() => {
    setTopBarFilled(true);
    return () => setTopBarFilled(false);
  }, [setTopBarFilled]);

  function parseProjectSettings(raw: unknown): ProjectSettingsPayload {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as ProjectSettingsPayload;
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

  function normalizeTestcaseIdPrefix(value: string): string {
    return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
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
        setTestcaseIdPrefix(normalizeTestcaseIdPrefix(String(parsedSettings.testcaseIdPrefix || p.key || "TC")));
        setTestRunEnvironments(normalizeTestRunEnvironments(parsedSettings.testRunEnvironments));
        const savedIcon = extractProjectIcon(parsedSettings);
        setIcon({ color: savedIcon?.color ?? null, glyph: savedIcon?.glyph ?? null });
      }).catch(() => router.replace("/projects"));
      getJiraStatus(projectId).then(setJiraStatus).catch(() => {});
      getLinearStatus(projectId).then(setLinearStatus).catch(() => {});
      getBillingInfo()
        .then((billing) => setLinearIsPro(billing.plan === "pro"))
        .catch(() => setLinearIsPro(null));
      listApiKeys(projectId).then((l) => setApiTokenCount(l.length)).catch(() => {});
      listCustomFieldDefinitions(projectId).then((l) => setCustomFieldCount(l.length)).catch(() => {});
      loadMembers().catch(() => {});
    });
  }, [loadMembers, projectId, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    const nameValidationError = validateProjectName(name);
    if (nameValidationError) {
      setNameError(nameValidationError);
      return;
    }
    const descriptionValidationError = validateProjectDescription(description);
    if (descriptionValidationError) {
      setDescriptionError(descriptionValidationError);
      return;
    }
    const iconGlyphValidationError = validateProjectIconGlyph(icon.glyph ?? "");
    if (iconGlyphValidationError) {
      setIconGlyphError(iconGlyphValidationError);
      return;
    }
    setSaving(true);
    try {
      const draftName = newEnvironmentName.trim();
      const draftUrl = newEnvironmentUrl.trim();
      // Only blocks the save (and only looks at these two fields) while the Test Environments tab
      // is active — leftover text left in an unrelated, hidden tab's inputs shouldn't stop someone
      // from saving a name/description change on the General tab.
      const hasDraftEnvironment = activeTab === "testRuns" && Boolean(draftName || draftUrl);
      if (hasDraftEnvironment) {
        const draftNameError = validateEnvironmentName(newEnvironmentName, testRunEnvironments);
        const draftUrlError = validateEnvironmentUrl(newEnvironmentUrl, testRunEnvironments);
        if (draftNameError || draftUrlError) {
          setNewEnvironmentNameError(draftNameError);
          setNewEnvironmentUrlError(draftUrlError);
          return;
        }
      }
      const environmentsToSave = [...testRunEnvironments];
      if (hasDraftEnvironment) {
        environmentsToSave.push({ name: draftName, url: draftUrl });
      }
      const currentSettings = parseProjectSettings(project?.settings);
      const nextSettings: ProjectSettingsPayload = {
        ...currentSettings,
        testcaseIdPrefix: normalizeTestcaseIdPrefix(testcaseIdPrefix) || "TC",
        testRunEnvironments: environmentsToSave.map((item) => ({
          name: item.name.trim(),
          url: item.url.trim(),
        })),
      };
      await updateProject(projectId, {
        name,
        description,
        settings: JSON.stringify(nextSettings),
        icon: { color: icon.color, glyph: icon.glyph?.trim() || null },
      });
      const refreshed = await getProject(projectId);
      setProject(refreshed);
      const refreshedSettings = parseProjectSettings(refreshed.settings);
      setTestcaseIdPrefix(normalizeTestcaseIdPrefix(String(refreshedSettings.testcaseIdPrefix || refreshed.key || "TC")));
      setTestRunEnvironments(normalizeTestRunEnvironments(refreshedSettings.testRunEnvironments));
      const savedIcon = extractProjectIcon(refreshedSettings);
      setIcon({ color: savedIcon?.color ?? null, glyph: savedIcon?.glyph ?? null });
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

  async function handleDeleteProject() {
    const projectName = String(project?.name ?? "").trim();
    if (!projectName) {
      setDeleteProjectError("Project name is unavailable. Refresh and try again.");
      return;
    }
    if (deleteProjectTypedName.trim() !== projectName) {
      setDeleteProjectError("Entered name does not match. Deletion cancelled.");
      return;
    }

    setDeletingProject(true);
    setDeleteProjectError(null);
    try {
      await deleteProjectRequest(projectId);
      setDeleteProjectModalOpen(false);
      setDeleteProjectTypedName("");
      router.replace("/projects");
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to delete project.";
      setDeleteProjectError(text);
    } finally {
      setDeletingProject(false);
    }
  }

  function handleAddEnvironment() {
    const nameValidationError = validateEnvironmentName(newEnvironmentName, testRunEnvironments);
    const urlValidationError = validateEnvironmentUrl(newEnvironmentUrl, testRunEnvironments);
    setNewEnvironmentNameError(nameValidationError);
    setNewEnvironmentUrlError(urlValidationError);
    if (nameValidationError || urlValidationError) return;
    setTestRunEnvironments((prev) => [...prev, { name: newEnvironmentName.trim(), url: newEnvironmentUrl.trim() }]);
    setNewEnvironmentName("");
    setNewEnvironmentUrl("");
    setNewEnvironmentNameError("");
    setNewEnvironmentUrlError("");
  }

  function handleRemoveEnvironment(index: number) {
    setTestRunEnvironments((prev) => prev.filter((_, i) => i !== index));
  }

  function handleTabChange(tab: SettingsTab) {
    setActiveTab(tab);
    router.replace(`/projects/${projectId}/settings?tab=${tab}`, { scroll: false });
  }

  const memberIds = new Set(projectMembers.map((member) => member.userId));
  const availableToAdd = workspaceMembers.filter((member) => !memberIds.has(member.userId));

  const canManageMembers = canManageCustomFields;

  function assignableRoles(): { value: string; label: string }[] {
    if (currentUserRole === "owner") return [{ value: "manager", label: "Manager" }, { value: "qa_engineer", label: "QA Engineer" }];
    if (currentUserRole === "manager") return [{ value: "qa_engineer", label: "QA Engineer" }];
    return [];
  }

  function canChangeRole(member: ProjectMember): boolean {
    if (!canManageMembers) return false;
    if (member.userId === currentUserId) return false;
    const targetRole = normalizeRole(member.role);
    if (targetRole === "owner") return false;
    if (currentUserRole === "manager" && targetRole === "manager") return false;
    return true;
  }

  async function handleAddMember(e: React.FormEvent) {
    e.preventDefault();
    if (!addUserId) {
      setAddMemberError("Select a workspace member");
      return;
    }
    setAddingMember(true);
    setAddMemberError(null);
    try {
      await addProjectMember(projectId, { userId: addUserId, role: addRole });
      setAddUserId("");
      setAddRole("qa_engineer");
      await loadMembers();
    } catch {
      setAddMemberError("Failed to add project member.");
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

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  }

  async function handleRemoveMember(userId: string) {
    setRemovingMemberId(userId);
    setMemberError(null);
    try {
      await removeProjectMember(projectId, userId);
      setProjectMembers((prev) => prev.filter((member) => member.userId !== userId));
      showToast("Member removed from project");
    } catch {
      setMemberError("Failed to remove project member.");
    } finally {
      setRemovingMemberId(null);
      setPendingMemberRemoval(null);
    }
  }

  if (!project) {
    return <PageLoader variant="screen" label="Loading project settings…" />;
  }

  const projectName = typeof project.name === "string" ? project.name : "";

  return (
    <main className="tc-fullbleed flex flex-col pb-4 pr-4 pt-4" style={{ height: "calc(100vh - 3.5rem)" }}>
      <div className="flex min-h-0 flex-1 flex-col">
        {topBarStartEl &&
          createPortal(
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[12px]">
              {projectName && (
                <>
                  <button
                    type="button"
                    onClick={() => router.push("/projects")}
                    className="cursor-pointer truncate text-[var(--muted-soft)] transition-colors hover:text-[var(--accent-light)]"
                  >
                    {projectName}
                  </button>
                  <IconChevronRight size={12} stroke={1.75} className="shrink-0 text-[var(--muted-soft)]" />
                </>
              )}
              <span className="truncate font-medium text-[var(--accent-light)]">Settings</span>
            </nav>,
            topBarStartEl,
          )}

        <div className="mb-3 shrink-0 pl-4">
          <h1 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-[var(--foreground)]">
            Project settings
          </h1>
          <p className="mt-1 text-[13px] text-[var(--muted-soft)]">
            Settings are grouped by section. Select a category from the left to configure.
          </p>
        </div>

        <div className="flex min-h-0 flex-1 overflow-hidden rounded-r-xl border border-l-0 border-[var(--border)] bg-[var(--surface)]">
          {/* ── Settings nav rail ── */}
          <aside className="flex w-[200px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] p-2">
            <div className="mb-1 px-2.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
              Project settings
            </div>
            <nav className="flex flex-col gap-0.5">
              {visibleTabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => handleTabChange(tab.key)}
                  className={`cursor-pointer rounded-[6px] px-2.5 py-2 text-left text-[13px] transition-colors ${
                    activeTab === tab.key
                      ? "bg-[var(--brand-soft)] font-medium text-[var(--accent-light)]"
                      : "text-[var(--ink-600)] hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </nav>
          </aside>

          {/* ── Tab content ── */}
          <div className="min-w-0 flex-1 overflow-y-auto p-6">
            <div className="max-w-3xl space-y-5">
      {(activeTab === "general" || activeTab === "testRuns") && (
        // noValidate: without it, the environment URL input's native type="url" constraint
        // intercepts Save's submit before handleSubmit ever runs, so the styled inline validation
        // above never gets a chance to show (same class of bug as the login/signup email fields).
        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
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
                  <div className="flex items-baseline justify-between">
                    <FieldLabel>Name</FieldLabel>
                    <span className="text-[12px] text-[var(--muted)]">
                      {name.length}/{PROJECT_NAME_MAX_LENGTH}
                    </span>
                  </div>
                  <Input
                    type="text"
                    value={name}
                    onChange={(e) => {
                      const value = e.target.value;
                      setName(value);
                      if (nameError && !validateProjectName(value)) setNameError("");
                    }}
                    maxLength={PROJECT_NAME_MAX_LENGTH}
                  />
                  {nameError && <FieldError>{nameError}</FieldError>}
                </Field>
                <Field>
                  <div className="flex items-baseline justify-between">
                    <FieldLabel>Description</FieldLabel>
                    <span className="text-[12px] text-[var(--muted)]">
                      {description.length}/{PROJECT_DESCRIPTION_MAX_LENGTH}
                    </span>
                  </div>
                  <Textarea
                    value={description}
                    onChange={(e) => {
                      const value = e.target.value;
                      setDescription(value);
                      if (descriptionError && !validateProjectDescription(value)) setDescriptionError("");
                    }}
                    rows={3}
                    maxLength={PROJECT_DESCRIPTION_MAX_LENGTH}
                  />
                  {descriptionError && <FieldError>{descriptionError}</FieldError>}
                </Field>
                <ProjectIconPicker
                  value={icon}
                  onChange={setIcon}
                  fallbackColor={avatarColor(projectId)}
                  fallbackGlyph={name.trim().charAt(0).toUpperCase() || "P"}
                  glyphError={iconGlyphError}
                  onGlyphErrorChange={setIconGlyphError}
                  disabled={saving}
                />
                <Field>
                  <FieldLabel>Test case ID prefix</FieldLabel>
                  <Input
                    type="text"
                    value={testcaseIdPrefix}
                    maxLength={3}
                    onChange={(e) => setTestcaseIdPrefix(normalizeTestcaseIdPrefix(e.target.value))}
                    placeholder="TC"
                    className="max-w-32 font-mono uppercase"
                  />
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    Max 3 letters or numbers. New test cases use this prefix, for example {testcaseIdPrefix || "TC"}-TC-1.
                  </p>
                </Field>
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </Button>
              </Card>
              <div className="rounded-xl border border-[var(--error-border)] bg-[var(--error-soft)] p-4 space-y-2">
                <h3 className="text-sm font-semibold text-[var(--error-foreground)]">Danger zone</h3>
                <p className="text-sm text-[var(--error-foreground)]">
                  Deleting a project permanently removes its test cases, runs, reports, and integrations.
                </p>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    setDeleteProjectTypedName("");
                    setDeleteProjectError(null);
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
                                className="text-[var(--error-foreground)] text-xs"
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
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
                <div>
                  <Input
                    type="text"
                    value={newEnvironmentName}
                    onChange={(e) => {
                      const value = e.target.value;
                      setNewEnvironmentName(value);
                      if (newEnvironmentNameError && !validateEnvironmentName(value, testRunEnvironments)) {
                        setNewEnvironmentNameError("");
                      }
                    }}
                    placeholder="Environment name"
                    maxLength={ENVIRONMENT_NAME_MAX_LENGTH}
                  />
                  {newEnvironmentNameError && <FieldError>{newEnvironmentNameError}</FieldError>}
                </div>
                <div>
                  <Input
                    type="url"
                    value={newEnvironmentUrl}
                    onChange={(e) => {
                      const value = e.target.value;
                      setNewEnvironmentUrl(value);
                      if (newEnvironmentUrlError && !validateEnvironmentUrl(value, testRunEnvironments)) {
                        setNewEnvironmentUrlError("");
                      }
                    }}
                    placeholder="https://staging.example.com"
                    maxLength={ENVIRONMENT_URL_MAX_LENGTH}
                  />
                  {newEnvironmentUrlError && <FieldError>{newEnvironmentUrlError}</FieldError>}
                </div>
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
              <p><strong>Owner:</strong> Full access to this project, including managing every member. The owner&apos;s role cannot be changed.</p>
              <p><strong>Manager:</strong> Can add or remove QA Engineers and manage project settings, but cannot change another manager&apos;s role or add an owner.</p>
              <p><strong>QA Engineer:</strong> Works inside this project, but cannot manage members or change project settings.</p>
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
                      onChange={(e) => {
                        setAddUserId(e.target.value);
                        if (addMemberError) setAddMemberError(null);
                      }}
                      disabled={addingMember || membersLoading}
                      aria-invalid={Boolean(addMemberError)}
                    >
                      <option value="">Select member…</option>
                      {availableToAdd.map((member) => (
                        <option key={member.userId} value={member.userId}>
                          {member.name || member.email} ({member.email})
                        </option>
                      ))}
                    </Select>
                    {addMemberError && <FieldError>{addMemberError}</FieldError>}
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
            <p className="text-sm text-[var(--error-foreground)]">{memberError}</p>
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
                            onClick={() => setPendingMemberRemoval({ userId: member.userId, label: member.name || member.email })}
                            disabled={removingMemberId === member.userId}
                            title="Remove from project"
                            className="inline-flex cursor-pointer items-center justify-center rounded-md p-1.5 text-[var(--error-foreground)] transition-colors hover:bg-[var(--error-soft)] disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <IconTrash size={15} />
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
      {activeTab === "apiTokens" && (
        <Card className="p-4 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--foreground)]">API & MCP access</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Generate API tokens so AI agents like Claude Code or Claude Desktop can read and write this project&apos;s test data.
            </p>
          </div>
          <div className="rounded-lg border border-[var(--border)] p-4 flex items-start gap-4">
            <div className="shrink-0 w-10 h-10 rounded-lg bg-[var(--brand-primary)] flex items-center justify-center">
              <IconKey className="w-5 h-5 text-white" stroke={1.75} />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-[var(--foreground)]">Tesbo API tokens</h3>
              <p className="text-xs text-[var(--muted)] mt-0.5">
                {apiTokenCount === null
                  ? "Loading…"
                  : apiTokenCount === 0
                  ? "No API tokens yet"
                  : `${apiTokenCount} active token${apiTokenCount === 1 ? "" : "s"}`}
              </p>
            </div>
            <div className="shrink-0">
              <Link
                href={`/projects/${projectId}/settings/api-tokens`}
                className="inline-flex h-9 items-center justify-center rounded-[10px] border border-transparent bg-[var(--brand-primary)] px-3.5 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-[var(--brand-hover)]"
              >
                Manage API tokens
              </Link>
            </div>
          </div>
        </Card>
      )}
      {activeTab === "customFields" && (
        <Card className="p-4 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--foreground)]">Custom Fields</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Capture additional test case metadata specific to this project&apos;s testing process (Pro plan).
            </p>
          </div>
          <div className="rounded-lg border border-[var(--border)] p-4 flex items-start gap-4">
            <div className="shrink-0 w-10 h-10 rounded-lg bg-[var(--brand-primary)] flex items-center justify-center">
              <IconStack2 className="w-5 h-5 text-white" stroke={1.75} />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-[var(--foreground)]">Test case custom fields</h3>
              <p className="text-xs text-[var(--muted)] mt-0.5">
                {customFieldCount === null
                  ? "Loading…"
                  : customFieldCount === 0
                  ? "No custom fields yet"
                  : `${customFieldCount} field${customFieldCount === 1 ? "" : "s"}`}
              </p>
            </div>
            <div className="shrink-0">
              <Link
                href={`/projects/${projectId}/settings/custom-fields`}
                className="inline-flex h-9 items-center justify-center rounded-[10px] border border-transparent bg-[var(--brand-primary)] px-3.5 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-[var(--brand-hover)]"
              >
                Manage custom fields
              </Link>
            </div>
          </div>
        </Card>
      )}
      {activeTab === "integrations" && (
        <Card className="p-4 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--foreground)]">App Integrations</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Jira and Linear connect once for the whole workspace (Workspace Settings → Integrations).
              Open a connected integration&apos;s settings to pick which remote project/team feeds <em>this</em>{" "}
              project, sync tickets, and configure the rest of its options.
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
              {jiraStatus?.connected ? (
                <div className="mt-2 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-2 h-2 rounded-full bg-[var(--success)]" />
                    <span className="text-xs text-[var(--success-foreground)] font-medium">Workspace connected</span>
                  </div>
                  {jiraStatus.connectedProjects && jiraStatus.connectedProjects.length > 0 ? (
                    <p className="text-xs text-[var(--muted)]">
                      {jiraStatus.connectedProjects.length} Jira project{jiraStatus.connectedProjects.length > 1 ? "s" : ""} linked to this project:{" "}
                      {jiraStatus.connectedProjects.map((p) => p.jiraProjectKey).join(", ")}
                    </p>
                  ) : (
                    <p className="text-xs text-[var(--muted-soft)]">No Jira project linked to this project yet.</p>
                  )}
                </div>
              ) : (
                <p className="mt-2 text-xs text-[var(--muted-soft)]">Not connected for this workspace yet.</p>
              )}
            </div>
            <div className="shrink-0">
              {jiraStatus?.connected ? (
                <Link
                  href={`/projects/${projectId}/settings/integrations/jira`}
                  aria-label="Jira integration settings"
                  title="Jira integration settings"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-[10px] border border-[var(--border)] text-[var(--muted)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
                >
                  <IconSettings size={17} stroke={1.75} />
                </Link>
              ) : (
                <Link
                  href="/settings/integrations/jira"
                  className="inline-flex h-9 items-center justify-center rounded-[10px] border border-transparent bg-[var(--brand-primary)] px-3.5 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-[var(--brand-hover)]"
                >
                  Connect in Workspace Settings
                </Link>
              )}
            </div>
          </div>

          {/* Linear Card */}
          <div className="rounded-lg border border-[var(--border)] p-4 flex items-start gap-4">
            <div className="shrink-0 w-10 h-10 rounded-lg bg-[var(--brand-primary)] flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="w-6 h-6 text-white" fill="currentColor">
                <path d="M2.28 15.36 8.64 21.7c-3.14-.55-5.79-3.2-6.36-6.34Zm-.27-2.06L14.7 22c.34.02.68.02 1.02 0L1.99 8.98c-.02.34-.02.68.02 1.02Zm.5-3.14L15.84 21.5a10.9 10.9 0 0 0 1.87-1.1L3.6 6.29a10.9 10.9 0 0 0-1.09 1.87Zm1.9-2.98L18.82 18.5a11 11 0 0 0 1.28-1.55L5.06 5.9a11 11 0 0 0-1.55 1.28Zm2.71-2.2L21.02 15.87A11 11 0 0 0 22 1.98L8.12 1a11 11 0 0 0-1.9 1.98Z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-[var(--foreground)]">Linear</h3>
              <p className="text-xs text-[var(--muted)] mt-0.5">
                Import issues from Linear to use as knowledge base for test generation.
              </p>
              {linearStatus?.connected ? (
                <div className="mt-2 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-2 h-2 rounded-full bg-[var(--success)]" />
                    <span className="text-xs text-[var(--success-foreground)] font-medium">Workspace connected</span>
                  </div>
                  {linearStatus.connectedProjects && linearStatus.connectedProjects.length > 0 ? (
                    <p className="text-xs text-[var(--muted)]">
                      {linearStatus.connectedProjects.length} Linear team{linearStatus.connectedProjects.length > 1 ? "s" : ""} linked to this project:{" "}
                      {linearStatus.connectedProjects.map((p) => p.linearTeamKey).join(", ")}
                    </p>
                  ) : (
                    <p className="text-xs text-[var(--muted-soft)]">No Linear team linked to this project yet.</p>
                  )}
                </div>
              ) : (
                <p className="mt-2 text-xs text-[var(--muted-soft)]">
                  {linearLocked
                    ? "Linear is a Pro plan integration — the Launch plan includes Jira only."
                    : "Not connected for this workspace yet."}
                </p>
              )}
            </div>
            <div className="shrink-0">
              {linearStatus?.connected ? (
                <Link
                  href={`/projects/${projectId}/settings/integrations/linear`}
                  aria-label="Linear integration settings"
                  title="Linear integration settings"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-[10px] border border-[var(--border)] text-[var(--muted)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
                >
                  <IconSettings size={17} stroke={1.75} />
                </Link>
              ) : (
                <Link
                  href={linearLocked ? "/settings?tab=billing" : "/settings/integrations/linear"}
                  data-testid="linear-project-cta"
                  className={
                    linearLocked
                      ? "inline-flex h-9 items-center justify-center rounded-[10px] border border-[var(--border)] px-3.5 text-[13px] font-semibold text-[var(--muted)] transition-colors hover:border-[var(--brand-primary)] hover:text-[var(--accent-light)]"
                      : "inline-flex h-9 items-center justify-center rounded-[10px] border border-transparent bg-[var(--brand-primary)] px-3.5 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-[var(--brand-hover)]"
                  }
                >
                  {linearLocked ? "Upgrade to Pro" : "Connect in Workspace Settings"}
                </Link>
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

      {activeTab === "integrations" && message && (
        <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 text-sm text-[var(--foreground)]">
          {message}
        </p>
      )}
            </div>
          </div>
        </div>
      </div>
      <Modal
        open={deleteProjectModalOpen}
        onClose={() => {
          if (deletingProject) return;
          setDeleteProjectModalOpen(false);
          setDeleteProjectError(null);
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
              onChange={(event) => {
                setDeleteProjectTypedName(event.target.value);
                if (deleteProjectError) setDeleteProjectError(null);
              }}
              placeholder={String(project?.name ?? "")}
              disabled={deletingProject}
              aria-invalid={Boolean(deleteProjectError)}
            />
            {deleteProjectError && <FieldError>{deleteProjectError}</FieldError>}
          </Field>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setDeleteProjectModalOpen(false);
                setDeleteProjectTypedName("");
                setDeleteProjectError(null);
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

      <ConfirmModal
        open={pendingMemberRemoval !== null}
        title="Remove project member"
        message={
          pendingMemberRemoval
            ? `Remove ${pendingMemberRemoval.label} from this project? They will lose access to it.`
            : ""
        }
        confirmLabel="Remove member"
        loading={pendingMemberRemoval !== null && removingMemberId === pendingMemberRemoval.userId}
        onConfirm={() => pendingMemberRemoval && handleRemoveMember(pendingMemberRemoval.userId)}
        onCancel={() => setPendingMemberRemoval(null)}
      />

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 rounded-[var(--radius-control)] bg-[var(--toast-surface)] px-4 py-2.5 text-sm text-[var(--toast-foreground)] shadow-lg">
          {toast}
        </div>
      )}
    </main>
  );
}
