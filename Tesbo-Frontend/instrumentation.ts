import * as Sentry from "@sentry/nextjs";
import { getSentryRuntimeConfig } from "@/lib/sentry";

export async function register() {
  if (!getSentryRuntimeConfig().enabled) return;

  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Safe when Sentry is not initialized (prod / unset env) — no-ops.
export const onRequestError = Sentry.captureRequestError;
