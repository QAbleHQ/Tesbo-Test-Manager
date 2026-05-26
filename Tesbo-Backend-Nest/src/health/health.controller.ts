import { Controller, Get } from "@nestjs/common";

@Controller()
export class HealthController {
  @Get("/health")
  health() {
    return { status: "ok" };
  }

  @Get("/api/health")
  apiHealth() {
    return { status: "ok" };
  }
}
