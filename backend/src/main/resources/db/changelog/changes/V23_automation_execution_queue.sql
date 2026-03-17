CREATE TABLE IF NOT EXISTS automation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle_id UUID NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'running',
    total_jobs INT NOT NULL DEFAULT 0,
    completed_jobs INT NOT NULL DEFAULT 0,
    passed_jobs INT NOT NULL DEFAULT 0,
    failed_jobs INT NOT NULL DEFAULT 0,
    cancelled_jobs INT NOT NULL DEFAULT 0,
    queued_jobs INT NOT NULL DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_cycle ON automation_runs(cycle_id);
CREATE INDEX IF NOT EXISTS idx_automation_runs_status ON automation_runs(status);

CREATE TABLE IF NOT EXISTS automation_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
    cycle_id UUID NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
    execution_id UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    testcase_title TEXT,
    testcase_external_id TEXT,
    script TEXT,
    start_url TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    worker_id TEXT,
    queue_job_id TEXT,
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 2,
    last_heartbeat_at TIMESTAMPTZ,
    error_message TEXT,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, execution_id)
);

CREATE INDEX IF NOT EXISTS idx_automation_jobs_run ON automation_jobs(run_id);
CREATE INDEX IF NOT EXISTS idx_automation_jobs_cycle ON automation_jobs(cycle_id);
CREATE INDEX IF NOT EXISTS idx_automation_jobs_status ON automation_jobs(status);
CREATE INDEX IF NOT EXISTS idx_automation_jobs_execution ON automation_jobs(execution_id);
