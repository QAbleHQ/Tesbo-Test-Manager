export const ZYRA_ARCHIVE_SWEEP_QUEUE = "zyra-archive-sweep";
export const ZYRA_ARCHIVE_SWEEP_JOB = "archive-sweep-run";
export const ZYRA_ARCHIVE_SWEEP_SCHEDULER_ID = "zyra-archive-sweep-nightly";

// One BullMQ Job Scheduler firing per calendar day — mirrors integration-sync's nightly-sync-jira/
// nightly-sync-linear pattern (integration-sync.module.ts), registered idempotently in this
// module's own onModuleInit so re-registering on every boot (including across multiple backend
// instances) just confirms the schedule rather than duplicating it.
//
// 03:00, not midnight: integration-sync's own nightly ticket mirror already fires at midnight IST
// (NIGHTLY_SYNC_CRON) and hits the same Jira/Linear per-app rate limits this sweep's Jira path
// also uses. Running three hours later avoids stacking both jobs' API pressure at the same instant
// — the ticket mirror is normally done well within that window (it pages up to MAX_TICKETS_PER_RUN
// per project, not per organization) — without coupling this schedule to that job's own constant.
export const ZYRA_ARCHIVE_SWEEP_CRON = "0 3 * * *";
// Same "Asia/Kolkata has observed no DST since 1945" reasoning integration-sync.constants.ts's
// NIGHTLY_SYNC_TZ documents — not imported from there on purpose: these are two independent
// schedules that happen to both anchor on IST, not one schedule depending on the other's constant.
export const ZYRA_ARCHIVE_SWEEP_TZ = "Asia/Kolkata";

// Bounded concurrency for Linear's per-issue live lookups (no batch-by-key call exists for Linear —
// see fetchLiveTicketCategory's own comment). Matches INTEGRATION_SYNC_CONCURRENCY
// (integration-sync.constants.ts) exactly, not a new number picked independently — same Jira/Linear
// per-app rate-limit concern, same reasoning, reused rather than re-derived. Jira's own path in this
// sweep needs no concurrency setting at all: it's JQL-batched (fetchLiveJiraTicketCategoriesBulk),
// so per-project call counts are already small — see the module's own report on real-world scale.
export const ZYRA_ARCHIVE_SWEEP_LINEAR_CONCURRENCY = 3;
