export const INTEGRATION_SYNC_QUEUE = "integration-sync";

// Two job types on one queue. `sync-run` is the fan-out coordinator (pages the provider API,
// upserts ticket rows, enqueues one `sync-ticket` per ticket); `sync-ticket` builds the
// Knowledge Base document for a single ticket. Splitting them means one flaky ticket retries
// on its own instead of restarting a 400-ticket backlog.
export const INTEGRATION_SYNC_RUN_JOB = "sync-run";
export const INTEGRATION_SYNC_TICKET_JOB = "sync-ticket";

// Provider page sizes. Jira caps /search/jql at 100; Linear's GraphQL `first` caps at 250 but
// 100 keeps response bodies manageable.
export const JIRA_PAGE_SIZE = 100;
export const LINEAR_PAGE_SIZE = 100;

// Hard ceiling on tickets pulled in a single run, so a first sync against a 50k-issue Jira
// project can't run for hours or blow up the queue. Ordered by most-recently-updated, so the
// cutoff drops the stalest tickets first. Surfaced to the user when it bites.
export const MAX_TICKETS_PER_RUN = 2000;

// Comments per ticket. Jira and Linear both return newest-last; we keep the most recent
// COMMENTS_PER_TICKET so a 300-comment epic doesn't dominate the document or the AI prompt.
export const COMMENTS_PER_TICKET = 50;

// Worker concurrency. Kept modest: Jira Cloud rate-limits per-app, and every `sync-ticket`
// job makes at least one comments call.
export const INTEGRATION_SYNC_CONCURRENCY = 3;

// Character budget for the comment text handed to the decision-summary model. Comments beyond
// this are dropped from the prompt only — the document still stores them verbatim.
export const DECISION_PROMPT_CHAR_BUDGET = 12000;

// Folder created (lazily, on first successful sync) to hold everything a provider owns.
export const PROVIDER_FOLDER_NAMES: Record<string, string> = { jira: "Jira", linear: "Linear" };

// ── Nightly cron ──

// One orchestrator job per provider, so a Jira-side outage can never block Linear's nightly run
// (or vice versa) and each has its own independent BullMQ Job Scheduler.
export const INTEGRATION_SYNC_NIGHTLY_JIRA_JOB = "nightly-sync-jira";
export const INTEGRATION_SYNC_NIGHTLY_LINEAR_JOB = "nightly-sync-linear";
export const INTEGRATION_SYNC_NIGHTLY_JIRA_SCHEDULER_ID = "integration-sync-nightly-jira";
export const INTEGRATION_SYNC_NIGHTLY_LINEAR_SCHEDULER_ID = "integration-sync-nightly-linear";

// Midnight IST, every night. No per-organization timezone exists anywhere in this schema, so this
// is a single global fire time rather than one derived per workspace.
export const NIGHTLY_SYNC_CRON = "0 0 * * *";
export const NIGHTLY_SYNC_TZ = "Asia/Kolkata";

// Subtracted from the previous successful run's started_at before using it as the incremental
// "updated >=" cursor. Guards against a ticket that changed a few seconds before the previous run
// started but hadn't yet landed in the provider's search index at that moment — without this, the
// next incremental run's cursor would sit after that ticket's real updated timestamp and skip it
// forever. The cost is a handful of redundant (cheap, hash-gated no-op) re-fetches per run.
export const NIGHTLY_SYNC_SINCE_BUFFER_MINUTES = 10;
