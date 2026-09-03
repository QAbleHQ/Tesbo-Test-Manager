"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getIntegrationAuthUrl, getIntegrationStatus, type IntegrationProvider } from "@/lib/api";

// Shared with app/integrations/callback/page.tsx — the only two places that touch this channel.
// BroadcastChannel never crosses origins, so a message here can only come from our own callback
// tab; it is still treated as advisory only (see probeConnected below), never trusted directly.
export const INTEGRATION_OAUTH_CHANNEL = "tesbo:integration-oauth";

export interface IntegrationOAuthMessage {
  provider: IntegrationProvider;
  status: "success";
  ts: number;
}

const CLOSE_POLL_MS = 750;
const BACKSTOP_POLL_MS = 7000;
// Mirrors OAUTH_STATE_TTL_MS in Tesbo-Backend-Nest/src/legacy/legacy.service.ts — waiting past
// this is pointless, the signed state the popup carries will already be rejected server-side.
const WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const UNKNOWN_STATUS_RETRY_MS = 1200;

export type IntegrationOAuthPhase = "idle" | "opening" | "waiting" | "blocked" | "timeout";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// sessionStorage is tab-scoped (survives remounts within a tab, never shared across tabs), so this
// gives every browser tab its own stable suffix for the popup window name below — without it, two
// tabs both connecting the same provider would fight over one shared window name and could
// steal-navigate each other's in-progress popup.
function tabScopedId(): string {
  if (typeof window === "undefined") return "ssr";
  const key = "tesbo:oauth-tab-id";
  try {
    let id = window.sessionStorage.getItem(key);
    if (!id) {
      id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
      window.sessionStorage.setItem(key, id);
    }
    return id;
  } catch {
    // Private browsing / storage blocked — fall back to a per-load id. Loses the same-tab dedup
    // across a full page reload, but never collides with another tab.
    return `${Date.now()}-${Math.random()}`;
  }
}

/**
 * The real source of truth throughout this flow: the DB write already happened via an
 * authenticated backend call from the popup tab, so every signal below (broadcast message,
 * popup-closed, backstop interval) only ever triggers this and acts on its answer — nothing is
 * ever inferred from the popup tab's own state or from a same-origin message payload.
 */
async function probeConnected(provider: IntegrationProvider): Promise<"connected" | "not-connected" | "unknown"> {
  try {
    const status = await getIntegrationStatus(provider);
    return status.connected ? "connected" : "not-connected";
  } catch {
    return "unknown";
  }
}

/**
 * Drives the "Connect <provider>" OAuth flow in a separate tab so the page that triggered it
 * never navigates away — no more trying to route back into the app from a tab whose browser
 * history actually belongs to the OAuth provider.
 *
 * `onConnected` decides what "refresh after success" means for the caller (refetch status,
 * redirect to a pending project mapping, etc).
 */
