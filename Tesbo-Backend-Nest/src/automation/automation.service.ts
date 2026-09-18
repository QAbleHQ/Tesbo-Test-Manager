import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import * as path from "path";
import { DatabaseService } from "../database/database.service";
import { LegacyService, isUuid } from "../legacy/legacy.service";
import { PlanLimitsService } from "../plan-limits/plan-limits.service";
import { StorageService } from "../storage/storage.service";
import {
  ACCEPTED_WIRE_STATUSES,
  AUTOMATION_AGENT_SLUG,
  EVIDENCE_EXTENSIONS,
  EVIDENCE_KINDS,
  TRIGGERED_BY_VALUES,
  isEvidenceKind,
  isTriggeredBy,
  normalizeWireStatus,
  type EvidenceKind
} from "./automation.types";

type Body = Record<string, any>;

interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

/** External-id shape: `TES-1042`. Bounded by testcases.external_id VARCHAR(32). */
const MAX_CASE_ID_LENGTH = 32;
/** How many case ids one run-creation or resolve call may name. */
const MAX_CASE_IDS_PER_CALL = 2000;
const MAX_RUN_NAME_LENGTH = 255;
const MAX_EXTERNAL_ID_LENGTH = 64;
const MAX_BRANCH_LENGTH = 255;
const MAX_COMMIT_SHA_LENGTH = 64;
const MAX_BUILD_URL_LENGTH = 1024;
/** executions.error_message / error_stack are TEXT; these are sanity ceilings, not column limits. */
const MAX_ERROR_MESSAGE_LENGTH = 8_000;
const MAX_ERROR_STACK_LENGTH = 32_000;

/**
 * Automation ingest — a framework SDK reporting results into an existing project.
 *
 * Basecamp 10189985971. The shape of this service is set by three decisions taken before any of
 * it was written, each of which rules out an easier implementation:
 *
 * 1. **Results land on `cycles` / `cycle_items` / `executions`, not on a parallel model.** An
 *    automated run is a run: it shows up in the runs list, the traceability matrix, the execution
 *    reports and a test case's own history, because it is the same rows those already read. The
 *    alternative — the `Tesbo*` reporting client that used to sit unused in the frontend — keyed
 *    results on spec name + test name and stored them outside `cycles`, which is both the
 *    name-matching the card's §3 rules out and a silo nothing else in the product can see.
 *
 * 2. **Cases are linked by `testcases.external_id`, never by test name or file path.** Card §3:
 *    name-matching "breaks silently on refactors, and produces results attached to the wrong case
 *    with no visible error". `external_id` is UNIQUE per project and is what `tesbo.testId("…")`
 *    carries.
 *
 * 3. **Automation never creates a test case.** Card's positioning note: QA engineers own, write
 *    and approve test cases; automation only reports results against cases that already exist. An
 *    unknown case id is reported back to the caller as unknown — it is not helpfully conjured
 *    into existence. Attaching an *existing* case to a run is not the same thing and is done
 *    freely (see recordResult).
 */
@Injectable()
export class AutomationService {
  private readonly logger = new Logger(AutomationService.name);

