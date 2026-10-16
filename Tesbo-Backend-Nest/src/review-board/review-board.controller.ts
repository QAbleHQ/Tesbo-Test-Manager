import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { AuthenticatedRequest } from "../common/request.types";
import { ReviewBoardService } from "./review-board.service";

// Under /api/projects/:projectId so the global ProjectWriteLockGuard also covers every POST here
// (a project locked read-only after a downgrade cannot start analyses or apply review decisions).
@Controller("/api/projects/:projectId/review-board")
export class ReviewBoardController {
  constructor(private readonly reviewBoard: ReviewBoardService) {}

  @Get("/analysis")
  latestAnalysis(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.reviewBoard.getLatestAnalysis(req.userId, projectId);
  }

  @Post("/analysis")
  @HttpCode(202)
  startAnalysis(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.reviewBoard.startAnalysis(req.userId, projectId);
  }

  @Get("/recommendations")
  list(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Query() query: { status?: string; limit?: string; offset?: string }
  ) {
    return this.reviewBoard.listRecommendations(req.userId, projectId, query);
  }

  @Get("/history")
  history(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Query() query: { limit?: string; offset?: string }) {
    return this.reviewBoard.listHistory(req.userId, projectId, query);
  }

  @Post("/recommendations/:recommendationId/keep")
  @HttpCode(200)
  keep(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("recommendationId") recommendationId: string) {
    return this.reviewBoard.keep(req.userId, projectId, recommendationId);
  }

  @Post("/recommendations/:recommendationId/edit")
  @HttpCode(200)
  edit(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("recommendationId") recommendationId: string,
    @Body() body: Record<string, any>
  ) {
    return this.reviewBoard.edit(req.userId, projectId, recommendationId, body);
  }

  @Post("/recommendations/:recommendationId/remove")
  @HttpCode(200)
  remove(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("recommendationId") recommendationId: string,
    @Body() body: Record<string, any>
  ) {
    return this.reviewBoard.remove(req.userId, projectId, recommendationId, body);
  }
}
