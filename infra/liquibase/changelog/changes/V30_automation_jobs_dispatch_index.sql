-- Speeds up per-project dispatch: pending Bull enqueue (queued, not yet in Redis)
CREATE INDEX IF NOT EXISTS idx_automation_jobs_project_dispatch
    ON automation_jobs (cycle_id)
    WHERE status = 'queued' AND queue_job_id IS NULL;
