-- One row per report day, so the daily Basecamp analytics report is posted at most once even when
-- several backend instances can fire it: blue and green colours each run their own Redis (and so
-- their own scheduler) during a deploy, and a non-production stack pointed at this database must
-- never double-post. The job claims the day here before posting; see analytics-report.service.ts.
--
-- claimed_at is a lease, not a lock: a crashed run's claim goes stale after 15 minutes and a retry
-- can take it. posted_at is the only thing that makes a day final.
CREATE TABLE IF NOT EXISTS analytics_report_runs (
    report_date        DATE PRIMARY KEY,          -- the Asia/Kolkata day the report is ABOUT
    claimed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    posted_at          TIMESTAMPTZ,
    basecamp_answer_id BIGINT
);
