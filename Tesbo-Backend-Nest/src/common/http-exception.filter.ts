import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Response } from "express";

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === "string") {
        response.status(status).json({ error: body });
      } else {
        response.status(status).json(body);
      }
      return;
    }
    console.error("Unhandled exception:", exception);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: "Internal server error" });
  }
}
