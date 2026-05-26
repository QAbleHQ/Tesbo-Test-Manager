import { Body, Controller, Get, Post, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { AuthenticatedRequest } from "../common/request.types";
import { SetupService } from "./setup.service";

type FirstAdminBody = {
  email?: string;
  password?: string;
  orgName?: string;
  demoData?: boolean;
};

@Controller("/api/setup")
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Get("/status")
  async status() {
    return { required: await this.setup.setupRequired() };
  }

  @Post("/first-admin")
  createFirstAdmin(@Body() body: FirstAdminBody, @Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    return this.setup.createFirstAdmin(body, req, res);
  }
}
