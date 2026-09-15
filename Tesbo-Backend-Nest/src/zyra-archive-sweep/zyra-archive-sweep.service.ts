import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { LegacyService } from "../legacy/legacy.service";
import { ZYRA_ARCHIVE_SWEEP_LINEAR_CONCURRENCY } from "./zyra-archive-sweep.constants";

type Body = Record<string, any>;

interface ArchiveSweepCandidate {
  id: string;
  projectId: string;
  jiraIssueKey: string | null;
  linearIssueKey: string | null;
}

export interface ArchiveSweepFailure {
  testcaseId: string;
  provider: "jira" | "linear";
  issueKey: string;
  reason: string;
  detail?: string;
}

export interface ArchiveSweepSummary {
  candidatesFound: number;
  checked: number;
  staged: number;
  alreadyStaged: number;
  skippedNotConnected: number;
  skippedNotDone: number;
  skippedUnmappedCategory: number;
  skippedArchivedMeanwhile: number;
  failed: number;
  failures: ArchiveSweepFailure[];
  // Projects that got a real, newly-inserted notification this run (a project can have staged
  // candidates but 0 notified — e.g. every member already got today's notification from an
  // earlier/overlapping run, or the project genuinely has no members).
  notifiedProjects: number;
  // Total notification ROWS inserted, across every notified project's recipients.
  notificationRows: number;
  // A project whose notify call itself failed (DB error) — never counted against notifiedProjects,
  // never allowed to abort the run or any other project's notification.
  notifyFailures: number;
  durationMs: number;
}

// Same fixed +5:30, no-DST-since-1945 technique nightlyCycleDate() (integration-sync.service.ts)
// already uses — reused as a technique, not imported, for the same reason
// ZYRA_ARCHIVE_SWEEP_TZ's own comment gives: two independent schedules that happen to both anchor
// on IST, not one depending on the other's constant.
function sweepCycleDate(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Minimal, dependency-free bounded-concurrency map — no library in package.json does this today,
 *  and pulling one in for a 76-item loop isn't warranted. `limit` workers each pull the next unclaimed
 *  index off a shared cursor until the array is exhausted; a failing `fn` call is the caller's problem
 *  (this sweep's own per-candidate handler always catches, so nothing here needs to). */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
  return results;
}

function groupByProject<T extends ArchiveSweepCandidate>(candidates: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.projectId);
    if (group) group.push(candidate);
    else groups.set(candidate.projectId, [candidate]);
  }
  return groups;
}

/**
 * Archive-sweep sub-task C's orchestration, deliberately kept independent of BullMQ (that's
 * ZyraArchiveSweepProcessor's one job — call run() and log/return whatever it returns) so this
 * class is unit-testable the same way every other spec in this session tests LegacyService: mock
 * the two dependencies, assert on behavior, no real queue involved.
 *
 * One in-process run handles the whole sweep rather than fanning out into many BullMQ jobs (unlike
 * integration-sync's run -> per-ticket-job pattern) — deliberate, not an oversight. Integration-sync
 * fans out because a single Jira project sync can mean thousands of tickets; this sweep's real scale
 * (320 linked test cases today, ~15 projects) comfortably finishes as one job — see the run's own
 * `durationMs` in the summary for the actual number, not a guess. Revisit toward a fan-out design
 * only if candidate volume grows by orders of magnitude, not now.
 */
@Injectable()
export class ZyraArchiveSweepService {
  private readonly logger = new Logger(ZyraArchiveSweepService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly legacy: LegacyService
  ) {}

