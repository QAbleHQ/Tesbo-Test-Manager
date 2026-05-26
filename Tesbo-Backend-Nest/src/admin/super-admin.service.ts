import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";

@Injectable()
export class SuperAdminService {
  constructor(private readonly db: DatabaseService) {}

  async isPlatformAdmin(userId: string): Promise<boolean> {
    const result = await this.db.query("SELECT 1 FROM platform_admins WHERE user_id = $1 LIMIT 1", [userId]);
    return (result.rowCount ?? 0) > 0;
  }
}
