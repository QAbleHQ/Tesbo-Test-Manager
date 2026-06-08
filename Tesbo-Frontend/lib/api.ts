const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7000";

type RequestInitWithBody = Omit<RequestInit, "body"> & { body?: unknown };

type ApiErrorBody = { error?: string; detail?: string };

function formatApiError(status: number, body: ApiErrorBody): string {
  const msg = body.error || String(status);
  const detail = body.detail?.trim();
  if (detail) return `${msg}: ${detail}`;
  return msg;
}

export async function api<T = unknown>(
  path: string,
  options: RequestInitWithBody = {}
): Promise<T> {
  const { body, ...rest } = options;
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(rest.headers as Record<string, string>),
  };
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...rest,
      headers,
      credentials: "include",
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Network request failed";
    const looksLikeCorsOrNetwork =
      msg === "Failed to fetch" ||
      msg === "Load failed" ||
      msg.includes("NetworkError") ||
      msg.includes("network");
    if (looksLikeCorsOrNetwork) {
      throw new Error(
        `${msg} — browser blocked or could not reach the API. Confirm NEXT_PUBLIC_API_URL, HTTPS, and that the backend allows this page’s origin in CORS_ALLOWED_ORIGINS.`
      );
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as ApiErrorBody;
    throw new Error(formatApiError(res.status, err));
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text.trim()) return undefined as T;
  return JSON.parse(text) as T;
}

export async function authMe(): Promise<{
  userId: string;
  isPlatformAdmin?: boolean;
} | null> {
  try {
    return await api<{ userId: string; isPlatformAdmin?: boolean }>(
      "/api/auth/me"
    );
  } catch {
    return null;
  }
}

// --- Platform Admin APIs ---

export async function getSystemHealth() {
  return api<{
    status: string;
    timestamp: string;
    services: Record<
      string,
      {
        status: string;
        latency_ms?: number;
        url?: string;
        error?: string;
        http_status?: number;
        provider?: string;
        latest_migration?: string;
      }
    >;
  }>("/api/admin/system/health");
}

export type BrandingSettings = {
  productName: string;
  logoUrl: string;
};

export async function getBranding(): Promise<BrandingSettings> {
  return api<BrandingSettings>("/api/branding");
}

export async function getAdminBranding(): Promise<BrandingSettings> {
  return api<BrandingSettings>("/api/admin/branding");
}

export async function updateAdminBranding(data: BrandingSettings): Promise<BrandingSettings> {
  return api<BrandingSettings>("/api/admin/branding", { method: "PATCH", body: data });
}

export async function getAdminList() {
  return api<
    Array<{
      id: string;
      userId: string;
      role: string;
      email: string;
      name: string | null;
      avatarUrl: string | null;
      createdAt: string;
      grantedBy?: { email: string; name: string };
    }>
  >("/api/admin/admins");
}

export async function addPlatformAdmin(
  email: string
): Promise<{ id: string; userId: string; email: string; role: string }> {
  return api("/api/admin/admins", { method: "POST", body: { email } });
}

export async function removePlatformAdmin(adminId: string): Promise<void> {
  await api(`/api/admin/admins/${adminId}`, { method: "DELETE" });
}

export async function requestOtp(email: string): Promise<void> {
  await api("/api/auth/otp/request", { method: "POST", body: { email } });
}

export async function getSetupStatus(): Promise<{ required: boolean }> {
  return api<{ required: boolean }>("/api/setup/status");
}

export async function createFirstAdmin(data: {
  email: string;
  password: string;
  orgName: string;
  demoData: boolean;
}): Promise<{ userId: string; organizationId: string; projectId: string }> {
  return api("/api/setup/first-admin", { method: "POST", body: data });
}

export async function loginWithPassword(email: string, password: string): Promise<{ ok: boolean; userId: string }> {
  return api("/api/auth/password/login", { method: "POST", body: { email, password } });
}

export async function verifyOtp(email: string, code: string): Promise<{ ok: boolean; userId: string }> {
  return api("/api/auth/otp/verify", { method: "POST", body: { email, code } });
}

export async function logout(): Promise<void> {
  await api("/api/auth/logout", { method: "POST" });
}

export interface OnboardingResponse {
  organizationId: string;
  projectId: string;
  projectKey: string;
}

export interface CreateWorkspaceResponse {
  organizationId: string;
}

export async function createWorkspace(data: {
  orgName: string;
}): Promise<CreateWorkspaceResponse> {
  return api<CreateWorkspaceResponse>("/api/onboarding/workspace", {
    method: "POST",
    body: data,
  });
}

export async function createOrgAndProject(data: {
  orgName: string;
  projectKey: string;
  projectName: string;
  projectDescription?: string;
}): Promise<OnboardingResponse> {
  return api<OnboardingResponse>("/api/onboarding/org-and-project", {
    method: "POST",
    body: data,
  });
}

// Workspace (organization) – team members at workspace level; project access is by allocation
export interface WorkspaceInfo {
  id: string;
  name: string;
  slug: string;
  role?: string;
  createdAt: string;
}

export interface WorkspaceMember {
  userId: string;
  email: string;
  name: string;
  role: string;
  joinedAt: string;
}

export async function getWorkspace(): Promise<WorkspaceInfo> {
  return api<WorkspaceInfo>("/api/workspace");
}

export interface WorkspaceAiKey {
  id: string;
  name: string;
  provider: string;
  defaultModel?: string;
  baseUrl?: string | null;
  authHeaderName?: string | null;
  authScheme?: string | null;
  active: boolean;
  maskedKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceAiProjectAllocation {
  projectId: string;
  projectKey: string;
  projectName: string;
  workspaceAiKeyId: string;
}

export interface WorkspaceAiKeysResponse {
  keys: WorkspaceAiKey[];
  projects: WorkspaceAiProjectAllocation[];
}

export async function listWorkspaceAiKeys(): Promise<WorkspaceAiKeysResponse> {
  return api<WorkspaceAiKeysResponse>("/api/workspace/ai-keys");
}

export async function createWorkspaceAiKey(data: {
  name: string;
  provider: string;
  apiKey: string;
  defaultModel?: string;
  baseUrl?: string;
  authHeaderName?: string;
  authScheme?: string;
}): Promise<WorkspaceAiKey> {
  return api<WorkspaceAiKey>("/api/workspace/ai-keys", {
    method: "POST",
    body: data,
  });
}

export async function deleteWorkspaceAiKey(keyId: string): Promise<void> {
  await api(`/api/workspace/ai-keys/${keyId}`, { method: "DELETE" });
}

export async function allocateWorkspaceAiKeyToProject(data: {
  projectId: string;
  workspaceAiKeyId?: string;
}): Promise<void> {
  await api("/api/workspace/ai-keys/allocations", {
    method: "POST",
    body: data,
  });
}

export async function listWorkspaceMembers(): Promise<WorkspaceMember[]> {
  return api<WorkspaceMember[]>("/api/workspace/members");
}

export async function addWorkspaceMember(data: { email?: string; userId?: string; role?: string }): Promise<void> {
  await api("/api/workspace/members", { method: "POST", body: data });
}

export async function removeWorkspaceMember(userId: string): Promise<void> {
  await api(`/api/workspace/members/${userId}`, { method: "DELETE" });
}

export interface WorkspaceInvitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
}

export async function listWorkspaceInvitations(): Promise<WorkspaceInvitation[]> {
  return api<WorkspaceInvitation[]>("/api/workspace/invitations");
}

export async function createWorkspaceInvitation(data: { email: string; role?: string }): Promise<WorkspaceInvitation> {
  return api<WorkspaceInvitation>("/api/workspace/invitations", { method: "POST", body: data });
}

export async function revokeWorkspaceInvitation(invitationId: string): Promise<void> {
  await api(`/api/workspace/invitations/${invitationId}`, { method: "DELETE" });
}

