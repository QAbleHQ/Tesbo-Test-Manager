import { Injectable } from "@nestjs/common";
import * as dotenv from "dotenv";
import { existsSync } from "fs";
import { join } from "path";

@Injectable()
export class AppConfigService {
  private readonly env = this.loadEnv();

  readonly port = this.integer("PORT", 7000);
  readonly databaseUrl = this.normalizeDatabaseUrl(this.string("DATABASE_URL", "postgresql://localhost:5432/tesbo"));
  readonly databaseUser = this.optionalString("DATABASE_USER");
  readonly databasePassword = this.optionalString("DATABASE_PASSWORD");
  // Connections this instance may hold. Budget it as poolMax x instances against the server's
  // max_connections (100 by default) — the ceiling is shared, not per process.
  readonly databasePoolMax = this.integer("DB_POOL_MAX", 20);
  // Server-side cap on a single statement. Without it one pathological query (an unbounded report on
  // a large workspace) holds its connection indefinitely, and enough of them stall the whole instance
  // because nothing fails fast enough to shed load. Postgres cancels the query and the client sees an
  // error, so the connection returns to the pool either way. 0 disables it.
  readonly databaseStatementTimeoutMs = this.integer("DB_STATEMENT_TIMEOUT_MS", 30_000);
  // How long a caller waits for a free connection before erroring rather than queueing forever.
  readonly databaseConnectionTimeoutMs = this.integer("DB_CONNECTION_TIMEOUT_MS", 10_000);
  readonly databaseIdleTimeoutMs = this.integer("DB_IDLE_TIMEOUT_MS", 30_000);
  // Guards the transaction() helper: if its callback hangs between BEGIN and COMMIT, the connection
  // is held with an open transaction, which also pins vacuum. 0 disables it.
  readonly databaseIdleInTransactionTimeoutMs = this.integer("DB_IDLE_IN_TRANSACTION_TIMEOUT_MS", 60_000);
  /*
   * How long an idle keep-alive connection is held open, and how long headers may take to arrive.
   *
   * Node defaults these to 5s and 60s. 5s is shorter than any keep-alive client upstream of us
   * holds a pooled socket for — nginx (deploy/nginx) reuses upstream connections for 60s by
   * default, and so does every server-side HTTP agent that talks to this API — so the server would
   * send FIN on a socket the client still believed was good, and a request written into that socket
   * came back as ECONNRESET / "socket hang up" rather than as any HTTP status. It surfaces as an
   * intermittent transport fault on whichever request happened to follow a pause, which reads like a
   * network problem and is not one.
   *
   * The rule is that this must exceed the idle timeout of everything that connects to us, and that
   * headersTimeout must in turn exceed this one (Node enforces the ordering: a headersTimeout below
   * keepAliveTimeout closes connections mid-request).
   */
  readonly httpKeepAliveTimeoutMs = this.integer("HTTP_KEEP_ALIVE_TIMEOUT_MS", 65_000);
  readonly httpHeadersTimeoutMs = this.integer("HTTP_HEADERS_TIMEOUT_MS", 70_000);
  readonly redisUrl = this.string("REDIS_URL", "redis://localhost:6379");
  readonly postmarkApiToken = this.string("POSTMARK_API_TOKEN", "");
  readonly postmarkFromEmail = this.string("POSTMARK_FROM_EMAIL", "noreply@example.com");
  // "live" delivers mail for real and is what PRODUCTION must set. Anything else — including an
  // unset or misspelled value — means "log", which never emails an OTP and only posts the remaining
  // communication emails when Postmark confirms the token belongs to a non-delivering Sandbox
  // server. The default is the safe one on purpose: a forgotten setting has to fail towards "no mail
  // sent", never towards "the e2e suite emailed a thousand invented addresses". See
  // config/email-delivery.policy.ts for the full decision table.
  readonly emailDeliveryMode: "live" | "log" =
    this.string("EMAIL_DELIVERY_MODE", "log").trim().toLowerCase() === "live" ? "live" : "log";
  readonly otpExpiryMinutes = this.integer("OTP_EXPIRY_MINUTES", 10);
  readonly sessionDays = this.integer("SESSION_DAYS", 30);
  readonly sessionCookieName = "tesbo_session";
  readonly corsAllowedOrigins = this.parseCorsAllowedOrigins();
  readonly frontendUrl = this.string("FRONTEND_URL", "http://localhost:1010");
  readonly uploadDir = this.string("UPLOAD_DIR", "./uploads");
  readonly maxUploadSize = this.integer("MAX_UPLOAD_SIZE", 10485760);
  // Applies to JSON/urlencoded request bodies (e.g. knowledge base document saves), not file uploads
  readonly maxRequestBodySize = this.integer("MAX_REQUEST_BODY_SIZE", 20 * 1024 * 1024);
  // Object storage: defaults to local disk (uploadDir above). Set STORAGE_DRIVER=s3 to use
  // any S3-compatible service (AWS S3, MinIO, Cloudflare R2, DigitalOcean Spaces, etc).
  readonly storageDriver = this.string("STORAGE_DRIVER", "local").toLowerCase() === "s3" ? "s3" : "local";
  readonly s3Bucket = this.optionalString("S3_BUCKET");
  // Optional key prefix so multiple environments (local/staging/prod) can share one bucket
  // without colliding, e.g. "local/knowledge-base/<organizationId>/<projectId>/<uuid>.<ext>".
  readonly s3BucketFolder = this.optionalString("S3_BUCKET_FOLDER");
  readonly s3Region = this.string("S3_REGION", "us-east-1");
  readonly s3Endpoint = this.optionalString("S3_ENDPOINT") || undefined;
  readonly s3AccessKeyId = this.optionalString("S3_ACCESS_KEY_ID") || undefined;
  readonly s3SecretAccessKey = this.optionalString("S3_SECRET_ACCESS_KEY") || undefined;
  readonly s3ForcePathStyle = this.string("S3_FORCE_PATH_STYLE", "false").toLowerCase() === "true";
  readonly s3PresignedUrlTtlSeconds = this.integer("S3_PRESIGNED_URL_TTL_SECONDS", 300);
  readonly stripeSecretKey = this.optionalString("STRIPE_SECRET_KEY");
  readonly stripeWebhookSecret = this.optionalString("STRIPE_WEBHOOK_SECRET");
  readonly stripePriceIdProMonthly = this.optionalString("STRIPE_PRICE_ID_PRO_MONTHLY");
  readonly stripePriceIdProAnnual = this.optionalString("STRIPE_PRICE_ID_PRO_ANNUAL");
  // India-registered Stripe accounts can't charge Indian-issued cards in a non-INR
  // currency (RBI cross-border rule) — these are the INR equivalents of the two prices
  // above, charged instead when the buyer is detected as being in India.
  readonly stripePriceIdProMonthlyInr = this.optionalString("STRIPE_PRICE_ID_PRO_MONTHLY_INR");
  readonly stripePriceIdProAnnualInr = this.optionalString("STRIPE_PRICE_ID_PRO_ANNUAL_INR");
  /**
   * Billing/Stripe is optional. Empty STRIPE_SECRET_KEY → checkout/portal/webhooks stay off and
   * plan-limit gating is skipped so the rest of the app is unaffected. Set the secret (and price
   * IDs) in .env to turn Cloud billing back on.
   */
  readonly isStripeBillingEnabled = Boolean(this.stripeSecretKey?.trim());
  // Forces the detected country (e.g. "IN") for every request. Local stacks and staging see only
  // private IPs, which can't be geolocated, so without this the India price list is untestable.
  // Must stay unset in production — it would hand INR pricing to every visitor.
  readonly billingForceCountry = this.optionalString("BILLING_FORCE_COUNTRY");
  // Only enable when an edge that OVERWRITES client-supplied country headers (Cloudflare,
  // CloudFront, Vercel, Fastly) fronts the app. Otherwise a caller can forge cf-ipcountry: IN
  // and buy the India price list from anywhere.
  readonly trustProxyCountryHeader = this.string("TRUST_PROXY_COUNTRY_HEADER", "false").toLowerCase() === "true";
  // Days of full Pro-level access a workspace keeps after its subscription ends, before Launch
  // limits are enforced for real. 0 disables the grace window (immediate enforcement).
  readonly planGraceDays = this.integer("PLAN_GRACE_DAYS", 30);
  // Where "need more storage?" and other billing dead-ends point people.
  readonly supportContactEmail = this.string("SUPPORT_CONTACT_EMAIL", "support@tryqable.com");

