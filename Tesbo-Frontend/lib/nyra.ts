import { useEffect, useRef, useState } from "react";
import { API_BASE, api } from "@/lib/api";

export type NyraRunStatus = "queued" | "running" | "completed" | "partial" | "failed" | "stopped";
export const NYRA_ACTIVE: ReadonlySet<NyraRunStatus> = new Set(["queued", "running"]);

export type NyraKind = "screen" | "feature" | "workflow" | "business_rule" | "test_case" | "form" | "api_call" | "issue" | "tech";
export const NYRA_KINDS: Array<{ key: NyraKind; label: string }> = [
  { key: "screen", label: "Screens" },
  { key: "feature", label: "Features" },
  { key: "workflow", label: "Workflows" },
  { key: "business_rule", label: "Business rules" },
  { key: "test_case", label: "Test cases" },
  { key: "form", label: "Forms" },
  { key: "api_call", label: "API calls" },
  { key: "issue", label: "Issues" },
  { key: "tech", label: "Tech" },
];

export interface NyraEnvironment {
  id: string;
  name: string;
  baseUrl: string | null;
  mode: "observe" | "sandbox";
  allowedDomains: string[];
  loginUrl: string | null;
  username: string | null;
  loginMethod: string | null;
  hasPassword: boolean;
}

export interface NyraProjectDetail {
  id: string;
  name: string;
  appUrl: string | null;
  hasTestAccount: boolean;
  username: string | null;
  environments: NyraEnvironment[];
}

export interface NyraBudget {
  maxPages: number | null;
  maxMinutes: number | null;
  maxDepth: number | null;
}