export interface InviteDetails {
  id: string;
  organizationId: string | null;
  projectId: string | null;
  organizationName: string | null;
  projectName: string | null;
  email: string;
  role: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
  status: "pending" | "accepted" | "expired";
}

export async function getInvitationByToken(token: string): Promise<InviteDetails> {
  return api<InviteDetails>(`/api/invitations/${token}`);
}

export async function acceptInvitation(token: string): Promise<{ accepted: boolean; organizationId: string | null; projectId: string | null }> {
  return api<{ accepted: boolean; organizationId: string | null; projectId: string | null }>(`/api/invitations/${token}/accept`, {
    method: "POST",
  });
}

export interface WorkspaceProjectAccessMember {
  userId: string;
  email: string;
  name: string;
  workspaceRole: string;
  projectRoles: Record<string, string>;
}

export interface WorkspaceProjectInfo {
  id: string;
  key: string;
  name: string;
}

export interface WorkspaceProjectAccessMatrix {
  projects: WorkspaceProjectInfo[];
  members: WorkspaceProjectAccessMember[];
}

export async function getWorkspaceProjectAccess(): Promise<WorkspaceProjectAccessMatrix> {
  return api<WorkspaceProjectAccessMatrix>("/api/workspace/project-access");
}

export async function setWorkspaceProjectAccess(data: { projectId: string; userId: string; role: string }): Promise<void> {
  await api("/api/workspace/project-access", { method: "PUT", body: data });
}

export async function removeWorkspaceProjectAccess(data: { projectId: string; userId: string }): Promise<void> {
  await api("/api/workspace/project-access", { method: "DELETE", body: data });
}

// Projects
export type ProjectType = "tesbox";

export interface ProjectSummary {
  id: string;
  key: string;
  name: string;
  description: string;
  projectType: ProjectType;
  role: string;
  createdAt: string;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  return api<ProjectSummary[]>("/api/projects");
}

export interface CreateProjectResponse {
  id: string;
  key: string;
  name: string;
  projectType: ProjectType;
  createdAt: string;
}

export async function createProject(data: { key?: string; name: string; description?: string; projectType?: ProjectType }): Promise<CreateProjectResponse> {
  return api<CreateProjectResponse>("/api/projects", { method: "POST", body: data });
}

export async function getProject(id: string): Promise<Record<string, unknown>> {
  return api<Record<string, unknown>>(`/api/projects/${id}`);
}

export async function updateProject(id: string, data: { name?: string; description?: string; settings?: string }): Promise<void> {
  await api(`/api/projects/${id}`, { method: "PATCH", body: data });
}


export async function deleteProject(id: string): Promise<void> {
  await api(`/api/projects/${id}`, { method: "DELETE" });
}

export interface TestEnvironmentSetting {
  name: string;
  url: string;
}

export interface AiGeneratedDraft {
  title: string;
  preconditions: string;
  stepsJson: string;
  expectedSummary: string;
  priority: string;
  tags: string[];
}

export interface GenerateAiTestCasesBody {
  userStory: string;
  acceptanceCriteria?: string;
  prompt?: string;
  style?: string;
  count?: number;
  provider?: "openai" | "anthropic";
  model?: string;
  includeHappyFlow?: boolean;
  includeNegativeFlow?: boolean;
  includeMultiTab?: boolean;
  includeCrossBrowser?: boolean;
  includeBoundary?: boolean;
}

export interface GenerateAiTestCasesResponse {
  generationRequestId: string;
  provider: "openai" | "anthropic";
  drafts: AiGeneratedDraft[];
  generatedCount: number;
}

export async function generateAiTestCases(
  projectId: string,
  data: GenerateAiTestCasesBody
): Promise<GenerateAiTestCasesResponse> {
  return api<GenerateAiTestCasesResponse>(`/api/projects/${projectId}/ai/generate-testcases`, {
    method: "POST",
    body: data,
  });
}

export interface AiGenerationHistoryItem {
  id: string;
  requestedBy: string;
  provider: string;
  model: string | null;
  userStory: string;
  acceptanceCriteria: string;
  customPrompt: string;
  style: string;
  requestedCount: number;
  includeHappyFlow: boolean;
  includeNegativeFlow: boolean;
  includeMultiTab: boolean;
  includeCrossBrowser: boolean;
  includeBoundary: boolean;
  generatedCount: number;
  generatedPayload: string;
  savedCount: number;
  saveEvents: string;
  createdAt: string;
  updatedAt: string;
}

export async function listAiGenerationHistory(
  projectId: string,
  params?: { limit?: number; offset?: number }
): Promise<{ list: AiGenerationHistoryItem[] }> {
  const sp = new URLSearchParams();
  if (params?.limit != null) sp.set("limit", String(params.limit));
  if (params?.offset != null) sp.set("offset", String(params.offset));
  const query = sp.toString();
  return api<{ list: AiGenerationHistoryItem[] }>(
    `/api/projects/${projectId}/ai/generation-history${query ? `?${query}` : ""}`
  );
}

export async function trackAiGenerationSaved(
  projectId: string,
  requestId: string,
  data: { suiteId?: string; testcaseIds: string[] }
): Promise<void> {
  await api(`/api/projects/${projectId}/ai/generation-history/${requestId}/save`, {
    method: "POST",
    body: data,
  });
}

export interface ZyraTask {
  id: string;
  provider: "openai" | "anthropic";
  model: string | null;
  userStory: string;
  acceptanceCriteria: string;
  customPrompt: string;
  requestedCount: number;
  generatedCount: number;
  savedCount: number;
  taskStatus: "todo" | "in_progress" | "in_review" | "done" | "accepted" | "rejected" | string;
  feedback: string;
  context: string;
  jiraIssueKeys: string[];
  drafts: AiGeneratedDraft[];
  sources: Array<{ type: string; title: string; detail: string }>;
  activities: Array<{ actor: "user" | "agent" | string; stage: string; title: string; detail: string; createdAt: string }>;
  tokenUsage: { input: number; output: number; total: number };
  createdAt: string;
  updatedAt: string;
}

export interface ZyraAgentState {
  agent: {
    name: string;
    role: string;
    active: boolean;
    activationReason: string;
  };
  settings: { testcaseCount: number };
  aiKey: {
    id: string;
    name: string;
    provider: string;
    defaultModel?: string | null;
    baseUrl?: string | null;
    authHeaderName?: string | null;
    authScheme?: string | null;
    maskedKey: string;
  } | null;
  tokenUsage: { total: number };
  tasks: ZyraTask[];
}

export async function getZyraAgent(projectId: string): Promise<ZyraAgentState> {
  return api<ZyraAgentState>(`/api/projects/${projectId}/agents/zyra`);
}

export async function updateZyraSettings(projectId: string, data: { testcaseCount: number }): Promise<{ testcaseCount: number }> {
  return api<{ testcaseCount: number }>(`/api/projects/${projectId}/agents/zyra/settings`, {
    method: "PATCH",
    body: data,
  });
}

export async function createZyraTask(
  projectId: string,
  data: {
    story: string;
    context?: string;
    acceptanceCriteria?: string;
    jiraIssueKeys?: string[];
    knowledgeItemIds?: string[];
    count?: number;
  }
): Promise<GenerateAiTestCasesResponse & { task: ZyraTask; tokenUsage: { input: number; output: number; total: number } }> {
  return api(`/api/projects/${projectId}/agents/zyra/tasks`, {
    method: "POST",
    body: data,
  });
}

export async function getZyraTask(projectId: string, taskId: string): Promise<ZyraTask> {
  return api<ZyraTask>(`/api/projects/${projectId}/agents/zyra/tasks/${taskId}`);
}

