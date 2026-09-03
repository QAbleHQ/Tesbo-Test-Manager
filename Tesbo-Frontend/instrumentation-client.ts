import * as Sentry from "@sentry/nextjs";
import { getSentryRuntimeConfig, shouldSendClientEvent } from "@/lib/sentry";

const config = getSentryRuntimeConfig();

if (config.enabled) {
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    // Performance / which route was slow or failed
    tracesSampleRate: 1.0,
    // Stage-only: record every session + always attach replay when an error happens
    replaysSessionSampleRate: 1.0,
    replaysOnErrorSampleRate: 1.0,
    integrations: [
      Sentry.replayIntegration({
        // Stage debugging: show UI so you can see which page / state broke.
        // Form field values stay masked (OTP, passwords, tokens).
        maskAllText: false,
        blockAllMedia: false,
        maskAllInputs: true,
      }),
    ],
    beforeSend(event) {
      if (typeof window !== "undefined" && !shouldSendClientEvent(window.location.hostname)) {
        return null;
      }
      // Always attach current page URL for quick triage
      const url = typeof window !== "undefined" ? window.location.href : undefined;
      if (url) {
        event.tags = { ...event.tags, page_url: url };
      }
      return event;
    },
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
