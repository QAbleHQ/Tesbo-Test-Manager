--liquibase formatted sql
--changeset bettercases:V2-test-cases-suites
-- Suites (folder hierarchy, adjacency list)
CREATE TABLE suites (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id       UUID REFERENCES suites(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    position        INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_suites_project ON suites(project_id);
CREATE INDEX idx_suites_parent ON suites(parent_id);

-- Tags (project-scoped)
CREATE TABLE tags (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name            VARCHAR(64) NOT NULL,
    UNIQUE(project_id, name)
);

CREATE INDEX idx_tags_project ON tags(project_id);

-- Test cases
CREATE TABLE testcases (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    suite_id        UUID REFERENCES suites(id) ON DELETE SET NULL,
    external_id     VARCHAR(32) NOT NULL,
    title           VARCHAR(512) NOT NULL,
    description     TEXT,
    preconditions   TEXT,
    postconditions  TEXT,
    steps           JSONB NOT NULL DEFAULT '[]',
    test_data       TEXT,
    priority        VARCHAR(8) NOT NULL DEFAULT 'P2',
    severity        VARCHAR(32),
    type            VARCHAR(32) DEFAULT 'Functional',
    automation_status VARCHAR(32) DEFAULT 'Not Automated',
    automation_repo  VARCHAR(1024),
    automation_path  VARCHAR(512),
    automation_test_name VARCHAR(512),
    automation_framework VARCHAR(64),
    automation_tags  VARCHAR(512),
    owner_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    component       VARCHAR(255),
    status          VARCHAR(32) NOT NULL DEFAULT 'Draft',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_testcases_project_external ON testcases(project_id, external_id);
CREATE INDEX idx_testcases_project ON testcases(project_id);
CREATE INDEX idx_testcases_suite ON testcases(suite_id);
CREATE INDEX idx_testcases_owner ON testcases(owner_id);
CREATE INDEX idx_testcases_status ON testcases(project_id, status);
CREATE INDEX idx_testcases_updated ON testcases(project_id, updated_at DESC);

-- Full-text search
ALTER TABLE testcases ADD COLUMN search_vector tsvector;
CREATE INDEX idx_testcases_search ON testcases USING GIN(search_vector);

--liquibase formatted sql
--changeset bettercases:V2-test-cases-search-trigger splitStatements:false
CREATE OR REPLACE FUNCTION testcases_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.preconditions, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER testcases_search_vector_update
  BEFORE INSERT OR UPDATE ON testcases
  FOR EACH ROW EXECUTE PROCEDURE testcases_search_vector_trigger();

-- Test case versions (snapshot for history)
CREATE TABLE testcase_versions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    testcase_id     UUID NOT NULL REFERENCES testcases(id) ON DELETE CASCADE,
    version         INT NOT NULL,
    snapshot        JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_testcase_versions_testcase ON testcase_versions(testcase_id);

-- Entity tags (many-to-many)
CREATE TABLE entity_tags (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    entity_type     VARCHAR(32) NOT NULL,
    entity_id       UUID NOT NULL,
    tag_id          UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(entity_type, entity_id, tag_id)
);

CREATE INDEX idx_entity_tags_entity ON entity_tags(entity_type, entity_id);
CREATE INDEX idx_entity_tags_tag ON entity_tags(tag_id);

-- Custom field definitions (per project)
CREATE TABLE custom_field_definitions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name            VARCHAR(64) NOT NULL,
    type            VARCHAR(32) NOT NULL,
    options         JSONB,
    entity_types    VARCHAR(64)[] DEFAULT ARRAY['testcase'],
    deleted_at      TIMESTAMPTZ,
    UNIQUE(project_id, name)
);

CREATE INDEX idx_custom_field_defs_project ON custom_field_definitions(project_id);

-- Custom field values
CREATE TABLE custom_field_values (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    definition_id   UUID NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
    entity_type     VARCHAR(32) NOT NULL,
    entity_id       UUID NOT NULL,
    value_text      TEXT,
    value_number    NUMERIC,
    value_date      DATE,
    value_json      JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(definition_id, entity_type, entity_id)
);

CREATE INDEX idx_custom_field_values_entity ON custom_field_values(entity_type, entity_id);

-- Attachments (metadata; file stored externally or path)
CREATE TABLE attachments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    entity_type     VARCHAR(32) NOT NULL,
    entity_id       UUID NOT NULL,
    file_name       VARCHAR(255) NOT NULL,
    content_type    VARCHAR(128),
    file_size       BIGINT,
    storage_path    VARCHAR(1024) NOT NULL,
    uploaded_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_attachments_entity ON attachments(entity_type, entity_id);
