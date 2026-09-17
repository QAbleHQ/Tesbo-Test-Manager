import { Controller, Get } from "@nestjs/common";

// GIT_SHA is set by the deploy pipeline (Jenkinsfile/Jenkinsfile.stage export it from `git
// rev-parse --short HEAD` before `docker compose up`, and docker-compose.yml threads it into the
// backend container's environment). "local" is the honest default everywhere else — local dev,
// e2e, a plain `docker compose up` with no CI involved. Added after a nightly-cron incident where
// two backend instances (one several commits stale) were independently running the same scheduled
// job against the same database with no way to tell them apart short of DB forensics — comparing
// this field across every environment pointed at one DATABASE_URL is the fast version of that check.
const GIT_SHA = process.env.GIT_SHA || "local";

@Controller()
export class HealthController {
  @Get("/health")
  health() {
    return { status: "ok", gitSha: GIT_SHA };
  }

  @Get("/api/health")
  apiHealth() {
    return { status: "ok", gitSha: GIT_SHA };
  }
}