export async function sendZyraFeedback(
  projectId: string,
  taskId: string,
  data: string | { feedback: string; referenceNote?: string; jiraIssueKeys?: string[] }
): Promise<GenerateAiTestCasesResponse & { task: ZyraTask; tokenUsage: { input: number; output: number; total: number } }> {
  return api(`/api/projects/${projectId}/agents/zyra/tasks/${taskId}/feedback`, {
    method: "POST",
    body: typeof data === "string" ? { feedback: data } : data,
  });
}

export async function deleteZyraTaskDraft(projectId: string, taskId: string, draftIndex: number): Promise<ZyraTask> {
  return api<ZyraTask>(`/api/projects/${projectId}/agents/zyra/tasks/${taskId}/drafts/${draftIndex}`, {
    method: "DELETE",
  });
}

export async function closeZyraTask(projectId: string, taskId: string): Promise<ZyraTask> {
  return api<ZyraTask>(`/api/projects/${projectId}/agents/zyra/tasks/${taskId}/close`, {
    method: "POST",
  });
}

export async function saveZyraTask(
  projectId: string,
  taskId: string,
  data: { selectedDraftIndexes: number[]; suiteId?: string; suiteName?: string }
): Promise<{ savedCount: number; suiteId: string | null; testcases: { id: string; externalId: string; title: string; createdAt: string }[] }> {
  return api(`/api/projects/${projectId}/agents/zyra/tasks/${taskId}/save`, {
    method: "POST",
    body: data,
  });
}

export async function listProjectMembers(projectId: string): Promise<{ userId: string; email: string; name: string; role: string; joinedAt: string }[]> {
  return api(`/api/projects/${projectId}/members`);
}

export async function addProjectMember(projectId: string, data: { userId: string; role: string }): Promise<void> {
  await api(`/api/projects/${projectId}/members`, { method: "POST", body: data });
}

export async function removeProjectMember(projectId: string, userId: string): Promise<void> {
  await api(`/api/projects/${projectId}/members/${userId}`, { method: "DELETE" });
}

// Suites
export interface SuiteNode {
  id: string;
  parentId: string | null;
  name: string;
  position: number;
  createdAt: string;
  testCaseCount: number;
}

export async function listSuites(projectId: string): Promise<SuiteNode[]> {
  return api<SuiteNode[]>(`/api/projects/${projectId}/suites`);
}

export async function createSuite(projectId: string, data: { name: string; parentId?: string; position?: number }): Promise<SuiteNode> {
  return api<SuiteNode>(`/api/projects/${projectId}/suites`, { method: "POST", body: data });
}

export async function updateSuite(suiteId: string, data: { name?: string; parentId?: string; position?: number }): Promise<void> {
  await api(`/api/suites/${suiteId}`, { method: "PATCH", body: data });
}

export async function deleteSuite(suiteId: string, mode: "deleteTestcases" | "moveToDefault" = "moveToDefault"): Promise<void> {
  await api(`/api/suites/${suiteId}?mode=${mode}`, { method: "DELETE" });
}

// Test cases
export interface TestCaseListItem {
  id: string;
  externalId: string;
  title: string;
  priority: string;
  type: string;
  automationStatus: string;
  automationTags?: string;
  status: string;
  suiteId: string | null;
  ownerId: string | null;
  updatedAt: string;
  jiraIssueKey?: string | null;
  jiraUrl?: string | null;
}

export async function listTestCases(
  projectId: string,
  params?: {
    limit?: number;
    offset?: number;
    suiteId?: string;
    status?: string;
    priority?: string;
    type?: string;
    automationStatus?: string;
    jiraIssueKey?: string;
    search?: string;
  }
): Promise<{ list: TestCaseListItem[]; total: number }> {
  const sp = new URLSearchParams();
  if (params?.limit != null) sp.set("limit", String(params.limit));
  if (params?.offset != null) sp.set("offset", String(params.offset));
  if (params?.suiteId) sp.set("suiteId", params.suiteId);
  if (params?.status) sp.set("status", params.status);
  if (params?.priority) sp.set("priority", params.priority);
  if (params?.type) sp.set("type", params.type);
  if (params?.automationStatus) sp.set("automationStatus", params.automationStatus);
  if (params?.jiraIssueKey) sp.set("jiraIssueKey", params.jiraIssueKey);
  if (params?.search) sp.set("search", params.search);
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:7000"}/api/projects/${projectId}/testcases?${sp}`, { credentials: "include" });
  const list = await res.json();
  if (!res.ok) {
    const err = (list as { error?: string }).error || res.statusText;
    throw new Error(err || String(res.status));
  }
  const normalizedList = Array.isArray(list) ? list : [];
  const totalHeader = res.headers.get("X-Total-Count");
  let total = totalHeader != null ? parseInt(totalHeader, 10) : normalizedList.length;
  if (Number.isNaN(total)) {
    total = normalizedList.length;
  }
  return { list: normalizedList, total };
}

export async function getTestCase(projectId: string, testcaseId: string): Promise<Record<string, unknown>> {
  return api(`/api/projects/${projectId}/testcases/${testcaseId}`);
}

export async function createTestCase(projectId: string, data: Record<string, unknown>): Promise<{ id: string; externalId: string; title: string; createdAt: string }> {
  return api(`/api/projects/${projectId}/testcases`, { method: "POST", body: data });
}

export async function updateTestCase(projectId: string, testcaseId: string, data: Record<string, unknown>): Promise<void> {
  await api(`/api/projects/${projectId}/testcases/${testcaseId}`, { method: "PUT", body: data });
}

export async function deleteTestCase(projectId: string, testcaseId: string): Promise<void> {
  await api(`/api/projects/${projectId}/testcases/${testcaseId}`, { method: "DELETE" });
}

export async function bulkUpdateTestCases(projectId: string, data: { testcaseIds: string[]; priority?: string; suiteId?: string; status?: string; ownerId?: string }): Promise<void> {
  await api(`/api/projects/${projectId}/testcases/bulk-update`, { method: "POST", body: data });
}

export async function bulkDeleteTestCases(projectId: string, data: { testcaseIds: string[] }): Promise<void> {
  await api(`/api/projects/${projectId}/testcases/bulk-delete`, { method: "POST", body: data });
}

export async function listLinkedJiraKeys(projectId: string): Promise<{ keys: string[]; counts: Record<string, number> }> {
  return api<{ keys: string[]; counts: Record<string, number> }>(`/api/projects/${projectId}/testcases/linked-jira-keys`);
}

// Test case import/export
export function getExportUrl(projectId: string, format: "csv" | "xlsx"): string {
  return `${API_BASE}/api/projects/${projectId}/testcases/export/${format}`;
}

export function getTemplateUrl(projectId: string, format: "csv" | "xlsx"): string {
  return `${API_BASE}/api/projects/${projectId}/testcases/import/template?format=${format}`;
}

export interface ImportPreviewResult {
  uploadId: string;
  headers: string[];
  previewRows: string[][];
  totalRows: number;
}

