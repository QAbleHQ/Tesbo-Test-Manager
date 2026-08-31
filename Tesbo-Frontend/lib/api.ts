import { readStoredValue } from "./storage";

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7000";

type RequestInitWithBody = Omit<RequestInit, "body"> & { body?: unknown };

type ApiErrorBody = { error?: string; detail?: string; errors?: { field?: string; message?: string }[] };

/**
 * A response with no `error`/`errors` body is never something the endpoint chose to say to a
 * user — every hand-written throw in the backend sets one (see legacy.service.ts's
 * BadRequestException({ error: ... }) calls). It means the request failed somewhere that never
 * got a chance to phrase it for a person: a rate limiter, a proxy's 502/504, or an unhandled
 * exception. Falling back to `String(status)` used to hand the caller a bare "500" or "429" as
 * the entire message — this is the friendly sentence for that case, keyed off the status class.
 */
function genericStatusMessage(status: number): string {
  if (status === 401) return "Your session has expired. Please sign in again.";
  if (status === 403) return "You don't have permission to do this.";
  if (status === 404) return "That could not be found. It may have been deleted or moved.";
  if (status === 409) return "This couldn't be saved because it conflicts with a recent change. Refresh and try again.";
  if (status === 429) return "Too many requests. Please wait a moment and try again.";
  if (status >= 500) return "Something went wrong on our end. Please try again.";
  return "Something went wrong. Please try again.";
}

function formatApiError(status: number, body: ApiErrorBody): string {
  if (!body.error && body.errors?.length) {
    return body.errors.map((e) => e.message).filter(Boolean).join(", ") || genericStatusMessage(status);
  }
  const msg = body.error || genericStatusMessage(status);
  const detail = body.detail?.trim();
  if (detail) return `${msg}: ${detail}`;
  return msg;
}

function isNetworkFetchError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : "Network request failed";
  return (
    msg === "Failed to fetch" ||
    msg === "Load failed" ||
    msg.includes("NetworkError") ||
    msg.includes("network")
  );
}

