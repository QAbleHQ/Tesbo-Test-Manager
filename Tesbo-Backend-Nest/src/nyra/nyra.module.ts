import { Module } from "@nestjs/common";
import { LegacyModule } from "../legacy/legacy.module";
import { PlanLimitsModule } from "../plan-limits/plan-limits.module";
import { NyraClient } from "./nyra.client";
import { NyraController } from "./nyra.controller";
import { NyraRunsController } from "./nyra-runs.controller";
import { NyraReviewService } from "./nyra-review.service";
import { NyraRunsService } from "./nyra-runs.service";
import { NyraService } from "./nyra.service";

@Module({
  imports: [LegacyModule, PlanLimitsModule],
  controllers: [NyraController, NyraRunsController],
  providers: [NyraClient, NyraService, NyraReviewService, NyraRunsService]
})
export class NyraModule {}
