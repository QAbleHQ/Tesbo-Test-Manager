import path from "path";
import { fileURLToPath } from "url";
import { withSentryConfig } from "@sentry/nextjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import("next").NextConfig} */
const nextConfig = {
  // Repo root has a lockfile but no `next`; pin Turbopack root so `next` resolves.
  turbopack: {
    root: __dirname,
  },
};

// Source maps upload is opt-in via SENTRY_AUTH_TOKEN on stage CI only.
// without an auth token we still wrap for webpack instrumentation but skip uploads.
const sentryWebpackPluginOptions = {
  org: "qable",
  // Must match Sentry project slug (renamed from javascript-nextjs)
  project: "app-tesbo-stage",
  silent: true,
  disableLogger: true,
  widenClientFileUpload: true,
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
  },
  authToken: process.env.SENTRY_AUTH_TOKEN,
};

export default withSentryConfig(nextConfig, sentryWebpackPluginOptions);
