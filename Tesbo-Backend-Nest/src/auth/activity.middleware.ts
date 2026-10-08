import { Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Response } from "express";
import { AuthenticatedRequest } from "../common/request.types";
import { UserActivityService } from "./user-activity.service";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// /api/auth/* is sign-in, sign-out and password flows: not product activity (the report's own
// definition of engaged is "an activity without login").
const NOT_ACTIVITY = /^\/api\/auth(\/|$)/;

/**
 * Counts a user-initiated mutation as activity for the daily report. Runs after AuthMiddleware.
 *
 * Only mutations: reads are polled by the frontend (Zyra tasks, runs), so counting GETs would mark
 * every idle open tab as engaged. Only successful ones (status < 400): a rejected or invalid request
 * did not do anything. API-token (MCP) calls count, as the token owner acting through an agent.
 */
@Injectable()
export class ActivityMiddleware implements NestMiddleware {
  constructor(private readonly activity: UserActivityService) {}

  use(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    const userId = req.userId;
    if (userId && MUTATING.has(req.method) && !NOT_ACTIVITY.test(req.originalUrl.split("?")[0])) {
      res.once("finish", () => {
        if (res.statusCode < 400) void this.activity.recordMutation(userId);
      });
    }
    next();
  }
}
