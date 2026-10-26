/*
 * Notion pages are numbered per linked database ("Notes 1", "Notes 2", ...), replacing the old
 * "notion:" + 8 hex chars of the page id (V133), which collided for pages created close together, so
 * the Requirements list could show the same key on several rows.
 *
 * notion_project_mappings.page_counter is the last number handed out for that database link. Relinking
 * the same database reuses the row (ON CONFLICT in LegacyService), so its numbers continue and never
 * repeat. Existing pages are renumbered 1..n per database in the order they were created in Notion.
 * A page whose mapping is gone keeps its current key.
 */
ALTER TABLE notion_project_mappings ADD COLUMN IF NOT EXISTS page_counter INTEGER NOT NULL DEFAULT 0;

WITH numbered AS (
  SELECT np.id, m.id AS mapping_id, m.notion_database_name AS name,
         row_number() OVER (PARTITION BY m.id ORDER BY np.notion_created_at NULLS LAST, np.synced_at, np.id) AS n
  FROM notion_pages np
  JOIN notion_project_mappings m
    ON m.project_id = np.project_id AND m.notion_database_id = np.mapped_remote_id
   AND m.integration_connection_id = np.integration_connection_id
)
UPDATE notion_pages np
   SET notion_page_key = COALESCE(NULLIF(trim(numbered.name), ''), 'Page') || ' ' || numbered.n
  FROM numbered
 WHERE np.id = numbered.id;

UPDATE notion_project_mappings m
   SET page_counter = c.n
  FROM (SELECT m2.id, count(*)::int AS n
          FROM notion_pages np
          JOIN notion_project_mappings m2
            ON m2.project_id = np.project_id AND m2.notion_database_id = np.mapped_remote_id
           AND m2.integration_connection_id = np.integration_connection_id
         GROUP BY m2.id) c
 WHERE m.id = c.id;
