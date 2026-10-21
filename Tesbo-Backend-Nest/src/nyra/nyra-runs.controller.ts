import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { AuthenticatedRequest } from "../common/request.types";
import { NyraRunsService } from "./nyra-runs.service";
import { NyraService } from "./nyra.service";

// Under /api/projects/:projectId so the global ProjectWriteLockGuard also covers the POSTs (a project
// locked read-only after a downgrade cannot start scans). Every route first proves the NYRA project
// was created from THIS Tesbo project; see NyraService.requireLinked.
@Controller("/api/projects/:projectId/agents/nyra/projects/:nyraId")
export class NyraRunsController {
  constructor(
    private readonly nyra: NyraService,
    private readonly runs: NyraRunsService
  ) {}

  @Get()
  project(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("nyraId") nyraId: string) {
    return this.nyra.detail(req.userId, projectId, nyraId);
  }

  @Patch("/environments/:envId")
  updateEnvironment(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("nyraId") nyraId: string,
    @Param("envId") envId: string,
    @Body() body: Record<string, any>
  ) {
    return this.nyra.updateEnvironment(req.userId, projectId, nyraId, envId, body);
  }

  @Get("/runs")
  list(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("nyraId") nyraId: string) {
    return this.runs.listRuns(req.userId, projectId, nyraId);
  }

  @Post("/runs")
  start(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("nyraId") nyraId: string, @Body() body: Record<string, any>) {
    return this.runs.startRun(req.userId, projectId, nyraId, body);
  }

  @Get("/runs/:runId")
  run(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("nyraId") nyraId: string, @Param("runId") runId: string) {
    return this.runs.getRun(req.userId, projectId, nyraId, runId);
  }

  @Post("/runs/:runId/stop")
  @HttpCode(202)
  stop(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("nyraId") nyraId: string, @Param("runId") runId: string) {
    return this.runs.stopRun(req.userId, projectId, nyraId, runId);
  }

  @Get("/runs/:runId/items")
  items(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("nyraId") nyraId: string, @Param("runId") runId: string) {
    return this.runs.items(req.userId, projectId, nyraId, runId);
  }

  @Get("/runs/:runId/recordings")
  recordings(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("nyraId") nyraId: string, @Param("runId") runId: string) {
    return this.runs.recordings(req.userId, projectId, nyraId, runId);
  }

  @Get("/runs/:runId/live.jpg")
  live(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("nyraId") nyraId: string, @Param("runId") runId: string, @Res() res: Response) {
    return this.runs.liveFrame(req.userId, projectId, nyraId, runId, res);
  }

  @Get("/runs/:runId/files/:kind/:name")
  file(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("nyraId") nyraId: string,
    @Param("runId") runId: string,
    @Param("kind") kind: string,
    @Param("name") name: string,
    @Res() res: Response
  ) {
    return this.runs.file(req.userId, projectId, nyraId, runId, kind, name, req, res);
  }

  @Get("/runs/:runId/export/:file")
  export(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("nyraId") nyraId: string,
    @Param("runId") runId: string,
    @Param("file") file: string,
    @Res() res: Response
  ) {
    return this.runs.export(req.userId, projectId, nyraId, runId, file, res);
  }

  @Get("/runs/:runId/events")
  events(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("nyraId") nyraId: string, @Param("runId") runId: string, @Res() res: Response) {
    return this.runs.events(req.userId, projectId, nyraId, runId, req, res);
  }
}
