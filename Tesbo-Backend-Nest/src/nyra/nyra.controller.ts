import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import { AuthenticatedRequest } from "../common/request.types";
import { NyraService } from "./nyra.service";

// Under /api/projects/:projectId so the global ProjectWriteLockGuard also covers the POST (a project
// locked read-only after a downgrade cannot create NYRA projects).
@Controller("/api/projects/:projectId/agents/nyra")
export class NyraController {
  constructor(private readonly nyra: NyraService) {}

  @Get()
  state(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.nyra.state(req.userId, projectId);
  }

  @Get("/projects")
  list(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.nyra.list(req.userId, projectId);
  }

  @Post("/projects")
  create(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.nyra.create(req.userId, projectId, body);
  }
}