  async run(): Promise<ArchiveSweepSummary> {
    const startedAt = Date.now();
    const summary: ArchiveSweepSummary = {
      candidatesFound: 0,
      checked: 0,
      staged: 0,
      alreadyStaged: 0,
      skippedNotConnected: 0,
      skippedNotDone: 0,
      skippedUnmappedCategory: 0,
      skippedArchivedMeanwhile: 0,
      failed: 0,
      failures: [],
      notifiedProjects: 0,
      notificationRows: 0,
      notifyFailures: 0,
      durationMs: 0
    };
    // Per-project count of candidates actually STAGED this run (not already_staged carried over
    // from a prior sweep) — the notification trigger below fires only for a project that appears
    // here with a positive count, matching "stages one or more candidates for a project", not
    // "has any unresolved candidate at all" (which would re-notify every day about the same
    // still-unreviewed batch).
    const stagedByProject = new Map<string, number>();

    const [candidates, alreadyStagedIds] = await Promise.all([this.loadCandidates(), this.loadAlreadyStagedTestcaseIds()]);
    summary.candidatesFound = candidates.length;

    // Pre-filter before spending any Jira/Linear API budget — see stageArchiveSweepProposal's own
    // comment for why this is an optimization, not the safety net (the partial unique index is).
    // This is also what makes an overlapping/concurrent sweep run cheap rather than merely safe: the
    // later run's candidates mostly vanish here, before it makes a single outbound call.
    const pending = candidates.filter((candidate) => {
      if (alreadyStagedIds.has(candidate.id)) {
        summary.alreadyStaged++;
        return false;
      }
      return true;
    });

    const jiraCandidates = pending.filter((candidate): candidate is ArchiveSweepCandidate & { jiraIssueKey: string } => Boolean(candidate.jiraIssueKey));
    const linearCandidates = pending.filter((candidate): candidate is ArchiveSweepCandidate & { linearIssueKey: string } => Boolean(candidate.linearIssueKey));

    await this.processJira(jiraCandidates, summary, stagedByProject);
    await this.processLinear(linearCandidates, summary, stagedByProject);

    await this.notifyStagedProjects(stagedByProject, summary);

    summary.durationMs = Date.now() - startedAt;
    this.logger.log(
      `Archive sweep finished in ${summary.durationMs}ms: ${summary.candidatesFound} candidates, ` +
        `${summary.alreadyStaged} already staged, ${summary.skippedNotConnected} not connected, ` +
        `${summary.checked} checked, ${summary.staged} staged, ${summary.skippedNotDone} not done, ` +
        `${summary.skippedUnmappedCategory} unmapped category, ${summary.skippedArchivedMeanwhile} archived meanwhile, ` +
        `${summary.failed} failed, ${summary.notifiedProjects} projects notified (${summary.notificationRows} rows), ` +
        `${summary.notifyFailures} notify failures`
    );
    if (summary.failures.length) {
      this.logger.warn(`Archive sweep failures: ${JSON.stringify(summary.failures.slice(0, 20))}${summary.failures.length > 20 ? ` (+${summary.failures.length - 20} more)` : ""}`);
    }
    return summary;
  }

