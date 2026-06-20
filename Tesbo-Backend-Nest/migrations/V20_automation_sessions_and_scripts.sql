
ALTER TABLE testcases
    ADD COLUMN IF NOT EXISTS automation_script TEXT,
    ADD COLUMN IF NOT EXISTS automation_script_language VARCHAR(64) DEFAULT 'playwright-ts',
    ADD COLUMN IF NOT EXISTS automation_script_version INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS automated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS automated_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS automation_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    testcase_id UUID NOT NULL REFERENCES testcases(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    current_url TEXT,
    browser_context_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_screenshot_path TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automation_sessions_project ON automation_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_automation_sessions_testcase ON automation_sessions(testcase_id);
CREATE INDEX IF NOT EXISTS idx_automation_sessions_user ON automation_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_automation_sessions_status ON automation_sessions(status);

CREATE TABLE IF NOT EXISTS automation_session_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES automation_sessions(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    testcase_id UUID NOT NULL REFERENCES testcases(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    command_id UUID,
    event_type VARCHAR(64) NOT NULL,
    raw_command TEXT,
    parsed_action_json JSONB,
    execution_result_json JSONB,
    screenshot_path TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automation_events_session ON automation_session_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_automation_events_project ON automation_session_events(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_automation_events_testcase ON automation_session_events(testcase_id, created_at);
