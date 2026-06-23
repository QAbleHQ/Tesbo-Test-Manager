
ALTER TABLE tesbo_report_cases
    ADD COLUMN IF NOT EXISTS trace_storage_key VARCHAR(2048),
    ADD COLUMN IF NOT EXISTS screenshot_storage_key VARCHAR(2048),
    ADD COLUMN IF NOT EXISTS video_storage_key VARCHAR(2048);
