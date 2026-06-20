
-- Lightweight bug tracker linked to test executions
CREATE TABLE bugs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    execution_id    UUID REFERENCES executions(id) ON DELETE SET NULL,
    testcase_id     UUID REFERENCES testcases(id) ON DELETE SET NULL,
    cycle_id        UUID REFERENCES cycles(id) ON DELETE SET NULL,
    title           VARCHAR(512) NOT NULL,
    description     TEXT,
    external_url    VARCHAR(1024),
    status          VARCHAR(32) NOT NULL DEFAULT 'Open',
    reported_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bugs_project ON bugs(project_id);
CREATE INDEX idx_bugs_execution ON bugs(execution_id) WHERE execution_id IS NOT NULL;
CREATE INDEX idx_bugs_cycle ON bugs(cycle_id) WHERE cycle_id IS NOT NULL;
CREATE INDEX idx_bugs_status ON bugs(status);
