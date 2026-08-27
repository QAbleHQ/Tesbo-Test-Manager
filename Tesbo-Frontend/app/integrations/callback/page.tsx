"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, Suspense, type ReactNode } from "react";
import { integrationCallback, getIntegrationAuthUrl, type IntegrationProvider } from "@/lib/api";
import { INTEGRATION_OAUTH_CHANNEL, type IntegrationOAuthMessage } from "@/lib/useIntegrationOAuthConnect";

const PROVIDER_LABELS: Record<IntegrationProvider, string> = { jira: "Jira", linear: "Linear" };

// Same brand marks used in components/settings/IntegrationsTab.tsx, kept local here since this
// page is meant to be a disposable, self-contained OAuth landing tab.
const PROVIDER_ICONS: Record<IntegrationProvider, ReactNode> = {
  jira: (
    <svg viewBox="0 0 24 24" className="h-6 w-6 text-white" fill="currentColor">
      <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53ZM6.77 6.8a4.362 4.362 0 0 0 4.34 4.34h1.8v1.72a4.362 4.362 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.84-.84H6.77ZM2 11.6c0 2.4 1.95 4.34 4.35 4.35h1.78v1.71c0 2.4 1.95 4.35 4.35 4.35V12.44a.84.84 0 0 0-.84-.84H2Z" />
    </svg>
  ),
  linear: (
    <svg viewBox="0 0 24 24" className="h-6 w-6 text-white" fill="currentColor">
      <path d="M2.28 15.36 8.64 21.7c-3.14-.55-5.79-3.2-6.36-6.34Zm-.27-2.06L14.7 22c.34.02.68.02 1.02 0L1.99 8.98c-.02.34-.02.68.02 1.02Zm.5-3.14L15.84 21.5a10.9 10.9 0 0 0 1.87-1.1L3.6 6.29a10.9 10.9 0 0 0-1.09 1.87Zm1.9-2.98L18.82 18.5a11 11 0 0 0 1.28-1.55L5.06 5.9a11 11 0 0 0-1.55 1.28Zm2.71-2.2L21.02 15.87A11 11 0 0 0 22 1.98L8.12 1a11 11 0 0 0-1.9 1.98Z" />
    </svg>
  ),
};

const AUTO_CLOSE_DELAY_MS = 3000;
const CLOSE_CONFIRM_DELAY_MS = 400;

function broadcastSuccess(provider: IntegrationProvider) {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(INTEGRATION_OAUTH_CHANNEL);
  const message: IntegrationOAuthMessage = { provider, status: "success", ts: Date.now() };
  channel.postMessage(message);
  channel.close();
}

