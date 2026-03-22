--liquibase formatted sql
--changeset bettercases:V9-cycle-status

-- Add status column to cycles table for test run workflow
ALTER TABLE cycles ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'Planning';
CREATE INDEX IF NOT EXISTS idx_cycles_status ON cycles(status);
