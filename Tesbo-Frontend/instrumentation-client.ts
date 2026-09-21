import * as Sentry from "@sentry/nextjs";
import posthog from "posthog-js";
import { getPostHogConfig } from "@/lib/posthog";
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

// PostHog: only when NEXT_PUBLIC_POSTHOG_KEY is set (typically production app.tesbo.io).
// Email is NOT masked — identify() attaches the real Tesbo login email so Persons show who used the app.
const posthogConfig = getPostHogConfig();
if (posthogConfig.enabled) {
  posthog.init(posthogConfig.key, {
    api_host: posthogConfig.host,
    defaults: "2026-05-30",
    capture_pageview: true,
    capture_pageleave: true,
    person_profiles: "identified_only",
    session_recording: {
      // Keep password fields private; do not blanket-mask text so emails stay readable in replays.
      maskAllInputs: false,
      maskInputOptions: { password: true },
    },
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