export function useIntegrationOAuthConnect(provider: IntegrationProvider, onConnected: () => void) {
  const [phase, setPhase] = useState<IntegrationOAuthPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  const popupRef = useRef<Window | null>(null);
  const navigatedRef = useRef(false);
  const settledRef = useRef(false);
  const closeWatcherRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const backstopPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  // Callback identity churns on every render of the caller; read the latest without tearing
  // down/rebuilding the watch loop over it.
  const onConnectedRef = useRef(onConnected);
  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);

  const stopWatching = useCallback(() => {
    if (closeWatcherRef.current) clearInterval(closeWatcherRef.current);
    if (backstopPollRef.current) clearInterval(backstopPollRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    closeWatcherRef.current = null;
    backstopPollRef.current = null;
    timeoutRef.current = null;
    channelRef.current?.close();
    channelRef.current = null;
    // Otherwise a still-open result tab (success settled via broadcast/backstop while the user
    // left it open) would make the next connect() call mistake it for an in-progress flow — via
    // the same-instance reuse check above — and just focus it without arming any new watchers.
    popupRef.current = null;
    navigatedRef.current = false;
  }, []);

  const settleSuccess = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    stopWatching();
    setPhase("idle");
    setError(null);
    onConnectedRef.current();
  }, [stopWatching]);

  // Popup closed without ever confirming a connection — treat as a silent user cancel. The
  // specific failure reason (if any) was already shown in the now-closed tab; no need to repeat
  // it here.
  const settleCancelled = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    stopWatching();
    setPhase("idle");
  }, [stopWatching]);

  const settleTimeout = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    stopWatching();
    setPhase("timeout");
  }, [stopWatching]);

  useEffect(() => stopWatching, [stopWatching]);

  const connect = useCallback(async () => {
    if (phase === "opening" || phase === "waiting") {
      popupRef.current?.focus();
      return;
    }

    setError(null);
    // Named (not "_blank") so a same-instance double-click below reuses/focuses this tab instead
    // of spawning a duplicate. Opened synchronously, before the auth-url fetch, so the browser's
    // popup-blocker heuristic — which only allows window.open within the synchronous user-gesture
    // call stack — doesn't block it just because we awaited first. The tab-scoped suffix keeps two
    // different browser tabs connecting the same provider from colliding on one shared window name
    // (see tabScopedId above) — same-tab dedup below is unaffected since the id is stable per tab.
    const popup = window.open("", `tesbo-oauth-${provider}-${tabScopedId()}`);
    if (!popup) {
      setPhase("blocked");
      return;
    }

    if (popupRef.current === popup && navigatedRef.current && !popup.closed) {
      // Same hook instance, already navigated this exact window — bring it forward instead of
      // re-fetching a new auth-url and yanking an in-progress consent screen out from under it.
      // (This dedup is per hook instance/tab; a different tab gets its own window name via
      // tabScopedId() above, so it can no longer steal-navigate this one.)
      popup.focus();
      setPhase("waiting");
      return;
    }

    popupRef.current = popup;
    navigatedRef.current = false;
    settledRef.current = false;
    setPhase("opening");

    let url: string;
    try {
      ({ url } = await getIntegrationAuthUrl(provider));
    } catch (err) {
      popup.close();
      setError(err instanceof Error ? err.message : `Failed to initiate ${provider} authentication.`);
      setPhase("idle");
      return;
    }

    if (popup.closed) {
      // User closed the blank tab while the auth-url request was in flight.
      setPhase("idle");
      return;
    }

    // Sever the popup's back-reference to us before sending it to a third-party origin, while
    // keeping our own handle — writing .location.href and reading .closed cross-origin both
    // remain permitted after this; only reading the popup's own DOM/location is blocked.
    popup.opener = null;
    popup.location.href = url;
    navigatedRef.current = true;
    setPhase("waiting");

    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(INTEGRATION_OAUTH_CHANNEL);
      channel.onmessage = (event) => {
        const data = event.data as Partial<IntegrationOAuthMessage> | undefined;
        if (!data || data.provider !== provider || data.status !== "success" || settledRef.current) return;
        void probeConnected(provider).then((result) => {
          if (result === "connected") settleSuccess();
        });
      };
      channelRef.current = channel;
    }

    // Backstop only: covers the rare case where the user leaves the result tab open indefinitely
    // and the broadcast above never lands (unsupported/partitioned browser context).
    backstopPollRef.current = setInterval(() => {
      void probeConnected(provider).then((result) => {
        if (result === "connected") settleSuccess();
      });
    }, BACKSTOP_POLL_MS);

    // The actual deadlock breaker: the instant the popup closes, confirm with the backend before
    // deciding anything, rather than trusting whatever the broadcast/backstop cadence happened to
    // catch. Without this, a callback tab that auto-closes within a couple seconds of a real
    // success can race a slow or dropped broadcast and read as a false "cancelled".
    closeWatcherRef.current = setInterval(() => {
      if (!popup.closed) return;
      if (closeWatcherRef.current) clearInterval(closeWatcherRef.current);
      closeWatcherRef.current = null;
      void (async () => {
        let result = await probeConnected(provider);
        if (result === "unknown") {
          await delay(UNKNOWN_STATUS_RETRY_MS);
          result = await probeConnected(provider);
        }
        if (result === "connected") settleSuccess();
        else settleCancelled();
      })();
    }, CLOSE_POLL_MS);

    timeoutRef.current = setTimeout(() => {
      settleTimeout();
      try {
        popup.close();
      } catch {
        // Not ours to force if this fails — the tab still has its own "Close this tab" control.
      }
    }, WAIT_TIMEOUT_MS);
  }, [phase, provider, settleSuccess, settleCancelled, settleTimeout]);

  return { connect, phase, error };
}
