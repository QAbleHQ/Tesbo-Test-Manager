import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import { DatabaseService } from "../database/database.service";
import { PlanLimitsService } from "../plan-limits/plan-limits.service";
import { ChangedField } from "../common/text-diff.util";
import {
  INTEGRATION_SYNC_QUEUE,
  INTEGRATION_SYNC_RUN_JOB,
  INTEGRATION_SYNC_TICKET_JOB,
  PROVIDER_FOLDER_NAMES,
  SYNC_RUN_STALE_MINUTES
} from "./integration-sync.constants";
import { SyncProvider, SyncRunJobPayload, SyncRunStage, SyncTicketJobPayload, SyncTriggerSource } from "./integration-sync.types";

type Row = Record<string, any>;

/**
 * Today's calendar date in NIGHTLY_SYNC_TZ ("Asia/Kolkata"), as a plain YYYY-MM-DD string.
 *
 * Computed in application code and stored, rather than derived in SQL via
 * `date_trunc('day', created_at AT TIME ZONE 'Asia/Kolkata')` — Postgres marks `AT TIME ZONE` on a
 * timestamptz as STABLE, not IMMUTABLE (the IANA tz database can change), so it can't appear in an
 * index expression at all; `idx_integration_sync_runs_nightly_cycle` (V90) originally tried exactly
 * that and failed to create with "functions in index expression must be marked IMMUTABLE".
 *
 * The fixed +5:30 shift is safe specifically because Asia/Kolkata has never observed DST since 1945
 * and India has no plans to introduce it — this would NOT be a valid shortcut for a zone with DST.
 */
