import { Logger } from "@nestjs/common";
import type { DatabaseService } from "../database/database.service";
import { clipNotificationTitle, type NotificationLink, type NotificationType } from "./notification-events";

/**
 * The one place a matrix notification is written. A plain function over `DatabaseService` rather
 * than a method of LegacyService because the background workers that raise some notifications (the
 * knowledge-base embedding processor, the integration-sync service) cannot import LegacyService —
 * LegacyService already depends on both modules, so that would be a circular module import.
 * LegacyService.notifyUsers is this function plus its own logger.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NotifyOptions {
  type: NotificationType;
  title: string;
  link?: NotificationLink | null;
  /** Rides the (user_id, dedupe_key) unique index: a repeat for the same recipient is absorbed. */
  dedupeKey?: string;
  /** Never notified, whoever else is: the person who performed the action. */
  actorId?: string | null;
  /** Recipients who are not (any longer, or yet) members of this scope get nothing. */
  memberOf?: { organizationId?: string; projectId?: string };
}

const logger = new Logger("Notifications");

/** One row per recipient. Never throws; a failure is logged and counted as 0 rows. */
export async function writeNotifications(
  db: Pick<DatabaseService, "query">,
  recipientIds: Array<string | null | undefined>,
  opts: NotifyOptions,
  log: { error: (message: string) => void; warn?: (message: string) => void } = logger
): Promise<number> {
  try {
    const recipients = [...new Set(recipientIds.filter((id): id is string => !!id && UUID.test(id) && id !== opts.actorId))];
    if (!recipients.length) return 0;
    const params: unknown[] = [
      recipients,
      opts.type,
      clipNotificationTitle(opts.title),
      opts.link?.linkEntityType ?? null,
      opts.link?.linkEntityId ?? null,
      opts.dedupeKey ?? null
    ];
    let scope = "";
    if (opts.memberOf?.organizationId) {
      params.push(opts.memberOf.organizationId);
      scope += ` AND EXISTS (SELECT 1 FROM organization_members om WHERE om.user_id = u.id AND om.organization_id = $${params.length}::uuid)`;
    }
    if (opts.memberOf?.projectId) {
      params.push(opts.memberOf.projectId);
      scope += ` AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.user_id = u.id AND pm.project_id = $${params.length}::uuid)`;
    }
    const res = await db.query(
      `INSERT INTO notifications (user_id, type, title, link_entity_type, link_entity_id, dedupe_key)
       SELECT u.id, $2, $3, $4, $5, $6 FROM users u WHERE u.id = ANY($1::uuid[])${scope}
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING id`,
      params
    );
    // A notification with no dedupe key that wrote nothing was filtered out by membership scope or
    // named an unknown user — never "already sent". Say so, so a missing notification is findable.
    if (!res.rows.length && !opts.dedupeKey) {
      log.warn?.(`Notification "${opts.type}" wrote no rows for ${recipients.length} recipient(s)${opts.memberOf ? " (membership scope applied)" : ""}`);
    }
    return res.rows.length;
  } catch (err) {
    log.error(`Notification "${opts.type}" failed — ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}
