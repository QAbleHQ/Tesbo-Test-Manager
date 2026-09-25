import { Body, Controller, Delete, Get, Param, Post, Req } from "@nestjs/common";
import { AuthenticatedRequest } from "../common/request.types";
import { CustomTagsService } from "./custom-tags.service";

@Controller()
export class CustomTagsController {
  constructor(private readonly customTags: CustomTagsService) {}

  @Get("/api/projects/:projectId/custom-tags")
  listTags(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.customTags.listTags(req.userId, projectId);
  }

  @Post("/api/projects/:projectId/custom-tags")
  createTag(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.customTags.createTag(req.userId, projectId, body);
  }

  @Delete("/api/projects/:projectId/custom-tags/:tagId")
  deleteTag(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("tagId") tagId: string) {
    return this.customTags.deleteTag(req.userId, projectId, tagId);
  }

  @Get("/api/projects/:projectId/testcases/:testcaseId/tags")
  getTagsForTestCase(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("testcaseId") testcaseId: string) {
    return this.customTags.getTagsForTestCase(req.userId, projectId, testcaseId);
  }
}
