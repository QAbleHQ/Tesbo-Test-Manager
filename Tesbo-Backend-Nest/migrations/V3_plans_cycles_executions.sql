-- Plans (collection of suites/cases for a release)
CREATE TABLE plans (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    target_release  VARCHAR(128),
    owner_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_plans_project ON plans(project_id);

-- Plan items: either a suite (include all cases) or a specific test case
CREATE TABLE plan_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id         UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    suite_id        UUID REFERENCES suites(id) ON DELETE CASCADE,
    testcase_id     UUID REFERENCES testcases(id) ON DELETE CASCADE,
    position        INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT plan_item_ref CHECK (suite_id IS NOT NULL OR testcase_id IS NOT NULL)
);

CREATE INDEX idx_plan_items_plan ON plan_items(plan_id);

-- Test cycles (execution instance; case list is snapshot at creation)
CREATE TABLE cycles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    plan_id         UUID REFERENCES plans(id) ON DELETE SET NULL,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    environment     VARCHAR(128),
    build_version   VARCHAR(128),
    release_name    VARCHAR(128),
    started_at      TIMESTAMPTZ,
    ended_at        TIMESTAMPTZ,
    owner_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cycles_project ON cycles(project_id);

-- Cycle items: snapshot of test case ref at cycle creation
CREATE TABLE cycle_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle_id        UUID NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
    testcase_id     UUID NOT NULL REFERENCES testcases(id) ON DELETE CASCADE,
    snapshot_title  VARCHAR(512),
    position        INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cycle_items_cycle ON cycle_items(cycle_id);

-- Executions (one per cycle_item: status, assignee, evidence)
CREATE TABLE executions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle_item_id   UUID NOT NULL REFERENCES cycle_items(id) ON DELETE CASCADE,
    status          VARCHAR(32) NOT NULL DEFAULT 'Untested',
    assignee_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    actual_result   TEXT,
    executed_at     TIMESTAMPTZ,
    defect_key      VARCHAR(128),
    defect_url      VARCHAR(1024),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(cycle_item_id)
);

CREATE INDEX idx_executions_cycle_item ON executions(cycle_item_id);
CREATE INDEX idx_executions_assignee ON executions(assignee_id);
CREATE INDEX idx_executions_status ON executions(status);
