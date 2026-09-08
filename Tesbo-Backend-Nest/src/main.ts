import "reflect-metadata";

// Must run before AppModule (or anything it transitively imports) is loaded: several classes
// read process.env in a `static readonly` field initializer, which evaluates the moment the
// module is imported — well before AppConfigService's own dotenv.config() call would otherwise
// run during Nest's DI instantiation. Without this, those fields silently fall back to their
// hardcoded defaults, ignoring whatever the .env file actually says (e.g. MAX_UPLOAD_SIZE).
import * as dotenv from "dotenv";
import { existsSync } from "fs";
import { join } from "path";
const earlyEnvPath = [join(process.cwd(), ".env"), join(process.cwd(), "backend", ".env")].find(existsSync);
if (earlyEnvPath) dotenv.config({ path: earlyEnvPath });

import { startLangfuse, stopLangfuse } from "./observability/langfuse";

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import compression from "compression";
import cookieParser from "cookie-parser";
import { randomUUID } from "crypto";
import { json, urlencoded } from "express";
import type { Request, Response, NextFunction } from "express";
import { AppModule } from "./app.module";
import { AppConfigService } from "./config/app-config.service";
import { EmailDeliveryPolicy } from "./config/email-delivery.policy";
import { HttpExceptionFilter } from "./common/http-exception.filter";
import { assertEncryptionKeyConfigured } from "./common/crypto.util";
import type { AuthenticatedRequest } from "./common/request.types";

async function bootstrap() {
  assertEncryptionKeyConfigured();
  // bodyParser disabled here so we can raise the limit above Nest's 100kb default (see maxRequestBodySize below)
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { cors: false, bodyParser: false });
  const config = app.get(AppConfigService);

  // Trust the immediate reverse proxy (nginx, see deploy/nginx) so req.ip reflects the
  // real client from X-Forwarded-For instead of the proxy's own address — used for the
  // OTP rate limiter and for detecting the buyer's country at checkout (billing module).
  app.set("trust proxy", 1);

  // Compress responses before anything writes to them. JSON is the bulk of what this API returns
  // and compresses roughly ten to one — the activity feed alone was going out at 54KB raw.
  //
  // Left on the default `compressible` filter deliberately: it compresses text/JSON/CSV and skips
  // content types that are already compressed (application/zip for the knowledge-base folder export,
  // xlsx, and image attachments), so the binary download routes keep passing bytes through untouched.
  // Nothing here sets Content-Length by hand, which is what would otherwise break under compression.
  //
  // Safe to sit in front of every route, including the one SSE endpoint this API now has (Zyra
  // chat progress narration, GET .../turns/:turnId/events — see zyra-progress.service.ts): Nest's
  // built-in SSE response writer (@nestjs/core/router/sse-stream.js) already sends
  // `Cache-Control: ...no-transform`, which this filter's own no-transform check (line 296 of
  // compression/index.js) honours by skipping compression for that response — no extra
  // configuration needed here. The turn's actual answer (the POST response) is plain JSON and
  // compresses normally like everything else.
  app.use(compression());

  app.use(
    json({
      limit: config.maxRequestBodySize,
      // Stripe webhook signatures are verified against the exact bytes received, which the
      // JSON parser below would otherwise discard after parsing — stash them for BillingController.
      verify: (req, _res, buf) => {
        (req as AuthenticatedRequest).rawBody = buf;
      }
    })
  );
  app.use(urlencoded({ extended: true, limit: config.maxRequestBodySize }));
  app.use(cookieParser());
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Request-Id", randomUUID());
    const forwardedProto = req.header("x-forwarded-proto");
    const secure = req.secure || forwardedProto?.trim().toLowerCase() === "https";
    if (secure) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  app.enableCors({
    origin(origin, callback) {
      if (!origin) return callback(null, false);
      const normalized = config.normalizeCorsOrigin(origin);
      callback(null, config.corsAllowedOrigins.has(normalized));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept", "Accept-Language", "X-Request-Id"],
    exposedHeaders: ["X-Total-Count"],
    maxAge: 86400
  });

  app.useGlobalFilters(new HttpExceptionFilter(config.maxUploadSize));

  // Before listen(), so the first request of the process is already traced. Never throws and
  // never blocks meaningfully: with no keys configured it returns immediately without a network
  // call, and any failure inside logs and leaves tracing off.
  await startLangfuse();

  await app.listen(config.port, "0.0.0.0");

  // Set after listen(), which is when the underlying http.Server exists. See
  // AppConfigService.httpKeepAliveTimeoutMs for why Node's 5s default is not survivable behind a
  // keep-alive client.
  const httpServer = app.getHttpServer() as import("http").Server;
  httpServer.keepAliveTimeout = config.httpKeepAliveTimeoutMs;
  httpServer.headersTimeout = config.httpHeadersTimeoutMs;
  console.log(`Nest backend running on http://localhost:${config.port}`);

  // Announced on every boot so "will this stack email real people?" is answerable from the logs
  // alone, and so the e2e suite can assert it is running against a stack that cannot. Deliberately
  // after listen() and not awaited: it makes one call to Postmark, which must never delay startup.
  void app
    .get(EmailDeliveryPolicy)
    .describe()
    .then(({ mode, server, reach }) =>
      console.log(`[email] delivery mode=${mode} postmark_server=${server} reach=${reach}`)
    );

  // Spans batch in memory, so without an explicit flush every container restart loses the last
  // few seconds of traces — and a restart is exactly when the interesting trace exists. Both
  // signals are handled because compose stop sends SIGTERM and Ctrl-C sends SIGINT.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void (async () => {
        await stopLangfuse();
        await app.close().catch(() => undefined);
        process.exit(0);
      })();
    });
  }
}

void bootstrap();
