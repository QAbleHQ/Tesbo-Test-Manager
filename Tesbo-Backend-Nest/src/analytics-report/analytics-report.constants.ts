export const ANALYTICS_REPORT_QUEUE = "analytics-report";
export const ANALYTICS_REPORT_JOB = "analytics-report-daily";
export const ANALYTICS_REPORT_SCHEDULER_ID = "analytics-report-daily";

// 00:10 IST: ten minutes past midnight so the day being reported is fully closed. Registered with a
// tz, not converted to UTC, so it survives a server in any zone. India has no DST.
export const ANALYTICS_REPORT_CRON = "10 0 * * *";
export const ANALYTICS_REPORT_TZ = "Asia/Kolkata";

// "Tesbo Stastics" automatic check-in (sic) in the QAble Product Innovation Hub project.
export const DEFAULT_ANALYTICS_QUESTION_URL = "https://3.basecamp.com/5705339/buckets/47793887/questions/10370979699";

// Accounts that are test data, not users: the e2e suite's disposable mailinator addresses and its
// e2e-* fixtures. Excluded from every number in the report.
export const EXCLUDED_EMAIL_SQL = "(u.email ILIKE '%@mailinator.com' OR u.email ILIKE 'e2e-%')";

// A claim older than this belongs to a crashed run and may be retaken.
export const CLAIM_LEASE_MINUTES = 15;