function CallbackHandler() {
  const searchParams = useSearchParams();
  const code = searchParams.get("code");
  const oauthError = searchParams.get("error");
  // Signed state, shaped `<provider>.<payload>.<signature>`. Only the leading provider segment is
  // read here — to pick the endpoint — and the whole value goes back for the backend to verify.
  const state = searchParams.get("state") || "";
  const head = state.split(".")[0];
  const provider = head === "jira" || head === "linear" ? head : null;
  const providerLabel = provider ? PROVIDER_LABELS[provider] : "the app";

  // Failures visible straight from the query string need no round trip, so they stay derived rather
  // than being pushed into state from inside the effect.
  const upfrontError = oauthError
    ? "Authorization was denied or failed."
    : !code || !provider
      ? "Missing authorization code or integration context."
      : null;

  const [exchange, setExchange] = useState<{ status: "loading" | "success" | "error"; errorMsg: string }>({
    status: "loading",
    errorMsg: "",
  });
  const [closeFailed, setCloseFailed] = useState(false);
  // Authorization codes are single-use. Without this guard, a dev-mode Strict Mode double-invoke
  // (or any other double-mount) would fire a second POST with an already-burned code and turn a
  // working exchange into a spurious failure.
  const exchangedRef = useRef(false);

  useEffect(() => {
    if (upfrontError || !code || !provider) return;
    if (exchangedRef.current) return;
    exchangedRef.current = true;
    integrationCallback(provider, code, state)
      .then(() => {
        setExchange({ status: "success", errorMsg: "" });
        broadcastSuccess(provider);
      })
      .catch((err) => {
        setExchange({ status: "error", errorMsg: err?.message || "Failed to complete authentication." });
      });
  }, [upfrontError, code, provider, state]);

  const status = upfrontError ? "error" : exchange.status;
  const errorMsg = upfrontError || exchange.errorMsg;

  function attemptClose() {
    try {
      window.close();
    } catch {
      // Fall through to the timeout check below.
    }
    // window.close() is fire-and-forget with no synchronous success signal. If it actually
    // closed the tab, this document is torn down and the callback below never runs; if we're
    // still here after a beat, the browser refused (e.g. this tab wasn't opened by a script —
    // a reload or a direct/bookmarked visit to this URL).
    window.setTimeout(() => setCloseFailed(true), CLOSE_CONFIRM_DELAY_MS);
  }

  useEffect(() => {
    if (status !== "success") return;
    const t = window.setTimeout(attemptClose, AUTO_CLOSE_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [status]);

  async function handleTryAgain() {
    if (!provider) return;
    try {
      const { url } = await getIntegrationAuthUrl(provider);
      window.location.href = url;
    } catch (err) {
      setExchange({
        status: "error",
        errorMsg: err instanceof Error ? err.message : "Failed to restart authentication.",
      });
    }
  }

  const fallbackHref = provider ? `/settings/integrations/${provider}` : "/settings?tab=integrations";

  return (
    <main className="min-h-screen flex items-center justify-center bg-[var(--background)] px-6">
      <div className="max-w-sm w-full mx-auto text-center">
        {status === "loading" && (
          <>
            <div className="mx-auto w-10 h-10 rounded-full border-2 border-[var(--brand-primary)] border-t-transparent animate-spin" />
            <h1 className="mt-4 text-lg font-semibold text-[var(--foreground)]">
              Connecting to {providerLabel}…
            </h1>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Please wait while we complete the authentication.
            </p>
          </>
        )}

        {status === "success" && (
          <>
            <div className="mx-auto flex items-center justify-center gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--brand-primary)]">
                {provider ? PROVIDER_ICONS[provider] : null}
              </span>
              <svg className="h-5 w-5 text-[var(--success)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h1 className="mt-4 text-lg font-semibold text-[var(--foreground)]">
              {providerLabel} connected to Tesbo
            </h1>
            <p className="mt-2 text-sm text-[var(--muted)]">
              {closeFailed
                ? "You can close this tab now and return to your Tesbo tab."
                : "This tab will close automatically — your Tesbo tab has already picked this up."}
            </p>
            <button
              type="button"
              onClick={attemptClose}
              className="mt-5 inline-flex h-10 items-center justify-center rounded-[10px] bg-[var(--brand-primary)] px-4 text-sm font-semibold text-white shadow-sm hover:bg-[var(--brand-hover)]"
            >
              Return to Tesbo
            </button>
            {closeFailed && (
              <Link href={fallbackHref} className="mt-3 block text-sm text-[var(--accent-light)] hover:underline">
                Go to Tesbo
              </Link>
            )}
          </>
        )}

        {status === "error" && (
          <>
            <div className="mx-auto w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
              <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h1 className="mt-4 text-lg font-semibold text-[var(--foreground)]">
              Connection Failed
            </h1>
            <p className="mt-2 text-sm text-red-600">{errorMsg}</p>
            <div className="mt-4 flex items-center justify-center gap-2">
              {provider && (
                <button
                  type="button"
                  onClick={handleTryAgain}
                  className="rounded-lg bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--brand-hover)]"
                >
                  Try Again
                </button>
              )}
              <button
                type="button"
                onClick={attemptClose}
                className="rounded-lg bg-[var(--surface-secondary)] px-4 py-2 text-sm font-medium text-[var(--muted)] hover:bg-[var(--surface-tertiary)]"
              >
                Close this tab
              </button>
            </div>
            {closeFailed && (
              <Link href={fallbackHref} className="mt-3 block text-sm text-[var(--accent-light)] hover:underline">
                Go to Tesbo
              </Link>
            )}
          </>
        )}
      </div>
    </main>
  );
}

export default function IntegrationsCallbackPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen flex items-center justify-center">
          <p className="text-[var(--muted)]">Loading…</p>
        </main>
      }
    >
      <CallbackHandler />
    </Suspense>
  );
}
