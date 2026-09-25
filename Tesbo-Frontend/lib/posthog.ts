/**
 * PostHog product analytics — enable only when NEXT_PUBLIC_POSTHOG_KEY is set.
 * Production (app.tesbo.io): set key + host in .env.
 * Stage/local: leave blank so PostHog never initializes.
 *
 * Intentionally identifies logged-in Tesbo users with their real email (not masked)
 * so Persons / Activity show who used the product.
 */

import posthog from "posthog-js";

export function getPostHogConfig():
  | { enabled: false }
  | { enabled: true; key: string; host: string } {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim() ?? "";
  if (!key) return { enabled: false };

  const host =
    process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || "https://us.i.posthog.com";

  return { enabled: true, key, host };
}

export function isPostHogEnabled(): boolean {
  return getPostHogConfig().enabled;
}

/** Bind the browser session to the Tesbo account — email is stored in plain form on purpose. */
export function identifyTesboUser(user: {
  userId: string;
  email: string | null;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): void {
  if (!isPostHogEnabled() || typeof window === "undefined") return;
  if (!user.userId) return;

  const email = user.email?.trim() || undefined;
  const name =
    user.name?.trim() ||
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
    undefined;

  posthog.identify(user.userId, {
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
  });

  if (email) {
    posthog.people.set({ email, ...(name ? { name } : {}) });
  }
}

export function resetTesboUser(): void {
  if (!isPostHogEnabled() || typeof window === "undefined") return;
  posthog.reset();
}

export function captureTesboEvent(
  event: string,
  properties?: Record<string, string | number | boolean | null | undefined>
): void {
  if (!isPostHogEnabled() || typeof window === "undefined") return;
  posthog.capture(event, properties);
}
