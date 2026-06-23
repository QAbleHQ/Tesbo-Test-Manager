
CREATE TABLE IF NOT EXISTS automation_recordings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    testcase_id UUID REFERENCES testcases(id) ON DELETE SET NULL,
    session_id UUID REFERENCES automation_sessions(id) ON DELETE SET NULL,
    command_id UUID,
    run_id VARCHAR(255) NOT NULL,
    scenario_name VARCHAR(500),
    state VARCHAR(50) NOT NULL DEFAULT 'stopped',
    started_at TIMESTAMPTZ,
    stopped_at TIMESTAMPTZ,

    -- Core recording data (full fidelity)
    events JSONB NOT NULL DEFAULT '[]'::jsonb,
    direct_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
    reasoning_log JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- Compiled outputs
    compiled_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
    playwright_script TEXT,

    -- Summary stats for quick queries without deserializing JSONB
    total_events INTEGER NOT NULL DEFAULT 0,
    direct_action_count INTEGER NOT NULL DEFAULT 0,
    reasoning_count INTEGER NOT NULL DEFAULT 0,
    observe_count INTEGER NOT NULL DEFAULT 0,
    act_count INTEGER NOT NULL DEFAULT 0,
    successful_act_count INTEGER NOT NULL DEFAULT 0,
    extract_count INTEGER NOT NULL DEFAULT 0,
    navigate_count INTEGER NOT NULL DEFAULT 0,
    compiled_action_count INTEGER NOT NULL DEFAULT 0,

    -- Execution context
    start_url VARCHAR(2000),
    final_url VARCHAR(2000),
    duration_ms INTEGER,
    success BOOLEAN DEFAULT false,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automation_recordings_project ON automation_recordings(project_id);
CREATE INDEX IF NOT EXISTS idx_automation_recordings_testcase ON automation_recordings(testcase_id);
CREATE INDEX IF NOT EXISTS idx_automation_recordings_session ON automation_recordings(session_id);
CREATE INDEX IF NOT EXISTS idx_automation_recordings_created ON automation_recordings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_recordings_project_testcase ON automation_recordings(project_id, testcase_id, created_at DESC);
