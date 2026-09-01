import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import { DatabaseService } from "../database/database.service";
import { PlanLimitsService } from "../plan-limits/plan-limits.service";
import {
  INTEGRATION_SYNC_QUEUE,
  INTEGRATION_SYNC_RUN_JOB,
  INTEGRATION_SYNC_TICKET_JOB,
  PROVIDER_FOLDER_NAMES
} from "./integration-sync.constants";
import { SyncProvider, SyncRunJobPayload, SyncRunStage, SyncTicketJobPayload, SyncTriggerSource } from "./integration-sync.types";

type Row = Record<string, any>;

export interface SyncRunView {
  id: string;
  provider: string;
  status: string;
  stage: string;
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

interface TicketProgressDelta {
  processed?: number;
  failed?: number;
  created?: number;
  updated?: number;
  comments?: number;
  decisions?: number;
}

@Injectable()
export class IntegrationSyncService {
  private readonly logger = new Logger(IntegrationSyncService.name);

  constructor(
    @InjectQueue(INTEGRATION_SYNC_QUEUE) private readonly queue: Queue,
    private readonly db: DatabaseService,
    private readonly planLimits: PlanLimitsService
  ) {}

  // ── Producer ──

  /**
   * Creates a sync run and enqueues its coordinator job. If a run is already in flight for this
   * project+provider, returns that one instead of starting a second: the partial unique index
   * idx_integration_sync_runs_active makes the second INSERT fail, which is the race-safe way to
   * dedupe two people hitting Sync at once.
   */
  async startRun(
    organizationId: string,
    projectId: string,
    provider: SyncProvider,
    triggeredBy: string | null,
    remoteProjectKey: string | null,
    options?: { triggerSource?: SyncTriggerSource; since?: string | null }
  ): Promise<{ run: SyncRunView; alreadyRunning: boolean }> {
    const triggerSource: SyncTriggerSource = options?.triggerSource || "manual";
    const since = options?.since ?? null;
    const connection = await this.db.query<{ id: string }>(
      "SELECT id FROM integration_connections WHERE organization_id = $1 AND provider = $2",
      [organizationId, provider]
    );

    try {
      const inserted = await this.db.query<{ id: string }>(
        `INSERT INTO integration_sync_runs (organization_id, project_id, provider, connection_id, remote_project_key, triggered_by, trigger_source, status, stage)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', 'queued')
         RETURNING id`,
        [organizationId, projectId, provider, connection.rows[0]?.id || null, remoteProjectKey, triggeredBy, triggerSource]
      );
      const runId = inserted.rows[0].id;

      const payload: SyncRunJobPayload = { runId, organizationId, projectId, provider, triggeredBy, triggerSource, since };
      await this.queue.add(INTEGRATION_SYNC_RUN_JOB, payload, {
        jobId: `run-${runId}`,
        // One attempt only. A retry would re-page the whole provider backlog, and the run row
        // already records the failure for the UI — the user retries by clicking Sync again.
        attempts: 1,
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 200 }
      });

      const run = await this.getRun(runId);
      return { run: run as SyncRunView, alreadyRunning: false };
    } catch (err) {
      const existing = await this.getLatestRun(projectId, provider);
      if (existing && (existing.status === "queued" || existing.status === "running")) {
        return { run: existing, alreadyRunning: true };
      }
      throw err;
    }
  }

  async enqueueTicketJobs(payloads: SyncTicketJobPayload[]): Promise<void> {
    if (!payloads.length) return;
    await this.queue.addBulk(
      payloads.map((payload) => ({
        name: INTEGRATION_SYNC_TICKET_JOB,
        data: payload,
        opts: {
          // Scoped to the run so a re-run of the same ticket isn't deduped against a previous
          // run's completed job.
          jobId: `ticket-${payload.runId}-${payload.ticketId}`,
          attempts: 3,
          backoff: { type: "exponential" as const, delay: 4000 },
          removeOnComplete: { count: 2000 },
          removeOnFail: { count: 2000 }
        }
      }))
    );
  }

  // ── Run state ──

  async markRunning(runId: string, stage: SyncRunStage): Promise<void> {
    await this.db.query(
      `UPDATE integration_sync_runs
       SET status = 'running', stage = $2, started_at = COALESCE(started_at, now()), updated_at = now()
       WHERE id = $1`,
      [runId, stage]
    );
  }

  async setStage(runId: string, stage: SyncRunStage): Promise<void> {
    await this.db.query("UPDATE integration_sync_runs SET stage = $2, updated_at = now() WHERE id = $1", [runId, stage]);
  }