export async function previewImport(projectId: string, file: File): Promise<ImportPreviewResult> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/testcases/import/preview`, {
    method: "POST",
    credentials: "include",
    body: fd,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || String(res.status));
  }
  return res.json() as Promise<ImportPreviewResult>;
}

export interface ImportResult {
  imported: number;
  errors: { row: number; message: string }[];
  total: number;
}

export async function executeImport(
  projectId: string,
  body: { uploadId: string; columnMapping: Record<string, number> }
): Promise<ImportResult> {
  return api<ImportResult>(`/api/projects/${projectId}/testcases/import`, {
    method: "POST",
    body,
  });
}

export interface AutomationSession {
  id: string;
  projectId: string;
  testcaseId: string;
  userId: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  currentUrl: string | null;
  browserContextMeta: string | null;
  lastScreenshotPath: string | null;
  updatedAt: string;
  runtime?: {
    activeCommandId: string | null;
    queuedCount: number;
    isRunning: boolean;
  };
  events: Array<{
    id: string;
    commandId: string | null;
    eventType: string;
    rawCommand: string | null;
    parsedAction?: Record<string, unknown> | null;
    executionResult?: Record<string, unknown> | null;
    screenshotPath: string | null;
    createdAt: string;
  }>;
}

export async function startAutomationSession(
  projectId: string,
  testcaseId: string,
  data?: { startUrl?: string }
): Promise<{ id: string; startedAt: string }> {
  return api(`/api/projects/${projectId}/testcases/${testcaseId}/automation/sessions`, {
    method: "POST",
    body: data ?? {},
  });
}

export async function sendAutomationCommand(
  projectId: string,
  sessionId: string,
  command: string
): Promise<{
  commandId: string;
  requiresClarification: boolean;
  clarificationQuestion?: string;
  queued?: boolean;
  queueDepth?: number;
  result?: Record<string, unknown>;
}> {
  return api(`/api/projects/${projectId}/automation/sessions/${sessionId}/commands`, {
    method: "POST",
    body: { command },
  });
}

export async function stopAutomationCommand(
  projectId: string,
  sessionId: string
): Promise<{
  stopRequested: boolean;
  activeCommandId: string | null;
  queuedCount: number;
}> {
  return api(`/api/projects/${projectId}/automation/sessions/${sessionId}/commands/stop`, {
    method: "POST",
  });
}

export async function getAutomationSession(projectId: string, sessionId: string): Promise<AutomationSession> {
  return api(`/api/projects/${projectId}/automation/sessions/${sessionId}`);
}

export async function getAutomationStreamState(projectId: string, sessionId: string): Promise<Record<string, unknown>> {
  return api(`/api/projects/${projectId}/automation/sessions/${sessionId}/stream`);
}

export interface RecordingAction {
  type: string;
  action: string;
  playwright: string;
  targetDescription?: string;
  value?: string;
  url?: string;
}

/** Unified timeline entry — every recording interaction in chronological order. */
export interface TimelineEntry {
  seq: number;
  kind: "action" | "reasoning" | "result";
  ts: string;
  stepId?: string | null;
  url?: string | null;
  tool?: string | null;
  action?: string | null;
  playwright?: string | null;
  target?: string | null;
  value?: string | null;
  description?: string | null;
  text?: string | null;
  toolName?: string | null;
  data?: Record<string, unknown> | null;
  message?: string | null;
  assertions?: string[];
}

/** Summary stats computed from the unified timeline. */
export interface RecordingStats {
  totalEntries: number;
  actionCount: number;
  reasoningCount: number;
  resultCount: number;
  clickCount: number;
  typeCount: number;
  navigateCount: number;
  waitCount: number;
  pressCount: number;
  scrollCount: number;
  assertCount: number;
  playwrightLineCount: number;
}

export interface RecordingSummary {
  runId: string;
  state: string;
  startedAt: string | null;
  stoppedAt: string | null;
  totalEvents: number;
  observeCount: number;
  actCount: number;
  successfulActCount: number;
  extractCount: number;
  navigateCount: number;
  compiledActionCount: number;
}

export interface ReasoningEntry {
  text: string;
  timestamp: string;
  stepId: string | null;
  url: string | null;
  toolName: string | null;
  _seq: number;
}

export interface RecordingState {
  sessionId: string;
  hasRecording: boolean;
  message?: string;
  summary?: RecordingSummary;
  actions?: RecordingAction[];
  reasoningLog?: ReasoningEntry[];
  partialScript?: string;
}

export async function getAutomationRecording(projectId: string, sessionId: string): Promise<RecordingState> {
  return api(`/api/projects/${projectId}/automation/sessions/${sessionId}/recording`);
}

export async function compileAutomationRecording(
  projectId: string,
  sessionId: string,
  options?: { scenario?: string; addHeader?: boolean }
): Promise<{ sessionId: string; runId: string; script: string; summary: RecordingSummary; recording: Record<string, unknown> }> {
  return api(`/api/projects/${projectId}/automation/sessions/${sessionId}/recording/compile`, {
    method: "POST",
    body: options ?? {},
  });
}

export interface PersistedRecording {
  id: string;
  projectId: string;
  testcaseId: string | null;
  sessionId: string | null;
  commandId: string | null;
  runId: string;
  scenarioName: string | null;
  state: string;
  startedAt: string | null;
  stoppedAt: string | null;
  timeline?: TimelineEntry[];
  stats: RecordingStats;
  playwrightScript: string | null;
  startUrl: string | null;
  finalUrl: string | null;
  durationMs: number;
  success: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function listRecordingsByTestcase(
  projectId: string,
  testcaseId: string,
  limit?: number
): Promise<PersistedRecording[]> {
  const params = limit ? `?limit=${limit}` : "";
  return api(`/api/projects/${projectId}/testcases/${testcaseId}/automation/recordings${params}`);
}

export async function listRecordingsByProject(
  projectId: string,
  limit?: number
): Promise<PersistedRecording[]> {
  const params = limit ? `?limit=${limit}` : "";
  return api(`/api/projects/${projectId}/automation/recordings${params}`);
}

export async function getPersistedRecording(
  projectId: string,
  recordingId: string
): Promise<PersistedRecording> {
  return api(`/api/projects/${projectId}/automation/recordings/${recordingId}`);
}

export async function resetAutomationSession(
  projectId: string,
  sessionId: string,
  data?: { startUrl?: string }
): Promise<{ sessionId: string; currentUrl?: string }> {
  return api(`/api/projects/${projectId}/automation/sessions/${sessionId}/reset`, {
    method: "POST",
    body: data ?? {},
  });
}

export async function finalizeAutomationSession(
  projectId: string,
  sessionId: string,
  data?: {
    testName?: string;
    framework?: string;
    repo?: string;
    path?: string;
    script?: string;
    steps?: Array<{ stepNumber?: number; action?: string; expectedResult?: string }>;
  }
): Promise<{ status: string; script: string }> {
  return api(`/api/projects/${projectId}/automation/sessions/${sessionId}/finalize`, {
    method: "POST",
    body: data ?? {},
  });
}

export async function cancelAutomationSession(projectId: string, sessionId: string): Promise<void> {
  await api(`/api/projects/${projectId}/automation/sessions/${sessionId}/cancel`, { method: "POST" });
}

export async function sendAutomationManualAction(
  projectId: string,
  sessionId: string,
  data: {
    actionType: "click" | "type" | "press" | "drag" | "scroll";
    xRatio?: number;
    yRatio?: number;
    toXRatio?: number;
    toYRatio?: number;
    deltaX?: number;
    deltaY?: number;
    text?: string;
    key?: string;
    targetHint?: string;
  }
): Promise<Record<string, unknown>> {
  return api(`/api/projects/${projectId}/automation/sessions/${sessionId}/manual-actions`, {
    method: "POST",
    body: data,
  });
}

export async function runAutomationPlaywrightScript(
  projectId: string,
  sessionId: string,
  data: {
    script: string;
    scriptVersion?: number | null;
    startUrl?: string;
    actionDelayMs?: number;
  }
): Promise<{
  status: "passed" | "failed" | string;
  currentUrl?: string;
  errorMessage?: string | null;
  screenshotPath?: string | null;
  tracePath?: string | null;
  videoPath?: string | null;
  durationMs?: number;
  logs?: Array<Record<string, unknown>>;
}> {
  return api(`/api/projects/${projectId}/automation/sessions/${sessionId}/run-script`, {
    method: "POST",
    body: data,
  });
}

export function getAutomationSessionTraceUrl(projectId: string, sessionId: string): string {
  return `${API_BASE}/api/projects/${projectId}/automation/sessions/${sessionId}/trace`;
}

// Plans
export async function listPlans(projectId: string): Promise<Record<string, unknown>[]> {
  return api(`/api/projects/${projectId}/plans`);
}

export async function getPlan(planId: string): Promise<Record<string, unknown>> {
  return api(`/api/plans/${planId}`);
}

export async function createPlan(projectId: string, data: { name: string; description?: string; targetRelease?: string }): Promise<{ id: string }> {
  return api(`/api/projects/${projectId}/plans`, { method: "POST", body: data });
}

export async function updatePlan(planId: string, data: { name?: string; description?: string; targetRelease?: string }): Promise<void> {
  await api(`/api/plans/${planId}`, { method: "PATCH", body: data });
}

export async function deletePlan(planId: string): Promise<void> {
  await api(`/api/plans/${planId}`, { method: "DELETE" });
}

export async function listPlanItems(planId: string): Promise<{ id: string; suiteId: string | null; testcaseId: string | null; position: number }[]> {
  return api(`/api/plans/${planId}/items`);
}

export async function addPlanItem(planId: string, data: { suiteId?: string; testcaseId?: string; position?: number }): Promise<void> {
  await api(`/api/plans/${planId}/items`, { method: "POST", body: data });
}

// Plan Runs & Progress
export interface PlanRunItem {
  id: string;
  externalId: string;
  name: string;
  description: string;
  status: string;
  environment: string;
  buildVersion: string;
  releaseName: string;
  startedAt: string | null;
  endedAt: string | null;
  ownerId: string | null;
  createdAt: string;
  totalCases: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  untested: number;
}

export interface PlanProgress {
  runCount: number;
  totalCases: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  untested: number;
  executed: number;
  completionPercent: number;
}

export interface PlanListItem {
  id: string;
  externalId: string;
  name: string;
  description: string;
  targetRelease: string;
  ownerId: string | null;
  createdAt: string;
  runCount: number;
  totalCases: number;
  passed: number;
  failed: number;
  untested: number;
  completionPercent: number;
}

export async function listPlanRuns(planId: string): Promise<PlanRunItem[]> {
  return api(`/api/plans/${planId}/runs`);
}

export async function getPlanProgress(planId: string): Promise<PlanProgress> {
  return api(`/api/plans/${planId}/progress`);
}

export async function associateRunWithPlan(cycleId: string, planId: string): Promise<void> {
  await api(`/api/cycles/${cycleId}`, { method: "PATCH", body: { planId } });
}

export async function dissociateRunFromPlan(cycleId: string): Promise<void> {
  await api(`/api/cycles/${cycleId}`, { method: "PATCH", body: { clearPlan: true } });
}

// Test Runs (Cycles)
export interface TestRunListItem {
  id: string;
  externalId: string;
  planId: string | null;
  name: string;
  description: string;
  status: string;
  environment: string;
  buildVersion: string;
  releaseName: string;
  startedAt: string | null;
  endedAt: string | null;
  ownerId: string | null;
  createdAt: string;
  totalCases: number;
  passed: number;
  failed: number;
}

export interface TestRunDetail {
  id: string;
  externalId: string;
  projectId: string;
  planId: string | null;
  name: string;
  description: string;
  status: string;
  environment: string;
  buildVersion: string;
  releaseName: string;
  startedAt: string | null;
  endedAt: string | null;
  ownerId: string | null;
  shareToken: string | null;
  shareEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionItem {
  id: string;
  cycleItemId: string;
  testcaseId: string;
  snapshotTitle?: string;
  title: string;
  externalId: string;
  priority: string;
  type: string;
  suiteId?: string | null;
  description?: string;
  preconditions?: string;
  postconditions?: string;
  steps?: unknown;
  testData?: string;
  expectedResult?: string;
  automationStatus?: string;
  automationTags?: string;
  status: string;
  assigneeId: string | null;
  actualResult: string;
  executedAt: string | null;
  defectKey: string;
  defectUrl: string;
}

export interface AutomatedRunResult {
  runId: string;
  cycleId: string;
  status: "running" | "completed" | "failed";
  totalCases: number;
  executionProvider?: string;
  maxParallel?: number;
}

export interface AutomatedRunLiveStatusItem {
  executionId: string;
  title: string;
  externalId: string;
  status: "queued" | "running" | "passed" | "failed" | "manual" | "cancelled";
  index: number;
  message?: string;
}

export interface AutomatedRunLiveStatus {
  runId: string;
  cycleId: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  endedAt?: string;
  currentExecutionId?: string;
  totalCases: number;
  completed: number;
  passed: number;
  failed: number;
  executionProvider?: string;
  maxParallel?: number;
  error?: string;
  items: AutomatedRunLiveStatusItem[];
}

export interface ExecutionAutomationLogItem {
  kind?: string;
  stepId?: string;
  action?: string;
  status?: string;
  message?: string;
  selectorUsed?: string;
  currentUrl?: string;
  durationMs?: number;
  screenshotPath?: string;
  screenshotUrl?: string;
  detail?: Record<string, unknown>;
  ts?: string;
}

export interface ExecutionAutomationReport {
  id?: string;
  cycleId?: string;
  executionId: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  logs: ExecutionAutomationLogItem[];
  videoAvailable: boolean;
  videoUrl?: string | null;
  traceAvailable?: boolean;
  traceUrl?: string | null;
  tracePath?: string | null;
  screenshotPath?: string | null;
  screenshotUrl?: string | null;
  errorMessage?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface TestRunSchedule {
  id: string;
  projectId: string;
  cycleId: string;
  name: string;
  enabled: boolean;
  scheduleType: "one_time" | "recurring";
  runAt: string | null;
  intervalMinutes: number | null;
  timezone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listTestRuns(projectId: string): Promise<TestRunListItem[]> {
  return api(`/api/projects/${projectId}/cycles`);
}

export async function getTestRun(cycleId: string): Promise<TestRunDetail> {
  return api(`/api/cycles/${cycleId}`);
}

export async function createTestRun(projectId: string, data: { name: string; description?: string; environment: string; buildVersion?: string }): Promise<{ id: string; name: string; status: string; createdAt: string }> {
  return api(`/api/projects/${projectId}/cycles`, { method: "POST", body: data });
}

export async function updateTestRun(cycleId: string, data: { name?: string; description?: string; environment?: string; buildVersion?: string; status?: string }): Promise<void> {
  await api(`/api/cycles/${cycleId}`, { method: "PATCH", body: data });
}

export async function deleteTestRun(cycleId: string): Promise<void> {
  await api(`/api/cycles/${cycleId}`, { method: "DELETE" });
}

export async function addTestCasesToRun(cycleId: string, testcaseIds: string[]): Promise<void> {
  await api(`/api/cycles/${cycleId}/testcases`, { method: "POST", body: { testcaseIds } });
}

export async function removeTestCaseFromRun(cycleId: string, testcaseId: string): Promise<void> {
  await api(`/api/cycles/${cycleId}/testcases/${testcaseId}`, { method: "DELETE" });
}

export async function createCycleFromPlan(projectId: string, data: { planId: string; name?: string; environment: string; buildVersion?: string }): Promise<{ id: string }> {
  return api(`/api/projects/${projectId}/cycles/from-plan`, { method: "POST", body: data });
}

export async function listCycleExecutions(cycleId: string): Promise<ExecutionItem[]> {
  return api(`/api/cycles/${cycleId}/executions`);
}

export async function updateExecution(cycleId: string, executionId: string, data: { status?: string; assigneeId?: string; actualResult?: string; defectKey?: string; defectUrl?: string }): Promise<void> {
  await api(`/api/cycles/${cycleId}/executions/${executionId}`, { method: "PATCH", body: data });
}

export async function getExecutionAutomationReport(cycleId: string, executionId: string): Promise<ExecutionAutomationReport> {
  return api<ExecutionAutomationReport>(`/api/cycles/${cycleId}/executions/${executionId}/automation-report`);
}

export function getExecutionAutomationVideoUrl(cycleId: string, executionId: string): string {
  return `${API_BASE}/api/cycles/${cycleId}/executions/${executionId}/automation-video`;
}

export function getExecutionAutomationTraceUrl(cycleId: string, executionId: string): string {
  return `${API_BASE}/api/cycles/${cycleId}/executions/${executionId}/automation-trace`;
}

export async function executeAutomatedTestRun(cycleId: string): Promise<AutomatedRunResult> {
  return api<AutomatedRunResult>(`/api/cycles/${cycleId}/execute-automated`, { method: "POST" });
}

export async function getAutomatedRunStatus(cycleId: string, runId: string): Promise<AutomatedRunLiveStatus> {
  return api<AutomatedRunLiveStatus>(`/api/cycles/${cycleId}/execute-automated/${runId}/status`);
}

export async function getLatestAutomatedRunStatus(cycleId: string): Promise<AutomatedRunLiveStatus> {
  return api<AutomatedRunLiveStatus>(`/api/cycles/${cycleId}/execute-automated/latest/status`);
}

export async function listTestRunSchedules(projectId: string): Promise<TestRunSchedule[]> {
  return api<TestRunSchedule[]>(`/api/projects/${projectId}/cycles/schedules`);
}

export async function createTestRunSchedule(
  projectId: string,
  data: {
    cycleId: string;
    name: string;
    scheduleType: "one_time" | "recurring";
    runAt?: string;
    intervalMinutes?: number;
    timezone?: string;
    enabled?: boolean;
  }
): Promise<TestRunSchedule> {
  return api<TestRunSchedule>(`/api/projects/${projectId}/cycles/schedules`, {
    method: "POST",
    body: data,
  });
}

export async function updateTestRunSchedule(
  scheduleId: string,
  data: {
    cycleId?: string;
    name?: string;
    scheduleType?: "one_time" | "recurring";
    runAt?: string;
    intervalMinutes?: number;
    timezone?: string;
    enabled?: boolean;
  }
): Promise<void> {
  await api(`/api/cycles/schedules/${scheduleId}`, { method: "PATCH", body: data });
}

export async function deleteTestRunSchedule(scheduleId: string): Promise<void> {
  await api(`/api/cycles/schedules/${scheduleId}`, { method: "DELETE" });
}

// Sharing
export interface ShareState {
  shareToken: string;
  shareEnabled: boolean;
}

export async function toggleTestRunShare(cycleId: string, enabled: boolean): Promise<ShareState> {
  return api<ShareState>(`/api/cycles/${cycleId}/share`, { method: "POST", body: { enabled } });
}

export async function getPublicSharedRun(token: string): Promise<TestRunDetail & { shareEnabled: boolean }> {
  return api(`/api/public/shared-runs/${token}`);
}

export async function getPublicSharedExecutions(token: string): Promise<ExecutionItem[]> {
  return api(`/api/public/shared-runs/${token}/executions`);
}

// Keep old names as aliases for backward compat
export const listCycles = listTestRuns;
export const getCycle = getTestRun;

// Bugs
export interface BugItem {
  id: string;
  title: string;
  description: string;
  externalUrl: string;
  status: string;
  executionId: string | null;
  testcaseId: string | null;
  cycleId: string | null;
  reportedBy: string | null;
  reporterName: string;
  reporterEmail: string;
  tcExternalId: string;
  tcTitle: string;
  cycleName: string;
  createdAt: string;
  updatedAt: string;
}

export async function listBugs(projectId: string, params?: { status?: string; cycleId?: string }): Promise<BugItem[]> {
  const sp = new URLSearchParams();
  if (params?.status) sp.set("status", params.status);
  if (params?.cycleId) sp.set("cycleId", params.cycleId);
  const query = sp.toString();
  return api(`/api/projects/${projectId}/bugs${query ? `?${query}` : ""}`);
}

export async function getBug(bugId: string): Promise<BugItem> {
  return api(`/api/bugs/${bugId}`);
}

export async function createBug(projectId: string, data: {
  title: string;
  description?: string;
  externalUrl?: string;
  executionId?: string;
  testcaseId?: string;
  cycleId?: string;
}): Promise<{ id: string; title: string; status: string; createdAt: string }> {
  return api(`/api/projects/${projectId}/bugs`, { method: "POST", body: data });
}

export async function updateBug(bugId: string, data: {
  title?: string;
  description?: string;
  externalUrl?: string;
  status?: string;
}): Promise<void> {
  await api(`/api/bugs/${bugId}`, { method: "PATCH", body: data });
}

export async function deleteBug(bugId: string): Promise<void> {
  await api(`/api/bugs/${bugId}`, { method: "DELETE" });
}

// Workspace analytics (dashboard – all projects in workspace)
export interface WorkspaceAnalytics {
  projectCount: number;
  testCaseCount: number;
  suiteCount: number;
  planCount: number;
  cycleCount: number;
  executionStatus: Record<string, number>;
  executionTotal: number;
}

export async function getWorkspaceAnalytics(): Promise<WorkspaceAnalytics> {
  return api<WorkspaceAnalytics>("/api/workspace/analytics");
}

// Project analytics (optional project-level view)
export interface ProjectAnalytics {
  testCaseCount: number;
  suiteCount: number;
  planCount: number;
  cycleCount: number;
  executionStatus: Record<string, number>;
  executionTotal: number;
}

export async function getProjectAnalytics(projectId: string): Promise<ProjectAnalytics> {
  return api<ProjectAnalytics>(`/api/projects/${projectId}/analytics`);
}

// ── Report: Execution Report ──
export interface ExecutionReportRow {
  groupId: string;
  groupName: string;
  Passed: number;
  Failed: number;
  Blocked: number;
  Skipped: number;
  Untested: number;
  Retest: number;
  total: number;
}

export interface ExecutionReportResponse {
  filterBy: string;
  filterValue: string | null;
  rows: ExecutionReportRow[];
}

export async function getExecutionReport(
  projectId: string,
  params?: { filterBy?: string; filterValue?: string }
): Promise<ExecutionReportResponse> {
  const sp = new URLSearchParams();
  if (params?.filterBy) sp.set("filterBy", params.filterBy);
  if (params?.filterValue) sp.set("filterValue", params.filterValue);
  const query = sp.toString();
  return api<ExecutionReportResponse>(
    `/api/projects/${projectId}/reports/execution${query ? `?${query}` : ""}`
  );
}

// ── Report: Requirement Traceability Matrix ──
export interface RequirementMatrixRow {
  testcaseId: string;
  externalId: string;
  testcaseTitle: string;
  priority: string;
  testcaseStatus: string;
  suiteName: string | null;
  runId: string | null;
  runName: string | null;
  runStatus: string | null;
  executionId: string | null;
  executionStatus: string | null;
  executedAt: string | null;
  bugId: string | null;
  bugTitle: string | null;
  bugStatus: string | null;
  bugUrl: string | null;
}

export async function getRequirementMatrix(projectId: string): Promise<{ rows: RequirementMatrixRow[] }> {
  return api<{ rows: RequirementMatrixRow[] }>(`/api/projects/${projectId}/reports/requirement-matrix`);
}

// ── Report: Repository Summary ──
export interface RepositorySummary {
  totalTestCases: number;
  bySuite: { name: string; count: number }[];
  byStatus: { name: string; count: number }[];
  addedByDate: { date: string; count: number }[];
  updatedToday: number;
  updatedThisWeek: number;
  updatedThisMonth: number;
  byPriority: { name: string; count: number }[];
}

export async function getRepositorySummary(projectId: string): Promise<RepositorySummary> {
  return api<RepositorySummary>(`/api/projects/${projectId}/reports/repository-summary`);
}

// ── Jira Integration ──

export interface JiraConnection {
  connected: boolean;
  id?: string;
  cloudId?: string;
  siteUrl?: string;
  tokenExpiresAt?: string;
  connectedBy?: string;
  createdAt?: string;
  connectedProjects?: JiraConnectedProject[];
}

export interface JiraOAuthConfig {
  configured: boolean;
  source: "project" | "environment" | "none";
  clientId: string;
  redirectUri: string;
  hasClientSecret: boolean;
  updatedAt: string | null;
}

export interface JiraConnectedProject {
  id: string;
  jiraProjectId: string;
  jiraProjectKey: string;
  jiraProjectName: string;
  createdAt: string;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  style: string;
  connected: boolean;
}

export interface JiraTicket {
  id: string;
  jiraIssueId: string;
  jiraIssueKey: string;
  summary: string;
  description: string;
  issueType: string;
  status: string;
  priority: string;
  assignee: string;
  reporter: string;
  labels: string;
  jiraUrl: string;
  jiraCreatedAt: string | null;
  jiraUpdatedAt: string | null;
  syncedAt: string | null;
}

export async function getJiraAuthUrl(projectId: string): Promise<{ url: string }> {
  return api<{ url: string }>(`/api/projects/${projectId}/jira/auth-url`);
}

export async function getJiraConfig(projectId: string): Promise<JiraOAuthConfig> {
  return api<JiraOAuthConfig>(`/api/projects/${projectId}/jira/config`);
}

export async function updateJiraConfig(
  projectId: string,
  data: { clientId: string; clientSecret: string; redirectUri: string }
): Promise<JiraOAuthConfig> {
  return api<JiraOAuthConfig>(`/api/projects/${projectId}/jira/config`, {
    method: "PATCH",
    body: data,
  });
}

export async function jiraCallback(projectId: string, code: string): Promise<{ connectionId: string; cloudId: string; siteUrl: string }> {
  return api(`/api/projects/${projectId}/jira/callback`, { method: "POST", body: { code } });
}

export async function getJiraStatus(projectId: string): Promise<JiraConnection> {
  return api<JiraConnection>(`/api/projects/${projectId}/jira/status`);
}

export async function disconnectJira(projectId: string): Promise<void> {
  await api(`/api/projects/${projectId}/jira/disconnect`, { method: "DELETE" });
}

export async function listJiraProjects(projectId: string): Promise<JiraProject[]> {
  return api<JiraProject[]>(`/api/projects/${projectId}/jira/projects`);
}

export async function connectJiraProjects(
  projectId: string,
  projects: { id: string; key: string; name: string }[]
): Promise<void> {
  await api(`/api/projects/${projectId}/jira/projects`, { method: "POST", body: { projects } });
}

export async function syncJiraTickets(projectId: string): Promise<{ synced: number }> {
  return api<{ synced: number }>(`/api/projects/${projectId}/jira/sync`, { method: "POST" });
}

export async function addJiraComment(
  projectId: string,
  issueKey: string,
  comment: string,
  testCases?: { id: string; title: string }[]
): Promise<void> {
  await api(`/api/projects/${projectId}/jira/comment`, {
    method: "POST",
    body: { issueKey, comment, testCases },
  });
}

export async function listJiraTickets(
  projectId: string,
  params?: { limit?: number; offset?: number; search?: string }
): Promise<{ list: JiraTicket[]; total: number }> {
  const sp = new URLSearchParams();
  if (params?.limit != null) sp.set("limit", String(params.limit));
  if (params?.offset != null) sp.set("offset", String(params.offset));
  if (params?.search) sp.set("search", params.search);
  const query = sp.toString();
  return api<{ list: JiraTicket[]; total: number }>(
    `/api/projects/${projectId}/jira/tickets${query ? `?${query}` : ""}`
  );
}

// ── Knowledge Base ──

export interface KnowledgeBaseItem {
  id: string;
  itemType: "note" | "file";
  title: string;
  content: string;
  fileName: string | null;
  fileContentType: string | null;
  fileSize: number | null;
  createdBy: string | null;
  creatorName: string;
  creatorEmail: string;
  createdAt: string;
  updatedAt: string;
}

export async function listKnowledgeBaseItems(
  projectId: string,
  params?: { search?: string; type?: string }
): Promise<{ list: KnowledgeBaseItem[]; total: number }> {
  const sp = new URLSearchParams();
  if (params?.search) sp.set("search", params.search);
  if (params?.type) sp.set("type", params.type);
  const query = sp.toString();
  return api<{ list: KnowledgeBaseItem[]; total: number }>(
    `/api/projects/${projectId}/knowledge-base${query ? `?${query}` : ""}`
  );
}

export async function createKnowledgeBaseNote(
  projectId: string,
  title: string,
  content: string
): Promise<KnowledgeBaseItem> {
  return api<KnowledgeBaseItem>(`/api/projects/${projectId}/knowledge-base`, {
    method: "POST",
    body: { title, content },
  });
}

export async function uploadKnowledgeBaseFile(
  projectId: string,
  file: File
): Promise<KnowledgeBaseItem> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:7000"}/api/projects/${projectId}/knowledge-base/upload`,
    { method: "POST", credentials: "include", body: formData }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || String(res.status));
  }
  return res.json() as Promise<KnowledgeBaseItem>;
}

