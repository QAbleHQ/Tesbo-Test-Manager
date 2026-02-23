"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { requestOtp } from "@/lib/api";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirect = searchParams.get("redirect");
  const inviteEmail = searchParams.get("inviteEmail")?.trim().toLowerCase() || "";
  const isInviteEmailLocked = Boolean(inviteEmail);
  const [email, setEmail] = useState(inviteEmail);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const emailToUse = (isInviteEmailLocked ? inviteEmail : email).trim().toLowerCase();
    if (!emailToUse) {
      setError("Email is required");
      return;
    }
    setLoading(true);
    try {
      await requestOtp(emailToUse);
      const qp = new URLSearchParams({ email: emailToUse });
      if (redirect) qp.set("redirect", redirect);
      if (isInviteEmailLocked) {
        qp.set("inviteEmail", inviteEmail);
        qp.set("lockEmail", "1");
      }
      router.push(`/verify-otp?${qp.toString()}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed. You may be rate limited.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--background)] dark:bg-zinc-950 px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-[var(--foreground)] dark:text-zinc-100">BetterCases</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">Sign in with your email</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-[var(--muted)] dark:text-zinc-300 mb-1">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-lg border border-[var(--border)] dark:border-zinc-600 bg-[var(--surface)] dark:bg-zinc-900 px-3 py-2 text-[var(--foreground)] dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
              disabled={loading || isInviteEmailLocked}
            />
            {isInviteEmailLocked && (
              <p className="mt-1 text-xs text-zinc-500">
                This invitation can only be accepted with this email address.
              </p>
            )}
          </div>
          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-[var(--primary)] text-white py-2 px-4 font-medium hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "Sending…" : "Send login code"}
          </button>
        </form>
        <p className="text-center text-sm text-[var(--muted)]">
          We’ll send a one-time code to your email. No password needed.
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">Loading…</div>}>
      <LoginForm />
    </Suspense>
  );
}