  async setTotals(runId: string, totalTickets: number): Promise<void> {
    await this.db.query("UPDATE integration_sync_runs SET total_tickets = $2, updated_at = now() WHERE id = $1", [runId, totalTickets]);
  }

  async failRun(runId: string, error: string): Promise<void> {
    await this.db.query(
      `UPDATE integration_sync_runs
       SET status = 'failed', stage = 'failed', error = $2, finished_at = now(), updated_at = now()
       WHERE id = $1 AND status IN ('queued', 'running')`,
      [runId, error.slice(0, 2000)]
    );
  }

  async finishRun(runId: string, note: string | null): Promise<void> {
    await this.db.query(
      `UPDATE integration_sync_runs
       SET status = CASE WHEN failed_tickets > 0 THEN 'partial' ELSE 'succeeded' END,
           stage = 'done',
           error = COALESCE(error, $2),
           finished_at = now(),
           updated_at = now()
       WHERE id = $1 AND status IN ('queued', 'running')`,
      [runId, note]
    );
  }

  /**
   * Applies one ticket's outcome and finalizes the run when the last ticket lands. The increment
   * and the completeness check share a single statement's RETURNING so two workers finishing
   * simultaneously can't both see "not done yet" — whichever writes second sees the final count.
   */
  async recordTicketResult(runId: string, delta: TicketProgressDelta): Promise<void> {
    const res = await this.db.query<{ processed_tickets: number; failed_tickets: number; total_tickets: number }>(
      `UPDATE integration_sync_runs
       SET processed_tickets  = processed_tickets  + $2,
           failed_tickets     = failed_tickets     + $3,
           documents_created  = documents_created  + $4,
           documents_updated  = documents_updated  + $5,
           comments_synced    = comments_synced    + $6,
           decision_summaries = decision_summaries + $7,
           updated_at = now()
       WHERE id = $1
       RETURNING processed_tickets, failed_tickets, total_tickets`,
      [runId, delta.processed || 0, delta.failed || 0, delta.created || 0, delta.updated || 0, delta.comments || 0, delta.decisions || 0]
    );
    const row = res.rows[0];
    if (!row) return;
    if (row.processed_tickets + row.failed_tickets >= row.total_tickets) await this.finishRun(runId, null);
  }

  // ── Reads ──

  private static readonly RUN_SELECT = `
    SELECT r.id, r.provider, r.status, r.stage, r.remote_project_key, r.total_tickets, r.processed_tickets,
           r.failed_tickets, r.documents_created, r.documents_updated, r.comments_synced, r.decision_summaries,
           r.error, r.started_at, r.finished_at, r.created_at,
           COALESCE(NULLIF(TRIM(u.name), ''), u.email) AS triggered_by_name
    FROM integration_sync_runs r
    LEFT JOIN users u ON u.id = r.triggered_by`;

  async getRun(runId: string): Promise<SyncRunView | null> {
    const res = await this.db.query(`${IntegrationSyncService.RUN_SELECT} WHERE r.id = $1`, [runId]);
    return res.rows[0] ? this.toView(res.rows[0]) : null;
  }

  async getLatestRun(projectId: string, provider: SyncProvider): Promise<SyncRunView | null> {
    const res = await this.db.query(
      `${IntegrationSyncService.RUN_SELECT} WHERE r.project_id = $1 AND r.provider = $2 ORDER BY r.created_at DESC LIMIT 1`,
      [projectId, provider]
    );
    return res.rows[0] ? this.toView(res.rows[0]) : null;
  }

  async listRecentRuns(projectId: string, limit = 10): Promise<SyncRunView[]> {
    const res = await this.db.query(
      `${IntegrationSyncService.RUN_SELECT} WHERE r.project_id = $1 ORDER BY r.created_at DESC LIMIT $2`,
      [projectId, Math.max(1, Math.min(50, limit))]
    );
    return res.rows.map((row) => this.toView(row));
  }

  private toView(row: Record<string, any>): SyncRunView {
    return {
      id: String(row.id),
      provider: String(row.provider),
      status: String(row.status),
      stage: String(row.stage),
      remoteProjectKey: row.remote_project_key ? String(row.remote_project_key) : null,
      totalTickets: Number(row.total_tickets || 0),
      processedTickets: Number(row.processed_tickets || 0),
      failedTickets: Number(row.failed_tickets || 0),
      documentsCreated: Number(row.documents_created || 0),
      documentsUpdated: Number(row.documents_updated || 0),
      commentsSynced: Number(row.comments_synced || 0),
      decisionSummaries: Number(row.decision_summaries || 0),
      error: row.error ? String(row.error) : null,
      triggeredByName: row.triggered_by_name ? String(row.triggered_by_name) : null,
      startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
      finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString()
    };
  }

