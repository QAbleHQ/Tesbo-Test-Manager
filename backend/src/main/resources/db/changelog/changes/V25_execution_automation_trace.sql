--liquibase formatted sql
--changeset bettercases:V25-execution-automation-trace

ALTER TABLE execution_automation_reports
    ADD COLUMN IF NOT EXISTS trace_path TEXT;