function nightlyCycleDate(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

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

    // NULL for a manual run — idx_integration_sync_runs_nightly_cycle (V90) only covers
    // trigger_source = 'nightly', and a unique index never treats two NULLs as colliding, so manual
    // rows are unaffected either way.
    const cycleDate = triggerSource === "nightly" ? nightlyCycleDate() : null;

    try {
      const inserted = await this.db.query<{ id: string }>(
        `INSERT INTO integration_sync_runs (organization_id, project_id, provider, connection_id, remote_project_key, triggered_by, trigger_source, nightly_cycle_date, status, stage)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', 'queued')
         RETURNING id`,
        [organizationId, projectId, provider, connection.rows[0]?.id || null, remoteProjectKey, triggeredBy, triggerSource, cycleDate]
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
      // Two distinct unique constraints can reject this insert. idx_integration_sync_runs_active
      // (a run already queued/running for this project+provider) is the pre-existing double-click
      // guard, checked below for any trigger source. idx_integration_sync_runs_nightly_cycle (V90)
      // is nightly-only and has no status filter — it exists because the "active" index can't catch
      // a nightly re-fire that lands *after* the first nightly run for the day already finished
      // (observed: a container restart caused the scheduler to fire a second, unscheduled time
      // hours after the legitimate midnight-IST run). Either way, the caller gets back the run that
      // already represents this cycle instead of a raw DB error.
      if (triggerSource === "nightly") {
        const existing = await this.getLatestNightlyRunToday(projectId, provider);
        if (existing) {
          this.logger.warn(`Nightly ${provider} sync for project ${projectId} already ran this cycle (run ${existing.id}) — duplicate trigger suppressed.`);
          return { run: existing, alreadyRunning: true };
        }
        throw err;
      }
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

  /**
   * Called from LegacyService.integrationDisconnect before it deletes the integration_connections
   * row. A connection is org-scoped and can be mapped into several Tesbo projects, so a run can be
   * queued/running for any of them at disconnect time — without this, the DELETE's ON DELETE
   * CASCADE onto integration_sync_runs (and jira_tickets/linear_tickets) races the sync
   * processor's own concurrent writes to those same rows (recordTicketResult/finishRun), which can
   * deadlock rather than merely fail. Settling every active run to a terminal state first removes
   * that race entirely instead of trying to out-order the locks.
   */
  async failActiveRunsForConnection(organizationId: string, provider: SyncProvider, message: string): Promise<void> {
    await this.db.query(
      `UPDATE integration_sync_runs
       SET status = 'failed', stage = 'failed', error = $3, finished_at = now(), updated_at = now()
       WHERE organization_id = $1 AND provider = $2 AND status IN ('queued', 'running')`,
      [organizationId, provider, message.slice(0, 2000)]
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

  /** The nightly run already recorded for today's cycle (idx_integration_sync_runs_nightly_cycle,
   *  V90), if any — matched on the same stored nightly_cycle_date startRun writes, not a SQL-side
   *  timezone expression (see nightlyCycleDate's comment for why). */
  private async getLatestNightlyRunToday(projectId: string, provider: SyncProvider): Promise<SyncRunView | null> {
    const res = await this.db.query(
      `${IntegrationSyncService.RUN_SELECT}
       WHERE r.project_id = $1 AND r.provider = $2 AND r.trigger_source = 'nightly' AND r.nightly_cycle_date = $3
       ORDER BY r.created_at DESC LIMIT 1`,
      [projectId, provider, nightlyCycleDate()]
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

  // ── Boot recovery & stuck-run watchdog ──
  //
  // Earlier version of this tried to "resume" an interrupted run: reset its counters to 0 and
  // re-add its coordinator job under the same BullMQ jobId, trusting that "if Redis still holds
  // that job this is a no-op and the surviving job does the work." Two ways that trust broke, found
  // via a real incident (a nightly run stuck 'running' for 13.5 hours): (1) it's a check-then-act
  // race — nothing re-verified `status` was still 'queued'/'running' at UPDATE time, so a run that
  // legitimately finished in the gap got its stage/counters blindly stomped back to a fake "just
  // started" state; (2) resetting counters while relying on jobId dedupe is unsound — any ticket
  // job that had already completed (and was still Redis-retained) would silently no-op on re-add
  // rather than re-run, so its contribution to the now-zeroed tally was gone for good, and the
  // completion check (processed+failed >= total) could then never be satisfied again.
  //
  // Replaced with something structurally simpler and race-free: a run interrupted by whatever
  // stopped the previous process has nothing left in memory to resume, so it's just failed —
  // atomically, in one UPDATE with no separate read step to race against. Recovery becomes
  // identical to a manual Sync's own failure path: the run shows failed with a clear reason, the
  // next nightly cycle or a fresh click starts clean, and startRun's own dedup index (V90) makes
  // that always safe to retry.

  private async failStuckRuns(maxAgeMinutes: number, message: string): Promise<number> {
    const res = await this.db.query<{ id: string }>(
      `UPDATE integration_sync_runs
       SET status = 'failed', stage = 'failed', error = COALESCE(error, $2), finished_at = now(), updated_at = now()
       WHERE status IN ('queued', 'running') AND updated_at < now() - make_interval(mins => $1)
       RETURNING id`,
      [maxAgeMinutes, message]
    );
    return res.rows.length;
  }

  /**
   * Called once at boot. Any run still 'queued'/'running' from before this process started was
   * interrupted by whatever stopped the previous one (crash, deploy, restart) — there is no
   * in-memory work left to continue, so it's failed outright rather than resurrected.
   * `maxAgeMinutes: 0` matches every such run regardless of how recently it was touched.
   */
  async failInterruptedRuns(): Promise<void> {
    const count = await this
      .failStuckRuns(0, "Sync was interrupted before it finished (the server restarted). Run Sync again to retry.")
      .catch((err) => {
        this.logger.warn(`Failed to clean up interrupted sync runs on startup: ${err instanceof Error ? err.message : err}`);
        return 0;
      });
    if (count) this.logger.warn(`Failed ${count} sync run(s) left over from before this restart.`);
  }

  /**
   * Periodic safety net (SYNC_WATCHDOG_INTERVAL_MS) for a run that stalls without a restart — a
   * hung DB/Redis call, a worker killed without the container itself restarting. Anchored on
   * updated_at, which every real step (markRunning/setStage/setTotals/recordTicketResult) touches,
   * so a genuinely active run — even a large one — is never at risk of a false positive here; only
   * a run that has made zero progress for SYNC_RUN_STALE_MINUTES gets caught.
   */
  async failStaleRuns(): Promise<void> {
    const count = await this
      .failStuckRuns(SYNC_RUN_STALE_MINUTES, `Sync timed out after ${SYNC_RUN_STALE_MINUTES} minutes with no progress. Run Sync again to retry.`)
      .catch((err) => {
        this.logger.warn(`Stuck-run watchdog failed: ${err instanceof Error ? err.message : err}`);
        return 0;
      });
    if (count) this.logger.warn(`Watchdog failed ${count} stale sync run(s).`);
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
    changedFields: ChangedField[],
    triggeredBy: string | null
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO knowledge_document_sync_events (document_id, run_id, provider, event_type, changed_summary, changed_fields, triggered_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [documentId, runId, provider, eventType, changedSummary, changedFields.length ? JSON.stringify(changedFields) : null, triggeredBy]
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
    events: Array<{
      id: string;
      eventType: string;
      changedSummary: string | null;
      changedFields: ChangedField[];
      createdAt: string;
      triggeredByName: string | null;
    }>;
    hasMore: boolean;
  }> {
    const boundedLimit = Math.max(1, Math.min(50, limit));
    const res = await this.db.query<Row>(
      `SELECT e.id, e.event_type, e.changed_summary, e.changed_fields, e.created_at,
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
        // Historical rows predate this column and stay NULL — the frontend falls back to the
        // plain-sentence rendering (no badge/diff button) when this is empty.
        changedFields: Array.isArray(row.changed_fields) ? (row.changed_fields as ChangedField[]) : [],
        createdAt: new Date(row.created_at).toISOString(),
        triggeredByName: row.triggered_by_name ? String(row.triggered_by_name) : null
      })),
      hasMore
    };
  }
}