  // ── Knowledge Base folder ──

  /**
   * Resolves (creating on first use) the provider's folder under the project's KB root — the
   * "Jira" / "Linear" folder that holds every mirrored ticket document and its Notes sibling.
   * Called from the run processor, so the folder only ever appears once a sync has actually
   * started rather than sitting empty in every project.
   */
  async ensureProviderFolder(organizationId: string, projectId: string, provider: SyncProvider, userId: string | null): Promise<string> {
    const rootId = await this.ensureRootFolder(organizationId, projectId, userId);
    const name = PROVIDER_FOLDER_NAMES[provider] || provider;

    const existing = await this.db.query<{ id: string }>(
      "SELECT id FROM knowledge_folders WHERE project_id = $1 AND parent_folder_id = $2 AND name = $3 AND is_deleted = false LIMIT 1",
      [projectId, rootId, name]
    );
    if (existing.rows[0]) return existing.rows[0].id;

    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO knowledge_folders (organization_id, project_id, parent_folder_id, name, description, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (project_id, parent_folder_id, name) WHERE is_deleted = false AND parent_folder_id IS NOT NULL
       DO UPDATE SET updated_at = now()
       RETURNING id`,
      [organizationId, projectId, rootId, name, `Tickets synced from ${name}. Mirrored documents here are read-only.`, userId]
    );
    return inserted.rows[0].id;
  }

  private async ensureRootFolder(organizationId: string, projectId: string, userId: string | null): Promise<string> {
    const existing = await this.db.query<{ id: string }>(
      "SELECT id FROM knowledge_folders WHERE project_id = $1 AND is_root = true AND is_deleted = false LIMIT 1",
      [projectId]
    );
    if (existing.rows[0]) return existing.rows[0].id;

    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO knowledge_folders (organization_id, project_id, parent_folder_id, name, is_root, created_by, updated_by)
       VALUES ($1, $2, NULL, 'Knowledge Base', true, $3, $3)
       ON CONFLICT (project_id) WHERE is_root = true AND is_deleted = false DO NOTHING
       RETURNING id`,
      [organizationId, projectId, userId]
    );
    if (inserted.rows[0]) return inserted.rows[0].id;

    // DO NOTHING fired: another worker created the root between our SELECT and INSERT.
    const raced = await this.db.query<{ id: string }>(
      "SELECT id FROM knowledge_folders WHERE project_id = $1 AND is_root = true AND is_deleted = false LIMIT 1",
      [projectId]
    );
    return raced.rows[0].id;
  }

  // ── Boot recovery ──

  /**
   * A backend restart mid-run leaves a run row 'running' with no worker behind it, which would
   * spin the UI progress bar forever. Counters are reset and the coordinator re-enqueued: every
   * write in the pipeline is an upsert gated on a content hash, so redoing a run is cheap and
   * converges to the same state. Same idiom as RagModule's resumeInterruptedEmbeddings.
   */
  async resumeInterruptedRuns(): Promise<void> {
    const stuck = await this.db
      .query<{ id: string; organization_id: string; project_id: string; provider: SyncProvider; triggered_by: string | null }>(
        `SELECT id, organization_id, project_id, provider, triggered_by
         FROM integration_sync_runs
         WHERE status IN ('queued', 'running')`
      )
      .catch(() => ({ rows: [] as Array<{ id: string; organization_id: string; project_id: string; provider: SyncProvider; triggered_by: string | null }> }));

    for (const run of stuck.rows) {
      await this.db
        .query(
          `UPDATE integration_sync_runs
           SET processed_tickets = 0, failed_tickets = 0, documents_created = 0, documents_updated = 0,
               comments_synced = 0, decision_summaries = 0, total_tickets = 0, stage = 'queued', updated_at = now()
           WHERE id = $1`,
          [run.id]
        )
        .catch(() => undefined);

      const payload: SyncRunJobPayload = {
        runId: run.id,
        organizationId: run.organization_id,
        projectId: run.project_id,
        provider: run.provider,
        triggeredBy: run.triggered_by
      };
      // jobId is unchanged from the original add, so if Redis still holds that job this is a
      // no-op and the surviving job does the work.
      await this.queue
        .add(INTEGRATION_SYNC_RUN_JOB, payload, { jobId: `run-${run.id}`, attempts: 1, removeOnComplete: { count: 200 }, removeOnFail: { count: 200 } })
        .catch((err) => this.logger.warn(`Failed to resume sync run ${run.id}: ${err instanceof Error ? err.message : err}`));
    }
  }

  // ── Nightly cron ──

