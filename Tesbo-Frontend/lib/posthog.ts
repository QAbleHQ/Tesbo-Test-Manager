/**
 * PostHog product analytics — enable only when NEXT_PUBLIC_POSTHOG_KEY is set.
 * Production (app.tesbo.io): set key + host in .env.
 * Stage/local: leave blank so PostHog never initializes.
 */

export function getPostHogConfig():
  | { enabled: false }
  | { enabled: true; key: string; host: string } {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim() ?? "";
  if (!key) return { enabled: false };

  const host =
    process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || "https://us.i.posthog.com";

  return { enabled: true, key, host };
}
