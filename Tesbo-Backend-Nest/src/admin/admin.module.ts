import { Module } from "@nestjs/common";
import { AdminHealthController } from "./admin-health.controller";
import { SuperAdminService } from "./super-admin.service";

@Module({
  controllers: [AdminHealthController],
  providers: [SuperAdminService],
  exports: [SuperAdminService]
})
export class AdminModule {}