export async function updateKnowledgeBaseItem(
  projectId: string,
  itemId: string,
  data: { title?: string; content?: string }
): Promise<void> {
  await api(`/api/projects/${projectId}/knowledge-base/${itemId}`, {
    method: "PATCH",
    body: data,
  });
}

export async function deleteKnowledgeBaseItem(
  projectId: string,
  itemId: string
): Promise<void> {
  await api(`/api/projects/${projectId}/knowledge-base/${itemId}`, { method: "DELETE" });
}

export function getKnowledgeBaseFileUrl(projectId: string, itemId: string): string {
  return `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:7000"}/api/projects/${projectId}/knowledge-base/${itemId}/file`;
}

// ── Activity Feed ──

export interface ActivityLogItem {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  entityName: string | null;
  diff: string | null;
  createdAt: string;
}

export async function listActivity(
  projectId: string,
  params?: { limit?: number; offset?: number; entityType?: string }
): Promise<{ list: ActivityLogItem[]; total: number }> {
  const sp = new URLSearchParams();
  if (params?.limit != null) sp.set("limit", String(params.limit));
  if (params?.offset != null) sp.set("offset", String(params.offset));
  if (params?.entityType) sp.set("entityType", params.entityType);
  const query = sp.toString();
  return api<{ list: ActivityLogItem[]; total: number }>(
    `/api/projects/${projectId}/activity${query ? `?${query}` : ""}`
  );
}

