import { InjectQueue } from "@nestjs/bullmq";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException
} from "@nestjs/common";
import type { Queue } from "bullmq";
import type { PoolClient } from "pg";
import { SuitesCacheService } from "../cache/suites-cache.service";
import { TestcasesListCacheService } from "../cache/testcases-list-cache.service";
import { DatabaseService } from "../database/database.service";
import { LegacyService } from "../legacy/legacy.service";
import { PlanLimitsService } from "../plan-limits/plan-limits.service";
import { analyse, rescorePair, stepAgreement, TESTCASE_SOURCE_COLUMNS, toComparable, type ComparableCase, type Finding, type TestcaseSource } from "./review-board.analysis";
import {
  MAX_TESTCASES_PER_RUN,
  REVIEW_BOARD_JOB,
  REVIEW_BOARD_QUEUE,
  RUN_LEASE_MINUTES,
  RUN_RECLAIM_MINUTES
} from "./review-board.constants";

type Row = Record<string, any>;

const REVIEW_STATUSES = ["pending", "kept", "edited", "removed", "obsolete"] as const;
const EDITABLE_TEXT_FIELDS = ["title", "description", "preconditions", "postconditions", "testData"] as const;
const MAX_STEPS_ON_EDIT = 200;
const MAX_STEP_FIELD_CHARS = 5000;

/** a.col AS a_col, … for every column a TestcaseSource needs, so each query selects exactly what the type requires. */
const selectSide = (alias: "a" | "b") => TESTCASE_SOURCE_COLUMNS.map((c) => `${alias}.${c} AS ${alias}_${c}`).join(", ");

function sourceOf(r: Row, alias: "a" | "b"): TestcaseSource {
  const id = alias === "a" ? r.testcase_a_id : r.testcase_b_id;
  return { id, ...Object.fromEntries(TESTCASE_SOURCE_COLUMNS.map((c) => [c, r[`${alias}_${c}`]])) } as unknown as TestcaseSource;
}

/**
 * Why a finding no longer describes reality, or null when it still does.
 *   content    — a compared field (title, preconditions, steps, expected results, test data, postconditions) changed
 *   state      — description, status, suite, priority, severity, type, component, owner or an issue link changed
 *   unverified — no state fingerprint was ever recorded (the row predates V143); cannot be proven current
 */
export type StaleReason = "content" | "state" | "unverified";

export function staleReasonOf(rec: Row, a: ComparableCase, b: ComparableCase): StaleReason | null {
  if (a.fingerprint !== rec.fingerprint_a || b.fingerprint !== rec.fingerprint_b) return "content";
  if (rec.state_fingerprint_a == null || rec.state_fingerprint_b == null) return "unverified";
  if (a.stateFingerprint !== rec.state_fingerprint_a || b.stateFingerprint !== rec.state_fingerprint_b) return "state";
  return null;
}

const STALE_MESSAGE: Record<StaleReason, string> = {
  content: "One of these test cases changed after the analysis. Re-run the analysis before reviewing this finding.",
  state: "The status, suite, priority, owner or other details of one of these test cases changed after the analysis. Re-run the analysis before reviewing this finding.",
  unverified: "This finding was recorded before change tracking existed, so it cannot be verified as current. Re-run the analysis before reviewing it."
};

/** A failure whose message is safe, and useful, to show to the reviewer who started the run. */
class AnalysisError extends Error {}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

@Injectable()
export class ReviewBoardService {
  private readonly logger = new Logger(ReviewBoardService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly planLimits: PlanLimitsService,
    private readonly legacy: LegacyService,
    private readonly suitesCache: SuitesCacheService,
    private readonly testcasesListCache: TestcasesListCacheService,
    @InjectQueue(REVIEW_BOARD_QUEUE) private readonly queue: Queue
  ) {}

  /**
   * Every Review Board endpoint passes through here, in the same order CustomFieldsService uses:
   * project membership, then the organization's EFFECTIVE Pro plan, then the role. Owners and managers
   * only: project_members.role is normalised by LegacyService.normalizeRole, which maps anything it does
   * not recognise to qa_engineer — so an unknown role is refused, never granted.
   */
  private async requireReviewAccess(userId: string | null | undefined, projectId: string): Promise<Row> {
    const project = await this.legacy.requireProjectAccess(userId, projectId);
    await this.planLimits.assertReviewBoardEnabled(project.organization_id);
    if (this.legacy.normalizeRole(project.caller_role) === "qa_engineer") {
      throw new ForbiddenException({ error: "Only project owners and managers can use the Review Board." });
    }
    return project;
  }

