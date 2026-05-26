import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import { randomUUID } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { AppModule } from "./app.module";
import { AppConfigService } from "./config/app-config.service";
import { HttpExceptionFilter } from "./common/http-exception.filter";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: false });
  const config = app.get(AppConfigService);

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
    maxAge: 86400
  });

  app.useGlobalFilters(new HttpExceptionFilter());
  await app.listen(config.port, "0.0.0.0");
  console.log(`Nest backend running on http://localhost:${config.port}`);
}

void bootstrap();
