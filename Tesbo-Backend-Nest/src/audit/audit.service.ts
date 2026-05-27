import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";

@Injectable()
export class AuditService {
  constructor(private readonly db: DatabaseService) {}

  async log(
    actorId: string | null,
    action: string,
    entityType: string,
    entityId: string | null,
    diff = "{}",
    ipAddress?: string | null,
    userAgent?: string | null
  ): Promise<void> {
    const sql = `
      INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, diff, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
    `;
    try {
      await this.db.query(sql, [actorId, action, entityType, entityId, diff, ipAddress ?? null, userAgent ?? null]);
    } catch (error) {
      console.warn("Audit log failed:", error);
    }
  }
}