  // ---------------------------------------------------------------- runs

  private runDto(row: Row | undefined) {
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      testcasesAnalyzed: row.testcases_analyzed,
      pairsFound: row.pairs_found,
      truncated: row.truncated,
      error: row.error,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at
    };
  }

  /** Expires runs whose worker went silent, so a crashed run can never block the project's next one. */
  private async expireStaleRuns(projectId: string): Promise<void> {
    await this.db.query(
      `UPDATE review_analysis_runs
          SET status = 'failed', error = 'The analysis was interrupted before it finished. Start it again.', finished_at = now()
        WHERE project_id = $1 AND status IN ('queued', 'running')
          AND COALESCE(heartbeat_at, created_at) < now() - make_interval(mins => $2)`,
      [projectId, RUN_LEASE_MINUTES]
    );
  }

  async getLatestAnalysis(userId: string | null | undefined, projectId: string) {
    await this.requireReviewAccess(userId, projectId);
    await this.expireStaleRuns(projectId);
    const res = await this.db.query(
      "SELECT * FROM review_analysis_runs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1",
      [projectId]
    );
    return { analysis: this.runDto(res.rows[0]) };
  }

  async startAnalysis(userId: string | null | undefined, projectId: string) {
    await this.requireReviewAccess(userId, projectId);
    await this.expireStaleRuns(projectId);

    let run: Row;
    try {
      const inserted = await this.db.query(
        "INSERT INTO review_analysis_runs (project_id, requested_by, status) VALUES ($1, $2, 'queued') RETURNING *",
        [projectId, userId]
      );
      run = inserted.rows[0];
    } catch (err) {
      // 23505 on idx_review_runs_one_active: another run for this project is queued or running.
      if ((err as { code?: string }).code === "23505") {
        const active = await this.db.query(
          "SELECT * FROM review_analysis_runs WHERE project_id = $1 AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1",
          [projectId]
        );
        throw new ConflictException({ error: "An analysis is already running for this project.", analysis: this.runDto(active.rows[0]) });
      }
      throw err;
    }

    try {
      await this.queue.add(REVIEW_BOARD_JOB, { runId: run.id }, { jobId: run.id, attempts: 1, removeOnComplete: true, removeOnFail: 100 });
    } catch (err) {
      this.logger.error(`Could not enqueue review-board run ${run.id}: ${err instanceof Error ? err.message : err}`);
      await this.db.query(
        "UPDATE review_analysis_runs SET status = 'failed', error = 'The analysis could not be queued. Try again.', finished_at = now() WHERE id = $1",
        [run.id]
      );
      throw new ServiceUnavailableException({ error: "The analysis could not be queued. Try again in a moment." });
    }
    return { analysis: this.runDto(run) };
  }

  /**
   * Executed by the BullMQ worker. Never throws: every failure is recorded on the run row, because a
   * thrown error would only make BullMQ retry a deterministic job and leave the user watching a spinner.
   */
  async runAnalysis(runId: string): Promise<void> {
    // Claims a queued run, or a running one whose heartbeat has gone quiet (a stalled job being redelivered).
    const claimed = await this.db.query<{ project_id: string }>(
      `UPDATE review_analysis_runs
          SET status = 'running', started_at = COALESCE(started_at, now()), heartbeat_at = now()
        WHERE id = $1
          AND (status = 'queued' OR (status = 'running' AND heartbeat_at < now() - make_interval(mins => $2)))
        RETURNING project_id`,
      [runId, RUN_RECLAIM_MINUTES]
    );
    const projectId = claimed.rows[0]?.project_id;
    if (!projectId) return;

    try {
      const project = await this.db.query<{ organization_id: string; archived_at: string | null }>(
        "SELECT organization_id, archived_at FROM projects WHERE id = $1",
        [projectId]
      );
      if (!project.rows[0] || project.rows[0].archived_at) throw new AnalysisError("The project no longer exists.");
      // The plan can change between the click and the worker picking the job up.
      await this.planLimits.assertReviewBoardEnabled(project.rows[0].organization_id);

      const count = await this.db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM testcases WHERE project_id = $1 AND deleted_at IS NULL",
        [projectId]
      );
      if (Number(count.rows[0].n) > MAX_TESTCASES_PER_RUN) {
        throw new AnalysisError(
          `This project has ${count.rows[0].n} test cases; a single analysis supports up to ${MAX_TESTCASES_PER_RUN}. Nothing was analysed.`
        );
      }

      const rows = await this.db.query<TestcaseSource>(
        `SELECT id, ${TESTCASE_SOURCE_COLUMNS.join(", ")}
           FROM testcases WHERE project_id = $1 AND deleted_at IS NULL ORDER BY id`,
        [projectId]
      );
      await this.heartbeat(runId);
      const cases = rows.rows.map(toComparable);
      const { findings, truncated } = analyse(cases);
      await this.heartbeat(runId);
      await this.persist(runId, projectId, cases.length, findings, truncated);
    } catch (err) {
      // Only messages we wrote ourselves (or an HTTP error's own text, e.g. the Pro-plan refusal) reach the run row, which
      // reviewers can read. Anything else (a database error, a bug) is logged in full and shown as a generic failure.
      const message = this.publicRunError(err);
      this.logger.warn(`Review-board run ${runId} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      await this.db
        .query(
          "UPDATE review_analysis_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status = 'running'",
          [runId, message.slice(0, 500)]
        )
        .catch(() => undefined);
    }
  }

  private publicRunError(err: unknown): string {
    if (err instanceof AnalysisError) return err.message;
    if (err instanceof HttpException) {
      const body = err.getResponse();
      if (typeof body === "string") return body;
      const text = (body as Row).error ?? (body as Row).message;
      if (typeof text === "string") return text;
    }
    return "The analysis failed unexpectedly. Try again, and contact support if it keeps happening.";
  }

  private async heartbeat(runId: string): Promise<void> {
    await this.db.query("UPDATE review_analysis_runs SET heartbeat_at = now() WHERE id = $1 AND status = 'running'", [runId]);
  }

  /**
   * Writes a run's findings in ONE transaction. The completion UPDATE is conditional on status='running',
   * so a run that was expired (and possibly superseded) while it computed writes nothing at all.
   *
   * Upsert rules, per unordered pair:
   *   - new pair                                  → inserted as pending
   *   - seen before, both fingerprints unchanged  → reviewer decision kept (pending/kept/edited stay as they are)
   *   - seen before, either side materially changed, or previously obsolete → back to pending
   *   - removed                                   → never touched
   * Pending pairs this run no longer finds become obsolete (the cases were edited apart or one is gone).
   */
  private async persist(runId: string, projectId: string, analysed: number, findings: Finding[], truncated: boolean): Promise<void> {
    await this.db.transaction(async (client) => {
      const done = await client.query(
        `UPDATE review_analysis_runs
            SET status = 'completed', finished_at = now(), heartbeat_at = now(),
                testcases_analyzed = $2, pairs_found = $3, truncated = $4
          WHERE id = $1 AND status = 'running'
          RETURNING id`,
        [runId, analysed, findings.length, truncated]
      );
      if (done.rows.length === 0) return;

      const BATCH = 200;
      for (let i = 0; i < findings.length; i += BATCH) {
        const chunk = findings.slice(i, i + BATCH);
        await client.query(
          `INSERT INTO review_recommendations
             (project_id, testcase_a_id, testcase_b_id, classification, similarity, explanation, differences,
              fingerprint_a, fingerprint_b, state_fingerprint_a, state_fingerprint_b, last_run_id)
           SELECT $1::uuid, a, b, c, s, e, d::jsonb, fa, fb, sa, sb, $12::uuid
             FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::numeric[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[])
                  AS t(a, b, c, s, e, d, fa, fb, sa, sb)
           ON CONFLICT (project_id, testcase_a_id, testcase_b_id) DO UPDATE SET
             classification = EXCLUDED.classification,
             similarity     = EXCLUDED.similarity,
             explanation    = EXCLUDED.explanation,
             differences    = EXCLUDED.differences,
             review_status  = CASE
               WHEN review_recommendations.review_status = 'obsolete' THEN 'pending'
               WHEN review_recommendations.fingerprint_a <> EXCLUDED.fingerprint_a
                 OR review_recommendations.fingerprint_b <> EXCLUDED.fingerprint_b THEN 'pending'
               ELSE review_recommendations.review_status END,
             reviewed_by    = CASE
               WHEN review_recommendations.review_status = 'obsolete'
                 OR review_recommendations.fingerprint_a <> EXCLUDED.fingerprint_a
                 OR review_recommendations.fingerprint_b <> EXCLUDED.fingerprint_b THEN NULL
               ELSE review_recommendations.reviewed_by END,
             reviewed_at    = CASE
               WHEN review_recommendations.review_status = 'obsolete'
                 OR review_recommendations.fingerprint_a <> EXCLUDED.fingerprint_a
                 OR review_recommendations.fingerprint_b <> EXCLUDED.fingerprint_b THEN NULL
               ELSE review_recommendations.reviewed_at END,
             fingerprint_a  = EXCLUDED.fingerprint_a,
             fingerprint_b  = EXCLUDED.fingerprint_b,
             -- Re-describes the finding from the current facts. Refreshing these never touches review_status above:
             -- only a CONTENT change reopens a decision; a state-only change merely makes the finding current again.
             state_fingerprint_a = EXCLUDED.state_fingerprint_a,
             state_fingerprint_b = EXCLUDED.state_fingerprint_b,
             last_run_id    = EXCLUDED.last_run_id,
             updated_at     = now()
           WHERE review_recommendations.review_status <> 'removed'`,
          [
            projectId,
            chunk.map((f) => f.aId),
            chunk.map((f) => f.bId),
            chunk.map((f) => f.classification),
            chunk.map((f) => f.similarity),
            chunk.map((f) => f.explanation),
            chunk.map((f) => JSON.stringify(f.differences)),
            chunk.map((f) => f.fingerprintA),
            chunk.map((f) => f.fingerprintB),
            chunk.map((f) => f.stateFingerprintA),
            chunk.map((f) => f.stateFingerprintB),
            runId
          ]
        );
      }

      await client.query(
        `UPDATE review_recommendations SET review_status = 'obsolete', updated_at = now()
          WHERE project_id = $1 AND review_status = 'pending' AND last_run_id IS DISTINCT FROM $2`,
        [projectId, runId]
      );
    });
  }

  // ------------------------------------------------------- recommendations

  async listRecommendations(
    userId: string | null | undefined,
    projectId: string,
    query: { status?: string; limit?: string; offset?: string }
  ) {
    const project = await this.requireReviewAccess(userId, projectId);
    const requested = (query.status?.trim() ? query.status : "pending").split(",").map((s) => s.trim()).filter(Boolean);
    const statuses = requested.filter((s): s is (typeof REVIEW_STATUSES)[number] => (REVIEW_STATUSES as readonly string[]).includes(s));
    if (requested.length === 0 || statuses.length !== requested.length) {
      throw new BadRequestException({ error: `status must be one or more of: ${REVIEW_STATUSES.join(", ")}` });
    }
    const limit = Math.min(Math.max(Math.trunc(Number(query.limit)) || 50, 1), 100);
    const offset = Math.max(Math.trunc(Number(query.offset)) || 0, 0);

    // Both test cases must still exist: a finding about a deleted case is not actionable.
    const live = `JOIN testcases a ON a.id = r.testcase_a_id AND a.deleted_at IS NULL
                  JOIN testcases b ON b.id = r.testcase_b_id AND b.deleted_at IS NULL`;
    const [rows, total, counts] = await Promise.all([
      this.db.query(
        `SELECT r.*, ${selectSide("a")}, ${selectSide("b")},
                lr.status AS run_status, lr.finished_at AS run_finished_at
           FROM review_recommendations r ${live}
           LEFT JOIN review_analysis_runs lr ON lr.id = r.last_run_id
          WHERE r.project_id = $1 AND r.review_status = ANY($2::text[])
          ORDER BY (r.classification = 'exact_duplicate') DESC, r.similarity DESC, r.id
          LIMIT $3 OFFSET $4`,
        [projectId, statuses, limit, offset]
      ),
      this.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM review_recommendations r ${live} WHERE r.project_id = $1 AND r.review_status = ANY($2::text[])`,
        [projectId, statuses]
      ),
      this.loadCounts(projectId)
    ]);

    const items = rows.rows.map((r) => {
      const caseA = toComparable(sourceOf(r, "a"));
      const caseB = toComparable(sourceOf(r, "b"));
      const staleReason = staleReasonOf(r, caseA, caseB);
      return {
        id: r.id,
        classification: r.classification,
        similarity: Number(r.similarity),
        explanation: r.explanation,
        differences: r.differences,
        reviewStatus: r.review_status,
        // Either test case changed since the analysis that produced this finding (see StaleReason). Actions on a
        // stale finding are refused by the API, not just disabled in the UI.
        stale: staleReason !== null,
        staleReason,
        // How many steps the two cases share RIGHT NOW (same action and expected result), so the number next to the
        // match percentage is never out of date, even after an edit.
        stepAgreement: stepAgreement(caseA, caseB),
        reviewedBy: r.reviewed_by,
        reviewedAt: r.reviewed_at,
        lastAnalysis: { runId: r.last_run_id, status: r.run_status, finishedAt: r.run_finished_at },
        testcaseA: { id: caseA.id, externalId: caseA.externalId, title: caseA.title, repositoryName: project.name },
        testcaseB: { id: caseB.id, externalId: caseB.externalId, title: caseB.title, repositoryName: project.name }
      };
    });
    return { items, total: Number(total.rows[0].n), counts };
  }

  /**
   * Findings per status for the tab counts. Open findings only count while BOTH test cases still exist (a finding about
   * a deleted case is not actionable), but 'removed' ones count regardless: a removed finding by definition has a
   * deleted test case, and they are exactly what the History tab lists.
   */
  private async loadCounts(projectId: string): Promise<Record<string, number>> {
    const res = await this.db.query<{ review_status: string; n: string }>(
      `SELECT r.review_status, count(*)::text AS n
         FROM review_recommendations r
         LEFT JOIN testcases a ON a.id = r.testcase_a_id AND a.deleted_at IS NULL
         LEFT JOIN testcases b ON b.id = r.testcase_b_id AND b.deleted_at IS NULL
        WHERE r.project_id = $1 AND (r.review_status = 'removed' OR (a.id IS NOT NULL AND b.id IS NOT NULL))
        GROUP BY r.review_status`,
      [projectId]
    );
    const byStatus: Record<string, number> = Object.fromEntries(REVIEW_STATUSES.map((s) => [s, 0]));
    for (const c of res.rows) byStatus[c.review_status] = Number(c.n);
    return byStatus;
  }

  /**
   * History: the test cases removed from this project through the Review Board, newest first. Read-only. Everything shown
   * is already recorded when a removal happens (who, when, which case went, which stayed, the match at that moment), so
   * this needs no extra storage. `stillDeleted` / `deleted` are read live: a removed case that someone restored elsewhere
   * is reported as such rather than as deleted, and a kept case that was deleted later is flagged.
   */
  async listHistory(userId: string | null | undefined, projectId: string, query: { limit?: string; offset?: string }) {
    const project = await this.requireReviewAccess(userId, projectId);
    const limit = Math.min(Math.max(Math.trunc(Number(query.limit)) || 25, 1), 100);
    const offset = Math.max(Math.trunc(Number(query.offset)) || 0, 0);

    const [rows, total, counts] = await Promise.all([
      this.db.query(
        `SELECT r.id, r.classification, r.similarity, r.explanation, r.reviewed_at, r.removed_testcase_id,
                r.testcase_a_id, r.testcase_b_id, u.name AS reviewer_name,
                a.external_id AS a_external_id, a.title AS a_title, a.deleted_at AS a_deleted_at,
                b.external_id AS b_external_id, b.title AS b_title, b.deleted_at AS b_deleted_at
           FROM review_recommendations r
           JOIN testcases a ON a.id = r.testcase_a_id AND a.project_id = r.project_id
           JOIN testcases b ON b.id = r.testcase_b_id AND b.project_id = r.project_id
           LEFT JOIN users u ON u.id = r.reviewed_by
          WHERE r.project_id = $1 AND r.review_status = 'removed'
          ORDER BY r.reviewed_at DESC NULLS LAST, r.id
          LIMIT $2 OFFSET $3`,
        [projectId, limit, offset]
      ),
      this.db.query<{ n: string }>("SELECT count(*)::text AS n FROM review_recommendations WHERE project_id = $1 AND review_status = 'removed'", [projectId]),
      this.loadCounts(projectId)
    ]);

    const items = rows.rows.map((r) => {
      const removedIsA = r.removed_testcase_id === r.testcase_a_id;
      const side = (isA: boolean) => ({
        id: isA ? r.testcase_a_id : r.testcase_b_id,
        externalId: isA ? r.a_external_id : r.b_external_id,
        title: isA ? r.a_title : r.b_title,
        deleted: Boolean(isA ? r.a_deleted_at : r.b_deleted_at)
      });
      const removed = side(removedIsA);
      const kept = side(!removedIsA);
      return {
        id: r.id,
        classification: r.classification,
        similarity: Number(r.similarity),
        explanation: r.explanation,
        removedAt: r.reviewed_at,
        removedBy: r.reviewer_name ?? null,
        repositoryName: project.name,
        removed: { id: removed.id, externalId: removed.externalId, title: removed.title, stillDeleted: removed.deleted },
        kept
      };
    });
    return { items, total: Number(total.rows[0].n), counts };
  }

  /** The recommendation plus both live test cases, scoped to this project. 404 when any part is gone. */
  private async loadForAction(projectId: string, recommendationId: string): Promise<{ rec: Row; a: ComparableCase; b: ComparableCase }> {
    if (!isUuid(recommendationId)) throw new NotFoundException({ error: "Recommendation not found" });
    const res = await this.db.query(
      `SELECT r.*, ${selectSide("a")}, ${selectSide("b")}
         FROM review_recommendations r
         JOIN testcases a ON a.id = r.testcase_a_id AND a.project_id = r.project_id AND a.deleted_at IS NULL
         JOIN testcases b ON b.id = r.testcase_b_id AND b.project_id = r.project_id AND b.deleted_at IS NULL
        WHERE r.id = $1 AND r.project_id = $2`,
      [recommendationId, projectId]
    );
    const r = res.rows[0];
    if (!r) throw new NotFoundException({ error: "Recommendation not found" });
    return { rec: r, a: toComparable(sourceOf(r, "a")), b: toComparable(sourceOf(r, "b")) };
  }

  /** 409 unless the finding still describes both test cases as they are right now. */
  private assertFresh(rec: Row, a: ComparableCase, b: ComparableCase): void {
    const reason = staleReasonOf(rec, a, b);
    if (reason) throw new ConflictException({ error: STALE_MESSAGE[reason], code: "stale_recommendation", staleReason: reason });
  }

  /**
   * Locks the recommendation and BOTH test cases (FOR UPDATE, fixed order) inside the caller's transaction and
   * returns them. Everything judged from this result — pending, fresh, pair membership — is judged on rows no
   * concurrent edit can change until the transaction ends.
   */
  private async lockPair(client: PoolClient, projectId: string, recommendationId: string): Promise<{ rec: Row; a: ComparableCase; b: ComparableCase; rows: Map<string, Row> }> {
    if (!isUuid(recommendationId)) throw new NotFoundException({ error: "Recommendation not found" });
    const recRes = await client.query("SELECT * FROM review_recommendations WHERE id = $1 AND project_id = $2 FOR UPDATE", [recommendationId, projectId]);
    const rec = recRes.rows[0];
    if (!rec) throw new NotFoundException({ error: "Recommendation not found" });
    // Judged before the test cases are looked up: a finding that was already resolved by removing a case must answer
    // "already reviewed" (409), not "no longer exists" (404).
    this.assertPending(rec);
    const casesRes = await client.query(
      "SELECT * FROM testcases WHERE id = ANY($1::uuid[]) AND project_id = $2 AND deleted_at IS NULL ORDER BY id FOR UPDATE",
      [[rec.testcase_a_id, rec.testcase_b_id], projectId]
    );
    if (casesRes.rows.length !== 2) throw new NotFoundException({ error: "One of the test cases in this recommendation no longer exists." });
    const rows = new Map<string, Row>(casesRes.rows.map((r) => [r.id, r]));
    return {
      rec,
      rows,
      a: toComparable(rows.get(rec.testcase_a_id) as unknown as TestcaseSource),
      b: toComparable(rows.get(rec.testcase_b_id) as unknown as TestcaseSource)
    };
  }

  private assertPending(rec: Row): void {
    if (rec.review_status !== "pending") {
      throw new ConflictException({ error: `This recommendation was already reviewed (${rec.review_status}).`, reviewStatus: rec.review_status });
    }
  }

  private assertPairMember(rec: Row, testcaseId: unknown): string {
    const id = String(testcaseId ?? "");
    if (id !== rec.testcase_a_id && id !== rec.testcase_b_id) {
      throw new BadRequestException({ error: "testcaseId must be one of the two test cases in this recommendation." });
    }
    return id;
  }

  /** Same row shape as LegacyService.logProjectActivity, but written through the caller's transaction and NOT swallowed. */
  private async audit(
    client: PoolClient,
    projectId: string,
    actorId: string | null | undefined,
    action: string,
    entityType: string,
    entityId: string,
    entityName: string | null,
    diff: Row
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_logs (project_id, actor_id, action, entity_type, entity_id, entity_name, diff, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, (SELECT organization_id FROM projects WHERE id = $1))`,
      [projectId, actorId ?? null, action, entityType, entityId, entityName, JSON.stringify(diff)]
    );
  }

  /**
   * Marks the recommendation reviewed inside the caller's transaction. Conditional on 'pending', so two
   * reviewers (or a double click) cannot both win: the loser gets a 409.
   */
  private async markReviewed(
    client: PoolClient,
    recommendationId: string,
    userId: string | null | undefined,
    status: "kept" | "edited" | "removed",
    removedTestcaseId?: string
  ): Promise<void> {
    const res = await client.query(
      `UPDATE review_recommendations
          SET review_status = $2, reviewed_by = $3, reviewed_at = now(), removed_testcase_id = $4, updated_at = now()
        WHERE id = $1 AND review_status = 'pending'
        RETURNING id`,
      [recommendationId, status, userId ?? null, removedTestcaseId ?? null]
    );
    if (res.rows.length === 0) throw new ConflictException({ error: "This recommendation was already reviewed." });
  }

  private async invalidateTestcaseCaches(projectId: string): Promise<void> {
    await Promise.all([this.suitesCache.invalidate(projectId), this.testcasesListCache.invalidate(projectId)]).catch(() => undefined);
  }

  /** "Keep as is": dismisses the recommendation. Neither test case is touched. Decision and audit entry commit together. */
  async keep(userId: string | null | undefined, projectId: string, recommendationId: string) {
    await this.requireReviewAccess(userId, projectId);
    await this.db.transaction(async (client) => {
      const { rec, a, b } = await this.lockPair(client, projectId, recommendationId);
      this.assertFresh(rec, a, b);
      await this.markReviewed(client, recommendationId, userId, "kept");
      await this.audit(client, projectId, userId, "review_board_kept", "review_recommendation", recommendationId, null, {
        testcaseA: rec.testcase_a_id,
        testcaseB: rec.testcase_b_id
      });
    });
    return { id: recommendationId, reviewStatus: "kept" };
  }

  /**
   * "Remove from project": soft-deletes ONE test case of the pair. Everything happens in ONE transaction:
   *   - the recommendation row and both test case rows are locked (FOR UPDATE, in a fixed order), so a
   *     concurrent edit cannot slip between the freshness check and the delete, and a concurrent second
   *     reviewer waits and then sees the finding already resolved;
   *   - freshness is judged on the LOCKED rows (not on a copy read earlier);
   *   - soft delete, recommendation status and both audit entries (the standard `testcase_deleted` entry with
   *     the full before-row, plus `review_board_removed`) commit together or not at all.
   * Cache invalidation happens after commit, like every other test case write.
   */
  async remove(userId: string | null | undefined, projectId: string, recommendationId: string, body: Row) {
    await this.requireReviewAccess(userId, projectId);
    if (body?.confirm !== true) {
      throw new BadRequestException({ error: "Removal requires explicit confirmation (confirm: true)." });
    }
    if (!isUuid(recommendationId)) throw new NotFoundException({ error: "Recommendation not found" });
    const testcaseId = String(body?.testcaseId ?? "");

    const keptTestcaseId = await this.db.transaction(async (client) => {
      const { rec, a, b, rows: byId } = await this.lockPair(client, projectId, recommendationId);
      this.assertPairMember(rec, testcaseId);
      this.assertFresh(rec, a, b);

      const target = byId.get(testcaseId) as Row;
      await client.query(
        "UPDATE testcases SET deleted_at = now(), deleted_by = $2, updated_by = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL",
        [testcaseId, userId]
      );
      await this.markReviewed(client, recommendationId, userId, "removed", testcaseId);
      await this.audit(client, projectId, userId, "testcase_deleted", "testcase", testcaseId, `${target.external_id} - ${target.title}`, {
        before: camelKeys(target)
      });
      const kept = testcaseId === rec.testcase_a_id ? rec.testcase_b_id : rec.testcase_a_id;
      await this.audit(client, projectId, userId, "review_board_removed", "review_recommendation", recommendationId, null, {
        removedTestcaseId: testcaseId,
        keptTestcaseId: kept,
        classification: rec.classification,
        similarity: Number(rec.similarity)
      });
      return kept as string;
    });

    await this.invalidateTestcaseCaches(projectId);
    return { id: recommendationId, reviewStatus: "removed", removedTestcaseId: testcaseId, keptTestcaseId };
  }

  private validateEditedSteps(steps: unknown): unknown[] {
    if (!Array.isArray(steps) || steps.length > MAX_STEPS_ON_EDIT) {
      throw new BadRequestException({ error: `steps must be an array of at most ${MAX_STEPS_ON_EDIT} steps.` });
    }
    const field = (v: unknown, name: string): void => {
      if (v === undefined || v === null) return;
      if (typeof v !== "string" || v.length > MAX_STEP_FIELD_CHARS) {
        throw new BadRequestException({ error: `Each step's ${name} must be text of at most ${MAX_STEP_FIELD_CHARS} characters.` });
      }
    };
    for (const step of steps) {
      if (typeof step === "string") {
        field(step, "action");
      } else if (step && typeof step === "object" && !Array.isArray(step)) {
        const s = step as Row;
        field(s.action, "action");
        field(s.expectedResult, "expected result");
      } else {
        throw new BadRequestException({ error: "Each step must be text or an object with action and expectedResult." });
      }
    }
    return steps;
  }

  /**
   * "Edit": applies the reviewer's explicit edit to ONE test case of the pair, through the existing
   * updateTestCaseForUser. Only the content fields below are accepted. updateTestCase writes suite_id and
   * owner_id unconditionally (they are not COALESCEd like the rest), so the current values are carried over
   * here — a partial edit must never silently move a case out of its suite or drop its owner.
   *
   * The edit itself is the existing, separately-committed update; the recommendation is then marked 'edited'.
   * If the process dies between the two, the case is edited and the recommendation stays pending — which is
   * safe: its stored fingerprint no longer matches, so it reads as stale and cannot be used to remove anything.
   */
  async edit(userId: string | null | undefined, projectId: string, recommendationId: string, body: Row) {
    await this.requireReviewAccess(userId, projectId);
    const { rec, a, b } = await this.loadForAction(projectId, recommendationId);
    const testcaseId = this.assertPairMember(rec, body?.testcaseId);
    this.assertPending(rec);
    this.assertFresh(rec, a, b);
    if (body?.confirm !== true) {
      throw new BadRequestException({ error: "Saving an edit requires explicit confirmation (confirm: true)." });
    }

    const changes: Row = {};
    for (const field of EDITABLE_TEXT_FIELDS) {
      if (body[field] === undefined) continue;
      if (typeof body[field] !== "string") throw new BadRequestException({ error: `${field} must be a string.` });
      if (field === "title" && !body[field].trim()) throw new BadRequestException({ error: "title cannot be empty." });
      changes[field] = body[field];
    }
    if (body.steps !== undefined) changes.steps = this.validateEditedSteps(body.steps);
    if (Object.keys(changes).length === 0) throw new BadRequestException({ error: "No editable fields were provided." });

    const current = await this.db.query("SELECT suite_id, owner_id FROM testcases WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL", [testcaseId, projectId]);
    if (!current.rows[0]) throw new NotFoundException({ error: "Test case not found" });
    await this.legacy.updateTestCaseForUser(userId, projectId, testcaseId, {
      ...changes,
      suiteId: current.rows[0].suite_id,
      ownerId: current.rows[0].owner_id
    });

    const rescored = await this.db.transaction(async (client) => {
      await this.markReviewed(client, recommendationId, userId, "edited");
      const result = await this.rescoreFinding(client, projectId, rec);
      await this.audit(client, projectId, userId, "review_board_edited", "review_recommendation", recommendationId, null, {
        editedTestcaseId: testcaseId,
        fields: Object.keys(changes),
        ...(result ? { similarityBefore: Number(rec.similarity), similarityAfter: result.similarity } : {})
      });
      return result;
    });
    return {
      id: recommendationId,
      reviewStatus: "edited",
      editedTestcaseId: testcaseId,
      // The pair's match as it is NOW, so the caller can show it without waiting for another analysis.
      classification: rescored?.classification ?? rec.classification,
      similarity: rescored?.similarity ?? Number(rec.similarity)
    };
  }

  /**
   * Re-scores a finding from the CURRENT content of its two test cases and stores the result on the same row:
   * classification, match, explanation, differences, and both fingerprints. Called after an edit, so the finding
   * never keeps showing the pre-edit match, and an edited finding is not left reading "changed since analysis".
   * Returns null (and leaves the row alone) if either test case is gone.
   */
  private async rescoreFinding(client: PoolClient, projectId: string, rec: Row): Promise<Finding | null> {
    const res = await client.query(
      `SELECT id, ${TESTCASE_SOURCE_COLUMNS.join(", ")} FROM testcases
        WHERE id = ANY($1::uuid[]) AND project_id = $2 AND deleted_at IS NULL`,
      [[rec.testcase_a_id, rec.testcase_b_id], projectId]
    );
    if (res.rows.length !== 2) return null;
    const [x, y] = res.rows.map((r) => toComparable(r as unknown as TestcaseSource));
    const f = rescorePair(x, y);
    await client.query(
      `UPDATE review_recommendations
          SET classification = $2, similarity = $3, explanation = $4, differences = $5::jsonb,
              fingerprint_a = $6, fingerprint_b = $7, state_fingerprint_a = $8, state_fingerprint_b = $9, updated_at = now()
        WHERE id = $1`,
      [rec.id, f.classification, f.similarity, f.explanation, JSON.stringify(f.differences), f.fingerprintA, f.fingerprintB, f.stateFingerprintA, f.stateFingerprintB]
    );
    return f;
  }
}

function camelKeys(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), value]));
}
