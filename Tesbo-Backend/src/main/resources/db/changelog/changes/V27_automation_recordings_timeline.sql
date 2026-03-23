--liquibase formatted sql
--changeset bettercases:V27-automation-recordings-timeline

-- Add unified timeline column that replaces events + direct_actions + reasoning_log
ALTER TABLE automation_recordings ADD COLUMN IF NOT EXISTS timeline JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Replace granular stat columns with a single stats JSONB
ALTER TABLE automation_recordings ADD COLUMN IF NOT EXISTS stats JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Drop the old 3 separate JSONB columns (data now lives in timeline)
ALTER TABLE automation_recordings DROP COLUMN IF EXISTS events;
ALTER TABLE automation_recordings DROP COLUMN IF EXISTS direct_actions;
ALTER TABLE automation_recordings DROP COLUMN IF EXISTS reasoning_log;
ALTER TABLE automation_recordings DROP COLUMN IF EXISTS compiled_actions;

-- Drop the old individual counter columns (data now in stats JSONB)
ALTER TABLE automation_recordings DROP COLUMN IF EXISTS total_events;
ALTER TABLE automation_recordings DROP COLUMN IF EXISTS direct_action_count;
ALTER TABLE automation_recordings DROP COLUMN IF EXISTS reasoning_count;
ALTER TABLE automation_recordings DROP COLUMN IF EXISTS observe_count;
ALTER TABLE automation_recordings DROP COLUMN IF EXISTS act_count;
ALTER TABLE automation_recordings DROP COLUMN IF EXISTS successful_act_count;
ALTER TABLE automation_recordings DROP COLUMN IF EXISTS extract_count;
ALTER TABLE automation_recordings DROP COLUMN IF EXISTS navigate_count;
ALTER TABLE automation_recordings DROP COLUMN IF EXISTS compiled_action_count;
