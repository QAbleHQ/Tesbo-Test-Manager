"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { getSentryRuntimeConfig } from "@/lib/sentry";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    if (getSentryRuntimeConfig().enabled) {
      Sentry.captureException(error);
    }
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          fontFamily: "system-ui, sans-serif",
          background: "#0b0f14",
          color: "#e8eef7",
        }}
      >
        <div style={{ textAlign: "center", padding: "2rem" }}>
          <h1 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>Something went wrong</h1>
          <p style={{ opacity: 0.7, marginBottom: "1.25rem" }}>
            An unexpected error occurred. Please refresh and try again.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              border: "1px solid #3a4656",
              background: "#151b24",
              color: "#e8eef7",
              borderRadius: "8px",
              padding: "0.6rem 1rem",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
