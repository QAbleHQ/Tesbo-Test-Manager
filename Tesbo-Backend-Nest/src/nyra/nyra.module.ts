import { Module } from "@nestjs/common";
import { LegacyModule } from "../legacy/legacy.module";
import { PlanLimitsModule } from "../plan-limits/plan-limits.module";
import { NyraController } from "./nyra.controller";
import { NyraService } from "./nyra.service";

@Module({
  imports: [LegacyModule, PlanLimitsModule],
  controllers: [NyraController],
  providers: [NyraService]
})
export class NyraModule {}