export interface NyraRun {
  id: string;
  environmentId: string | null;
  status: NyraRunStatus;
  budget: NyraBudget;
  summary: { reason: string | null; pagesVisited: number | null; counts: Record<string, number>; recordings: number | null };
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export type NyraReviewStatus = "waiting" | "correct" | "edited" | "rejected";

export interface NyraItem {
  kind: NyraKind;
  key: string;
  /** What a person approved: NYRA's text, or the edited text. */
  title: string;
  data: Record<string, any>;
  reviewStatus: NyraReviewStatus;
  reviewedAt?: string | null;
  /** NYRA's own text, present only when a person edited the finding. */
  original?: { title: string; data: Record<string, any> } | null;
}

/** Whether approved findings will get vectors: a key that can embed exists for this project. */
export interface NyraEmbeddings {
  available: boolean;
  provider: string | null;
}

export interface NyraApproval {
  approvedAt: string;
  itemCount: number;
  documents: Array<{ kind: string; documentId: string; title: string }>;
}

/** The kinds a person reviews: the ones that explain the product. The rest stays in the report. */
export const NYRA_DOC_KINDS: ReadonlySet<NyraKind> = new Set(["screen", "feature", "workflow", "business_rule", "form", "tech"]);

export interface NyraDocBlock {
  heading: string;
  facts: Array<[string, string]>;
  steps: string[];
}
/** The Knowledge Base document the approved findings become, as the server will write it. */
export interface NyraDocPreview {
  title: string;
  intro: string[];
  sections: Array<{ id: string; heading: string; groups: Array<{ heading: string | null; blocks: NyraDocBlock[] }> }>;
  counts: Record<string, number>;
  clipped: boolean;
  /** Findings of the kinds that tell the story; approving needs at least one. */
  approvable: number;
  documentId: string | null;
  /** A person changed the document in the Knowledge Base after it was last approved. */
  editedInKb: boolean;
}

/** What a person may change per kind. Mirrors the server (nyra-review.ts), which enforces it. */
export const NYRA_EDITABLE: Partial<Record<NyraKind, { text?: Array<{ key: string; label: string; long?: boolean }>; list?: Array<{ key: string; label: string }>; oneOf?: Array<{ key: string; label: string; options: string[] }> }>> = {
  screen: { text: [{ key: "purpose", label: "Purpose", long: true }] },
  feature: { text: [{ key: "module", label: "Module" }, { key: "description", label: "Description", long: true }] },
  workflow: { text: [{ key: "goal", label: "Goal", long: true }], list: [{ key: "steps", label: "Steps" }] },
  business_rule: { text: [{ key: "explanation", label: "Why", long: true }] },
};

export interface NyraRecording {
  name: string;
  sizeBytes: number;
}

const base = (projectId: string, nyraId: string) => `/api/projects/${projectId}/agents/nyra/projects/${nyraId}`;

export const getNyraProject = (projectId: string, nyraId: string) => api<NyraProjectDetail>(base(projectId, nyraId));
export const listNyraRuns = (projectId: string, nyraId: string) => api<{ list: NyraRun[] }>(`${base(projectId, nyraId)}/runs`);
export const getNyraRun = (projectId: string, nyraId: string, runId: string) => api<NyraRun>(`${base(projectId, nyraId)}/runs/${runId}`);
export const startNyraRun = (projectId: string, nyraId: string, data: { environmentId: string; budget: Partial<Record<keyof NyraBudget, number>> }) =>
  api<NyraRun>(`${base(projectId, nyraId)}/runs`, { method: "POST", body: data });
export const stopNyraRun = (projectId: string, nyraId: string, runId: string) =>
  api<{ status: string }>(`${base(projectId, nyraId)}/runs/${runId}/stop`, { method: "POST" });
export const listNyraItems = (projectId: string, nyraId: string, runId: string) =>
  api<{ list: NyraItem[]; approval: NyraApproval | null; embeddings: NyraEmbeddings }>(`${base(projectId, nyraId)}/runs/${runId}/items`);
export const reviewNyraItem = (
  projectId: string,
  nyraId: string,
  runId: string,
  data: { kind: NyraKind; key: string; status: NyraReviewStatus; title?: string; data?: Record<string, unknown> }
) => api<NyraItem>(`${base(projectId, nyraId)}/runs/${runId}/items/review`, { method: "PUT", body: data });
export const reviewNyraItems = (
  projectId: string,
  nyraId: string,
  runId: string,
  data: { items: Array<{ kind: NyraKind; key: string }>; status: "correct" | "rejected" | "waiting" }
) => api<{ updated: number; skipped: number }>(`${base(projectId, nyraId)}/runs/${runId}/items/review-bulk`, { method: "POST", body: data });
export const approveNyraRun = (projectId: string, nyraId: string, runId: string, replaceEdits = false) =>
  api<{ approvedAt: string; itemCount: number; clipped: boolean; embeddings: NyraEmbeddings; documents: Array<{ kind: string; documentId: string; title: string; count: number; label: string }> }>(
    `${base(projectId, nyraId)}/runs/${runId}/approve`,
    { method: "POST", body: { replaceEdits } }
  );
// A signal is always passed: it also keeps api() from sharing one in-flight GET between two calls, so a
// preview asked for after a decision is never answered with the one that was already on its way.
export const getNyraDocumentPreview = (projectId: string, nyraId: string, runId: string, signal: AbortSignal) =>
  api<NyraDocPreview>(`${base(projectId, nyraId)}/runs/${runId}/document-preview`, { signal });
export const listNyraRecordings = (projectId: string, nyraId: string, runId: string) =>
  api<{ list: NyraRecording[] }>(`${base(projectId, nyraId)}/runs/${runId}/recordings`);
export const updateNyraEnvironment = (
  projectId: string,
  nyraId: string,
  envId: string,
  data: {
    name?: string;
    baseUrl?: string;
    mode?: "observe" | "sandbox";
    allowedDomains?: string[];
    testAccount?: { loginUrl?: string; username: string; password?: string; loginMethod?: "password" };
  }
) => api<NyraProjectDetail>(`${base(projectId, nyraId)}/environments/${envId}`, { method: "PATCH", body: data });

/** Same-origin-to-the-API URL for something a browser loads itself (image, video). The session cookie authenticates it. */
export const nyraFileUrl = (projectId: string, nyraId: string, runId: string, kind: "screens" | "recordings", name: string) =>
  `${API_BASE}${base(projectId, nyraId)}/runs/${runId}/files/${kind}/${encodeURIComponent(name)}`;
export const nyraLiveFrameUrl = (projectId: string, nyraId: string, runId: string) => `${API_BASE}${base(projectId, nyraId)}/runs/${runId}/live.jpg`;

export type NyraExport = "test-cases.csv" | "knowledge.md" | "business-rules.md";

/** The export as text. Empty string when NYRA has nothing to export (HTTP 204). */
export async function fetchNyraExport(projectId: string, nyraId: string, runId: string, file: NyraExport): Promise<string> {
  const res = await fetch(`${API_BASE}${base(projectId, nyraId)}/runs/${runId}/export/${file}`, { credentials: "include" });
  if (res.status === 204) return "";
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Could not load the export (HTTP ${res.status})`);
  }
  return res.text();
}

export function downloadText(text: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface NyraLogLine {
  id: number;
  level: string;
  message: string;
  ts: string;
}

export interface NyraStream {
  /** Items seen so far, by kind and key. Live only: NYRA saves results when the scan ends. */
  items: NyraItem[];
  log: NyraLogLine[];
  digest: { url: string; pattern: string; text: string } | null;
  /** The runner's own last status. It arrives BEFORE the results are saved, so it is a hint, not the end. */
  runnerStatus: string | null;
  /** False once the browser gave up (for example the run is gone). */
  live: boolean;
}

const EMPTY: NyraStream = { items: [], log: [], digest: null, runnerStatus: null, live: false };
const MAX_LOG = 2000;

/**
 * NYRA's live events for one run, through Tesbo's own proxy. The stream replays from the start when
 * opened (NYRA keeps 7 days), so it also serves a finished run's log. It never ends by itself, so it
 * is closed when `enabled` turns false or the component leaves.
 */
export function useNyraRunStream(projectId: string, nyraId: string, runId: string | null, enabled: boolean): NyraStream {
  const [state, setState] = useState<NyraStream>(EMPTY);
  const seq = useRef(0);

  useEffect(() => {
    setState(EMPTY);
    seq.current = 0;
    if (!enabled || !runId) return;
    const source = new EventSource(`${API_BASE}${base(projectId, nyraId)}/runs/${runId}/events`, { withCredentials: true });
    const items = new Map<string, NyraItem>();
    let log: NyraLogLine[] = [];
    let digest: NyraStream["digest"] = null;
    let runnerStatus: string | null = null;
    let live = true;
    // Events arrive in bursts (a replay is thousands); render at most about 4 times a second.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      setState({ items: [...items.values()], log, digest, runnerStatus, live });
    };
    const schedule = () => {
      if (!timer) timer = setTimeout(flush, 250);
    };
    const parse = (e: MessageEvent) => {
      try {
        return JSON.parse(e.data) as { ts: string; data: Record<string, any> };
      } catch {
        return null;
      }
    };
    source.addEventListener("open", () => {
      live = true;
      schedule();
    });
    source.addEventListener("status", (e) => {
      const m = parse(e as MessageEvent);
      if (m?.data?.status) runnerStatus = String(m.data.status);
      schedule();
    });
    source.addEventListener("log", (e) => {
      const m = parse(e as MessageEvent);
      if (!m) return;
      log = [...log, { id: seq.current++, level: String(m.data.level ?? "info"), message: String(m.data.message ?? ""), ts: m.ts }].slice(-MAX_LOG);
      schedule();
    });
    source.addEventListener("digest", (e) => {
      const m = parse(e as MessageEvent);
      if (m?.data) digest = { url: String(m.data.url ?? ""), pattern: String(m.data.pattern ?? ""), text: String(m.data.text ?? "") };
      schedule();
    });
    source.addEventListener("item", (e) => {
      const m = parse(e as MessageEvent);
      const d = m?.data;
      if (d?.kind && d?.key) {
        items.set(`${d.kind}:${d.key}`, { kind: d.kind, key: String(d.key), title: String(d.title ?? ""), data: d.data ?? {}, reviewStatus: "waiting" });
        schedule();
      }
    });
    source.onerror = () => {
      // EventSource retries by itself while CONNECTING; CLOSED means the server refused it.
      if (source.readyState === EventSource.CLOSED) {
        live = false;
        schedule();
      }
    };
    return () => {
      if (timer) clearTimeout(timer);
      source.close();
    };
  }, [projectId, nyraId, runId, enabled]);

  return state;
}
