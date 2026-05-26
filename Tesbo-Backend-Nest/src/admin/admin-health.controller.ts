import { Controller, Get, Req, UnauthorizedException } from "@nestjs/common";
import { AuthenticatedRequest } from "../common/request.types";
import { DatabaseService } from "../database/database.service";
import { AppConfigService } from "../config/app-config.service";
import { SuperAdminService } from "./super-admin.service";

@Controller("/api/admin/system")
export class AdminHealthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfigService,
    private readonly superAdmin: SuperAdminService
  ) {}

  @Get("/health")
  async check(@Req() req: AuthenticatedRequest) {
    if (!req.userId || !(await this.superAdmin.isPlatformAdmin(req.userId))) {
      throw new UnauthorizedException("Not authenticated");
    }
    const services: Record<string, Record<string, unknown>> = {};
    const started = Date.now();
    try {
      const migration = await this.db.query<{ id: string | null }>(
        'SELECT id FROM databasechangelog ORDER BY dateexecuted DESC, orderexecuted DESC LIMIT 1'
      );
      services.database = {
        status: "ok",
        latency_ms: Date.now() - started,
        latest_migration: migration.rows[0]?.id ?? null
      };
    } catch (error) {
      services.database = { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
    services.email = {
      status: this.config.postmarkApiToken ? "configured" : "not_configured",
      provider: "postmark"
    };
    return {
      status: Object.values(services).some((service) => service.status === "error") ? "degraded" : "ok",
      timestamp: new Date().toISOString(),
      services
    };
  }
}
