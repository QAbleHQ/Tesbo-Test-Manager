import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { LegacyService } from "../legacy/legacy.service";
import { DEFAULT_WORKSPACE_TIMEZONE, addDays, duePhase, formatDay, hourIn, isValidTimezone, todayIn, type DuePhase } from "../legacy/due-dates";
import { notificationLinks, notificationMessages, runLabel, type NotificationType } from "../legacy/notification-events";
import { DUE_DATE_NOTIFY_FROM_HOUR, DUE_DATE_OVERDUE_CATCHUP_DAYS } from "./due-date-sweep.constants";

type Kind = "run" | "plan";

interface DueItem {
  kind: Kind;
  id: string;
  name: string;
  externalId: string | null;
  status: string;
  ownerId: string | null;
  projectId: string;
  projectName: string;
  dueDate: string;
  timezone: string;
}

export interface DueDateSweepSummary {
  scanned: number;
  notifiedItems: number;
  notificationRows: number;
  failures: number;
  durationMs: number;
}

const TYPES: Record<Kind, Record<DuePhase, NotificationType>> = {
  run: { due_soon: "test_run_due_soon", due_today: "test_run_due_today", overdue: "test_run_overdue" },
  plan: { due_soon: "test_plan_due_soon", due_today: "test_plan_due_today", overdue: "test_plan_overdue" }
};

/**
 * Due-date reminders for test plans and test runs: "due tomorrow", "due today" and "overdue".
 *
 * Stateless on purpose. Nothing records "this item was reminded"; each pass recomputes the phase of
 * every open item from its current due date and writes a notification keyed on
 * `(kind, id, dueDate, phase)`. Two properties fall out of that, with no code of their own:
 *  - a repeat or overlapping pass is absorbed by the (user_id, dedupe_key) unique index;
 *  - moving a due date changes the key, so reminders follow the new date and the old date's are
 *    never sent (and an item pushed out of "overdue" is simply no longer overdue).
 *
 * "Open" means: a run that is not Completed; a plan that has no runs or has a run that is not
 * Completed. A deleted item, or one in an archived project, is never reminded.
 */
@Injectable()
export class DueDateSweepService {
  private readonly logger = new Logger(DueDateSweepService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly legacy: LegacyService
  ) {}

