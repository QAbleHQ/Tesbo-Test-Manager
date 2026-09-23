import { forwardRef, Module } from "@nestjs/common";
import { LegacyModule } from "../legacy/legacy.module";
import { CustomTagsController } from "./custom-tags.controller";
import { CustomTagsService } from "./custom-tags.service";

@Module({
  imports: [forwardRef(() => LegacyModule)],
  controllers: [CustomTagsController],
  providers: [CustomTagsService],
  exports: [CustomTagsService]
})
export class CustomTagsModule {}
