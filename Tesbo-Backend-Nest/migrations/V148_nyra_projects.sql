-- NYRA agent: which NYRA projects were created from which Tesbo project.
--
-- One NYRA_API_KEY sees every NYRA project in its NYRA workspace, so on its own it would show all of
-- them to every Tesbo project and workspace. A Tesbo project may only list and open the NYRA
-- projects recorded here. Ids only: the test-account password is sent to NYRA once and never stored.
CREATE TABLE nyra_projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    nyra_project_id VARCHAR(64) NOT NULL,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, nyra_project_id)
);
