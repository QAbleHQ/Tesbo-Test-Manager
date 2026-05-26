import { Module } from "@nestjs/common";
import { ConfigModule } from "./config/config.module";
import { DatabaseModule } from "./database/database.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { SetupModule } from "./setup/setup.module";
import { HealthModule } from "./health/health.module";
import { AdminModule } from "./admin/admin.module";
import { LegacyModule } from "./legacy/legacy.module";

@Module({
  imports: [ConfigModule, DatabaseModule, AuditModule, AuthModule, SetupModule, HealthModule, AdminModule, LegacyModule]
})
export class AppModule {}
