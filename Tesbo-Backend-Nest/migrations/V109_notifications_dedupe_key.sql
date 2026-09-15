
-- Archive-sweep notifications (the first real writer notifications has ever had — see this
-- migration's sibling code change: GET /api/notifications and POST /api/notifications/:id/read
-- were both hardcoded stubs until now, "Notifications are not implemented yet" per the comment
-- this change replaces).
--
-- Generic, reusable dedup column — not archive-sweep-specific by name — for the same reason
-- `ai_generation_requests.provider` (not a new column) was reused for the sweep's actor identity
-- in V107: this table's future notification types get the same mechanism for free rather than
-- each inventing (or forgetting to invent) their own.
--
-- One partial UNIQUE index, same plain-stored-column technique V90/V108 already established in
-- this codebase for exactly this problem (cross-run/cross-instance duplicate suppression): a
-- caller computes a deterministic key — for the archive sweep, `archive_sweep:<projectId>:<date>`,
-- one calendar day in the sweep's own timezone, mirroring nightlyCycleDate()'s reasoning without
-- importing it (two independent schedules, not one depending on the other's constant) — and a
-- retried or overlapping call's INSERT is absorbed by ON CONFLICT DO NOTHING rather than needing
-- an app-level pre-check or a caught 23505.
--
-- NULL for every notification that doesn't opt into dedup (nothing does yet, until this change's
-- writer), and a unique index never treats two NULLs as colliding, so this is purely additive.
ALTER TABLE notifications ADD COLUMN dedupe_key VARCHAR(128);

CREATE UNIQUE INDEX idx_notifications_user_dedupe
  ON notifications (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
