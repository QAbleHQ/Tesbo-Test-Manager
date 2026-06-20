
ALTER TABLE execution_automation_reports
    ADD COLUMN IF NOT EXISTS trace_path TEXT;
