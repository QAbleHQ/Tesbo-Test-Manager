import { api } from "@/lib/api";

/*
 * Review Board client. Types mirror the backend responses in
 * Tesbo-Backend-Nest/src/review-board/review-board.service.ts exactly — nothing is inferred or mocked.
 *
 * Errors: api() throws a plain Error whose message is the backend's own `error` text (stale finding,
 * analysis already running, Pro plan, owner/manager only…), which is already user-readable, so callers
 * show `err.message` and reload; no status code is needed.
 */

export type ReviewClassification = "exact_duplicate" | "similar";
export type ReviewStatus = "pending" | "kept" | "edited" | "removed" | "obsolete";
export type RunStatus = "queued" | "running" | "completed" | "failed";
/**
 * Why a finding no longer describes reality (mirrors the backend's StaleReason):
 *   content    — a compared field (title, preconditions, steps, expected results, test data, postconditions) changed
 *   state      — description, status, suite, priority, severity, type, component, owner or an issue link changed
 *   unverified — recorded before change tracking existed; cannot be proven current
 */
export type StaleReason = "content" | "state" | "unverified";
export type DifferenceField = "title" | "preconditions" | "steps" | "expectedResults" | "testData" | "postconditions";

export interface AnalysisRun {
  id: string;
  status: RunStatus;
  testcasesAnalyzed: number | null;
  pairsFound: number | null;
  /** True when the run found more than the per-run cap and kept only the most similar pairs. */
  truncated: boolean;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ReviewDifference {
  field: DifferenceField;
  a: string;
  b: string;
}

export interface ReviewTestcaseRef {
  id: string;
  externalId: string;
  title: string;
  repositoryName: string;
}

export interface ReviewRecommendation {
  id: string;
  classification: ReviewClassification;
  similarity: number;
  explanation: string;
  differences: ReviewDifference[];
  reviewStatus: ReviewStatus;
  /** Either test case changed after the analysis that produced this finding; the API refuses every action on it. */
  stale: boolean;
  staleReason: StaleReason | null;
  /** Steps the two test cases share right now (same action and expected result); the match % alone cannot show this. */
  stepAgreement: { identical: number; total: number };
  reviewedBy: string | null;
  reviewedAt: string | null;
  lastAnalysis: { runId: string | null; status: RunStatus | null; finishedAt: string | null };
  testcaseA: ReviewTestcaseRef;
  testcaseB: ReviewTestcaseRef;
}

export interface RecommendationList {
  items: ReviewRecommendation[];
  /** Total matching the requested status filter (for paging). */
  total: number;
  /** Counts across every status, regardless of the filter. */
  counts: Record<ReviewStatus, number>;
}

/** Editable fields of the backend's edit endpoint; anything else is ignored server-side. */
export interface ReviewEditFields {
  title?: string;
  description?: string;
  preconditions?: string;
  postconditions?: string;
  testData?: string;
  steps?: Array<{ stepNumber?: number; action: string; expectedResult: string }>;
}

const base = (projectId: string) => `/api/projects/${projectId}/review-board`;

export async function getReviewAnalysis(projectId: string): Promise<AnalysisRun | null> {
  const res = await api<{ analysis: AnalysisRun | null }>(`${base(projectId)}/analysis`);
  return res.analysis;
}

export async function startReviewAnalysis(projectId: string): Promise<AnalysisRun> {
  const res = await api<{ analysis: AnalysisRun }>(`${base(projectId)}/analysis`, { method: "POST" });
  return res.analysis;
}

export async function listReviewRecommendations(
  projectId: string,
  params: { status?: ReviewStatus[]; limit?: number; offset?: number } = {}
): Promise<RecommendationList> {
  const sp = new URLSearchParams();
  if (params.status?.length) sp.set("status", params.status.join(","));
  if (params.limit) sp.set("limit", String(params.limit));
  if (params.offset) sp.set("offset", String(params.offset));
  const qs = sp.toString();
  return api<RecommendationList>(`${base(projectId)}/recommendations${qs ? `?${qs}` : ""}`);
}

/** One removal recorded by the Review Board (GET …/review-board/history). */
export interface ReviewHistoryItem {
  id: string;
  classification: ReviewClassification;
  /** The match at the moment of removal. */
  similarity: number;
  explanation: string;
  removedAt: string | null;
  removedBy: string | null;
  repositoryName: string;
  /** The test case that was removed; `stillDeleted` is false if something restored it since. */
  removed: { id: string; externalId: string; title: string; stillDeleted: boolean };
  /** The test case that stayed; `deleted` is true if it was deleted later. */
  kept: { id: string; externalId: string; title: string; deleted: boolean };
}

export interface ReviewHistory {
  items: ReviewHistoryItem[];
  total: number;
  counts: Record<ReviewStatus, number>;
}

export async function listReviewHistory(projectId: string, params: { limit?: number; offset?: number } = {}): Promise<ReviewHistory> {
  const sp = new URLSearchParams();
  if (params.limit) sp.set("limit", String(params.limit));
  if (params.offset) sp.set("offset", String(params.offset));
  const qs = sp.toString();
  return api<ReviewHistory>(`${base(projectId)}/history${qs ? `?${qs}` : ""}`);
}

export async function keepReviewRecommendation(projectId: string, id: string): Promise<void> {
  await api(`${base(projectId)}/recommendations/${id}/keep`, { method: "POST" });
}

/** What the server answers after an edit: the finding's match is recalculated from the edited content. */
export interface ReviewEditResult {
  id: string;
  reviewStatus: ReviewStatus;
  editedTestcaseId: string;
  classification: ReviewClassification;
  similarity: number;
}

export async function editReviewRecommendation(projectId: string, id: string, testcaseId: string, fields: ReviewEditFields): Promise<ReviewEditResult> {
  return api<ReviewEditResult>(`${base(projectId)}/recommendations/${id}/edit`, { method: "POST", body: { testcaseId, confirm: true, ...fields } });
}

export async function removeReviewRecommendation(projectId: string, id: string, testcaseId: string): Promise<void> {
  await api(`${base(projectId)}/recommendations/${id}/remove`, { method: "POST", body: { testcaseId, confirm: true } });
}

// ------------------------------------------------------------------ pure helpers (no I/O)

export const RUN_ACTIVE: ReadonlySet<RunStatus> = new Set<RunStatus>(["queued", "running"]);

export const DIFFERENCE_LABEL: Record<DifferenceField, string> = {
  title: "Title",
  preconditions: "Preconditions",
  steps: "Steps",
  expectedResults: "Expected results",
  testData: "Test data",
  postconditions: "Postconditions",
};

export type Step = { action: string; expected: string };

/** Same normalisation the backend fingerprints with: case, spacing and punctuation are not differences. */
export function normalizeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function scalar(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function decode(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Reads every shape `testcases.steps` is stored in (array, JSON string, double-encoded string, plain text). */
export function parseSteps(raw: unknown): Step[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return [];
    let value = decode(text);
    if (typeof value === "string") {
      const inner = decode(value.trim());
      if (Array.isArray(inner)) value = inner;
    }
    if (!Array.isArray(value)) {
      const action = typeof value === "string" ? value.trim() : text;
      return action ? [{ action, expected: "" }] : [];
    }
    list = value;
  }
  if (!Array.isArray(list)) return [];
  const steps: Step[] = [];
  for (const item of list) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const s = item as Record<string, unknown>;
      const action = scalar(s.action) || scalar(s.step) || scalar(s.description);
      const expected = scalar(s.expectedResult) || scalar(s.expected);
      if (action || expected) steps.push({ action, expected });
    } else {
      const action = scalar(item);
      if (action) steps.push({ action, expected: "" });
    }
  }
  return steps;
}

