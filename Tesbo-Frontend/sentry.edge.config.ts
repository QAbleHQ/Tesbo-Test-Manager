import * as Sentry from "@sentry/nextjs";
import { getSentryRuntimeConfig } from "@/lib/sentry";

const config = getSentryRuntimeConfig();

if (config.enabled) {
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    tracesSampleRate: 0.1,
  });
}