async function fetchWithNetworkErrorMessage(
  input: string,
  init: RequestInit
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (e) {
    if (!isNetworkFetchError(e)) throw e instanceof Error ? e : new Error(String(e));
    // A browser keep-alive connection left idle past the server/proxy's keep-alive window fails
    // on the next write before any bytes reach the server — the request was never delivered, so
    // retrying once (a fresh connection) is safe even for a POST body. `init.body` here is always
    // an already-serialized JSON string (see `api()` below), never a one-shot stream, so it can be
    // resent. This is what a manual page refresh already did to "fix" the error; automate that one
    // retry instead of surfacing it.
    try {
      return await fetch(input, init);
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : "Network request failed";
      throw new Error(
        `${msg} — browser blocked or could not reach the API. Confirm NEXT_PUBLIC_API_URL, HTTPS, and that the backend allows this page’s origin in CORS_ALLOWED_ORIGINS.`
      );
    }
  }
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
  const res = await fetchWithNetworkErrorMessage(`${API_BASE}${path}`, {
    ...rest,
    headers,
    credentials: "include",
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
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
  email: string | null;
  name: string | null;
  isPlatformAdmin?: boolean;
  hasPassword?: boolean;
} | null> {
  try {
    return await api<{
      userId: string;
      email: string | null;
      name: string | null;
      isPlatformAdmin?: boolean;
      hasPassword?: boolean;
    }>("/api/auth/me");
  } catch {
    return null;
  }
}

// --- Platform Admin APIs ---

export type BrandingSettings = {
  productName: string;
  logoUrl: string;
};

export async function getBranding(): Promise<BrandingSettings> {
  return api<BrandingSettings>("/api/branding");
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

export async function requestPasswordReset(email: string): Promise<void> {
  await api("/api/auth/password/forgot", { method: "POST", body: { email } });
}

export async function checkPasswordResetToken(token: string): Promise<{ valid: boolean }> {
  return api(`/api/auth/password/reset/${encodeURIComponent(token)}`);
}

export async function resetPassword(token: string, password: string): Promise<{ ok: boolean }> {
  return api("/api/auth/password/reset", { method: "POST", body: { token, password } });
}

export async function changePassword(currentPassword: string | null, newPassword: string): Promise<void> {
  await api("/api/auth/password/change", {
    method: "POST",
    body: { currentPassword: currentPassword ?? undefined, newPassword }
  });
}

export async function startSignup(data: { firstName: string; lastName: string; email: string; password: string }): Promise<void> {
  await api("/api/auth/signup/start", { method: "POST", body: data });
}

export async function verifySignup(email: string, code: string): Promise<{ ok: boolean; userId: string }> {
  return api("/api/auth/signup/verify", { method: "POST", body: { email, code } });
}

export async function startInviteRegistration(token: string, data: { name: string; password: string }): Promise<void> {
  await api(`/api/invitations/${token}/register/start`, { method: "POST", body: data });
}

export async function verifyInviteRegistration(
  token: string,
  code: string
): Promise<{ ok: boolean; userId: string; organizationId: string }> {
  return api(`/api/invitations/${token}/register/verify`, { method: "POST", body: { code } });
}

export async function startInviteOtpRegistration(token: string, data: { name: string }): Promise<void> {
  await api(`/api/invitations/${token}/register/otp/start`, { method: "POST", body: data });
}

export async function verifyInviteOtpRegistration(
  token: string,
  code: string
): Promise<{ ok: boolean; userId: string; organizationId: string }> {
  return api(`/api/invitations/${token}/register/otp/verify`, { method: "POST", body: { code } });
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
  /** ISO 3166-1 alpha-2. Soft signal for currency detection at checkout. */
  country?: string;
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
  plan?: "launch" | "pro";
  role?: string;
  /** Self-reported ISO 3166-1 alpha-2 country; null when never provided. */
  country?: string | null;
  createdAt: string;
}

export interface WorkspaceMember {
  userId: string;
  email: string;
  name: string;
  role: string;
  joinedAt: string;
}

export type WorkspaceRole = "owner" | "manager" | "qa_engineer";

export async function getWorkspace(): Promise<WorkspaceInfo> {
  return api<WorkspaceInfo>("/api/workspace");
}

// Omit `country` to leave it untouched; pass "" to clear it.
export async function updateWorkspace(data: { name: string; country?: string }): Promise<WorkspaceInfo> {
  return api<WorkspaceInfo>("/api/workspace", {
    method: "PATCH",
    body: data,
  });
}

// Billing (Tesbo Cloud plans) — pricing is per workspace, not per seat.
export type BillingInterval = "monthly" | "annual";

export interface BillingInfo {
  plan: "launch" | "pro";
  billingInterval: BillingInterval | null;
  status: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** Set while a subscription invoice is unpaid — Stripe is still retrying. */
  paymentFailedAt: string | null;
  /** When Launch limits start applying after a downgrade. */
  graceEndsAt: string | null;
  /** Downgraded, but still holding Pro-sized limits until graceEndsAt. */
  inGracePeriod: boolean;
  /** Grace window closed — Launch limits are now enforced. */
  limitsEnforced: boolean;
}

export async function getBillingInfo(): Promise<BillingInfo> {
  return api<BillingInfo>("/api/billing");
}

export type BillingCurrency = "usd" | "inr";

export interface BillingPricing {
  currency: BillingCurrency;
  monthlyAmount: number | null;
  annualAmount: number | null;
  /** Whether THIS visitor may choose INR — the server decides from the detected country. */
  inrAvailable: boolean;
  /** A past payment has fixed the currency in Stripe; it can no longer be changed. */
  currencyLocked: boolean;
}

// `currency` states a preference only — the server independently decides whether it's allowed
// (INR requires being detected in India) and rejects it otherwise. Omit for pure auto-detection.
export async function getBillingPricing(currency?: BillingCurrency): Promise<BillingPricing> {
  const query = currency ? `?currency=${currency}` : "";
  return api<BillingPricing>(`/api/billing/pricing${query}`);
}

// Pulls subscription state straight from Stripe. Called after checkout redirects back so the
// upgrade lands even if the webhook is late, dropped, or not configured.
export async function reconcileBilling(): Promise<BillingInfo> {
  return api<BillingInfo>("/api/billing/reconcile", { method: "POST" });
}

export interface BillingHistoryEntry {
  /** Machine-readable event, e.g. billing_upgraded / billing_payment_failed. */
  action: string;
  summary: string;
  detail: Record<string, unknown>;
  at: string;
}

export async function getBillingHistory(): Promise<BillingHistoryEntry[]> {
  return api<BillingHistoryEntry[]>("/api/billing/history");
}

export interface BillingInvoice {
  id: string;
  number: string | null;
  status: string | null;
  /** Minor units (paise / cents). */
  amountPaid: number;
  amountDue: number;
  currency: string;
  createdAt: string;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
}

export async function getBillingInvoices(): Promise<BillingInvoice[]> {
  return api<BillingInvoice[]>("/api/billing/invoices");
}

export async function createCheckoutSession(interval: BillingInterval, currency?: BillingCurrency): Promise<{ url: string }> {
  return api<{ url: string }>("/api/billing/checkout-session", {
    method: "POST",
    body: { interval, currency },
  });
}

export async function createPortalSession(): Promise<{ url: string }> {
  return api<{ url: string }>("/api/billing/portal-session", { method: "POST" });
}

export interface PlanUsageSummary {
  plan: "launch" | "pro";
  projectCount: number;
  /** The limits actually in force — Pro-sized while a downgraded workspace is in its grace window. */
  projectLimit: number | null;
  storageUsedBytes: number;
  storageLimitBytes: number;
  inGracePeriod: boolean;
  graceEndsAt: string | null;
  /** Where to send someone who needs more room than their plan allows. */
  supportContactEmail: string;
}

export async function getBillingUsage(): Promise<PlanUsageSummary> {
  return api<PlanUsageSummary>("/api/billing/usage");
}

export interface WorkspaceListItem extends WorkspaceInfo {
  isActive: boolean;
}

export async function listWorkspaces(): Promise<WorkspaceListItem[]> {
  return api<WorkspaceListItem[]>("/api/workspaces");
}

export async function createAdditionalWorkspace(data: {
  orgName: string;
}): Promise<CreateWorkspaceResponse> {
  return api<CreateWorkspaceResponse>("/api/workspaces", {
    method: "POST",
    body: data,
  });
}

export async function switchWorkspace(id: string): Promise<WorkspaceInfo> {
  return api<WorkspaceInfo>(`/api/workspaces/${id}/switch`, {
    method: "POST",
  });
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

export interface AiProviderOption {
  id: string;
  label: string;
  wire: "openai" | "anthropic" | "azure";
  /** Prefills the base-URL field; null means the provider's wire default is used. */
  defaultBaseUrl: string | null;
  requiresBaseUrl: boolean;
  optionalApiKey: boolean;
  defaultModel: string;
}

export async function listAiProviders(): Promise<{ providers: AiProviderOption[] }> {
  return api<{ providers: AiProviderOption[] }>("/api/workspace/ai-providers");
}

export interface ProviderModelOption {
  id: string;
  displayName: string;
}

export interface ProviderModelsResponse {
  models: ProviderModelOption[];
  /** "live" when read from the provider, "fallback" when the curated list was used. */
  source: "live" | "fallback";
  /** Why the fallback was used; empty for "live". */
  reason: string;
}

/** Lists the models a given key can actually reach. Never throws for provider-side
 *  failures — it degrades to a curated list so the settings form stays usable. */
export async function listProviderModels(data: {
  provider: string;
  apiKey?: string;
  keyId?: string;
  baseUrl?: string;
  authHeaderName?: string;
  authScheme?: string;
}): Promise<ProviderModelsResponse> {
  return api<ProviderModelsResponse>("/api/workspace/ai-keys/models", {
    method: "POST",
    body: data,
  });
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

export async function changeWorkspaceMemberRole(userId: string, role: string): Promise<void> {
  await api("/api/workspace/members/role", { method: "POST", body: { userId, role } });
}

export interface InviteProject {
  id: string;
  name: string;
}

export interface WorkspaceInvitation {
  id: string;
  email: string;
  role: string;
  status: "pending" | "accepted" | "expired" | "cancelled";
  expiresAt: string;
  createdAt: string;
  invitedByName: string | null;
  invitedByEmail: string | null;
  projects: InviteProject[];
}

export async function listWorkspaceInvitations(): Promise<WorkspaceInvitation[]> {
  return api<WorkspaceInvitation[]>("/api/workspace/invitations");
}

export async function createWorkspaceInvitation(data: {
  email: string;
  role?: string;
  projectIds?: string[];
}): Promise<WorkspaceInvitation> {
  return api<WorkspaceInvitation>("/api/workspace/invitations", { method: "POST", body: data });
}

export async function cancelWorkspaceInvitation(invitationId: string): Promise<void> {
  await api(`/api/workspace/invitations/${invitationId}`, { method: "DELETE" });
}

export async function resendWorkspaceInvitation(invitationId: string): Promise<void> {
  await api(`/api/workspace/invitations/${invitationId}/resend`, { method: "POST" });
}

/** @deprecated use cancelWorkspaceInvitation */
export async function revokeWorkspaceInvitation(invitationId: string): Promise<void> {
  return cancelWorkspaceInvitation(invitationId);
}

export interface InviteDetails {
  id: string;
  organizationId: string | null;
  organizationName: string | null;
  email: string;
  role: string;
  status: "pending" | "accepted" | "expired" | "cancelled";
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
  projects: InviteProject[];
  hasAccount: boolean;
}

export async function getInvitationByToken(token: string): Promise<InviteDetails> {
  return api<InviteDetails>(`/api/invitations/${token}`);
}

export async function acceptInvitation(token: string): Promise<{ accepted: boolean; organizationId: string | null }> {
  return api<{ accepted: boolean; organizationId: string | null }>(`/api/invitations/${token}/accept`, {
    method: "POST",
  });
}

export async function registerFromInvitation(
  token: string,
  data: { name: string; password: string }
): Promise<{ userId: string; organizationId: string }> {
  return api<{ userId: string; organizationId: string }>(`/api/invitations/${token}/register`, {
    method: "POST",
    body: data,
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

// Raw columns from the `notifications` table (see migrations/V6_notifications.sql) — the backend
// route returns rows as-is, unlike the camelCase DTOs above.
export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link_entity_type: string | null;
  link_entity_id: string | null;
  read_at: string | null;
  created_at: string;
}

export async function listNotifications(): Promise<AppNotification[]> {
  return api<AppNotification[]>("/api/notifications");
}

export async function markNotificationRead(id: string): Promise<void> {
  return api<void>(`/api/notifications/${id}/read`, { method: "POST" });
}

/**
 * Every projects-list card's stats in one response, replacing the five per-project calls the
 * screen used to fan out (test cases, suites, activity, members, runs). See
 * LegacyService.projectsOverview for why the fan-out had to go.
 */
export interface ProjectOverview extends ProjectSummary {
  testCaseCount: number;
  suiteCount: number;
  teamMembers: { userId: string; name: string }[];
  lastActivityAt: string | null;
  status: "setup_required" | "configured" | "active";
  runCounts: { passed: number; failed: number; blocked: number; total: number } | null;
  currentPassRate: number | null;
}

export async function listProjectsOverview(): Promise<ProjectOverview[]> {
  return api<ProjectOverview[]>("/api/projects/overview");
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
  taskStatus: "todo" | "in_progress" | "in_review" | "failed" | "done" | "accepted" | "rejected" | string;
  feedback: string;
  context: string;
  jiraIssueKeys: string[];
  linearIssueKeys: string[];
  drafts: AiGeneratedDraft[];
  sources: Array<{ type: string; title: string; detail: string }>;
  activities: Array<{ actor: "user" | "agent" | string; stage: string; title: string; detail: string; createdAt: string; kind?: string }>;
  tokenUsage: { input: number; output: number; total: number };
  createdAt: string;
  updatedAt: string;
}

export interface ZyraCapabilities {
  generation: boolean;
  knowledgeBase: boolean;
  testcaseStorage: boolean;
  suiteOperations: boolean;
}

export interface ZyraAgentState {
  agent: {
    name: string;
    role: string;
    active: boolean;
    activationReason: string;
    lastUsedAt: string | null;
  };
  settings: { testcaseCount: number; testcaseRange: string; capabilities: ZyraCapabilities };
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
  /**
   * Test cases Zyra has created in this project, counted across chat mode AND task mode.
   *
   * Authoritative, and not derivable from `tasks`: chat mode writes no generation row, so summing
   * task.generatedCount reports 0 for a project whose cases were all made by talking to Zyra.
   */
  testcasesCreated: number;
  tasks: ZyraTask[];
}

export interface ZyraChatTestcaseRow {
  id?: string | null;
  externalId?: string;
  title: string;
  priority?: string;
  status?: string;
  type?: string;
  preconditions?: string;
  expectedSummary?: string;
  stepsJson?: unknown;
  action?: string;
  reason?: string;
}

export interface ZyraChatMessage {
  id: string;
  sessionId: string;
  projectId: string;
  userId: string | null;
  role: "user" | "assistant" | string;
  content: string;
  reasoningSummary: string | null;
  actionType: string | null;
  status: string;
  testcases: ZyraChatTestcaseRow[];
  activity: Array<{ actor?: string; title?: string; detail?: string; createdAt?: string }>;
  createdAt: string;
}

export interface ZyraChatActivePlan {
  planId: string;
  status: "running" | "paused";
  remainingScenarios: string[];
  batchSize: number;
  doneCount: number;
  totalCount: number;
}

export interface ZyraChatSession {
  id: string;
  projectId: string;
  userId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages?: ZyraChatMessage[];
  activePlan?: ZyraChatActivePlan | null;
  /** Only present on list responses; absent (falsy) on a session just returned from create/get. */
  hasMessages?: boolean;
}

export async function getZyraAgent(projectId: string): Promise<ZyraAgentState> {
  return api<ZyraAgentState>(`/api/projects/${projectId}/agents/zyra`);
}

export async function testZyraAiConnection(projectId: string): Promise<{ ok: boolean; provider: string; model: string; error?: string; latencyMs: number }> {
  return api(`/api/projects/${projectId}/agents/zyra/test`);
}

export async function updateZyraSettings(
  projectId: string,
  data: { testcaseRange?: string; capabilities?: Partial<ZyraCapabilities> }
): Promise<{ testcaseCount: number; testcaseRange: string; capabilities: ZyraCapabilities }> {
  return api<{ testcaseCount: number; testcaseRange: string; capabilities: ZyraCapabilities }>(`/api/projects/${projectId}/agents/zyra/settings`, {
    method: "PATCH",
    body: data,
  });
}

export async function listZyraChatSessions(projectId: string): Promise<{ list: ZyraChatSession[] }> {
  return api<{ list: ZyraChatSession[] }>(`/api/projects/${projectId}/agents/zyra/chat/sessions`);
}

export async function createZyraChatSession(projectId: string, data: { title?: string } = {}): Promise<ZyraChatSession> {
  return api<ZyraChatSession>(`/api/projects/${projectId}/agents/zyra/chat/sessions`, {
    method: "POST",
    body: data,
  });
}

export async function getZyraChatSession(projectId: string, sessionId: string): Promise<ZyraChatSession> {
  return api<ZyraChatSession>(`/api/projects/${projectId}/agents/zyra/chat/sessions/${sessionId}`);
}

export async function sendZyraChatMessage(
  projectId: string,
  sessionId: string,
  message: string
): Promise<{ message: ZyraChatMessage; session: ZyraChatSession }> {
  return api(`/api/projects/${projectId}/agents/zyra/chat/sessions/${sessionId}/messages`, {
    method: "POST",
    body: { message },
  });
}

export async function stopZyraChatPlan(projectId: string, sessionId: string): Promise<ZyraChatSession> {
  return api<ZyraChatSession>(`/api/projects/${projectId}/agents/zyra/chat/sessions/${sessionId}/stop-plan`, {
    method: "POST",
  });
}

export async function resumeZyraChatPlan(projectId: string, sessionId: string): Promise<ZyraChatSession> {
  return api<ZyraChatSession>(`/api/projects/${projectId}/agents/zyra/chat/sessions/${sessionId}/resume-plan`, {
    method: "POST",
  });
}

export async function createZyraTask(
  projectId: string,
  data: {
    story: string;
    context?: string;
    acceptanceCriteria?: string;
    jiraIssueKeys?: string[];
    linearIssueKeys?: string[];
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
  data: string | { feedback: string; referenceNote?: string; jiraIssueKeys?: string[]; linearIssueKeys?: string[] }
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

export interface ApiToken {
  id: string;
  name: string;
  scopes: string[];
  tokenPrefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}
export interface ApiTokenWithSecret extends ApiToken {
  token: string;
}

export async function listApiKeys(projectId: string): Promise<ApiToken[]> {
  return api<ApiToken[]>(`/api/projects/${projectId}/apikeys`);
}

export async function createApiKey(
  projectId: string,
  data: { name: string; scopes?: string[] }
): Promise<ApiTokenWithSecret> {
  return api<ApiTokenWithSecret>(`/api/projects/${projectId}/apikeys`, { method: "POST", body: data });
}

export async function revokeApiKey(projectId: string, keyId: string): Promise<void> {
  await api(`/api/projects/${projectId}/apikeys/${keyId}`, { method: "DELETE" });
}

export function getMcpUrl(projectId: string): string {
  return `${API_BASE}/api/projects/${projectId}/mcp`;
}

// Suites

/** Sentinel `suiteId` filter value meaning "test cases with no suite assigned". Matches the backend's UNASSIGNED_SUITE_ID. */
export const UNASSIGNED_SUITE_ID = "none";

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
  linearIssueKey?: string | null;
  linearUrl?: string | null;
  customFieldValues?: Record<string, unknown>;
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
    linearIssueKey?: string;
    search?: string;
    /** JSON-stringified CustomFieldFilterCondition[] — see buildCustomFieldFiltersQueryParam(). */
    customFieldFilters?: string;
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
  if (params?.linearIssueKey) sp.set("linearIssueKey", params.linearIssueKey);
  if (params?.search) sp.set("search", params.search);
  if (params?.customFieldFilters) sp.set("customFieldFilters", params.customFieldFilters);
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

// Server-side batch creation, used by import. Keep batches at or under the backend's
// MAX_BULK_TESTCASES (500) — larger sheets should be sent as several calls.
export const BULK_CREATE_BATCH_SIZE = 200;

export async function bulkCreateTestCases(
  projectId: string,
  data: { testcases: Record<string, unknown>[]; testcaseIdPrefix?: string }
): Promise<{ created: { id: string; externalId: string; title: string }[]; createdCount: number }> {
  return api(`/api/projects/${projectId}/testcases/bulk-create`, { method: "POST", body: data });
}

export async function updateTestCase(projectId: string, testcaseId: string, data: Record<string, unknown>): Promise<void> {
  await api(`/api/projects/${projectId}/testcases/${testcaseId}`, { method: "PUT", body: data });
}

export async function deleteTestCase(projectId: string, testcaseId: string): Promise<void> {
  await api(`/api/projects/${projectId}/testcases/${testcaseId}`, { method: "DELETE" });
}

export async function duplicateTestCase(projectId: string, testcaseId: string): Promise<{ id: string; externalId: string; title: string }> {
  return api(`/api/projects/${projectId}/testcases/${testcaseId}/duplicate`, { method: "POST" });
}

export async function bulkUpdateTestCases(projectId: string, data: { testcaseIds: string[]; priority?: string; suiteId?: string; status?: string; ownerId?: string; automationStatus?: string }): Promise<void> {
  await api(`/api/projects/${projectId}/testcases/bulk-update`, { method: "POST", body: data });
}

export async function bulkDeleteTestCases(projectId: string, data: { testcaseIds: string[] }): Promise<void> {
  await api(`/api/projects/${projectId}/testcases/bulk-delete`, { method: "POST", body: data });
}

// Custom fields (Pro plan feature) ------------------------------------------------

export type CustomFieldType = "text" | "long_text" | "boolean" | "single_select" | "multi_select" | "number" | "date";
export type CustomFieldStatus = "active" | "inactive" | "archived";

export interface CustomFieldOption {
  id: string;
  label: string;
  active: boolean;
  order: number;
}

export interface CustomFieldConfig {
  placeholder?: string | null;
  maxLength?: number | null;
  displayFormat?: "yes_no" | "true_false";
  options?: CustomFieldOption[];
  defaultOptionId?: string | null;
  defaultOptionIds?: string[];
  minSelected?: number | null;
  maxSelected?: number | null;
  min?: number | null;
  max?: number | null;
  decimalsAllowed?: boolean;
  unit?: string | null;
  allowPastDates?: boolean;
  allowFutureDates?: boolean;
  defaultValue?: unknown;
}

export interface CustomFieldDefinition {
  id: string;
  projectId: string;
  key: string;
  name: string;
  description: string | null;
  fieldType: CustomFieldType;
  status: CustomFieldStatus;
  required: boolean;
  displayOrder: number;
  config: CustomFieldConfig;
  isUsed: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomFieldValue {
  id: string;
  key: string;
  name: string;
  description: string | null;
  fieldType: CustomFieldType;
  status: CustomFieldStatus;
  required: boolean;
  displayOrder: number;
  config: CustomFieldConfig;
  value: unknown;
}

export type CustomFieldFilterOperator =
  | "contains"
  | "does_not_contain"
  | "equals"
  | "is_empty"
  | "is_not_empty"
  | "is"
  | "is_not"
  | "includes_any"
  | "includes_all"
  | "yes"
  | "no"
  | "greater_than"
  | "less_than"
  | "between"
  | "before"
  | "after"
  | "on"
  | "is_overdue";

export interface CustomFieldFilterCondition {
  definitionId: string;
  operator: CustomFieldFilterOperator;
  value?: unknown;
  valueTo?: unknown;
}

export function buildCustomFieldFiltersQueryParam(conditions: CustomFieldFilterCondition[]): string | undefined {
  return conditions.length ? JSON.stringify(conditions) : undefined;
}

export async function listCustomFieldDefinitions(
  projectId: string,
  opts?: { statuses?: CustomFieldStatus[] }
): Promise<CustomFieldDefinition[]> {
  const qs = opts?.statuses?.length ? `?status=${opts.statuses.join(",")}` : "";
  return api<CustomFieldDefinition[]>(`/api/projects/${projectId}/custom-fields/definitions${qs}`);
}

export async function getCustomFieldDefinition(projectId: string, definitionId: string): Promise<CustomFieldDefinition> {
  return api<CustomFieldDefinition>(`/api/projects/${projectId}/custom-fields/definitions/${definitionId}`);
}

export async function createCustomFieldDefinition(
  projectId: string,
  data: {
    name: string;
    description?: string | null;
    fieldType: CustomFieldType;
    required?: boolean;
    active?: boolean;
    config?: CustomFieldConfig;
  }
): Promise<CustomFieldDefinition> {
  return api<CustomFieldDefinition>(`/api/projects/${projectId}/custom-fields/definitions`, { method: "POST", body: data });
}

export async function updateCustomFieldDefinition(
  projectId: string,
  definitionId: string,
  data: Partial<{ name: string; description: string | null; required: boolean; config: CustomFieldConfig }>
): Promise<CustomFieldDefinition> {
  return api<CustomFieldDefinition>(`/api/projects/${projectId}/custom-fields/definitions/${definitionId}`, { method: "PATCH", body: data });
}

export async function reorderCustomFieldDefinitions(projectId: string, orderedIds: string[]): Promise<void> {
  await api(`/api/projects/${projectId}/custom-fields/definitions/reorder`, { method: "POST", body: { orderedIds } });
}

export async function setCustomFieldDefinitionStatus(
  projectId: string,
  definitionId: string,
  status: CustomFieldStatus
): Promise<CustomFieldDefinition> {
  return api<CustomFieldDefinition>(`/api/projects/${projectId}/custom-fields/definitions/${definitionId}/status`, {
    method: "PATCH",
    body: { status }
  });
}

export async function deleteCustomFieldDefinition(projectId: string, definitionId: string): Promise<void> {
  await api(`/api/projects/${projectId}/custom-fields/definitions/${definitionId}`, { method: "DELETE" });
}

export async function addCustomFieldOption(projectId: string, definitionId: string, label: string): Promise<CustomFieldDefinition> {
  return api<CustomFieldDefinition>(`/api/projects/${projectId}/custom-fields/definitions/${definitionId}/options`, {
    method: "POST",
    body: { label }
  });
}

export async function setCustomFieldOptionActive(
  projectId: string,
  definitionId: string,
  optionId: string,
  active: boolean
): Promise<CustomFieldDefinition> {
  return api<CustomFieldDefinition>(`/api/projects/${projectId}/custom-fields/definitions/${definitionId}/options/${optionId}`, {
    method: "PATCH",
    body: { active }
  });
}

export async function getCustomFieldValues(projectId: string, testcaseId: string): Promise<CustomFieldValue[]> {
  return api<CustomFieldValue[]>(`/api/projects/${projectId}/testcases/${testcaseId}/custom-field-values`);
}

export async function listLinkedJiraKeys(projectId: string): Promise<{ keys: string[]; counts: Record<string, number> }> {
  return api<{ keys: string[]; counts: Record<string, number> }>(`/api/projects/${projectId}/testcases/linked-jira-keys`);
}

export async function listLinkedLinearKeys(projectId: string): Promise<{ keys: string[]; counts: Record<string, number> }> {
  return api<{ keys: string[]; counts: Record<string, number> }>(`/api/projects/${projectId}/testcases/linked-linear-keys`);
}

// Test case import/export
export function getExportUrl(projectId: string, format: "csv" | "xlsx"): string {
  return `${API_BASE}/api/projects/${projectId}/testcases/export/${format}`;
}

export function getTemplateUrl(projectId: string, format: "csv" | "xlsx"): string {
  return `${API_BASE}/api/projects/${projectId}/testcases/import/template?format=${format}`;
}

export interface ImportResult {
  imported: number;
  errors: { row: number; message: string }[];
  total: number;
  // Suites the import created a new child under — the caller should expand these in the
  // suite tree so imported subfolders aren't left collapsed and undiscovered.
  expandSuiteIds?: string[];
}

/**
 * One mapped spreadsheet row, ready to insert. `rowNumber` is the line in the user's file, carried
 * through so the server can report an error against the row they can actually go and look at.
 */
export interface ImportTestCaseRow {
  rowNumber: number;
  title: string;
  description?: string;
  preconditions?: string;
  postconditions?: string;
  steps?: { stepNumber: number; action: string; expectedResult: string }[];
  testData?: string;
  priority?: string;
  severity?: string;
  type?: string;
  status?: string;
  suite?: string;
  component?: string;
  // definitionId -> already-coerced value. The modal resolves select labels to option ids before
  // sending, since it is the side that loaded the option lists to build the mapping UI.
  customFieldValues?: Record<string, unknown>;
}

/**
 * Commits a parsed import in one request.
 *
 * The modal used to POST createTestCase per row, which made a large file that many serial round
 * trips — and had the browser paginate the entire project first just to spot duplicate titles. Both
 * of those are the server's job now; the browser still parses the workbook and maps the columns.
 */
export async function importTestCases(
  projectId: string,
  data: { rows: ImportTestCaseRow[]; defaultSuiteId?: string }
): Promise<ImportResult> {
  return api<ImportResult>(`/api/projects/${projectId}/testcases/import`, { method: "POST", body: data });
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
export async function listPlans(projectId: string): Promise<PlanListItem[]> {
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

export interface PlanItem {
  id: string;
  suiteId: string | null;
  testcaseId: string | null;
  position: number;
  tcExternalId: string | null;
  tcTitle: string | null;
  tcPriority: string | null;
  suiteName: string | null;
  lastStatus: string | null;
}

export async function listPlanItems(planId: string): Promise<PlanItem[]> {
  return api(`/api/plans/${planId}/items`);
}

export async function addPlanItem(planId: string, data: { suiteId?: string; testcaseId?: string; position?: number }): Promise<void> {
  await api(`/api/plans/${planId}/items`, { method: "POST", body: data });
}

export async function removePlanItem(planId: string, itemId: string): Promise<void> {
  await api(`/api/plans/${planId}/items/${itemId}`, { method: "DELETE" });
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
  caseCount: number;
  runCount: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  lastRunAt: string | null;
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
  blocked: number;
  skipped: number;
  untested: number;
  /**
   * Automation provenance (Basecamp 10189985971). `source` is 'manual' for every run a person
   * creates; the rest are only ever set by the automation ingest and are null on a manual run.
   */
  source?: "manual" | "automation";
  triggeredBy?: string | null;
  commitSha?: string | null;
  branchName?: string | null;
  buildUrl?: string | null;
  closedAt?: string | null;
  closeStatus?: "completed" | "incomplete" | null;
  lastResultAt?: string | null;
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
  /**
   * Automation provenance (Basecamp 10189985971). `source` is 'manual' for every run a person
   * creates; the rest are only ever set by the automation ingest and are null on a manual run.
   */
  source?: "manual" | "automation";
  triggeredBy?: string | null;
  commitSha?: string | null;
  branchName?: string | null;
  buildUrl?: string | null;
  closedAt?: string | null;
  closeStatus?: "completed" | "incomplete" | null;
  lastResultAt?: string | null;
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
  /**
   * Set by the automation ingest only. `reportedBy` is 'human' for every result a person records,
   * so a row can be labelled as automated without joining back through the run -- and a tester's
   * later correction of an automated result flips it back, which is the point.
   *
   * `errorMessage` is deliberately separate from `actualResult`: that column is the tester's own
   * prose and an SDK never writes it.
   */
  durationMs?: number | null;
  retryCount?: number;
  errorMessage?: string | null;
  errorStack?: string | null;
  reportedBy?: "human" | "automation";
  /** Count only -- the file list is fetched per execution via listExecutionEvidence. */
  evidenceCount?: number;
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

export async function addTestCasesToRun(
  cycleId: string,
  testcaseIds: string[]
): Promise<{ requested: number; added: number; skipped: number }> {
  return api(`/api/cycles/${cycleId}/testcases`, { method: "POST", body: { testcaseIds } });
}

export async function removeTestCaseFromRun(cycleId: string, testcaseId: string): Promise<void> {
  await api(`/api/cycles/${cycleId}/testcases/${testcaseId}`, { method: "DELETE" });
}

export async function removeTestCasesFromRun(
  cycleId: string,
  testcaseIds: string[]
): Promise<{ requested: number; removed: number }> {
  return api(`/api/cycles/${cycleId}/testcases/bulk-delete`, { method: "POST", body: { testcaseIds } });
}

export async function createCycleFromPlan(projectId: string, data: { planId: string; name?: string; environment: string; buildVersion?: string }): Promise<{ id: string }> {
  return api(`/api/projects/${projectId}/cycles/from-plan`, { method: "POST", body: data });
}

export async function listCycleExecutions(cycleId: string): Promise<ExecutionItem[]> {
  return api(`/api/cycles/${cycleId}/executions`);
}

export async function updateExecution(cycleId: string, executionId: string, data: { status?: string; assigneeId?: string | null; actualResult?: string; defectKey?: string; defectUrl?: string }): Promise<void> {
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
export interface BugLink {
  id: string;
  testcaseId: string | null;
  testcaseTitle: string | null;
  testcaseExternalId: string | null;
  cycleId: string | null;
  cycleName: string | null;
  executionId: string | null;
}

export interface BugLinkInput {
  testcaseId?: string | null;
  cycleId?: string | null;
  executionId?: string | null;
}

export interface BugAttachment {
  id: string;
  fileName: string;
  contentType: string;
  fileSize: number;
  createdAt: string;
}

export type BugSeverity = "Critical" | "High" | "Medium" | "Low";

/*
 * Priority is nullable and separate from severity: severity is how bad the defect is, priority is
 * how soon it gets worked on (Basecamp 10226247009). null means untriaged — a real state, distinct
 * from any of P0..P3.
 */
export type BugPriority = "P0" | "P1" | "P2" | "P3";

export interface BugItem {
  id: string;
  title: string;
  description: string;
  externalUrl: string;
  status: string;
  severity: BugSeverity;
  priority: BugPriority | null;
  executionId: string | null;
  testcaseId: string | null;
  cycleId: string | null;
  reportedBy: string | null;
  reporterName: string;
  reporterEmail: string;
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeType?: "user" | "agent" | null;
  integrationProvider: "JIRA" | "LINEAR" | null;
  integrationIssueKey: string | null;
  betterbugsUrl: string | null;
  links: BugLink[];
  attachments: BugAttachment[];
  createdAt: string;
  updatedAt: string;
}

export async function listBugs(
  projectId: string,
  params?: { status?: string; cycleId?: string; assigneeId?: string }
): Promise<BugItem[]> {
  const sp = new URLSearchParams();
  if (params?.status) sp.set("status", params.status);
  if (params?.cycleId) sp.set("cycleId", params.cycleId);
  if (params?.assigneeId) sp.set("assigneeId", params.assigneeId);
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
  severity?: BugSeverity;
  priority?: BugPriority | null;
  // null/omitted both mean unassigned on create; there is no "clear" distinction to make yet.
  assigneeId?: string | null;
  integrationProvider?: "JIRA" | "LINEAR" | null;
  integrationIssueKey?: string | null;
  betterbugsUrl?: string | null;
  links: BugLinkInput[];
}): Promise<BugItem> {
  return api(`/api/projects/${projectId}/bugs`, { method: "POST", body: data });
}

export async function updateBug(bugId: string, data: {
  title?: string;
  description?: string;
  externalUrl?: string;
  status?: string;
  severity?: BugSeverity;
  // null clears it back to untriaged; omitted leaves the stored value alone.
  priority?: BugPriority | null;
  // null clears the assignee; omitted leaves the stored value alone.
  assigneeId?: string | null;
  integrationProvider?: "JIRA" | "LINEAR" | null;
  integrationIssueKey?: string | null;
  betterbugsUrl?: string | null;
  links?: BugLinkInput[];
}): Promise<BugItem> {
  return api(`/api/bugs/${bugId}`, { method: "PATCH", body: data });
}

export async function deleteBug(bugId: string): Promise<void> {
  await api(`/api/bugs/${bugId}`, { method: "DELETE" });
}

export async function addBugLink(bugId: string, link: BugLinkInput): Promise<BugItem> {
  return api(`/api/bugs/${bugId}/links`, { method: "POST", body: link });
}

export async function removeBugLink(bugId: string, linkId: string): Promise<BugItem> {
  return api(`/api/bugs/${bugId}/links/${linkId}`, { method: "DELETE" });
}

export async function uploadBugAttachments(projectId: string, bugId: string, files: File[]): Promise<{ list: BugAttachment[]; total: number }> {
  const formData = new FormData();
  for (const file of files) formData.append("files", file);
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/bugs/${bugId}/attachments`, {
    method: "POST",
    credentials: "include",
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || String(res.status));
  }
  return res.json();
}

export async function deleteBugAttachment(attachmentId: string): Promise<void> {
  await api(`/api/bugs/attachments/${attachmentId}`, { method: "DELETE" });
}

export function getBugAttachmentDownloadUrl(projectId: string, attachmentId: string): string {
  return `${API_BASE}/api/projects/${projectId}/bugs/attachments/${attachmentId}/download`;
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

// ── Report: shared cycle pass-rate series ──
export interface CyclePassRatePoint {
  id: string;
  name: string;
  createdAt: string;
  total: number;
  executed: number;
  passRate: number | null;
}

// ── Report: Overview ──
export interface SuiteHealthRow {
  suiteName: string;
  executed: number;
  passedPct: number;
  failedPct: number;
  blockedPct: number;
}

export interface ReportsOverview {
  passRateTrend: CyclePassRatePoint[];
  trendDelta: number;
  suiteHealth: SuiteHealthRow[];
  aiSummary: string;
  flakyCount: number;
  coverageGapCount: number;
  untestedP1Count: number;
}

export async function getReportsOverview(projectId: string): Promise<ReportsOverview> {
  return api<ReportsOverview>(`/api/projects/${projectId}/reports/overview`);
}

// ── Report: AI Insights ──
export interface FlakyTestRow {
  testcaseId: string;
  externalId: string;
  title: string;
  suiteName: string;
  runs: { runName: string; status: string }[];
  flipCount: number;
  flakinessLabel: "High" | "Medium" | "Low";
}

export interface CoverageRow {
  suiteName: string;
  total: number;
  covered: number;
  pct: number;
}

export interface ReportsInsights {
  healthScore: number;
  healthLabel: string;
  flakyTests: FlakyTestRow[];
  coverageGaps: CoverageRow[];
  coverageBySuite: CoverageRow[];
  untestedP1Count: number;
}

export async function getReportsInsights(projectId: string): Promise<ReportsInsights> {
  return api<ReportsInsights>(`/api/projects/${projectId}/reports/insights`);
}

// ── Report: Trends ──
export interface ReportsTrends {
  passRateTrend: CyclePassRatePoint[];
  trendDelta: number;
  executionVelocity: { name: string; count: number }[];
  bugDiscoveryRate: { week: string; count: number }[];
}

export async function getReportsTrends(projectId: string): Promise<ReportsTrends> {
  return api<ReportsTrends>(`/api/projects/${projectId}/reports/trends`);
}

// ── Report: export ──
// One file per report view, mirroring what the screen is showing — including the Execution Report
// tab's active filter, so exporting while looking at one plan doesn't hand back every plan.
// Downloaded through a plain <a href> like the test case export, which keeps the session cookie on
// the request and lets the browser name the file from Content-Disposition.
export type ReportExportView = "overview" | "execution" | "matrix" | "repository" | "insights" | "trends";

export function getReportsExportUrl(
  projectId: string,
  view: ReportExportView,
  format: "csv" | "xlsx",
  params?: { filterBy?: string; filterValue?: string }
): string {
  const sp = new URLSearchParams({ view });
  if (params?.filterBy) sp.set("filterBy", params.filterBy);
  if (params?.filterValue) sp.set("filterValue", params.filterValue);
  return `${API_BASE}/api/projects/${projectId}/reports/export/${format}?${sp.toString()}`;
}

// ── Project Home dashboard summary ──
export interface ProjectDashboardSummary {
  testCases: { total: number; addedThisWeek: number };
  passRate: { value: number | null; deltaThisWeek: number | null };
  openBugs: { total: number; bySeverity: { Critical: number; High: number; Medium: number; Low: number } };
  coverage: { pct: number | null; totalRequirements: number };
  plans: number;
  suites: number;
  activeRuns: number;
}

export async function getProjectDashboardSummary(projectId: string): Promise<ProjectDashboardSummary> {
  return api<ProjectDashboardSummary>(`/api/projects/${projectId}/dashboard`);
}

// ── App integrations (Jira, Linear) ──
// Connecting/configuring an app is workspace-scoped (one connection per organization per
// provider) — see settings/integrations. Mapping which remote project/team feeds a given Tesbo
// project, syncing, and browsing tickets stays project-scoped, mirrored per provider below.

export type IntegrationProvider = "jira" | "linear";

/**
 * Read-only view of how the deployment is configured for this provider. Credentials come from the
 * backend environment (`<PROVIDER>_CLIENT_ID` / `_CLIENT_SECRET`) and cannot be set from the UI, so
 * `configured` is simply whether connecting is possible at all. `redirectUri` is exposed so a
 * self-hosted operator can see which callback URL to register in the provider console.
 */
export interface IntegrationOAuthConfig {
  configured: boolean;
  clientId: string;
  redirectUri: string;
}

export async function getIntegrationAuthUrl(provider: IntegrationProvider): Promise<{ url: string }> {
  return api<{ url: string }>(`/api/workspace/integrations/${provider}/auth-url`);
}

export async function getIntegrationConfig(provider: IntegrationProvider): Promise<IntegrationOAuthConfig> {
  return api<IntegrationOAuthConfig>(`/api/workspace/integrations/${provider}/config`);
}

// `state` is the signed value the backend put on the authorize URL; it must be handed back
// verbatim so the backend can confirm this callback belongs to the workspace that started it.
export async function integrationCallback(
  provider: IntegrationProvider,
  code: string,
  state: string
): Promise<{ connectionId: string; siteUrl: string }> {
  return api(`/api/workspace/integrations/${provider}/callback`, { method: "POST", body: { code, state } });
}

export async function disconnectIntegration(provider: IntegrationProvider): Promise<void> {
  await api(`/api/workspace/integrations/${provider}/disconnect`, { method: "DELETE" });
}

export interface IntegrationConnectionStatus {
  connected: boolean;
  id?: string;
  siteUrl?: string;
  tokenExpiresAt?: string | null;
  connectedBy?: string;
  createdAt?: string;
  connectedProjects?: { projectId: string; projectName: string; projectKey: string }[];
}

export async function getIntegrationStatus(provider: IntegrationProvider): Promise<IntegrationConnectionStatus> {
  return api<IntegrationConnectionStatus>(`/api/workspace/integrations/${provider}/status`);
}

// ── Jira (project-scoped mapping/sync/tickets) ──

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

export async function getJiraStatus(projectId: string): Promise<JiraConnection> {
  return api<JiraConnection>(`/api/projects/${projectId}/jira/status`);
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

// ── Integration sync runs ──
// Sync is queued, not synchronous: POST returns a run to poll rather than a finished count.

export type SyncRunStatus = "queued" | "running" | "succeeded" | "partial" | "failed";
export type SyncRunStage = "queued" | "connecting" | "fetching_tickets" | "building_documents" | "done" | "failed";

export interface SyncRun {
  id: string;
  provider: string;
  status: SyncRunStatus;
  stage: SyncRunStage;
  remoteProjectKey: string | null;
  totalTickets: number;
  processedTickets: number;
  failedTickets: number;
  documentsCreated: number;
  documentsUpdated: number;
  commentsSynced: number;
  decisionSummaries: number;
  error: string | null;
  triggeredByName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface StartSyncResult {
  run: SyncRun;
  /** True when a run was already in flight and this request joined it instead of starting another. */
  alreadyRunning: boolean;
}

export function isSyncRunActive(run: SyncRun | null | undefined): boolean {
  return !!run && (run.status === "queued" || run.status === "running");
}

export async function syncJiraTickets(projectId: string): Promise<StartSyncResult> {
  return api<StartSyncResult>(`/api/projects/${projectId}/jira/sync`, { method: "POST" });
}

export async function getIntegrationSyncStatus(projectId: string, provider: IntegrationProvider): Promise<{ run: SyncRun | null }> {
  return api<{ run: SyncRun | null }>(`/api/projects/${projectId}/integrations/${provider}/sync-status`);
}

export async function getIntegrationSyncHistory(projectId: string): Promise<{ runs: SyncRun[] }> {
  return api<{ runs: SyncRun[] }>(`/api/projects/${projectId}/integrations/sync-history`);
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

export interface TicketListParams {
  limit?: number;
  offset?: number;
  search?: string;
  issueType?: string;
  status?: string;
  coverage?: "covered" | "uncovered";
}

function ticketListParamsToSearch(params?: TicketListParams): URLSearchParams {
  const sp = new URLSearchParams();
  if (params?.limit != null) sp.set("limit", String(params.limit));
  if (params?.offset != null) sp.set("offset", String(params.offset));
  if (params?.search) sp.set("search", params.search);
  if (params?.issueType) sp.set("issueType", params.issueType);
  if (params?.status) sp.set("status", params.status);
  if (params?.coverage) sp.set("coverage", params.coverage);
  return sp;
}

export async function listJiraTickets(
  projectId: string,
  params?: TicketListParams
): Promise<{ list: JiraTicket[]; total: number }> {
  const query = ticketListParamsToSearch(params).toString();
  return api<{ list: JiraTicket[]; total: number }>(
    `/api/projects/${projectId}/jira/tickets${query ? `?${query}` : ""}`
  );
}

export interface IssueSearchResult {
  provider: "JIRA" | "LINEAR";
  key: string;
  summary: string;
  status: string;
  url: string;
}

export async function searchJiraIssuesLive(projectId: string, search: string): Promise<{ list: IssueSearchResult[] }> {
  const sp = new URLSearchParams();
  if (search) sp.set("search", search);
  return api(`/api/projects/${projectId}/jira/search-issues?${sp.toString()}`);
}

// ── Linear (project-scoped mapping/sync/tickets) ──
// Linear's unit of work is a "team" rather than a "project" — the shape below mirrors Jira's
// so the two providers can share UI, but the field names stay Linear-accurate.

export interface LinearConnection {
  connected: boolean;
  id?: string;
  siteUrl?: string;
  tokenExpiresAt?: string;
  connectedBy?: string;
  createdAt?: string;
  connectedProjects?: LinearConnectedTeam[];
}

export interface LinearConnectedTeam {
  id: string;
  linearTeamId: string;
  linearTeamKey: string;
  linearTeamName: string;
  createdAt: string;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
  style: string;
  connected: boolean;
}

export interface LinearTicket {
  id: string;
  linearIssueId: string;
  linearIssueKey: string;
  summary: string;
  description: string;
  issueType: string;
  status: string;
  priority: string;
  assignee: string;
  reporter: string;
  labels: string;
  linearUrl: string;
  linearCreatedAt: string | null;
  linearUpdatedAt: string | null;
  syncedAt: string | null;
}

export async function getLinearStatus(projectId: string): Promise<LinearConnection> {
  return api<LinearConnection>(`/api/projects/${projectId}/linear/status`);
}

export async function listLinearTeams(projectId: string): Promise<LinearTeam[]> {
  return api<LinearTeam[]>(`/api/projects/${projectId}/linear/teams`);
}

export async function connectLinearTeams(
  projectId: string,
  projects: { id: string; key: string; name: string }[]
): Promise<void> {
  await api(`/api/projects/${projectId}/linear/teams`, { method: "POST", body: { projects } });
}

export async function syncLinearTickets(projectId: string): Promise<StartSyncResult> {
  return api<StartSyncResult>(`/api/projects/${projectId}/linear/sync`, { method: "POST" });
}

export async function addLinearComment(projectId: string, issueKey: string, comment: string): Promise<void> {
  await api(`/api/projects/${projectId}/linear/comment`, { method: "POST", body: { issueKey, comment } });
}

export async function listLinearTickets(
  projectId: string,
  params?: TicketListParams
): Promise<{ list: LinearTicket[]; total: number }> {
  const query = ticketListParamsToSearch(params).toString();
  return api<{ list: LinearTicket[]; total: number }>(
    `/api/projects/${projectId}/linear/tickets${query ? `?${query}` : ""}`
  );
}

export async function searchLinearIssuesLive(projectId: string, search: string): Promise<{ list: IssueSearchResult[] }> {
  const sp = new URLSearchParams();
  if (search) sp.set("search", search);
  return api(`/api/projects/${projectId}/linear/search-issues?${sp.toString()}`);
}

// ── Requirements page: cross-source (Jira + Linear) aggregates ──

export interface TicketSourceStats {
  total: number;
  covered: number;
  uncovered: number;
  types: string[];
  statuses: string[];
}

export interface RequirementsSummary {
  all: TicketSourceStats;
  jira: TicketSourceStats;
  linear: TicketSourceStats;
}

export async function getRequirementsSummary(projectId: string): Promise<RequirementsSummary> {
  return api<RequirementsSummary>(`/api/projects/${projectId}/tickets/summary`);
}

export interface AllSourcesTicket {
  id: string;
  source: "jira" | "linear";
  key: string;
  summary: string;
  description: string;
  issueType: string;
  status: string;
  priority: string;
  assignee: string;
  reporter: string;
  labels: string;
  url: string;
  createdAt: string | null;
  updatedAt: string | null;
  hasCoverage: boolean;
}

export async function listAllTickets(
  projectId: string,
  params?: TicketListParams
): Promise<{ list: AllSourcesTicket[]; total: number }> {
  const query = ticketListParamsToSearch(params).toString();
  return api<{ list: AllSourcesTicket[]; total: number }>(
    `/api/projects/${projectId}/tickets${query ? `?${query}` : ""}`
  );
}

// ── Knowledge Base ──

export interface KnowledgeFolder {
  id: string;
  organizationId: string;
  projectId: string;
  parentFolderId: string | null;
  name: string;
  description: string | null;
  isRoot: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface KnowledgeFolderTreeNode extends KnowledgeFolder {
  children: KnowledgeFolderTreeNode[];
}

export type KnowledgeDocumentType =
  | "general"
  | "requirement_note"
  | "test_data_note"
  | "api_note"
  | "release_note"
  | "ai_memory";
export type KnowledgeDocumentStatus = "draft" | "published" | "approved" | "rejected";

export interface KnowledgeDocument {
  id: string;
  organizationId: string;
  projectId: string;
  folderId: string;
  title: string;
  contentJson: unknown;
  contentHtml: string | null;
  contentText: string | null;
  documentType: KnowledgeDocumentType;
  status: KnowledgeDocumentStatus;
  isAiGenerated: boolean;
  sourceProvider: string | null;
  sourceExternalId: string | null;
  sourceUrl: string | null;
  /** "mirror" = provider-owned, overwritten every sync. "notes" = the human-owned sibling. */
  sourceRole: "mirror" | "notes" | null;
  sourceSyncedBy: string | null;
  sourceSyncedAt: string | null;
  /** True for provider mirrors: the editor is locked and the API rejects updates. */
  isReadOnly: boolean;
  /** Display name of whoever last ran the sync that wrote this document. Detail endpoint only. */
  syncedByName?: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface KnowledgeFile {
  id: string;
  organizationId: string;
  projectId: string;
  folderId: string;
  fileName: string;
  originalFileName: string;
  mimeType: string | null;
  fileExtension: string | null;
  fileSize: number | null;
  storageKey: string | null;
  uploadedBy: string | null;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type KnowledgeBreadcrumbEntry = { id: string; name: string };

export type KnowledgeItem = (KnowledgeFolder | KnowledgeDocument | KnowledgeFile) & {
  type: "folder" | "document" | "file";
  updatedByName?: string | null;
  updatedByEmail?: string | null;
};

export interface KnowledgeDocumentVersion {
  id: string;
  versionNumber: number;
  title: string;
  createdBy: string | null;
  createdAt: string;
}

// Folders

export function getKnowledgeFolderTree(projectId: string): Promise<KnowledgeFolderTreeNode> {
  return api<KnowledgeFolderTreeNode>(`/api/projects/${projectId}/knowledge-base/folders/tree`);
}

export interface KnowledgeBaseSummary {
  folders: number;
  documents: number;
  files: number;
  total: number;
}

export function getKnowledgeBaseSummary(projectId: string): Promise<KnowledgeBaseSummary> {
  return api<KnowledgeBaseSummary>(`/api/projects/${projectId}/knowledge-base/summary`);
}

export function getKnowledgeFolderExportUrl(projectId: string, folderId: string): string {
  return `${API_BASE}/api/projects/${projectId}/knowledge-base/folders/${folderId}/export`;
}

export function getKnowledgeFolder(
  projectId: string,
  folderId: string
): Promise<KnowledgeFolder & { breadcrumb: KnowledgeBreadcrumbEntry[] }> {
  return api(`/api/projects/${projectId}/knowledge-base/folders/${folderId}`);
}

export function listKnowledgeFolderItems(
  projectId: string,
  folderId: string,
  params?: { search?: string }
): Promise<{ folder: KnowledgeFolder & { breadcrumb: KnowledgeBreadcrumbEntry[] }; items: KnowledgeItem[]; total: number }> {
  const sp = new URLSearchParams();
  if (params?.search) sp.set("search", params.search);
  const query = sp.toString();
  return api(`/api/projects/${projectId}/knowledge-base/folders/${folderId}/items${query ? `?${query}` : ""}`);
}

export function createKnowledgeFolder(
  projectId: string,
  data: { name: string; description?: string; parentFolderId?: string }
): Promise<KnowledgeFolder> {
  return api(`/api/projects/${projectId}/knowledge-base/folders`, { method: "POST", body: data });
}

export function updateKnowledgeFolder(
  projectId: string,
  folderId: string,
  data: { name?: string; description?: string }
): Promise<KnowledgeFolder> {
  return api(`/api/projects/${projectId}/knowledge-base/folders/${folderId}`, { method: "PATCH", body: data });
}

export function moveKnowledgeFolder(projectId: string, folderId: string, parentFolderId: string): Promise<KnowledgeFolder> {
  return api(`/api/projects/${projectId}/knowledge-base/folders/${folderId}/move`, {
    method: "PATCH",
    body: { parentFolderId },
  });
}

export function deleteKnowledgeFolder(projectId: string, folderId: string): Promise<{ success: boolean }> {
  return api(`/api/projects/${projectId}/knowledge-base/folders/${folderId}`, { method: "DELETE" });
}

export function restoreKnowledgeFolder(projectId: string, folderId: string): Promise<KnowledgeFolder> {
  return api(`/api/projects/${projectId}/knowledge-base/folders/${folderId}/restore`, { method: "PATCH" });
}

// Documents

export function listKnowledgeDocuments(
  projectId: string,
  params?: { documentType?: string }
): Promise<{ list: KnowledgeDocument[]; total: number }> {
  const sp = new URLSearchParams();
  if (params?.documentType) sp.set("documentType", params.documentType);
  const query = sp.toString();
  return api(`/api/projects/${projectId}/knowledge-base/documents${query ? `?${query}` : ""}`);
}

export function createKnowledgeDocument(
  projectId: string,
  data: { folderId: string; title: string; documentType?: string; contentJson?: unknown; contentHtml?: string; contentText?: string }
): Promise<KnowledgeDocument> {
  return api(`/api/projects/${projectId}/knowledge-base/documents`, { method: "POST", body: data });
}

export function getKnowledgeDocument(
  projectId: string,
  documentId: string
): Promise<KnowledgeDocument & { breadcrumb: KnowledgeBreadcrumbEntry[] }> {
  return api(`/api/projects/${projectId}/knowledge-base/documents/${documentId}`);
}

export function updateKnowledgeDocument(
  projectId: string,
  documentId: string,
  data: Partial<{ title: string; contentJson: unknown; contentHtml: string; contentText: string; documentType: string; status: string }>
): Promise<KnowledgeDocument> {
  return api(`/api/projects/${projectId}/knowledge-base/documents/${documentId}`, { method: "PATCH", body: data });
}

export function moveKnowledgeDocument(projectId: string, documentId: string, folderId: string): Promise<KnowledgeDocument> {
  return api(`/api/projects/${projectId}/knowledge-base/documents/${documentId}/move`, { method: "PATCH", body: { folderId } });
}

export function duplicateKnowledgeDocument(projectId: string, documentId: string): Promise<KnowledgeDocument> {
  return api(`/api/projects/${projectId}/knowledge-base/documents/${documentId}/duplicate`, { method: "POST" });
}

export function deleteKnowledgeDocument(projectId: string, documentId: string): Promise<{ success: boolean }> {
  return api(`/api/projects/${projectId}/knowledge-base/documents/${documentId}`, { method: "DELETE" });
}

export function restoreKnowledgeDocument(projectId: string, documentId: string): Promise<KnowledgeDocument> {
  return api(`/api/projects/${projectId}/knowledge-base/documents/${documentId}/restore`, { method: "PATCH" });
}

export function listKnowledgeDocumentVersions(
  projectId: string,
  documentId: string
): Promise<{ list: KnowledgeDocumentVersion[]; total: number }> {
  return api(`/api/projects/${projectId}/knowledge-base/documents/${documentId}/versions`);
}

export function restoreKnowledgeDocumentVersion(projectId: string, documentId: string, versionId: string): Promise<KnowledgeDocument> {
  return api(`/api/projects/${projectId}/knowledge-base/documents/${documentId}/restore-version`, {
    method: "POST",
    body: { versionId },
  });
}

export function approveAiMemory(projectId: string, documentId: string): Promise<KnowledgeDocument> {
  return api(`/api/projects/${projectId}/knowledge-base/documents/${documentId}/approve-ai-memory`, { method: "PATCH" });
}

export function rejectAiMemory(projectId: string, documentId: string): Promise<KnowledgeDocument> {
  return api(`/api/projects/${projectId}/knowledge-base/documents/${documentId}/reject-ai-memory`, { method: "PATCH" });
}

// Document comments
// Stored separately from the document body, so they work on read-only provider mirrors whose
// body is rewritten by every sync.

export interface KnowledgeDocumentComment {
  id: string;
  documentId: string;
  parentCommentId: string | null;
  authorId: string | null;
  authorName: string;
  body: string;
  /** Quoted passage this thread is anchored to, or null for a document-level comment. */
  anchorText: string | null;
  anchorStart: number | null;
  anchorEnd: number | null;
  isResolved: boolean;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** One level of nesting only — replies never have replies of their own. */
  replies: KnowledgeDocumentComment[];
}

export function listKnowledgeDocumentComments(
  projectId: string,
  documentId: string
): Promise<{ list: KnowledgeDocumentComment[]; total: number; openCount: number }> {
  return api(`/api/projects/${projectId}/knowledge-base/documents/${documentId}/comments`);
}

export function createKnowledgeDocumentComment(
  projectId: string,
  documentId: string,
  input: { body: string; parentCommentId?: string; anchorText?: string; anchorStart?: number; anchorEnd?: number }
): Promise<KnowledgeDocumentComment> {
  return api(`/api/projects/${projectId}/knowledge-base/documents/${documentId}/comments`, { method: "POST", body: input });
}

export function updateKnowledgeDocumentComment(
  projectId: string,
  commentId: string,
  input: { body?: string; isResolved?: boolean }
): Promise<KnowledgeDocumentComment> {
  return api(`/api/projects/${projectId}/knowledge-base/comments/${commentId}`, { method: "PATCH", body: input });
}

export function deleteKnowledgeDocumentComment(projectId: string, commentId: string): Promise<{ success: boolean }> {
  return api(`/api/projects/${projectId}/knowledge-base/comments/${commentId}`, { method: "DELETE" });
}

// Files

// Matches the backend's FilesInterceptor("files", 10, ...) cap per request — files beyond this
// count in a single multipart request are dropped by multer, so larger selections are split into
// sequential batches here instead of raising the per-request limit (which holds every file for a
// batch in memory until the whole batch validates).
const KB_UPLOAD_BATCH_SIZE = 10;

async function uploadKnowledgeFileBatch(
  projectId: string,
  folderId: string,
  files: File[]
): Promise<{ list: KnowledgeFile[]; total: number }> {
  const formData = new FormData();
  formData.append("folderId", folderId);
  for (const file of files) formData.append("files", file);
  const res = await fetchWithNetworkErrorMessage(
    `${API_BASE}/api/projects/${projectId}/knowledge-base/files/upload`,
    { method: "POST", credentials: "include", body: formData }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || String(res.status));
  }
  return res.json();
}

export async function uploadKnowledgeFiles(
  projectId: string,
  folderId: string,
  files: File[],
  onProgress?: (uploaded: number, total: number) => void
): Promise<{ list: KnowledgeFile[]; total: number }> {
  const list: KnowledgeFile[] = [];
  for (let i = 0; i < files.length; i += KB_UPLOAD_BATCH_SIZE) {
    const batch = files.slice(i, i + KB_UPLOAD_BATCH_SIZE);
    const result = await uploadKnowledgeFileBatch(projectId, folderId, batch);
    list.push(...result.list);
    onProgress?.(Math.min(i + batch.length, files.length), files.length);
  }
  return { list, total: list.length };
}

export function getKnowledgeFile(
  projectId: string,
  fileId: string
): Promise<KnowledgeFile & { breadcrumb: KnowledgeBreadcrumbEntry[] }> {
  return api(`/api/projects/${projectId}/knowledge-base/files/${fileId}`);
}

export function updateKnowledgeFile(projectId: string, fileId: string, originalFileName: string): Promise<KnowledgeFile> {
  return api(`/api/projects/${projectId}/knowledge-base/files/${fileId}`, {
    method: "PATCH",
    body: { originalFileName },
  });
}

export function moveKnowledgeFile(projectId: string, fileId: string, folderId: string): Promise<KnowledgeFile> {
  return api(`/api/projects/${projectId}/knowledge-base/files/${fileId}/move`, { method: "PATCH", body: { folderId } });
}

export function deleteKnowledgeFile(projectId: string, fileId: string): Promise<{ success: boolean }> {
  return api(`/api/projects/${projectId}/knowledge-base/files/${fileId}`, { method: "DELETE" });
}

export function restoreKnowledgeFile(projectId: string, fileId: string): Promise<KnowledgeFile> {
  return api(`/api/projects/${projectId}/knowledge-base/files/${fileId}/restore`, { method: "PATCH" });
}

export function getKnowledgeFileDownloadUrl(projectId: string, fileId: string): string {
  return `${API_BASE}/api/projects/${projectId}/knowledge-base/files/${fileId}/download`;
}

export function getKnowledgeFilePreviewUrl(projectId: string, fileId: string): string {
  return `${API_BASE}/api/projects/${projectId}/knowledge-base/files/${fileId}/preview`;
}

// Search

export function searchKnowledgeBase(
  projectId: string,
  params: { q: string; type?: string; date?: string }
): Promise<{ list: KnowledgeItem[]; total: number }> {
  const sp = new URLSearchParams();
  sp.set("q", params.q);
  if (params.type) sp.set("type", params.type);
  if (params.date) sp.set("date", params.date);
  return api(`/api/projects/${projectId}/knowledge-base/search?${sp.toString()}`);
}

// ── Activity Feed ──

export interface ActivityLogItem {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  actorName: string | null;
  actorKind: "user" | "agent" | null;
  action: string;
  entityType: string;
  entityId: string | null;
  entityName: string | null;
  diff: string | null;
  createdAt: string;
}

export async function listActivity(
  projectId: string,
  params?: { limit?: number; offset?: number; entityType?: string; actorId?: string; search?: string; since?: string }
): Promise<{ list: ActivityLogItem[]; total: number }> {
  const sp = new URLSearchParams();
  if (params?.limit != null) sp.set("limit", String(params.limit));
  if (params?.offset != null) sp.set("offset", String(params.offset));
  if (params?.entityType) sp.set("entityType", params.entityType);
  if (params?.actorId) sp.set("actorId", params.actorId);
  if (params?.search) sp.set("search", params.search);
  if (params?.since) sp.set("since", params.since);
  const query = sp.toString();
  return api<{ list: ActivityLogItem[]; total: number }>(
    `/api/projects/${projectId}/activity${query ? `?${query}` : ""}`
  );
}

export interface ActivitySummary {
  weekly: { created: number; updated: number; aiActions: number; deleted: number; total: number };
  activeMembers: {
    actorId: string;
    actorName: string | null;
    actorEmail: string | null;
    actorKind: "user" | "agent" | null;
    count: number;
  }[];
  byEntityType: { entityType: string; count: number }[];
}

export async function getActivitySummary(projectId: string): Promise<ActivitySummary> {
  return api<ActivitySummary>(`/api/projects/${projectId}/activity/summary`);
}

// ── Workspace Activity (master feed, owner-only) ──

export interface WorkspaceActivityLogItem extends ActivityLogItem {
  projectId: string | null;
  projectName: string | null;
}

export async function listWorkspaceActivity(params?: {
  limit?: number;
  offset?: number;
  entityType?: string;
  actorId?: string;
  projectId?: string;
  search?: string;
  since?: string;
}): Promise<{ list: WorkspaceActivityLogItem[]; total: number }> {
  const sp = new URLSearchParams();
  if (params?.limit != null) sp.set("limit", String(params.limit));
  if (params?.offset != null) sp.set("offset", String(params.offset));
  if (params?.entityType) sp.set("entityType", params.entityType);
  if (params?.actorId) sp.set("actorId", params.actorId);
  if (params?.projectId) sp.set("projectId", params.projectId);
  if (params?.search) sp.set("search", params.search);
  if (params?.since) sp.set("since", params.since);
  const query = sp.toString();
  return api<{ list: WorkspaceActivityLogItem[]; total: number }>(
    `/api/workspace/activity${query ? `?${query}` : ""}`
  );
}

export async function getWorkspaceActivitySummary(): Promise<ActivitySummary> {
  return api<ActivitySummary>("/api/workspace/activity/summary");
}

// ── Automation ingest (Basecamp 10189985971) ──────────────────────────────────
//
// Replaces the previous "Tesbo Test Manager reports module" block: ~30 client functions
// (listTesboRuns, ingestTesboPlaywright, the alert-rule CRUD, share links, key rotation) plus
// their types, none of which was imported anywhere, and only six of which had any backend at all
// — the rest called routes that did not exist.
//
// It was not merely dead, it encoded the opposite design: TesboRunCase was keyed on `specName` +
// `title` and getTesboTestHistory looked history up by test name, which is precisely the
// name-matching the card's §3 rules out ("breaks silently on refactors, and produces results
// attached to the wrong case with no visible error"), and its runs lived outside `cycles` so they
// could never appear in the runs list, the traceability matrix or a test case's own history.
//
// Automation results are now ordinary runs and executions, linked by the test case's external id.

/** What kind of file a piece of evidence is, which decides how the viewer renders it. */
export type EvidenceKind = "screenshot" | "video" | "trace" | "log";

export interface ExecutionEvidence {
  id: string;
  kind: EvidenceKind | null;
  fileName: string;
  fileSize: number | null;
  contentType: string | null;
  createdAt?: string;
}

export interface AutomationRunResult {
  caseId: string | null;
  title: string;
  executionId: string;
  status: string;
  durationMs: number | null;
  retryCount: number;
  errorMessage: string | null;
  executedAt: string | null;
  reportedBy: "human" | "automation";
  evidence: ExecutionEvidence[];
}

export interface AutomationRunSummary {
  runId: string;
  name: string;
  status: string;
  source: "manual" | "automation";
  triggeredBy: string | null;
  commitSha: string | null;
  branch: string | null;
  buildUrl: string | null;
  externalId: string | null;
  environment: string | null;
  buildVersion: string | null;
  releaseName: string | null;
  startedAt: string | null;
  endedAt: string | null;
  closedAt: string | null;
  closeStatus: "completed" | "incomplete" | null;
  lastResultAt: string | null;
  createdAt: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    blocked: number;
    untested: number;
  };
}

export interface AutomationRunDetail extends AutomationRunSummary {
  results: AutomationRunResult[];
}

export async function getAutomationRun(projectId: string, runId: string): Promise<AutomationRunDetail> {
  return api<AutomationRunDetail>(`/api/projects/${projectId}/automation/runs/${runId}`);
}

// ── Execution evidence ────────────────────────────────────────────────────────
//
// The backend has served POST/GET /api/cycles/:cycleId/executions/:executionId/attachments since
// the bug-evidence work, and nothing in the frontend has ever called either — so evidence has been
// storable, billable against the plan's storage allowance, and unviewable. These two are what the
// run screens use to show it.

export async function listExecutionEvidence(
  cycleId: string,
  executionId: string
): Promise<{ list: ExecutionEvidence[]; total: number }> {
  return api<{ list: ExecutionEvidence[]; total: number }>(
    `/api/cycles/${cycleId}/executions/${executionId}/attachments`
  );
}

/*
 * Playwright trace viewing.
 *
 * A trace .zip is not something a browser can open; the thing that renders it is Playwright's own
 * web app at trace.playwright.dev, which runs wholly in the visitor's browser and fetches the
 * archive itself — cross-origin, with no cookies. So the ordinary evidence download URL is no use
 * to it (session-authorized, and it redirects to a private presigned URL). These mint a short-lived
 * signed link instead and turn it into the viewer URL.
 *
 * The trace bytes go from our API to the person's own browser. trace.playwright.dev uploads
 * nothing and stores nothing — it is a static page — but the link it is handed does grant access to
 * that one archive until it expires, which is why the token is scoped to a single attachment and
 * lives for an hour rather than indefinitely.
 */
export async function createExecutionTraceLink(
  cycleId: string,
  executionId: string,
  attachmentId: string
): Promise<{ token: string; expiresAt: string }> {
  return api<{ token: string; expiresAt: string }>(
    `/api/cycles/${cycleId}/executions/${executionId}/attachments/${attachmentId}/trace-link`
  );
}

/** The URL the viewer fetches: our API, redeeming the signed token, with CORS for that one origin. */
export function publicTraceUrl(token: string): string {
  return `${API_BASE}/api/public/trace/${token}`;
}

/** Playwright's hosted viewer, pointed at a trace of ours. Used for both the iframe and the tab. */
export function playwrightTraceViewerUrl(traceUrl: string): string {
  return `https://trace.playwright.dev/?trace=${encodeURIComponent(traceUrl)}`;
}

export async function uploadExecutionEvidence(
  cycleId: string,
  executionId: string,
  files: File[]
): Promise<{ list: ExecutionEvidence[]; total: number }> {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  const token = typeof window !== "undefined" ? readStoredValue("token") : null;
  const res = await fetch(`${API_BASE}/api/cycles/${cycleId}/executions/${executionId}/attachments`, {
    method: "POST",
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  if (!res.ok) {
    // The backend answers a rejected upload with { error } naming the file and the limit; surface
    // that rather than a generic message, since "which file and why" is the whole point of it.
    const text = await res.text();
    let message = "Failed to upload evidence";
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      if (text) message = text;
    }
    throw new Error(message);
  }
  return res.json() as Promise<{ list: ExecutionEvidence[]; total: number }>;
}
