import { Injectable, Logger } from "@nestjs/common";
import { AppConfigService } from "../config/app-config.service";
import { DatabaseService } from "../database/database.service";
import { ANALYTICS_REPORT_TZ, CLAIM_LEASE_MINUTES, EXCLUDED_EMAIL_SQL } from "./analytics-report.constants";
import { buildReportHtml, type UserMetrics } from "./analytics-report.format";
import { BasecampClient, missingBasecampConfig } from "./basecamp.client";

export type ReportOutcome = "posted" | "disabled" | "not_configured" | "already_done";

@Injectable()
export class AnalyticsReportService {
  private readonly logger = new Logger(AnalyticsReportService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfigService,
    private readonly basecamp: BasecampClient
  ) {}

  /**
   * Posts the report for `reportDate` (an Asia/Kolkata calendar day, "YYYY-MM-DD"); with none given it
   * is the day before today in IST, which is what the 00:10 run is about. Throws on a Basecamp or
   * database failure so BullMQ retries; the claim is released first so the retry can take it.
   */
  async run(reportDate?: string): Promise<ReportOutcome> {
    if (!this.config.analyticsReportEnabled) return "disabled";
    const missing = missingBasecampConfig(this.config);
    if (missing) {
      this.logger.warn(`Analytics report skipped: ${missing}.`);
      return "not_configured";
    }

    const day = reportDate ?? (await this.previousIstDay());
    if (!(await this.claim(day))) {
      this.logger.log(`Analytics report for ${day} already posted or in progress; skipping.`);
      return "already_done";
    }
    try {
      const html = buildReportHtml(day, ANALYTICS_REPORT_TZ, await this.metrics(day));
      const answerId = await this.basecamp.postAnswer(html, day);
      await this.db.query("UPDATE analytics_report_runs SET posted_at = now(), basecamp_answer_id = $2 WHERE report_date = $1", [day, answerId]);
      this.logger.log(`Analytics report for ${day} posted to Basecamp (answer ${answerId}).`);
      return "posted";
    } catch (error) {
      await this.release(day);
      throw error;
    }
  }

  async metrics(day: string): Promise<UserMetrics> {
    // Four counts over the same exclusion, so every number in the report agrees on who counts as a user.
    // DAU and engaged read user_daily_activity (V136); "engaged" is activity WITHOUT a login that day, so
    // a user who logs in and works is a DAU only, never counted twice.
    const { rows } = await this.db.query<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM users u WHERE NOT ${EXCLUDED_EMAIL_SQL}
            AND (u.created_at AT TIME ZONE '${ANALYTICS_REPORT_TZ}')::date = $1::date) AS new_users,
         (SELECT count(*) FROM users u WHERE NOT ${EXCLUDED_EMAIL_SQL}
            AND (u.created_at AT TIME ZONE '${ANALYTICS_REPORT_TZ}')::date <= $1::date) AS total_users,
         (SELECT count(*) FROM user_daily_activity a JOIN users u ON u.id = a.user_id
           WHERE a.activity_date = $1::date AND a.logged_in AND NOT ${EXCLUDED_EMAIL_SQL}) AS dau,
         (SELECT count(*) FROM user_daily_activity a JOIN users u ON u.id = a.user_id
           WHERE a.activity_date = $1::date AND a.engaged AND NOT a.logged_in AND NOT ${EXCLUDED_EMAIL_SQL}) AS engaged`,
      [day]
    );
    const r = rows[0];
    return { newUsers: Number(r.new_users), totalUsers: Number(r.total_users), dau: Number(r.dau), engagedUsers: Number(r.engaged) };
  }

  private async previousIstDay(): Promise<string> {
    const { rows } = await this.db.query<{ d: string }>(
      `SELECT to_char((now() AT TIME ZONE '${ANALYTICS_REPORT_TZ}')::date - 1, 'YYYY-MM-DD') AS d`
    );
    return rows[0].d;
  }

  /** Takes the day unless it is already posted or another run holds a live (under 15 min) claim. */
  private async claim(day: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `INSERT INTO analytics_report_runs (report_date) VALUES ($1::date)
       ON CONFLICT (report_date) DO UPDATE SET claimed_at = now()
         WHERE analytics_report_runs.posted_at IS NULL
           AND analytics_report_runs.claimed_at < now() - interval '${CLAIM_LEASE_MINUTES} minutes'
       RETURNING report_date`,
      [day]
    );
    return rows.length > 0;
  }

  private async release(day: string): Promise<void> {
    await this.db
      .query(
        `UPDATE analytics_report_runs SET claimed_at = now() - interval '${CLAIM_LEASE_MINUTES * 2} minutes'
          WHERE report_date = $1::date AND posted_at IS NULL`,
        [day]
      )
      .catch((error) => this.logger.warn(`Could not release analytics report claim for ${day}: ${(error as Error).message}`));
  }
}