  private loadEnv(): Record<string, string | undefined> {
    const dotenvPath = this.findDotEnvPath();
    const parsed = dotenvPath ? dotenv.config({ path: dotenvPath }).parsed ?? {} : {};
    return { ...process.env, ...parsed };
  }

  normalizeCorsOrigin(raw?: string | null): string {
    if (!raw) return "";
    let origin = raw.trim();
    if (origin.charCodeAt(0) === 0xfeff) origin = origin.slice(1).trim();
    while (origin.endsWith("/")) origin = origin.slice(0, -1).trim();
    return origin;
  }

  private parseCorsAllowedOrigins(): Set<string> {
    const defaults = [
      "http://localhost:1010",
      "http://localhost:3000",
      "http://localhost:3001",
      "http://127.0.0.1:1010",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:3001",
      "https://frontdoor.tesbo.io",
      "https://automate.tesbo.io",
      "https://exe.tesbo.io",
      "https://backdoor.tesbo.io"
    ].join(",");
    const csv = this.string("CORS_ALLOWED_ORIGINS", defaults).trim() || defaults;
    return new Set(
      csv
        .split(",")
        .map((value) => this.normalizeCorsOrigin(value))
        .filter(Boolean)
    );
  }

  private normalizeDatabaseUrl(raw: string): string {
    const value = raw.trim();
    if (value.startsWith("jdbc:postgresql://")) return value.slice("jdbc:".length);
    if (value.startsWith("jdbc:postgres://")) return value.slice("jdbc:".length);
    return value;
  }

  private string(key: string, defaultValue: string): string {
    return this.env?.[key] ?? process.env[key] ?? defaultValue;
  }

  private optionalString(key: string): string {
    return (this.env?.[key] ?? process.env[key] ?? "").trim();
  }

  private integer(key: string, defaultValue: number): number {
    const value = this.env?.[key] ?? process.env[key];
    if (value == null || value.trim() === "") return defaultValue;
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return defaultValue;
    return parsed;
  }

  private findDotEnvPath(): string | null {
    const candidates = [join(process.cwd(), ".env"), join(process.cwd(), "backend", ".env")];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  }
}
