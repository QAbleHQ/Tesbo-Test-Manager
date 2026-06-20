-- Import jobs (CSV import history and errors)
CREATE TABLE import_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    uploaded_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    file_name       VARCHAR(255),
    status          VARCHAR(32) NOT NULL DEFAULT 'pending',
    total_rows      INT DEFAULT 0,
    imported_rows   INT DEFAULT 0,
    failed_rows     INT DEFAULT 0,
    error_report_path VARCHAR(1024),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_import_jobs_project ON import_jobs(project_id);

-- Export jobs (async export download)
CREATE TABLE export_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    requested_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    type            VARCHAR(32) NOT NULL,
    status          VARCHAR(32) NOT NULL DEFAULT 'pending',
    file_path       VARCHAR(1024),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_export_jobs_project ON export_jobs(project_id);
