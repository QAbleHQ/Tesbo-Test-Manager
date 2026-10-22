export const DUE_DATE_SWEEP_QUEUE = "due-date-sweep";
export const DUE_DATE_SWEEP_JOB = "due-date-sweep-run";
export const DUE_DATE_SWEEP_SCHEDULER_ID = "due-date-sweep-hourly";

// Hourly, not daily: "today" is each workspace's own calendar day (organizations.timezone), so no
// single UTC instant is "morning" for everyone. Every run looks at every workspace and acts only on
// those whose local clock is past DUE_DATE_NOTIFY_FROM_HOUR; the per-day dedupe keys make the
// repeat runs inside that window no-ops rather than duplicates.
export const DUE_DATE_SWEEP_CRON = "0 * * * *";
export const DUE_DATE_SWEEP_TZ = "UTC";

/** Workspace-local hour from which reminders go out, so nobody is notified at 00:05. */
export const DUE_DATE_NOTIFY_FROM_HOUR = 8;

/**
 * How far back a missed due date is still announced. Bounds the scan (an item overdue for a year
 * is not news) while still catching an item whose date was set in the past or a sweep outage.
 */
export const DUE_DATE_OVERDUE_CATCHUP_DAYS = 14;
