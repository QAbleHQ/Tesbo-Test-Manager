import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { SetupController } from "./setup.controller";
import { SetupService } from "./setup.service";

@Module({
  imports: [AuthModule],
  controllers: [SetupController],
  providers: [SetupService]
})
export class SetupModule {}
