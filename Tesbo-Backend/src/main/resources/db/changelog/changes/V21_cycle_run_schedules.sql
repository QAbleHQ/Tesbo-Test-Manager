--liquibase formatted sql
--changeset bettercases:V21-cycle-run-schedules

CREATE TABLE IF NOT EXISTS cycle_run_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    cycle_id UUID NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    schedule_type VARCHAR(32) NOT NULL,
    run_at TIMESTAMPTZ,
    interval_minutes INT,
    timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
    next_run_at TIMESTAMPTZ,
    last_run_at TIMESTAMPTZ,
    last_status VARCHAR(32),
    last_error TEXT,
    is_running BOOLEAN NOT NULL DEFAULT false,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cycle_run_schedules_type_check CHECK (schedule_type IN ('one_time', 'recurring')),
    CONSTRAINT cycle_run_schedules_one_time_check CHECK (
        (schedule_type = 'one_time' AND run_at IS NOT NULL)
        OR (schedule_type = 'recurring' AND interval_minutes IS NOT NULL AND interval_minutes > 0)
    )
);

CREATE INDEX IF NOT EXISTS idx_cycle_run_schedules_project ON cycle_run_schedules(project_id);
CREATE INDEX IF NOT EXISTS idx_cycle_run_schedules_cycle ON cycle_run_schedules(cycle_id);
CREATE INDEX IF NOT EXISTS idx_cycle_run_schedules_next_run ON cycle_run_schedules(next_run_at) WHERE enabled = true;