  /** Resolved once — the automation agent's actor id never changes at runtime. */
  private actorIdPromise: Promise<string | null> | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly legacy: LegacyService,
    private readonly planLimits: PlanLimitsService,
    private readonly storage: StorageService
  ) {}

  /**
   * Actor id for the well-known `tesbo-automation` agent (V84).
   *
   * Mirrors McpService.resolveMcpActorId. Falls back to the calling user when the agent row is
   * missing — a workspace whose migrations are mid-deploy should still record results, with
   * slightly less precise attribution, rather than refusing them.
   */
  private async resolveAutomationActorId(): Promise<string | null> {
    if (!this.actorIdPromise) {
      this.actorIdPromise = this.db
        .query<{ id: string }>("SELECT a.id FROM actors a JOIN agents g ON g.id = a.id WHERE g.slug = $1", [
          AUTOMATION_AGENT_SLUG
        ])
        .then((res) => res.rows[0]?.id || null)
        .catch((err) => {
          this.logger.warn(`Failed to resolve automation agent actor: ${err instanceof Error ? err.message : err}`);
          return null;
        });
    }
    return this.actorIdPromise;
  }

  // ---------------------------------------------------------------------------------------------
  // Input normalisation
  // ---------------------------------------------------------------------------------------------

  /**
   * Trims a bounded string field, or throws naming the field and its limit.
   *
   * Every column this ingest writes is bounded, and a CI process supplies most of them from
   * environment variables it does not control (a branch name can be any length a git ref allows).
   * Truncating silently would store a commit SHA that does not match any commit; the caller gets a
   * 400 that names the field instead.
   */
  private boundedString(value: unknown, field: string, max: number): string | null {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    if (!text) return null;
    if (text.length > max) {
      throw new BadRequestException({ error: `${field} must be ${max} characters or fewer (got ${text.length})` });
    }
    return text;
  }

  /**
   * Normalises the `caseIds` array a caller supplies.
   *
   * Deduped, because a suite that tags two tests with the same case id is legitimate (two automated
   * tests covering one manual case) and must not make the run-creation call fail on the
   * `cycle_items` unique constraint. Capped, because the value goes into a single `= ANY($1)` and a
   * caller could otherwise send an unbounded array.
   */
  private normalizeCaseIds(raw: unknown, field = "caseIds"): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new BadRequestException({ error: `${field} must be an array of test case ids` });
    if (raw.length > MAX_CASE_IDS_PER_CALL) {
      throw new BadRequestException({
        error: `${field} accepts at most ${MAX_CASE_IDS_PER_CALL} ids per call (got ${raw.length})`
      });
    }
    const seen = new Set<string>();
    for (const entry of raw) {
      const id = String(entry ?? "").trim();
      if (!id) continue;
      if (id.length > MAX_CASE_ID_LENGTH) {
        throw new BadRequestException({
          error: `Test case id "${id.slice(0, MAX_CASE_ID_LENGTH)}…" is longer than ${MAX_CASE_ID_LENGTH} characters, so it cannot be a Tesbo case id`
        });
      }
      seen.add(id);
    }
    return [...seen];
  }

  // ---------------------------------------------------------------------------------------------
  // Case resolution
  // ---------------------------------------------------------------------------------------------

  /**
   * Maps caller-supplied external ids to the project's test cases.
   *
   * Case-insensitive on purpose: `external_id` is stored as typed but a developer writing
   * `tesbo.testId("tes-1042")` in a spec means the same case as `TES-1042`, and the index
   * `idx_testcases_external_id_trgm` is on `lower(external_id)` so the comparison is indexed
   * either way. Scoped to the project so an id from another workspace resolves to nothing rather
   * than to that workspace's case.
   */
  private async resolveCases(
    projectId: string,
    caseIds: string[]
  ): Promise<{ found: Map<string, { id: string; externalId: string; title: string; status: string }>; unknown: string[] }> {
    const found = new Map<string, { id: string; externalId: string; title: string; status: string }>();
    if (!caseIds.length) return { found, unknown: [] };

    const res = await this.db.query<{ id: string; external_id: string; title: string; status: string }>(
      `SELECT id, external_id, title, status
         FROM testcases
        WHERE project_id = $1 AND deleted_at IS NULL AND lower(external_id) = ANY($2::text[])`,
      [projectId, caseIds.map((id) => id.toLowerCase())]
    );
    for (const row of res.rows) {
      found.set(row.external_id.toLowerCase(), {
        id: row.id,
        externalId: row.external_id,
        title: row.title,
        status: row.status
      });
    }
    const unknown = caseIds.filter((id) => !found.has(id.toLowerCase()));
    return { found, unknown };
  }

  /**
   * `POST /api/projects/:projectId/automation/cases/resolve`
   *
   * Card §3: "Case ID format should be validated against the customer's Tesbo project on SDK init,
   * so a typo in the ID fails fast locally instead of silently not reporting." This is the call an
   * SDK makes at collection time, before a single test runs, so an untagged or mistyped id is a
   * message on the developer's terminal rather than a result that never arrives.
   */
  async resolveCaseIds(userId: string | null | undefined, projectId: string, body: Body) {
    await this.legacy.requireProjectAccess(userId, projectId);
    const caseIds = this.normalizeCaseIds(body?.caseIds);
    const { found, unknown } = await this.resolveCases(projectId, caseIds);
    return {
      requested: caseIds.length,
      known: caseIds
        .map((id) => found.get(id.toLowerCase()))
        .filter((row): row is NonNullable<typeof row> => Boolean(row))
        .map((row) => ({ caseId: row.externalId, title: row.title, status: row.status })),
      unknown
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Run lifecycle
  // ---------------------------------------------------------------------------------------------

  /**
   * `POST /api/projects/:projectId/automation/runs` — card §4 step 1.
   *
   * One run per execution session, never per test: "Per-test runs would flood the system with
   * thousands of runs per CI build and destroy both usability and reporting cost."
   *
   * Two behaviours worth knowing about:
   *
   * **Cases are actually attached.** `POST /api/projects/:projectId/cycles/from-cases` looks like
   * it does this and does not — all three cycle-create routes call the same `createCycle()`, which
   * reads neither `planId`'s items nor `testcaseIds`, so a caller gets an empty run and no error
   * (FEATURE_DOCUMENTATION.md §Test runs). This route seeds them in the same statement.
   *
   * **`externalId` makes the call idempotent.** A GitHub Actions workflow that is re-run presents
   * the same run id; without this it would open a second Tesbo run holding half the results.
   * Backed by the partial unique index on (project_id, external_id) from V84, narrowed by V112 to
   * `WHERE external_id IS NOT NULL AND deleted_at IS NULL` -- so two live shards racing to create
   * the run both end up with the same one, while a resubmit *after* that run was soft-deleted opens
   * a genuine new run instead of resolving back to a dead one it can never attach cases to again.
   */
  async createRun(userId: string | null | undefined, projectId: string, body: Body) {
    await this.legacy.requireProjectAccess(userId, projectId);
    const actorId = (await this.resolveAutomationActorId()) ?? this.requireActor(userId);

    const name = this.boundedString(body?.name, "name", MAX_RUN_NAME_LENGTH);
    if (!name) throw new BadRequestException({ error: "name is required" });

    const externalId = this.boundedString(body?.externalId, "externalId", MAX_EXTERNAL_ID_LENGTH);
    const triggeredByRaw = body?.triggeredBy;
    if (triggeredByRaw !== undefined && triggeredByRaw !== null && !isTriggeredBy(triggeredByRaw)) {
      throw new BadRequestException({
        error: `triggeredBy must be one of: ${TRIGGERED_BY_VALUES.join(", ")}`
      });
    }
    const caseIds = this.normalizeCaseIds(body?.caseIds);

    // Idempotency check before the insert so a re-run gets its existing run back with the same
    // shape as a fresh create, rather than a 409 it would have to special-case.
    //
    // `AND deleted_at IS NULL`: closes the gap V112_cycles_external_id_partial_index.sql's commit
    // describes -- without this filter, a resubmit after the run was soft-deleted (V111) would
    // resolve back to the dead row and hand the caller a "reused" run that attachCases' EXISTS
    // guard then silently refuses to write into. Now the dead row simply doesn't match, the insert
    // below runs, and (because the unique index is now partial on deleted_at IS NULL too) it
    // succeeds and opens a genuine new run for the same externalId.
    if (externalId) {
      const existing = await this.db.query<{ id: string }>(
        "SELECT id FROM cycles WHERE project_id = $1 AND external_id = $2 AND deleted_at IS NULL",
        [projectId, externalId]
      );
      if (existing.rows[0]) {
        const attached = await this.attachCases(existing.rows[0].id, projectId, caseIds);
        return {
          ...(await this.runSummary(existing.rows[0].id)),
          reused: true,
          casesAttached: attached.attached,
          unknownCaseIds: attached.unknown
        };
      }
    }

    let runId: string;
    try {
      const res = await this.db.query<{ id: string }>(
        `INSERT INTO cycles (
           project_id, name, description, environment, build_version, release_name, owner_id,
           status, started_at, source, triggered_by, commit_sha, branch_name, build_url, external_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'In Progress',now(),'automation',$8,$9,$10,$11,$12)
         RETURNING id`,
        [
          projectId,
          name,
          this.boundedString(body?.description, "description", 10_000) ?? "",
          this.boundedString(body?.environment, "environment", 128),
          this.boundedString(body?.buildVersion, "buildVersion", 128),
          this.boundedString(body?.releaseName, "releaseName", 128),
          // owner_id is a users FK, so an agent actor cannot fill it. An automated run has no human
          // owner; the token's user is the closest true answer and is who to ask about the pipeline.
          isUuid(userId) ? userId : null,
          triggeredByRaw ?? null,
          this.boundedString(body?.commitSha, "commitSha", MAX_COMMIT_SHA_LENGTH),
          this.boundedString(body?.branch, "branch", MAX_BRANCH_LENGTH),
          this.boundedString(body?.buildUrl, "buildUrl", MAX_BUILD_URL_LENGTH),
          externalId
        ]
      );
      runId = res.rows[0].id;
    } catch (err) {
      // Two shards racing on the same externalId: the loser's insert violates the partial unique
      // index. Resolve to the winner's run instead of failing the shard's whole session.
      //
      // `AND deleted_at IS NULL` here too: the unique index this violation came from
      // (idx_cycles_project_external_id, V112) is now itself partial on deleted_at IS NULL, so
      // the row that won the race is necessarily live at the moment of the violation. The filter
      // does not make `!raced.rows[0]` unreachable, though -- it stays reachable for a genuine
      // live-row race: the winner gets soft-deleted (DELETE /api/cycles/:id) in the window between
      // this insert's unique-violation and this SELECT running, in which case falling through to
      // `throw err` (rather than silently reusing a run this shard is about to find is gone) is the
      // right behaviour. Not separately covered by an e2e test -- it needs a delete to land inside
      // a sub-millisecond window between two concurrent inserts, which is not practical to force
      // deterministically from outside the process.
      if (externalId && this.isUniqueViolation(err)) {
        const raced = await this.db.query<{ id: string }>(
          "SELECT id FROM cycles WHERE project_id = $1 AND external_id = $2 AND deleted_at IS NULL",
          [projectId, externalId]
        );
        if (!raced.rows[0]) throw err;
        const attached = await this.attachCases(raced.rows[0].id, projectId, caseIds);
        return {
          ...(await this.runSummary(raced.rows[0].id)),
          reused: true,
          casesAttached: attached.attached,
          unknownCaseIds: attached.unknown
        };
      }
      throw err;
    }

    const attached = await this.attachCases(runId, projectId, caseIds);
    await this.legacy.logProjectActivity(projectId, actorId, "automation_run_created", "cycle", runId, name, {
      triggeredBy: triggeredByRaw ?? null,
      branch: this.boundedString(body?.branch, "branch", MAX_BRANCH_LENGTH),
      commitSha: this.boundedString(body?.commitSha, "commitSha", MAX_COMMIT_SHA_LENGTH),
      casesAttached: attached.attached,
      unknownCaseIds: attached.unknown.length
    });

    return {
      ...(await this.runSummary(runId)),
      reused: false,
      casesAttached: attached.attached,
      unknownCaseIds: attached.unknown
    };
  }

  /**
   * Attaches existing project test cases to a run and opens an Untested execution for each.
   *
   * `ON CONFLICT DO NOTHING` on both inserts, so re-attaching a case already in the run is a
   * no-op — which is what makes recordResult safe to call for a case the run was not created with.
   * `t.project_id = $2` is a tenancy check, not a convenience filter: without it a caller could
   * name another workspace's case id and have this run adopt it, copying that tenant's title into
   * snapshot_title on the way (the same hole addCycleTestCases closed).
   */
  private async attachCases(
    runId: string,
    projectId: string,
    caseIds: string[]
  ): Promise<{ attached: number; unknown: string[] }> {
    if (!caseIds.length) return { attached: 0, unknown: [] };
    const { found, unknown } = await this.resolveCases(projectId, caseIds);
    if (!found.size) return { attached: 0, unknown };

    const res = await this.db.query<{ id: string }>(
      `WITH input AS (
         SELECT id, ord FROM unnest($2::uuid[]) WITH ORDINALITY AS u(id, ord)
       ),
       base AS (
         SELECT COALESCE(MAX(position), 0) AS pos FROM cycle_items WHERE cycle_id = $1
       ),
       ins AS (
         -- The EXISTS guard stops the CI ingest path from writing cases into a run that has been
         -- soft-deleted (hard-delete remediation Phase 1). createRun's externalId-reuse lookups and
         -- recordResult's requireRun both now filter deleted_at themselves too
         -- (V112_cycles_external_id_partial_index.sql closed the createRun half of that gap), so in
         -- the common case the run this statement runs against is already known live -- but every
         -- caller resolves the run in a separate statement before reaching this INSERT, leaving a
         -- window where a concurrent delete could land in between. This EXISTS guard is what closes
         -- that window at the point of the actual write, rather than trusting an earlier read to
         -- still be true. cycle_items_cycle_id_testcase_id_key is now a partial unique index (WHERE
         -- deleted_at IS NULL) — the ON CONFLICT target below repeats that predicate so Postgres can
         -- infer it, and a previously-removed case gets a fresh row instead of no-op'ing forever.
         -- snapshot_title is joined by every other field the run's execution list, detail panel,
         -- CSV export and reports display (V119) — captured here at add-time so a run's history
         -- stops depending on the live testcase row surviving a later soft-delete.
         INSERT INTO cycle_items (
           cycle_id, testcase_id, snapshot_title, position,
           snapshot_external_id, snapshot_priority, snapshot_type, snapshot_suite_id,
           snapshot_description, snapshot_preconditions, snapshot_postconditions, snapshot_steps,
           snapshot_test_data, snapshot_automation_status, snapshot_automation_tags
         )
         SELECT $1, t.id, t.title, base.pos + i.ord,
                t.external_id, t.priority, t.type, t.suite_id,
                t.description, t.preconditions, t.postconditions, t.steps,
                t.test_data, t.automation_status, t.automation_tags
           FROM input i
           JOIN testcases t ON t.id = i.id AND t.deleted_at IS NULL AND t.project_id = $3
           CROSS JOIN base
          WHERE EXISTS (SELECT 1 FROM cycles c WHERE c.id = $1 AND c.deleted_at IS NULL)
         ON CONFLICT (cycle_id, testcase_id) WHERE deleted_at IS NULL DO NOTHING
         RETURNING id
       )
       INSERT INTO executions (cycle_item_id)
       SELECT id FROM ins
       ON CONFLICT (cycle_item_id) DO NOTHING
       RETURNING id`,
      [runId, [...found.values()].map((row) => row.id), projectId]
    );
    return { attached: res.rows.length, unknown };
  }

  /**
   * `POST /api/projects/:projectId/automation/runs/:runId/results` — card §4 step 2.
   *
   * Idempotent by construction rather than by application logic: `cycle_items` is UNIQUE on
   * (cycle_id, testcase_id) and `executions` is UNIQUE on (cycle_item_id), so there is exactly one
   * result row per (run, case) and a resubmission can only ever update it. The card's "upsert on
   * (run_id, case_id) — if a retry submits again, it overwrites, doesn't duplicate" needs no
   * uniqueness code here; it is a property of the schema.
   *
   * What the retry DOES need is to stay visible. "Latest attempt wins, but retry count should be
   * stored for visibility": a case that passes on the third attempt reads Passed with
   * retry_count = 2, which is what distinguishes it from one that passed first time. A
   * caller-supplied `retryCount` (Playwright knows its own attempt index) wins over the
   * increment, so a re-reported result does not inflate the count.
   */
  async recordResult(userId: string | null | undefined, projectId: string, runId: string, body: Body) {
    await this.legacy.requireProjectAccess(userId, projectId);
    const run = await this.requireRun(projectId, runId);
    const actorId = (await this.resolveAutomationActorId()) ?? this.requireActor(userId);

    const caseId = this.boundedString(body?.caseId, "caseId", MAX_CASE_ID_LENGTH);
    if (!caseId) throw new BadRequestException({ error: "caseId is required" });

    const status = normalizeWireStatus(body?.status);
    if (!status) {
      throw new BadRequestException({
        error: `status must be one of: ${ACCEPTED_WIRE_STATUSES.join(", ")}`
      });
    }

    const { found } = await this.resolveCases(projectId, [caseId]);
    const testcase = found.get(caseId.toLowerCase());
    if (!testcase) {
      /*
       * Card positioning note: automation "does not generate or approve test cases". So an id that
       * matches nothing is reported as unknown, not created. 404 rather than 400 because the
       * caller's request was well-formed — the case simply isn't in this project — and because
       * that is what lets an SDK count "N results skipped, case not found in Tesbo" without
       * treating it as a protocol error.
       */
      throw new NotFoundException({
        error: `No test case with id "${caseId}" in this project. Automation reports results against existing cases and never creates them — add the case in Tesbo, or fix the tesbo.testId() tag.`
      });
    }

    /*
     * Every remaining field is validated BEFORE anything is written. attachCases below is a real
     * mutation, so validating after it would let a request that answers 400 still add a case to the
     * run as a side effect -- a rejected call has to leave the run exactly as it found it.
     */
    const durationMs = this.normalizeDuration(body?.durationMs);
    const suppliedRetryCount = this.normalizeRetryCount(body?.retryCount);
    const errorMessage = this.boundedString(body?.errorMessage, "errorMessage", MAX_ERROR_MESSAGE_LENGTH);
    const errorStack = this.boundedString(body?.errorStack, "errorStack", MAX_ERROR_STACK_LENGTH);

    // A case the run was not created with is attached now. This is not case *creation*: the case
    // already exists and was already approved by a person; a suite that grew a test since the run
    // was opened should still report against it rather than silently dropping the result.
    await this.attachCases(runId, projectId, [testcase.externalId]);

    /*
     * One statement, resolving the execution through the run and case rather than taking an
     * execution id from the caller: an SDK never sees Tesbo's uuids, and resolving inside the
     * UPDATE keeps two shards reporting the same case from interleaving a read and a write.
     *
     * `actual_result` is deliberately NOT written. That column is a human tester's prose, and an
     * SDK overwriting it would destroy notes a person typed; automation failure text goes to
     * error_message. `defect_key`/`defect_url` are left to the existing manual flow for the same
     * reason.
     */
    const res = await this.db.query<{ id: string; status: string; retry_count: number }>(
      `UPDATE executions e SET
         status = $3,
         executed_at = now(),
         executed_by = $4,
         duration_ms = $5,
         retry_count = CASE WHEN $6::int IS NOT NULL THEN $6::int
                            WHEN e.status <> 'Untested' THEN e.retry_count + 1
                            ELSE e.retry_count END,
         error_message = $7,
         error_stack = $8,
         reported_by = 'automation',
         updated_at = now()
       FROM cycle_items ci
       WHERE ci.id = e.cycle_item_id AND ci.cycle_id = $1 AND ci.testcase_id = $2
         AND e.deleted_at IS NULL
       RETURNING e.id, e.status, e.retry_count`,
      [runId, testcase.id, status, actorId, durationMs, suppliedRetryCount, errorMessage, errorStack]
    );
    const updated = res.rows[0];
    if (!updated) {
      // attachCases above opened the execution, so reaching here means it was soft-deleted.
      throw new NotFoundException({ error: `The result row for case "${caseId}" in this run is no longer available` });
    }

    await this.db.query("UPDATE cycles SET last_result_at = now(), updated_at = now() WHERE id = $1", [runId]);

    return {
      runId,
      caseId: testcase.externalId,
      executionId: updated.id,
      status: updated.status,
      retryCount: updated.retry_count,
      runClosed: Boolean(run.closed_at)
    };
  }

  private normalizeDuration(value: unknown): number | null {
    if (value === undefined || value === null || value === "") return null;
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms < 0) {
      throw new BadRequestException({ error: "durationMs must be a non-negative number of milliseconds" });
    }
    // INTEGER column: ~24.8 days. A single test taking longer is a bad value, not a long test.
    if (ms > 2_147_483_647) {
      throw new BadRequestException({ error: "durationMs is larger than a single test execution can plausibly be" });
    }
    return Math.round(ms);
  }

  private normalizeRetryCount(value: unknown): number | null {
    if (value === undefined || value === null || value === "") return null;
    const count = Number(value);
    if (!Number.isInteger(count) || count < 0) {
      throw new BadRequestException({ error: "retryCount must be a non-negative integer" });
    }
    if (count > 1_000) throw new BadRequestException({ error: "retryCount is implausibly large" });
    return count;
  }

  /**
   * `PATCH /api/projects/:projectId/automation/runs/:runId/close` — card §4 step 3.
   *
   * The submitted summary is **reconciled, not trusted**. The card asks the SDK to send
   * total/passed/failed/skipped, but the SDK's count and Tesbo's stored rows can legitimately
   * disagree — a result POST that failed and was not retried, a test whose case id was unknown, a
   * shard that died. Recording the SDK's numbers as the run's would make the run screen contradict
   * its own rows. So the stored counts win, and any disagreement is returned as `mismatch` for the
   * SDK to print, which is the only place a dropped result is visible at all.
   */
  async closeRun(userId: string | null | undefined, projectId: string, runId: string, body: Body) {
    await this.legacy.requireProjectAccess(userId, projectId);
    const run = await this.requireRun(projectId, runId);
    const actorId = (await this.resolveAutomationActorId()) ?? this.requireActor(userId);

    const requested = body?.status === undefined || body?.status === null ? "completed" : String(body.status).trim().toLowerCase();
    if (!["completed", "incomplete"].includes(requested)) {
      throw new BadRequestException({ error: "status must be one of: completed, incomplete" });
    }

    if (run.closed_at) {
      // Closing twice is what a retried CI step does. Report the run as it stands rather than
      // reopening it or erroring — but say so, so an SDK does not treat it as a fresh close.
      return { ...(await this.runSummary(runId)), alreadyClosed: true, mismatch: null };
    }

    const counts = await this.resultCounts(runId);
    await this.db.query(
      `UPDATE cycles SET status = 'Completed', ended_at = now(), closed_at = now(), close_status = $2,
         updated_at = now() WHERE id = $1`,
      [runId, requested]
    );

    const mismatch = this.summaryMismatch(body?.summary, counts);
    await this.legacy.logProjectActivity(projectId, actorId, "automation_run_closed", "cycle", runId, run.name, {
      closeStatus: requested,
      counts,
      mismatch
    });

    return { ...(await this.runSummary(runId)), alreadyClosed: false, mismatch };
  }

  /**
   * Compares an SDK-reported summary against the stored rows.
   *
   * Returns null when they agree or when no summary was sent. Every field is optional, so an SDK
   * that reports only a total is checked only on the total.
   */
  private summaryMismatch(
    summary: unknown,
    counts: { total: number; passed: number; failed: number; skipped: number; blocked: number; untested: number }
  ): Record<string, { reported: number; stored: number }> | null {
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
    const reported = summary as Record<string, unknown>;
    const pairs: Array<[string, number]> = [
      ["total", counts.total],
      ["passed", counts.passed],
      ["failed", counts.failed],
      ["skipped", counts.skipped]
    ];
    const diff: Record<string, { reported: number; stored: number }> = {};
    for (const [key, stored] of pairs) {
      const value = reported[key];
      if (value === undefined || value === null) continue;
      const num = Number(value);
      if (!Number.isFinite(num)) continue;
      if (num !== stored) diff[key] = { reported: num, stored };
    }
    return Object.keys(diff).length ? diff : null;
  }

  private async resultCounts(runId: string) {
    const res = await this.db.query<Record<string, string>>(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE e.status = 'Passed')::int AS passed,
         COUNT(*) FILTER (WHERE e.status = 'Failed')::int AS failed,
         COUNT(*) FILTER (WHERE e.status = 'Skipped')::int AS skipped,
         COUNT(*) FILTER (WHERE e.status = 'Blocked')::int AS blocked,
         COUNT(*) FILTER (WHERE e.status IN ('Untested', 'Retest'))::int AS untested
       FROM executions e
       JOIN cycle_items ci ON ci.id = e.cycle_item_id
       WHERE ci.cycle_id = $1 AND e.deleted_at IS NULL`,
      [runId]
    );
    const row = res.rows[0] ?? {};
    return {
      total: Number(row.total ?? 0),
      passed: Number(row.passed ?? 0),
      failed: Number(row.failed ?? 0),
      skipped: Number(row.skipped ?? 0),
      blocked: Number(row.blocked ?? 0),
      untested: Number(row.untested ?? 0)
    };
  }

  /**
   * `GET /api/projects/:projectId/automation/runs/:runId` — card §6, "returns full run + results,
   * for CI to link back in build logs".
   */
  async getRun(userId: string | null | undefined, projectId: string, runId: string) {
    await this.legacy.requireProjectAccess(userId, projectId);
    await this.requireRun(projectId, runId);
    const summary = await this.runSummary(runId);

    const res = await this.db.query(
      `SELECT t.external_id AS case_id,
              COALESCE(NULLIF(ci.snapshot_title, ''), NULLIF(t.title, ''), 'Untitled test case') AS title,
              e.id AS execution_id, e.status, e.duration_ms, e.retry_count, e.error_message,
              e.executed_at, e.reported_by,
              COALESCE(ev.items, '[]'::json) AS evidence
         FROM executions e
         JOIN cycle_items ci ON ci.id = e.cycle_item_id
         LEFT JOIN testcases t ON t.id = ci.testcase_id
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object(
             'id', a.id, 'kind', a.evidence_kind, 'fileName', a.file_name,
             'fileSize', a.file_size, 'contentType', a.content_type
           ) ORDER BY a.created_at) AS items
             FROM attachments a
            WHERE a.entity_type = 'execution' AND a.entity_id = e.id AND a.deleted_at IS NULL
         ) ev ON true
        WHERE ci.cycle_id = $1 AND e.deleted_at IS NULL
        ORDER BY ci.position, t.external_id`,
      [runId]
    );

    return {
      ...summary,
      results: res.rows.map((row) => ({
        caseId: row.case_id,
        title: row.title,
        executionId: row.execution_id,
        status: row.status,
        durationMs: row.duration_ms,
        retryCount: row.retry_count,
        errorMessage: row.error_message,
        executedAt: row.executed_at,
        reportedBy: row.reported_by,
        evidence: Array.isArray(row.evidence) ? row.evidence : []
      }))
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Evidence
  // ---------------------------------------------------------------------------------------------

  /**
   * `POST /api/projects/:projectId/automation/runs/:runId/results/:caseId/evidence` — card §5.
   *
   * Multipart rather than the base64 `evidence: [{type, url/base64}]` of the card's draft §6
   * contract: base64 inflates a 25MB trace to 33MB of JSON that has to be buffered and decoded,
   * and multipart lets this route reuse the size cap, the byte accounting and the storage
   * abstraction the two existing evidence paths already use.
   *
   * The behaviour that is NOT like those paths, and is the point of this method: **a full storage
   * quota skips the upload instead of failing the request.** Card §5: "At 100% of quota, new
   * evidence uploads are skipped going forward, but the pass/fail/skip result itself still records
   * normally — a full quota must never block test result reporting, only evidence attachment."
   * `assertStorageAvailable` throws, which would fail a CI step over a screenshot, so this calls
   * `checkStorageAvailable` and reports `skipped: "quota"` instead.
   */
  async uploadEvidence(
    userId: string | null | undefined,
    projectId: string,
    runId: string,
    caseId: string,
    kindInput: unknown,
    files: UploadedFile[]
  ) {
    const project = await this.legacy.requireProjectAccess(userId, projectId);
    await this.requireRun(projectId, runId);
    const actorId = (await this.resolveAutomationActorId()) ?? this.requireActor(userId);

    if (!files || files.length === 0) throw new BadRequestException({ error: "No files were uploaded" });
    if (!isEvidenceKind(kindInput)) {
      throw new BadRequestException({ error: `kind must be one of: ${EVIDENCE_KINDS.join(", ")}` });
    }
    const kind: EvidenceKind = kindInput;

    const normalizedCaseId = this.boundedString(caseId, "caseId", MAX_CASE_ID_LENGTH);
    if (!normalizedCaseId) throw new BadRequestException({ error: "caseId is required" });

    const execution = await this.db.query<{ id: string }>(
      `SELECT e.id FROM executions e
         JOIN cycle_items ci ON ci.id = e.cycle_item_id
         JOIN testcases t ON t.id = ci.testcase_id
        WHERE ci.cycle_id = $1 AND lower(t.external_id) = $2 AND e.deleted_at IS NULL
          AND t.project_id = $3 AND t.deleted_at IS NULL`,
      [runId, normalizedCaseId.toLowerCase(), projectId]
    );
    const executionId = execution.rows[0]?.id;
    if (!executionId) {
      throw new NotFoundException({
        error: `Case "${normalizedCaseId}" has no result in this run. Post the result before its evidence.`
      });
    }

    this.assertValidEvidence(files, kind);

    // All-or-nothing on the batch, like assertValidEvidenceFiles: the loop below writes one object
    // per file, so a mid-loop rejection would leave the accepted ones stored and billed while the
    // request answers an error.
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const quota = await this.planLimits.checkStorageAvailable(project.organization_id, totalBytes);
    if (!quota.allowed) {
      this.logger.log(
        `Skipping ${files.length} evidence file(s) (${totalBytes} bytes) for execution ${executionId}: storage quota full`
      );
      return {
        list: [],
        total: 0,
        skipped: "quota" as const,
        reason: quota.reason,
        usedBytes: quota.usedBytes,
        limitBytes: quota.limitBytes
      };
    }

    const created: Body[] = [];
    for (const file of files) {
      const ext = path.extname(file.originalname).replace(/^\./, "").toLowerCase();
      const storageKey = `executions/${projectId}/${executionId}/${randomUUID()}${ext ? `.${ext}` : ""}`;
      await this.storage.put(storageKey, file.buffer, file.mimetype);
      const res = await this.db.query(
        `INSERT INTO attachments
           (project_id, entity_type, entity_id, file_name, content_type, file_size, storage_path, uploaded_by, evidence_kind)
         VALUES ($1, 'execution', $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, file_name, content_type, file_size, evidence_kind, created_at`,
        [
          projectId,
          executionId,
          LegacyService.displayFileName(file.originalname),
          file.mimetype,
          file.size,
          storageKey,
          actorId,
          kind
        ]
      );
      created.push(res.rows[0]);
    }

    return { list: created, total: created.length, skipped: null as null | "quota" };
  }

  /**
   * Type and size validation for automation evidence.
   *
   * Deliberately NOT `LegacyService.assertValidEvidenceFiles`, whose allowlist excludes `zip`
   * because "a zip hides anything past an extension check" — and a Playwright trace is a `.zip`,
   * which card §5 requires. See EVIDENCE_EXTENSIONS for why the narrower per-kind allowlist is a
   * safe place to make that exception and what keeps it narrow.
   */
  private assertValidEvidence(files: UploadedFile[], kind: EvidenceKind) {
    const allowed = EVIDENCE_EXTENSIONS[kind];
    const supported = [...allowed].sort().join(", ");
    for (const file of files) {
      const name = LegacyService.displayFileName(file.originalname);
      const ext = path.extname(file.originalname).replace(/^\./, "").toLowerCase();
      if (!ext) {
        throw new BadRequestException({
          error: `${name} has no file extension, so its type can't be determined. ${kind} evidence accepts: ${supported}.`
        });
      }
      if (!allowed.has(ext)) {
        throw new BadRequestException({
          error: `${name}: .${ext} files aren't accepted as ${kind} evidence. Supported types: ${supported}.`
        });
      }
      if (file.size <= 0) throw new BadRequestException({ error: `${name} is empty (0 bytes).` });
      if (file.size > LegacyService.EVIDENCE_MAX_FILE_SIZE) {
        const mb = (LegacyService.EVIDENCE_MAX_FILE_SIZE / (1024 * 1024)).toFixed(0);
        throw new BadRequestException({
          error: `${name} is over the ${mb}MB limit for evidence files.`
        });
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------------------------

  /**
   * Resolves a run inside the project on the URL.
   *
   * Scoped to `projectId` so a run id from another workspace is "not found" rather than reachable,
   * and a malformed id gets the same answer as an unknown one instead of failing the uuid cast in
   * Postgres and turning a typo into a 500 — the convention requireProjectAccess uses.
   */
  private async requireRun(projectId: string, runId: string) {
    if (!isUuid(runId)) throw new NotFoundException({ error: "Run not found" });
    // deleted_at IS NULL: a soft-deleted run must stop accepting result submissions, closes, etc.
    // through the automation ingest path exactly the way it stops resolving anywhere else
    // (hard-delete remediation Phase 1 — see progress log).
    const res = await this.db.query<{ id: string; name: string; closed_at: string | null; source: string }>(
      "SELECT id, name, closed_at, source FROM cycles WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL",
      [runId, projectId]
    );
    if (!res.rows[0]) throw new NotFoundException({ error: "Run not found" });
    return res.rows[0];
  }

  private async runSummary(runId: string) {
    // AND deleted_at IS NULL: every caller of runSummary reaches it either straight after
    // requireRun (getRun, closeRun) or straight after resolving/inserting a live row in createRun,
    // so this filter changes no existing caller's behaviour -- it just stops runSummary itself
    // from being a route back to describing a soft-deleted run's data, closing the same gap as the
    // two createRun lookup sites above (V112_cycles_external_id_partial_index.sql).
    const res = await this.db.query<Body>(
      `SELECT id, name, status, source, triggered_by, commit_sha, branch_name, build_url, external_id,
              environment, build_version, release_name, started_at, ended_at, closed_at, close_status,
              last_result_at, created_at
         FROM cycles WHERE id = $1 AND deleted_at IS NULL`,
      [runId]
    );
    const row = res.rows[0] ?? {};
    return {
      runId: row.id,
      name: row.name,
      status: row.status,
      source: row.source,
      triggeredBy: row.triggered_by,
      commitSha: row.commit_sha,
      branch: row.branch_name,
      buildUrl: row.build_url,
      externalId: row.external_id,
      environment: row.environment,
      buildVersion: row.build_version,
      releaseName: row.release_name,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      closedAt: row.closed_at,
      closeStatus: row.close_status,
      lastResultAt: row.last_result_at,
      createdAt: row.created_at,
      summary: await this.resultCounts(runId)
    };
  }

  /** The caller's own id, for the case where the agent actor row could not be resolved. */
  private requireActor(userId: string | null | undefined): string {
    if (!isUuid(userId)) throw new BadRequestException({ error: "Authenticated caller required" });
    return String(userId);
  }

  private isUniqueViolation(err: unknown): boolean {
    return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "23505");
  }
}
