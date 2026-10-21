import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UploadedFiles,
  UseInterceptors
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import type { AuthenticatedRequest } from "../common/request.types";
import { LegacyService } from "../legacy/legacy.service";
import { AutomationService } from "./automation.service";

/** Evidence files accepted in one upload call: a screenshot, a video and a trace per test, plus room. */
const MAX_EVIDENCE_FILES_PER_CALL = 10;

/**
 * Automation ingest — HTTP transport. Basecamp 10189985971 §6.
 *
 * **Why these paths and not the card's `/api/v1/runs/...`.** `ProjectWriteLockGuard` is registered
 * as a global APP_GUARD but matches only `^/api/projects/<uuid>(/.*)?$`, so mounting this surface
 * anywhere else would silently exempt automation from the plan read-only lock that every other
 * write path obeys — a behaviour decision made by accident of routing. Under
 * `/api/projects/:projectId/automation/...` a downgraded workspace refuses automation writes for
 * the same reason it refuses a manual edit, and the project is in the URL rather than the body so
 * the guard and the token scope check below can both see it.
 *
 * **Auth.** Either a browser session (a member of the project) or a project-scoped API bearer
 * token, resolved by AuthMiddleware. When a token is used it must be scoped to the project on the
 * URL and carry the right scope for the method — enforced here because
 * `LegacyService.requireProjectAccess` authorizes the token's *user*, who may belong to several
 * projects, so on its own it would let a token issued for project A write to project B. McpService
 * makes the same check for the same reason. AuthMiddleware now also refuses, before any controller,
 * a token on another project or outside the allowlist in auth/api-token-policy.ts, so this check is
 * the second of two rather than the only one; it stays because this controller owns its scope rules
 * (a POST here can be a read).
 */
@Controller()
export class AutomationController {
  constructor(private readonly automation: AutomationService) {}

  /**
   * Rejects a token that is not scoped to this project, or that lacks the scope this call needs.
   *
   * A session caller passes through untouched — `requireProjectAccess` in the service is what
   * authorizes them, exactly as it does everywhere else in the API.
   */
  private assertTokenScope(req: AuthenticatedRequest, projectId: string, required: "read" | "write") {
    const token = req.apiToken;
    if (!token) {
      // No token: either a browser session (fine, the service authorizes it) or nothing at all
      // (the service's requireUser answers that).
      if (!req.userId) {
        throw new UnauthorizedException({
          error: "Automation requires a project API token (Authorization: Bearer tsbo_...) or a signed-in session"
        });
      }
      return;
    }
    if (!token.projectId) {
      throw new ForbiddenException({ error: "This API token is not scoped to a project" });
    }
    if (token.projectId !== projectId) {
      throw new ForbiddenException({ error: "This API token is not scoped to this project" });
    }
    if (!token.scopes?.includes(required)) {
      throw new ForbiddenException({
        error: `This call requires the "${required}" scope; the token has [${token.scopes?.join(", ") || "none"}]`
      });
    }
  }

  /**
   * Validates the case ids in a suite against the project, at test-collection time.
   *
   * Card §3: a typo in a `tesbo.testId()` tag should fail fast on the developer's machine, not
   * silently not report hours later. POST rather than GET because a suite can carry hundreds of
   * ids, which do not belong in a query string — with the consequence that on a plan-locked
   * project this is refused by the write-lock guard along with everything else, which is the
   * honest answer: the run that would follow could not be created either.
   */
  @Post("/api/projects/:projectId/automation/cases/resolve")
  resolveCases(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    this.assertTokenScope(req, projectId, "read");
    return this.automation.resolveCaseIds(req.userId, projectId, body || {});
  }

  @Post("/api/projects/:projectId/automation/runs")
  createRun(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    this.assertTokenScope(req, projectId, "write");
    return this.automation.createRun(req.userId, projectId, body || {});
  }

  @Get("/api/projects/:projectId/automation/runs/:runId")
  getRun(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("runId") runId: string) {
    this.assertTokenScope(req, projectId, "read");
    return this.automation.getRun(req.userId, projectId, runId);
  }

  @Post("/api/projects/:projectId/automation/runs/:runId/results")
  recordResult(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
    @Body() body: Record<string, any>
  ) {
    this.assertTokenScope(req, projectId, "write");
    return this.automation.recordResult(req.userId, projectId, runId, body || {});
  }

  /**
   * Evidence for one result.
   *
   * The interceptor's `fileSize` limit is the same per-file ceiling the service re-checks, because
   * multer enforces it mid-stream and reports it without a field-level reason — the service's check
   * is what produces a message naming the file and the limit.
   */
  @Post("/api/projects/:projectId/automation/runs/:runId/results/:caseId/evidence")
  @UseInterceptors(
    FilesInterceptor("files", MAX_EVIDENCE_FILES_PER_CALL, { limits: { fileSize: LegacyService.EVIDENCE_MAX_FILE_SIZE } })
  )
  uploadEvidence(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
    @Param("caseId") caseId: string,
    @Body() body: Record<string, any>,
    @UploadedFiles() files: Array<{ buffer: Buffer; originalname: string; mimetype: string; size: number }>
  ) {
    this.assertTokenScope(req, projectId, "write");
    return this.automation.uploadEvidence(req.userId, projectId, runId, caseId, body?.kind, files);
  }

  @Patch("/api/projects/:projectId/automation/runs/:runId/close")
  closeRun(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
    @Body() body: Record<string, any>
  ) {
    this.assertTokenScope(req, projectId, "write");
    return this.automation.closeRun(req.userId, projectId, runId, body || {});
  }
}
