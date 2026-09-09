-- Disconnecting a Jira/Linear integration never touched the Knowledge Base folder that
-- ensureProviderFolder created for it, so the "Jira"/"Linear" folder (and every mirrored ticket
-- document inside it) stayed fully visible after disconnect. This adds the two columns needed to
-- fix that without ever hard-deleting anything:
--
--   source_provider  identifies a system-generated provider folder by a real discriminator instead
--                     of matching on its display name ("Jira"/"Linear") — a name match would miss a
--                     folder the user renamed, and would wrongly sweep up a user's own folder that
--                     happens to share the name.
--   deletion_reason  distinguishes a disconnect-triggered soft-delete ('integration_disconnect')
--                     from an ordinary user delete ('manual'), so only the former can be made
--                     non-restorable. NULL on every already-soft-deleted row (manual deletes made
--                     before this migration), so nothing restorable today becomes blocked.

ALTER TABLE knowledge_folders
  ADD COLUMN IF NOT EXISTS source_provider VARCHAR(32),
  ADD COLUMN IF NOT EXISTS deletion_reason VARCHAR(32);

-- Query pattern this backs: integrationDisconnect's org-wide "find every provider folder in this
-- workspace" lookup (WHERE organization_id = $1 AND source_provider = $2 AND is_deleted = false).
-- Without this, disconnect does a sequential scan of knowledge_folders across every tenant on the
-- platform, not just the disconnecting workspace's rows.
CREATE INDEX IF NOT EXISTS idx_knowledge_folders_source_provider ON knowledge_folders(organization_id, source_provider)
  WHERE source_provider IS NOT NULL AND is_deleted = false;

-- One-time backfill so already-connected workspaces are covered by the fix immediately, without
-- waiting for their next sync to re-create the folder. Two signals, strongest first:
--
-- Signal 1: a folder already holding at least one mirrored document tagged with a provider (V72's
-- knowledge_documents.source_provider, set at sync time) IS that provider's folder, regardless of
-- what the folder is currently named — a document's source_provider survives a later folder rename
-- even though the folder's own name no longer does. This is the fix for the gap signal 2 alone would
-- have: a folder renamed before this migration ever ran would never match on name and would stay
-- invisible-but-undeleted forever after every future disconnect.
UPDATE knowledge_folders kf
SET source_provider = doc.source_provider
FROM (
  SELECT DISTINCT ON (folder_id) folder_id, source_provider
  FROM knowledge_documents
  WHERE source_provider IS NOT NULL
  ORDER BY folder_id, created_at ASC
) doc
WHERE kf.id = doc.folder_id
  AND kf.is_deleted = false
  AND kf.source_provider IS NULL;

-- Signal 2 (fallback): a folder ensureProviderFolder created but whose first sync failed before
-- writing a single document has nothing to key off signal 1 — fall back to the default name, but
-- only within a workspace that actually has (or had) a real connection for that provider. Matching
-- on name alone, with no such guard, would mistag a folder a user happened to name "Jira"/"Linear"
-- themselves, and that folder would then be permanently (non-restorably) soft-deleted the next time
-- *anyone* in the workspace disconnects that provider — exactly the false-positive this column
-- exists to avoid. This does not rule out a coincidentally-named folder living in a *different*
-- project of an organization that legitimately connected the provider elsewhere; backfill is
-- inherently a best-effort reconstruction of history that was never recorded. Application code keys
-- off source_provider from here on and never re-matches by name again.
UPDATE knowledge_folders kf
SET source_provider = pf.provider
FROM (VALUES ('Jira', 'jira'), ('Linear', 'linear')) AS pf(name, provider)
WHERE kf.name = pf.name
  AND kf.is_deleted = false
  AND kf.source_provider IS NULL
  AND kf.parent_folder_id IN (SELECT id FROM knowledge_folders WHERE is_root = true)
  AND EXISTS (
    SELECT 1 FROM integration_connections ic
    WHERE ic.organization_id = kf.organization_id AND ic.provider = pf.provider
  );