  /**
   * One notification per project this run actually staged something new for — never per candidate.
   * `notifyProjectMembers` fans that single call out to every current project member in one
   * INSERT..SELECT (see its own comment); the `dedupeKey` here (`archive_sweep:<projectId>:<day>`)
   * is what keeps an overlapping or retried sweep run from creating a second round of notifications
   * for the same project on the same day — each recipient's duplicate INSERT attempt is silently
   * absorbed by the partial unique index (V109), not prevented by any check here. A project whose
   * notify call fails outright (a DB error, not a dedup conflict — dedup conflicts are invisible,
   * absorbed inside the INSERT itself) is logged and skipped; it never aborts another project's
   * notification or anything about the sweep's own already-completed staging work.
   */
  private async notifyStagedProjects(stagedByProject: Map<string, number>, summary: ArchiveSweepSummary): Promise<void> {
    if (!stagedByProject.size) return;
    const dedupeDate = sweepCycleDate();
    for (const [projectId, count] of stagedByProject) {
      if (count <= 0) continue;
      try {
        const projectName = await this.loadProjectName(projectId);
        const label = projectName ? ` in ${projectName}` : "";
        const rows = await this.legacy.notifyProjectMembers(projectId, {
          type: "zyra_archive_sweep",
          title: `Zyra found ${count} archive candidate${count === 1 ? "" : "s"}`,
          body: `${count} test case${count === 1 ? "" : "s"}${label} ${count === 1 ? "has" : "have"} a linked Jira/Linear ticket that looks done. Review before archiving on the Zyra task board.`,
          linkEntityType: "zyra_task_board",
          linkEntityId: projectId,
          dedupeKey: `archive_sweep:${projectId}:${dedupeDate}`
        });
        if (rows > 0) summary.notifiedProjects++;
        summary.notificationRows += rows;
      } catch (err) {
        summary.notifyFailures++;
        this.logger.error(`Archive sweep: notification failed for project ${projectId} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async loadProjectName(projectId: string): Promise<string | null> {
    try {
      const res = await this.db.query<{ name: string }>("SELECT name FROM projects WHERE id = $1", [projectId]);
      return res.rows[0]?.name || null;
    } catch {
      // A cosmetic lookup only — the notification is still useful without a project name in the
      // body (the link still scopes it correctly), so a failure here must not skip notifying.
      return null;
    }
  }

  private async loadCandidates(): Promise<ArchiveSweepCandidate[]> {
    // testcases_active (V64) rather than hand-rolling `deleted_at IS NULL` — same view every other
    // read-path in this codebase uses for "active test cases". status <> 'Archived': proposing to
    // archive an already-archived test case is pure waste, both of API budget and of a proposal a
    // human would never need to act on.
    const res = await this.db.query<Body>(
      `SELECT id, project_id AS "projectId", jira_issue_key AS "jiraIssueKey", linear_issue_key AS "linearIssueKey"
       FROM testcases_active
       WHERE status <> 'Archived' AND (jira_issue_key IS NOT NULL OR linear_issue_key IS NOT NULL)`,
      []
    );
    return res.rows as unknown as ArchiveSweepCandidate[];
  }

  private async loadAlreadyStagedTestcaseIds(): Promise<Set<string>> {
    // Same predicate idx_ai_generation_requests_sweep_archive_dedup (V108) enforces at the DB level
    // — read here purely so this run doesn't spend Jira/Linear API budget re-checking a candidate
    // it already knows has an unresolved proposal sitting from a prior sweep.
    const res = await this.db.query<{ sweep_testcase_id: string }>(
      "SELECT sweep_testcase_id FROM ai_generation_requests WHERE provider = 'zyra_archive_sweep' AND task_status <> 'done' AND sweep_testcase_id IS NOT NULL",
      []
    );
    return new Set(res.rows.map((row) => row.sweep_testcase_id));
  }

  private async processJira(
    candidates: Array<ArchiveSweepCandidate & { jiraIssueKey: string }>,
    summary: ArchiveSweepSummary,
    stagedByProject: Map<string, number>
  ): Promise<void> {
    if (!candidates.length) return;
    for (const [projectId, group] of groupByProject(candidates)) {
      const keys = group.map((candidate) => candidate.jiraIssueKey);
      let results: Map<string, { found: boolean; doneness: "done" | "not_done" | null; rawCategory: string | null; reason: string; detail?: string }>;
      try {
        results = await this.legacy.fetchLiveJiraTicketCategoriesBulk(projectId, keys);
      } catch (err) {
        // fetchLiveJiraTicketCategoriesBulk itself never throws for a routine miss (see its own
        // contract) — this only catches something genuinely unexpected (e.g. a programming error),
        // and even then must not take the rest of the run's projects down with it.
        const detail = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        this.logger.error(`Archive sweep: Jira lookup crashed for project ${projectId} — ${detail}`);
        for (const candidate of group) {
          summary.failed++;
          summary.failures.push({ testcaseId: candidate.id, provider: "jira", issueKey: candidate.jiraIssueKey, reason: "error", detail });
        }
        continue;
      }
      for (const candidate of group) {
        const result = results.get(candidate.jiraIssueKey) || { found: false, doneness: null, rawCategory: null, reason: "error", detail: "missing from bulk result" };
        await this.handleResult(candidate, "jira", candidate.jiraIssueKey, result, summary, stagedByProject);
      }
    }
  }

  private async processLinear(
    candidates: Array<ArchiveSweepCandidate & { linearIssueKey: string }>,
    summary: ArchiveSweepSummary,
    stagedByProject: Map<string, number>
  ): Promise<void> {
    if (!candidates.length) return;
    await mapWithConcurrency(candidates, ZYRA_ARCHIVE_SWEEP_LINEAR_CONCURRENCY, async (candidate) => {
      let result: { found: boolean; doneness: "done" | "not_done" | null; rawCategory: string | null; reason: string; detail?: string };
      try {
        result = await this.legacy.fetchLiveTicketCategory(candidate.projectId, "linear", candidate.linearIssueKey);
      } catch (err) {
        // Same defensive backstop as the Jira branch — fetchLiveTicketCategory's own contract is
        // "never throw", this only catches the genuinely unexpected.
        const detail = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        this.logger.error(`Archive sweep: Linear lookup crashed for testcase ${candidate.id} — ${detail}`);
        summary.failed++;
        summary.failures.push({ testcaseId: candidate.id, provider: "linear", issueKey: candidate.linearIssueKey, reason: "error", detail });
        return;
      }
      await this.handleResult(candidate, "linear", candidate.linearIssueKey, result, summary, stagedByProject);
    });
  }

  private async handleResult(
    candidate: ArchiveSweepCandidate,
    provider: "jira" | "linear",
    issueKey: string,
    result: { found: boolean; doneness: "done" | "not_done" | null; rawCategory: string | null; reason: string; detail?: string },
    summary: ArchiveSweepSummary,
    stagedByProject: Map<string, number>
  ): Promise<void> {
    if (result.reason === "not_connected") {
      // Never reached the provider at all — not a failure of the check, just nothing to check yet.
      summary.skippedNotConnected++;
      return;
    }
    summary.checked++;
    if (result.reason === "not_found" || result.reason === "error") {
      summary.failed++;
      summary.failures.push({ testcaseId: candidate.id, provider, issueKey, reason: result.reason, detail: result.detail });
      return;
    }
    if (result.doneness === null) {
      summary.skippedUnmappedCategory++;
      return;
    }
    if (result.doneness === "not_done") {
      summary.skippedNotDone++;
      return;
    }

    const providerLabel = provider === "jira" ? "Jira" : "Linear";
    const reason = `Zyra's archive sweep found the linked ${providerLabel} ticket ${issueKey}'s status category is "${result.rawCategory}" (done) — this test case may no longer be needed. Review before archiving.`;
    const outcome = await this.legacy.stageArchiveSweepProposal(candidate.projectId, candidate.id, reason);
    if (outcome === "staged") {
      summary.staged++;
      stagedByProject.set(candidate.projectId, (stagedByProject.get(candidate.projectId) || 0) + 1);
    } else if (outcome === "already_staged") {
      summary.alreadyStaged++;
    } else {
      summary.skippedArchivedMeanwhile++;
    }
  }
}