  async run(now: Date = new Date()): Promise<DueDateSweepSummary> {
    const startedAt = Date.now();
    const summary: DueDateSweepSummary = { scanned: 0, notifiedItems: 0, notificationRows: 0, failures: 0, durationMs: 0 };
    const items = await this.loadOpenItems(now);
    summary.scanned = items.length;
    for (const item of items) {
      try {
        const zone = isValidTimezone(item.timezone) ? item.timezone : DEFAULT_WORKSPACE_TIMEZONE;
        if (hourIn(zone, now) < DUE_DATE_NOTIFY_FROM_HOUR) continue;
        const today = todayIn(zone, now);
        const phase = duePhase(item.dueDate, today);
        if (!phase) continue;
        if (phase === "overdue" && item.dueDate < addDays(today, -DUE_DATE_OVERDUE_CATCHUP_DAYS)) continue;
        const rows = await this.notify(item, phase);
        if (rows > 0) summary.notifiedItems++;
        summary.notificationRows += rows;
      } catch (err) {
        summary.failures++;
        this.logger.error(`Due-date sweep: ${item.kind} ${item.id} failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    summary.durationMs = Date.now() - startedAt;
    this.logger.log(
      `Due-date sweep finished in ${summary.durationMs}ms: ${summary.scanned} scanned, ${summary.notifiedItems} items notified (${summary.notificationRows} rows), ${summary.failures} failed`
    );
    return summary;
  }

  /**
   * Every open run/plan whose due date could be inside the reminder window in *some* workspace
   * timezone. The window is padded by a day each side of the UTC date (zones span UTC-12..+14); the
   * exact phase is then decided per item in its own zone.
   */
  private async loadOpenItems(now: Date): Promise<DueItem[]> {
    const utcToday = now.toISOString().slice(0, 10);
    const from = addDays(utcToday, -(DUE_DATE_OVERDUE_CATCHUP_DAYS + 1));
    const to = addDays(utcToday, 2);
    const runs = await this.db.query<Record<string, string | null>>(
      `SELECT c.id, c.name, c.external_id, c.status, c.owner_id, c.project_id, p.name AS project_name,
              to_char(c.due_date, 'YYYY-MM-DD') AS due_date, o.timezone
       FROM cycles c
       JOIN projects p ON p.id = c.project_id AND p.archived_at IS NULL
       JOIN organizations o ON o.id = p.organization_id
       WHERE c.deleted_at IS NULL AND c.due_date BETWEEN $1::date AND $2::date AND c.status <> 'Completed'`,
      [from, to]
    );
    const plans = await this.db.query<Record<string, string | null>>(
      `SELECT pl.id, pl.name, pl.external_id, pl.owner_id, pl.project_id, p.name AS project_name,
              to_char(pl.due_date, 'YYYY-MM-DD') AS due_date, o.timezone,
              CASE WHEN EXISTS (SELECT 1 FROM cycles r WHERE r.plan_id = pl.id AND r.deleted_at IS NULL) THEN 'Active' ELSE 'Draft' END AS status
       FROM plans pl
       JOIN projects p ON p.id = pl.project_id AND p.archived_at IS NULL
       JOIN organizations o ON o.id = p.organization_id
       WHERE pl.deleted_at IS NULL AND pl.due_date BETWEEN $1::date AND $2::date
         AND NOT (
           EXISTS (SELECT 1 FROM cycles r WHERE r.plan_id = pl.id AND r.deleted_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM cycles r WHERE r.plan_id = pl.id AND r.deleted_at IS NULL AND r.status <> 'Completed')
         )`,
      [from, to]
    );
    const toItem =
      (kind: Kind) =>
      (row: Record<string, string | null>): DueItem => ({
        kind,
        id: String(row.id),
        name: String(row.name ?? ""),
        externalId: row.external_id ?? null,
        status: String(row.status ?? ""),
        ownerId: row.owner_id ?? null,
        projectId: String(row.project_id),
        projectName: String(row.project_name ?? ""),
        dueDate: String(row.due_date),
        timezone: String(row.timezone ?? DEFAULT_WORKSPACE_TIMEZONE)
      });
    return [...runs.rows.map(toItem("run")), ...plans.rows.map(toItem("plan"))];
  }

  /**
   * The owner, plus — for a run — whoever still has an unfinished case assigned. An item nobody is
   * named on falls back to the project's owners, so a reminder is never addressed to no one.
   */
  private async recipients(item: DueItem): Promise<string[]> {
    const ids = new Set<string>();
    if (item.ownerId) ids.add(item.ownerId);
    if (item.kind === "run") {
      const assigned = await this.db.query<{ assignee_id: string }>(
        `SELECT DISTINCT e.assignee_id FROM executions e
         JOIN cycle_items ci ON ci.id = e.cycle_item_id
         WHERE ci.cycle_id = $1 AND e.assignee_id IS NOT NULL AND e.status IN ('Untested', 'Retest', 'Blocked')
           AND e.deleted_at IS NULL AND ci.deleted_at IS NULL`,
        [item.id]
      );
      for (const row of assigned.rows) ids.add(row.assignee_id);
    }
    if (!ids.size) {
      const owners = await this.db.query<{ user_id: string }>("SELECT user_id FROM project_members WHERE project_id = $1 AND role = 'owner'", [item.projectId]);
      for (const row of owners.rows) ids.add(row.user_id);
    }
    return [...ids];
  }

  private async notify(item: DueItem, phase: DuePhase): Promise<number> {
    const recipients = await this.recipients(item);
    if (!recipients.length) return 0;
    const name = item.kind === "run" ? runLabel(item.name, item.externalId) : item.name;
    return this.legacy.notifyUsers(recipients, {
      type: TYPES[item.kind][phase],
      title: notificationMessages.dueReminder(item.kind === "run" ? "Test run" : "Test plan", name, phase),
      body: notificationMessages.dueReminderBody(item.projectName, formatDay(item.dueDate), item.status),
      link: item.kind === "run" ? notificationLinks.testRun(item.projectId, item.id) : notificationLinks.testPlan(item.projectId, item.id),
      // The due date is part of the key: a moved date starts a fresh set of reminders.
      dedupeKey: `due:${item.kind}:${item.id}:${item.dueDate}:${phase}`,
      memberOf: { projectId: item.projectId }
    });
  }
}
