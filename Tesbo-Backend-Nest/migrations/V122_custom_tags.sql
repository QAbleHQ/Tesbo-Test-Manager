-- Project-scoped custom tags: an Owner/Manager-curated catalog, assignable to test cases,
-- and used by Insights -> Execution Report's "Group by: Tags" filter.
--
-- Deliberately separate from testcases.automation_tags (a pre-existing free-text,
-- comma-separated column with no catalog behind it, still used for the Repository table's
-- tag chips and cycle-item snapshotting). This is an additive, distinct tag concept, not a
-- migration of that one -- nothing here reads or writes automation_tags.
CREATE TABLE custom_tags (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name          VARCHAR(40) NOT NULL,
    created_by    UUID REFERENCES actors(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_custom_tags_project ON custom_tags(project_id);

-- Case-insensitive uniqueness per project -- "Bug" and "bug" are the same tag.
CREATE UNIQUE INDEX idx_custom_tags_project_name ON custom_tags(project_id, lower(name));

-- One row per (testcase, tag) assignment. No extra columns: assignment carries no metadata
-- of its own, so there's nothing to store beyond the pair itself.
CREATE TABLE testcase_custom_tags (
    testcase_id   UUID NOT NULL REFERENCES testcases(id) ON DELETE CASCADE,
    tag_id        UUID NOT NULL REFERENCES custom_tags(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (testcase_id, tag_id)
);

CREATE INDEX idx_testcase_custom_tags_tag ON testcase_custom_tags(tag_id);
