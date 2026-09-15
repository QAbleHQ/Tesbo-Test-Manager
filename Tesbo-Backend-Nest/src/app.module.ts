import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { PlanLimitsModule } from "./plan-limits/plan-limits.module";
import { ProjectWriteLockGuard } from "./plan-limits/project-write-lock.guard";
import { ConfigModule } from "./config/config.module";
import { AppConfigService } from "./config/app-config.service";
import { DatabaseModule } from "./database/database.module";
import { RequestCacheModule } from "./request-cache/request-cache.module";
import { RedisCacheModule } from "./cache/redis-cache.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { SetupModule } from "./setup/setup.module";
import { HealthModule } from "./health/health.module";
import { AdminModule } from "./admin/admin.module";
import { LegacyModule } from "./legacy/legacy.module";
import { McpModule } from "./mcp/mcp.module";
import { BillingModule } from "./billing/billing.module";
import { CustomFieldsModule } from "./custom-fields/custom-fields.module";
import { AutomationModule } from "./automation/automation.module";
import { ZyraArchiveSweepModule } from "./zyra-archive-sweep/zyra-archive-sweep.module";

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    RequestCacheModule,
    RedisCacheModule,
    BullModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({ connection: { url: config.redisUrl } })
    }),
    AuditModule,
    AuthModule,
    SetupModule,
    HealthModule,
    AdminModule,
    LegacyModule,
    McpModule,
    BillingModule,
    CustomFieldsModule,
    PlanLimitsModule,
    AutomationModule,
    ZyraArchiveSweepModule
  ],
  // Global so every current and future mutating /api/projects/:id route is covered; the guard
  // itself no-ops on reads and on workspaces that are within their limits.
  providers: [{ provide: APP_GUARD, useClass: ProjectWriteLockGuard }]
})
export class AppModule {}
