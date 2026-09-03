import * as Sentry from "@sentry/nextjs";
import { getSentryRuntimeConfig, shouldSendClientEvent } from "@/lib/sentry";

const config = getSentryRuntimeConfig();

if (config.enabled) {
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    tracesSampleRate: 0.2,
    // Drop anything that somehow runs on production host
    beforeSend(event) {
      if (typeof window !== "undefined" && !shouldSendClientEvent(window.location.hostname)) {
        return null;
      }
      return event;
    },
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
