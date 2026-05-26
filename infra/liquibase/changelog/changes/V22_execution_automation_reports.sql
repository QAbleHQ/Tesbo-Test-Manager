--liquibase formatted sql
--changeset bettercases:V22-execution-automation-reports

CREATE TABLE IF NOT EXISTS execution_automation_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle_id UUID NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
    execution_id UUID NOT NULL UNIQUE REFERENCES executions(id) ON DELETE CASCADE,
    status VARCHAR(32) NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    logs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    video_path TEXT,
    screenshot_path TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_execution_automation_reports_cycle
    ON execution_automation_reports(cycle_id);
