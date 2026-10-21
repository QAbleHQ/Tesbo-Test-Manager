import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException
} from "@nestjs/common";
import { safeFetch } from "../common/safe-fetch";
import { AppConfigService } from "../config/app-config.service";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export interface NyraRequest {
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * NYRA's 422 body echoes the caller's input, which includes the test-account password. Only the `msg`
 * of each error is kept, never `input`, and a raw body is never logged.
 */
export function nyraValidationMessage(detail: unknown): string {
  if (typeof detail === "string" && detail.trim()) return detail.trim().slice(0, 300);
  if (Array.isArray(detail)) {
    const msgs = detail
      .map((d) => (d && typeof d === "object" && typeof d.msg === "string" ? d.msg : ""))
      .filter(Boolean);
    if (msgs.length) return msgs.join("; ").slice(0, 300);
  }
  return "NYRA rejected the project details";
}

/** The only door to NYRA. Server-to-server: the key never leaves this process. */
@Injectable()
export class NyraClient {
  private readonly logger = new Logger(NyraClient.name);

  constructor(private readonly config: AppConfigService) {}

  get configured(): boolean {
    return !!this.config.nyraApiKey && !!this.config.nyraBaseUrl;
  }

  /** The raw upstream response, for callers that stream it. A failure status is already turned into an exception. */
  async fetch(method: string, path: string, opts: NyraRequest = {}): Promise<Response> {
    let res: Response;
    try {
      res = await safeFetch(
        `${this.config.nyraBaseUrl}/api/v1${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${this.config.nyraApiKey}`,
            Accept: "application/json",
            ...(opts.body ? { "Content-Type": "application/json" } : {}),
            ...opts.headers
          },
          ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
          ...(opts.signal ? { signal: opts.signal } : {})
        },
        { timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES }
      );
    } catch (err) {
      this.logger.warn(`NYRA ${method} ${path} failed: ${(err as Error).message}`);
      throw new BadGatewayException({ error: "NYRA is unreachable. Try again later." });
    }
    // 206 and 416 are the answers to a Range request, not failures; 204 is "nothing yet".
    if (res.ok || res.status === 416) return res;
    await this.fail(res, method, path);
    throw new BadGatewayException({ error: "NYRA is unavailable. Try again later." });
  }

  async json(method: string, path: string, opts: NyraRequest = {}): Promise<any> {
    const res = await this.fetch(method, path, opts);
    if (res.status === 204) return null;
    return res.json().catch(() => null);
  }

  /** Never forwards NYRA's body as is: a 422 echoes the submitted password. */
  private async fail(res: Response, method: string, path: string): Promise<never> {
    const payload: any = await res.json().catch(() => null);
    this.logger.warn(`NYRA ${method} ${path} answered ${res.status}`);
    if (res.status === 422) throw new BadRequestException({ error: nyraValidationMessage(payload?.detail) });
    if (res.status === 404) throw new NotFoundException({ error: "Not found in NYRA" });
    if (res.status === 409) throw new ConflictException({ error: "A scan is already running on this environment." });
    if (res.status === 401 || res.status === 403) {
      throw new BadGatewayException({ error: "NYRA rejected this server's API key. Ask an administrator to check NYRA_API_KEY." });
    }
    if (res.status === 429) throw new HttpException({ error: "NYRA is rate limiting requests. Try again in a minute." }, 429);
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new BadGatewayException({ error: "NYRA's API is not running. Check that NYRA is up." });
    }
    throw new BadGatewayException({ error: "NYRA is unavailable. Try again later." });
  }
}