export interface CompareRow {
  key: string;
  label: string;
  a: string;
  b: string;
  /** Different after normalisation — the same test the backend applies. */
  differs: boolean;
}

function row(key: string, label: string, a: string, b: string): CompareRow {
  return { key, label, a, b, differs: normalizeText(a) !== normalizeText(b) };
}

/** Side-by-side rows for the Compare view, from two rows as returned by getTestCase(). */
export function buildCompareRows(a: Record<string, unknown>, b: Record<string, unknown>): CompareRow[] {
  const text = (r: Record<string, unknown>, k: string) => (typeof r[k] === "string" ? (r[k] as string) : "");
  const rows: CompareRow[] = [
    row("title", "Title", text(a, "title"), text(b, "title")),
    row("description", "Description", text(a, "description"), text(b, "description")),
    row("preconditions", "Preconditions", text(a, "preconditions"), text(b, "preconditions")),
  ];
  const stepsA = parseSteps(a.steps);
  const stepsB = parseSteps(b.steps);
  const count = Math.max(stepsA.length, stepsB.length);
  for (let i = 0; i < count; i++) {
    const fmt = (s?: Step) => (s ? [s.action, s.expected && `Expected: ${s.expected}`].filter(Boolean).join("\n") : "");
    const x = stepsA[i];
    const y = stepsB[i];
    const different = normalizeText(x?.action) !== normalizeText(y?.action) || normalizeText(x?.expected) !== normalizeText(y?.expected);
    rows.push({ key: `step-${i}`, label: `Step ${i + 1}`, a: fmt(x), b: fmt(y), differs: different });
  }
  rows.push(
    row("testData", "Test data", text(a, "testData"), text(b, "testData")),
    row("postconditions", "Postconditions", text(a, "postconditions"), text(b, "postconditions"))
  );
  return rows;
}

/** Fields the backend does NOT compare, shown for context only (they never change a finding's classification). */
export function buildContextRows(a: Record<string, unknown>, b: Record<string, unknown>): CompareRow[] {
  const keys: Array<[string, string]> = [["status", "Status"], ["priority", "Priority"], ["type", "Type"]];
  return keys.map(([k, label]) => row(k, label, scalar(a[k]), scalar(b[k])));
}

/** Only the fields whose normalised content changed, so an unchanged field is never re-sent. */
export function changedEditFields(
  original: Record<string, unknown>,
  draft: { title: string; description: string; preconditions: string; postconditions: string; testData: string; steps: Step[] }
): ReviewEditFields {
  const out: ReviewEditFields = {};
  const str = (k: "title" | "description" | "preconditions" | "postconditions" | "testData") => {
    const before = typeof original[k] === "string" ? (original[k] as string) : "";
    if (draft[k] !== before) out[k] = draft[k];
  };
  str("title");
  str("description");
  str("preconditions");
  str("postconditions");
  str("testData");
  const before = parseSteps(original.steps);
  const same = before.length === draft.steps.length && before.every((s, i) => s.action === draft.steps[i].action && s.expected === draft.steps[i].expected);
  if (!same) {
    out.steps = draft.steps
      .filter((s) => s.action.trim() || s.expected.trim())
      .map((s, i) => ({ stepNumber: i + 1, action: s.action, expectedResult: s.expected }));
  }
  return out;
}

export const STALE_HINT: Record<StaleReason, string> = {
  content: "The title, preconditions, steps, expected results, test data or postconditions of one of these test cases changed after the analysis.",
  state: "The description, status, suite, priority, severity, type, component, owner or issue links of one of these test cases changed after the analysis.",
  unverified: "This finding was recorded before change tracking existed, so it cannot be verified as current.",
};

export function formatPercent(similarity: number): string {
  return `${Math.round(similarity * 100)}%`;
}

