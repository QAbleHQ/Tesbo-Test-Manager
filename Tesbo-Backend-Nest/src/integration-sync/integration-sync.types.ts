export type SyncProvider = "jira" | "linear";

export type SyncRunStatus = "queued" | "running" | "succeeded" | "partial" | "failed";

// 'manual' = the Sync button; 'nightly' = the scheduler. See V88.
export type SyncTriggerSource = "manual" | "nightly";

// Sub-step shown verbatim in the UI, so a user watching a slow sync can tell "still pulling
// tickets from Jira" apart from "building documents" apart from "indexing for Zyra".
export type SyncRunStage =
  | "queued"
  | "connecting"
  | "fetching_tickets"
  | "building_documents"
  | "done"
  | "failed";

export interface SyncRunJobPayload {
  runId: string;
  organizationId: string;
  projectId: string;
  provider: SyncProvider;
  triggeredBy: string | null;
  /** Defaults to "manual" at every existing call site — new field, old behavior unchanged. */
  triggerSource?: SyncTriggerSource;
  /** ISO timestamp. When set, only tickets updated at/after this instant are fetched. */
  since?: string | null;
}

export interface SyncTicketJobPayload {
  runId: string;
  organizationId: string;
  projectId: string;
  provider: SyncProvider;
  /** Our own jira_tickets/linear_tickets row id. */
  ticketId: string;
  /** Provider-side issue id, used as knowledge_documents.source_external_id. */
  issueId: string;
  issueKey: string;
  /** Provider folder the run created up front, so every ticket job doesn't re-resolve it. */
  folderId: string;
  triggeredBy: string | null;
}

export interface RemoteComment {
  author: string;
  createdAt: string | null;
  body: string;
}

/** Provider-agnostic ticket shape the run processor upserts. */
export interface RemoteTicket {
  issueId: string;
  issueKey: string;
  summary: string;
  description: string;
  issueType: string;
  status: string;
  priority: string;
  assignee: string;
  reporter: string;
  labels: string;
  createdAt: string | null;
  updatedAt: string | null;
  url: string;
}
