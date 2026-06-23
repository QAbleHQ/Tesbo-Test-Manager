
CREATE TABLE knowledge_base_items (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    item_type         VARCHAR(32) NOT NULL CHECK (item_type IN ('note', 'file')),
    title             VARCHAR(512) NOT NULL,
    content           TEXT,
    file_name         VARCHAR(512),
    file_content_type VARCHAR(256),
    file_size         BIGINT,
    storage_path      VARCHAR(1024),
    created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_kb_items_project      ON knowledge_base_items(project_id);
CREATE INDEX idx_kb_items_project_type ON knowledge_base_items(project_id, item_type);