// ── Tesbo Test Manager reports module ─────────────────────────────────────────

export interface TesboRunSummary {
  id: string;
  projectId: string;
  name: string;
  status: string;
  branchName?: string | null;
  pullRequest?: string | null;
  commitAuthor?: string | null;
  runNumber?: string | null;
  sourceType?: string | null;
  githubRunId?: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface TesboRunCase {
  caseId: string;
  specName?: string | null;
  title: string;
  fullTitle?: string | null;
  status: string;
  durationMs: number | null;
  traceUrl: string | null;
  screenshotUrl: string | null;
  videoUrl: string | null;
  errorMessage?: string | null;
  errorStack?: string | null;
  attempt?: number | null;
  projectName?: string | null;
  browserName?: string | null;
  browserVersion?: string | null;
  osName?: string | null;
  osPlatform?: string | null;
  osArch?: string | null;
  tags?: string[];
  steps?: Array<{
    description?: string;
    status?: string;
    durationMs?: number;
  }>;
}

export interface TesboRunDetail extends TesboRunSummary {
  specCount: number;
  cases: TesboRunCase[];
}

export interface TesboPublicRunDetail extends TesboRunDetail {
  shareEnabled: boolean;
}

export interface TesboSpecSummary {
  specName: string;
  totalRuns: number;
  latestRunAt: string | null;
  passed: number;
  failed: number;
  skipped: number;
}

export interface TesboSpecDetail {
  specName: string;
  tests: {
    testName: string;
    latestStatus: string | null;
    totalRuns: number;
    passed: number;
    failed: number;
    skipped: number;
  }[];
}

export interface TesboProjectTest {
  specName: string;
  testName: string;
  latestStatus: string | null;
  latestRunAt: string | null;
  totalRuns: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface TesboAnalytics {
  totalRuns: number;
  totalTests: number;
  passRate: number;
  byStatus: Record<string, number>;
  runsByDay: { day: string; count: number }[];
}

export interface TesboAlertRule {
  id: string;
  name: string;
  conditionType: "FAILURE_RATIO" | "PASS_RATIO" | "BUILD_UPDATE";
  comparator: "GREATER_THAN" | "GREATER_OR_EQUAL";
  threshold: number | null;
  recipients: string[];
  frequency: "IMMEDIATE" | "DAILY";
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TesboShareState {
  enabled: boolean;
  token: string | null;
  publicUrl: string | null;
}

export interface TesboSettings {
  keepTrace: boolean;
  traceRetentionDays: number;
  ingestionApiKey: string;
  alertsEnabled: boolean;
  shareByDefault: boolean;
}

export async function listTesboRuns(projectId: string): Promise<TesboRunSummary[]> {
  return api<TesboRunSummary[]>(`/api/projects/${projectId}/tesbo-reports/runs`);
}

export async function getTesboRun(projectId: string, runId: string): Promise<TesboRunDetail> {
  return api<TesboRunDetail>(`/api/projects/${projectId}/tesbo-reports/runs/${runId}`);
}

export async function listTesboSpecs(projectId: string): Promise<TesboSpecSummary[]> {
  return api<TesboSpecSummary[]>(`/api/projects/${projectId}/tesbo-reports/specs`);
}

export async function getTesboSpec(projectId: string, specName: string): Promise<TesboSpecDetail> {
  return api<TesboSpecDetail>(
    `/api/projects/${projectId}/tesbo-reports/specs/${encodeURIComponent(specName)}`
  );
}

export async function getTesboTestHistory(
  projectId: string,
  specName: string,
  testName: string
): Promise<{
  specName: string;
  testName: string;
  runs: { runId: string; runName: string; status: string; executedAt: string | null }[];
}> {
  return api(
    `/api/projects/${projectId}/tesbo-reports/specs/${encodeURIComponent(specName)}/tests/${encodeURIComponent(testName)}`
  );
}

export async function listTesboTests(projectId: string): Promise<TesboProjectTest[]> {
  return api<TesboProjectTest[]>(`/api/projects/${projectId}/tesbo-reports/tests`);
}

export async function getTesboAnalytics(projectId: string): Promise<TesboAnalytics> {
  return api<TesboAnalytics>(`/api/projects/${projectId}/tesbo-reports/analytics`);
}

export async function listTesboAlertRules(projectId: string): Promise<TesboAlertRule[]> {
  return api<TesboAlertRule[]>(`/api/projects/${projectId}/tesbo-reports/alerts`);
}

export async function createTesboAlertRule(
  projectId: string,
  body: Omit<TesboAlertRule, "id" | "createdAt" | "updatedAt">
): Promise<TesboAlertRule> {
  return api<TesboAlertRule>(`/api/projects/${projectId}/tesbo-reports/alerts`, {
    method: "POST",
    body,
  });
}

export async function updateTesboAlertRule(
  projectId: string,
  alertId: string,
  body: Omit<TesboAlertRule, "id" | "createdAt" | "updatedAt">
): Promise<TesboAlertRule> {
  return api<TesboAlertRule>(`/api/projects/${projectId}/tesbo-reports/alerts/${alertId}`, {
    method: "PUT",
    body,
  });
}

export async function deleteTesboAlertRule(projectId: string, alertId: string): Promise<void> {
  await api(`/api/projects/${projectId}/tesbo-reports/alerts/${alertId}`, {
    method: "DELETE",
  });
}

export async function toggleTesboAlertRule(
  projectId: string,
  alertId: string,
  enabled: boolean
): Promise<TesboAlertRule> {
  return api<TesboAlertRule>(`/api/projects/${projectId}/tesbo-reports/alerts/${alertId}/toggle`, {
    method: "POST",
    body: { enabled },
  });
}

export async function sendTesboAlertTest(projectId: string, alertId: string): Promise<void> {
  await api(`/api/projects/${projectId}/tesbo-reports/alerts/${alertId}/send-test`, {
    method: "POST",
  });
}

export async function getTesboRunShare(projectId: string, runId: string): Promise<TesboShareState> {
  return api<TesboShareState>(`/api/projects/${projectId}/tesbo-reports/runs/${runId}/share`);
}

export async function createTesboRunShare(
  projectId: string,
  runId: string,
  expiresInHours = 168
): Promise<TesboShareState> {
  return api<TesboShareState>(`/api/projects/${projectId}/tesbo-reports/runs/${runId}/share`, {
    method: "POST",
    body: { expiresInHours },
  });
}

export async function disableTesboRunShare(projectId: string, runId: string): Promise<void> {
  await api(`/api/projects/${projectId}/tesbo-reports/runs/${runId}/share`, {
    method: "DELETE",
  });
}

export async function getPublicTesboRun(token: string): Promise<TesboPublicRunDetail> {
  return api<TesboPublicRunDetail>(`/api/public/tesbo-reports/${token}`);
}

export async function getTesboSettings(projectId: string): Promise<TesboSettings> {
  return api<TesboSettings>(`/api/projects/${projectId}/tesbo-reports/settings`);
}

export async function updateTesboSettings(
  projectId: string,
  body: Partial<TesboSettings>
): Promise<TesboSettings> {
  return api<TesboSettings>(`/api/projects/${projectId}/tesbo-reports/settings`, {
    method: "PUT",
    body,
  });
}

export async function rotateTesboIngestionKey(projectId: string): Promise<{ ingestionApiKey: string }> {
  return api<{ ingestionApiKey: string }>(`/api/projects/${projectId}/tesbo-reports/settings/rotate-key`, {
    method: "POST",
  });
}

export async function ingestTesboPlaywright(projectId: string, payload: unknown): Promise<{ runId: string }> {
  return api<{ runId: string }>(`/api/projects/${projectId}/tesbo-reports/ingest/playwright`, {
    method: "POST",
    body: { payload },
  });
}

export async function ingestTesboPlaywrightUpload(projectId: string, file: File): Promise<{ runId: string }> {
  const form = new FormData();
  form.append("result", file);
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/tesbo-reports/ingest/playwright/upload`, {
    method: "POST",
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Failed to upload Tesbo Test Manager result file");
  }
  return res.json() as Promise<{ runId: string }>;
}

export async function uploadTesboCaseArtifact(
  projectId: string,
  runId: string,
  caseId: string,
  kind: "trace" | "screenshot" | "video",
  file: File
): Promise<{ caseId: string; kind: string; url: string }> {
  const form = new FormData();
  form.append("file", file);
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
  const res = await fetch(
    `${API_BASE}/api/projects/${projectId}/tesbo-reports/runs/${runId}/cases/${caseId}/artifacts/${kind}/upload`,
    {
      method: "POST",
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Failed to upload Tesbo Test Manager artifact");
  }
  return res.json() as Promise<{ caseId: string; kind: string; url: string }>;
}
