"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { verifyOtp } from "@/lib/api";

function VerifyOtpForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const emailParam = searchParams.get("email") ?? "";
  const [email, setEmail] = useState(emailParam);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!email.trim() || !code.trim()) {
      setError("Email and code are required");
      return;
    }
    setLoading(true);
    try {
      await verifyOtp(email.trim(), code.trim());
      router.push("/onboarding");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid or expired code");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--background)] dark:bg-zinc-950 px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-[var(--foreground)] dark:text-zinc-100">Check your email</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">Enter the code we sent to your inbox</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-[var(--muted)] dark:text-zinc-300 mb-1">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-[var(--border)] dark:border-zinc-600 bg-[var(--surface)] dark:bg-zinc-900 px-3 py-2 text-[var(--foreground)] dark:text-zinc-100"
              disabled={loading}
            />
          </div>
          <div>
            <label htmlFor="code" className="block text-sm font-medium text-[var(--muted)] dark:text-zinc-300 mb-1">
              Code
            </label>
            <input
              id="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              className="w-full rounded-lg border border-[var(--border)] dark:border-zinc-600 bg-[var(--surface)] dark:bg-zinc-900 px-3 py-2 text-[var(--foreground)] dark:text-zinc-100 text-center text-lg tracking-widest"
              maxLength={6}
              disabled={loading}
            />
          </div>
          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-[var(--primary)] text-white py-2 px-4 font-medium hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "Verifying…" : "Verify and sign in"}
          </button>
        </form>
        <p className="text-center text-sm text-[var(--muted)]">
          <Link href="/login" className="text-[var(--primary)] hover:underline">Use a different email</Link>
        </p>
      </div>
    </div>
  );
}

export default function VerifyOtpPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">Loading…</div>}>
      <VerifyOtpForm />
    </Suspense>
  );
}
