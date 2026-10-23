import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import { UnsafeOutboundUrlError } from "./safe-fetch";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  // Only needed to phrase the file-too-large message with the actual configured limit.
  constructor(private readonly maxUploadSize?: number) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      // Multer's file-upload limits (FilesInterceptor's `limits` option, used by every
      // knowledge-base/attachment upload route) surface here as ordinary HttpExceptions, but
      // with multer's own raw wording ("File too large", "Unexpected field") — not something a
      // user would recognize as size/count-related. Rephrase those two specifically; every
      // other HttpException (including other multer error codes) passes through unchanged.
      if (typeof body === "object" && body !== null && "message" in body) {
        const message = (body as { message?: unknown }).message;
        if (message === "File too large") {
          const limit = typeof this.maxUploadSize === "number" ? formatBytes(this.maxUploadSize) : "the configured limit";
          response.status(status).json({ error: `This file is too large. Maximum supported size is ${limit}.` });
          return;
        }
        if (message === "Unexpected field") {
          response.status(status).json({ error: "You can upload up to 10 files at a time." });
          return;
        }
      }
      // A 429 from the brute-force limits says when to try again, in the header clients and proxies read.
      if (status === HttpStatus.TOO_MANY_REQUESTS && typeof body === "object" && body !== null) {
        const retryAfter = (body as { retryAfterSeconds?: unknown }).retryAfterSeconds;
        if (typeof retryAfter === "number" && retryAfter > 0) response.setHeader("Retry-After", String(Math.ceil(retryAfter)));
      }
      if (typeof body === "string") {
        response.status(status).json({ error: body });
      } else {
        response.status(status).json(body);
      }
      return;
    }
    const payloadError = exception as { type?: string; status?: number; limit?: number } | null;
    if (payloadError?.type === "entity.too.large") {
      const limit = typeof payloadError.limit === "number" ? formatBytes(payloadError.limit) : "the configured limit";
      response
        .status(HttpStatus.PAYLOAD_TOO_LARGE)
        .json({ error: `This request is too large. Maximum supported size is ${limit}.` });
      return;
    }
    // A saved AI provider URL that the server now refuses to call (a key saved before the check existed,
    // or a name re-pointed since). A caller error to fix in settings, not a server fault.
    if (exception instanceof UnsafeOutboundUrlError) {
      response.status(HttpStatus.BAD_REQUEST).json({ error: `AI provider base URL not allowed: ${exception.message}`, code: "ai_base_url_blocked" });
      return;
    }
    console.error("Unhandled exception:", exception);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: "Internal server error" });
  }
}
