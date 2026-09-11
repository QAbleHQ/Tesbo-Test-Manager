import { Global, Module } from "@nestjs/common";
import { ProjectLookupService } from "./project-lookup.service";
import { RequestCacheService } from "./request-cache.service";

@Global()
@Module({
  providers: [RequestCacheService, ProjectLookupService],
  exports: [RequestCacheService, ProjectLookupService]
})
export class RequestCacheModule {}
