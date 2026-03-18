"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, Suspense } from "react";
import { jiraCallback } from "@/lib/api";

function CallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    const code = searchParams.get("code");
    const state = searchParams.get("state"); // projectId
    const error = searchParams.get("error");

    if (error) {
      setStatus("error");
      setErrorMsg("Jira authorization was denied or failed.");
      return;
    }

    if (!code || !state) {
      setStatus("error");
      setErrorMsg("Missing authorization code or project context.");
      return;
    }

    jiraCallback(state, code)
      .then(() => {
        setStatus("success");
        // Redirect to Jira project selection page
        router.replace(`/projects/${state}/settings/integrations/jira`);
      })
      .catch((err) => {
        setStatus("error");
        setErrorMsg(err?.message || "Failed to complete Jira authentication.");
      });
  }, [searchParams, router]);

  return (
    <main className="min-h-screen flex items-center justify-center bg-[var(--background)]">
      <div className="max-w-md w-full mx-auto px-6 py-12 text-center">
        {status === "loading" && (
          <>
            <div className="mx-auto w-10 h-10 rounded-full border-2 border-[var(--brand-primary)] border-t-transparent animate-spin" />
            <h1 className="mt-4 text-lg font-semibold text-[var(--foreground)]">
              Connecting to Jira…
            </h1>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Please wait while we complete the authentication.
            </p>
          </>
        )}
        {status === "success" && (
          <>
            <div className="mx-auto w-10 h-10 rounded-full bg-green-100 flex items-center justify-center">
              <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h1 className="mt-4 text-lg font-semibold text-[var(--foreground)]">
              Jira Connected!
            </h1>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Redirecting to project selection…
            </p>
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
            <button
              onClick={() => router.back()}
              className="mt-4 rounded-lg bg-[var(--surface-secondary)] px-4 py-2 text-sm font-medium text-[var(--muted)] hover:bg-[var(--surface-tertiary)]"
            >
              Go Back
            </button>
          </>
        )}
      </div>
    </main>
  );
}

export default function JiraCallbackPage() {
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
