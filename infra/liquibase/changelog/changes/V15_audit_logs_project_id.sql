--liquibase formatted sql

--changeset bettercases:15-1
ALTER TABLE audit_logs ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX idx_audit_logs_project ON audit_logs(project_id);

--changeset bettercases:15-2
ALTER TABLE audit_logs ADD COLUMN entity_name VARCHAR(512);
