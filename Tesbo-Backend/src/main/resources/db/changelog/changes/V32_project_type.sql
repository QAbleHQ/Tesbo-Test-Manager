--liquibase formatted sql
--changeset tesbox:32

ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_type TEXT NOT NULL DEFAULT 'tesbox';