  /**
   * The incremental cursor for a project+provider: the start time of its most recent successful
   * (succeeded or partial) run, regardless of who triggered it — a 3pm manual Sync means tonight's
   * run only needs tickets updated after 3pm. 'failed' runs are deliberately excluded so a
   * transient failure night never causes the following run to silently skip the missed window.
   * Returns null when there is no prior successful run (first-ever sync for this project+provider).
   */
  async getLastSuccessfulRunStart(projectId: string, provider: SyncProvider): Promise<Date | null> {
    const res = await this.db.query<{ started_at: string | null }>(
      `SELECT MAX(started_at) AS started_at FROM integration_sync_runs
       WHERE project_id = $1 AND provider = $2 AND status IN ('succeeded', 'partial')`,
      [projectId, provider]
    );
    const startedAt = res.rows[0]?.started_at;
    return startedAt ? new Date(startedAt) : null;
  }

  /**
   * Every (organization, project, remote key) the nightly scheduler should sync tonight for one
   * provider: an enabled mapping backed by a live connection. A disconnected workspace's
   * integration_connections row is deleted outright (see legacy.service.ts's disconnect flow), so
   * it drops out of this join with no extra "still connected" check needed. Linear is additionally
   * filtered through plan entitlement — Jira is unaffected since the Launch plan includes it.
   */
  async listNightlySyncTargets(
    provider: SyncProvider
  ): Promise<Array<{ organizationId: string; projectId: string; remoteKey: string }>> {
    const mappingTable = provider === "jira" ? "jira_project_mappings" : "linear_project_mappings";
    const remoteKeyCol = provider === "jira" ? "jira_project_key" : "linear_team_key";
    const res = await this.db.query<{ organization_id: string; project_id: string; remote_key: string }>(
      `SELECT ic.organization_id, m.project_id, m.${remoteKeyCol} AS remote_key
       FROM ${mappingTable} m
       JOIN integration_connections ic ON ic.id = m.${provider === "jira" ? "jira_connection_id" : "integration_connection_id"}
       WHERE m.enabled = true AND ic.provider = $1`,
      [provider]
    );

    const targets = res.rows.map((row) => ({
      organizationId: String(row.organization_id),
      projectId: String(row.project_id),
      remoteKey: String(row.remote_key)
    }));
    if (provider !== "linear") return targets;

    const allowed: typeof targets = [];
    for (const target of targets) {
      if (await this.planLimits.isIntegrationAllowed(target.organizationId, "linear")) allowed.push(target);
    }
    return allowed;
  }

  /** Append-only log backing the Knowledge Base info-icon popover. Never updated or deleted. */
  async recordSyncEvent(
    documentId: string,
    runId: string,
    eventType: "created" | "updated",
    provider: SyncProvider,
    changedSummary: string | null,
    triggeredBy: string | null
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO knowledge_document_sync_events (document_id, run_id, provider, event_type, changed_summary, triggered_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [documentId, runId, provider, eventType, changedSummary, triggeredBy]
    );
  }

  /**
   * Paginated, newest-first — 5 events per page in the popover. Fetches one extra row beyond the
   * page size rather than a separate COUNT(*): the (limit+1)-th row's presence is `hasMore`, and is
   * trimmed off before returning, so paging costs one query instead of two.
   */
  async listSyncEventsForDocument(
    documentId: string,
    limit = 5,
    offset = 0
  ): Promise<{
    events: Array<{ id: string; eventType: string; changedSummary: string | null; createdAt: string; triggeredByName: string | null }>;
    hasMore: boolean;
  }> {
    const boundedLimit = Math.max(1, Math.min(50, limit));
    const res = await this.db.query<Row>(
      `SELECT e.id, e.event_type, e.changed_summary, e.created_at,
              COALESCE(NULLIF(TRIM(u.name), ''), u.email) AS triggered_by_name
       FROM knowledge_document_sync_events e
       LEFT JOIN users u ON u.id = e.triggered_by
       WHERE e.document_id = $1
       ORDER BY e.created_at DESC
       LIMIT $2 OFFSET $3`,
      [documentId, boundedLimit + 1, Math.max(0, offset)]
    );
    const hasMore = res.rows.length > boundedLimit;
    return {
      events: res.rows.slice(0, boundedLimit).map((row) => ({
        id: String(row.id),
        eventType: String(row.event_type),
        changedSummary: row.changed_summary ? String(row.changed_summary) : null,
        createdAt: new Date(row.created_at).toISOString(),
        triggeredByName: row.triggered_by_name ? String(row.triggered_by_name) : null
      })),
      hasMore
    };
  }
}
