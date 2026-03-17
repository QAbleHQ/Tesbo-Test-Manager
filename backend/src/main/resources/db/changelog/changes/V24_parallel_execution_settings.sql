ALTER TABLE automation_runs
    ADD COLUMN IF NOT EXISTS execution_provider TEXT NOT NULL DEFAULT 'default',
    ADD COLUMN IF NOT EXISTS max_parallel INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS provider_config_json JSONB;

ALTER TABLE automation_jobs
    ADD COLUMN IF NOT EXISTS execution_provider TEXT NOT NULL DEFAULT 'default',
    ADD COLUMN IF NOT EXISTS provider_payload_json JSONB,
    ADD COLUMN IF NOT EXISTS shard_index INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS shard_total INT NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_automation_runs_provider ON automation_runs(execution_provider);
CREATE INDEX IF NOT EXISTS idx_automation_jobs_shard ON automation_jobs(run_id, shard_index);
