
CREATE TABLE IF NOT EXISTS workspace_ai_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(128) NOT NULL,
    provider VARCHAR(32) NOT NULL,
    api_key TEXT NOT NULL,
    default_model VARCHAR(128),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, name)
);

CREATE INDEX IF NOT EXISTS idx_workspace_ai_keys_org ON workspace_ai_keys(organization_id);

CREATE TABLE IF NOT EXISTS project_ai_key_allocations (
    project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    workspace_ai_key_id UUID REFERENCES workspace_ai_keys(id) ON DELETE SET NULL,
    allocated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_ai_alloc_workspace_key ON project_ai_key_allocations(workspace_ai_key_id);
