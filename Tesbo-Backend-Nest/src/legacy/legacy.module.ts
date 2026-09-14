import { forwardRef, Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { StorageModule } from "../storage/storage.module";
import { RagModule } from "../rag/rag.module";
import { IntegrationSyncModule } from "../integration-sync/integration-sync.module";
import { PlanLimitsModule } from "../plan-limits/plan-limits.module";
import { CustomFieldsModule } from "../custom-fields/custom-fields.module";
import { LegacyController } from "./legacy.controller";
import { LegacyService } from "./legacy.service";
import { SignupController } from "./signup.controller";
import { SignupService } from "./signup.service";
import { ZyraProgressService } from "./zyra-progress.service";
import { KbExtractionRunnerService } from "./kb-extraction-runner.service";

@Module({
  imports: [AuthModule, StorageModule, RagModule, IntegrationSyncModule, PlanLimitsModule, forwardRef(() => CustomFieldsModule)],
  controllers: [LegacyController, SignupController],
  providers: [LegacyService, SignupService, ZyraProgressService, KbExtractionRunnerService],
  exports: [LegacyService]
})
export class LegacyModule {}
