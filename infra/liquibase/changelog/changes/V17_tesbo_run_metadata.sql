--liquibase formatted sql
--changeset bettercases:V17-tesbo-run-metadata

ALTER TABLE tesbo_report_runs
    ADD COLUMN IF NOT EXISTS branch_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS pull_request VARCHAR(128),
    ADD COLUMN IF NOT EXISTS commit_author VARCHAR(255),
    ADD COLUMN IF NOT EXISTS run_number VARCHAR(64),
    ADD COLUMN IF NOT EXISTS source_type VARCHAR(64),
    ADD COLUMN IF NOT EXISTS github_run_id VARCHAR(128);

CREATE INDEX IF NOT EXISTS idx_tesbo_runs_source ON tesbo_report_runs(project_id, source_type);
