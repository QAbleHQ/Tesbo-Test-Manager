"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { verifyOtp } from "@/lib/api";
import { Button, Field, FieldError, FieldHint, FieldLabel, Input } from "@/components/ui";

function VerifyOtpForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const emailParam = searchParams.get("email") ?? "";
  const inviteEmail = searchParams.get("inviteEmail")?.trim().toLowerCase() || "";
  const isInviteEmailLocked = searchParams.get("lockEmail") === "1" && Boolean(inviteEmail);
  const redirectParam = searchParams.get("redirect");
  const [email, setEmail] = useState(inviteEmail || emailParam);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const emailToUse = (isInviteEmailLocked ? inviteEmail : email).trim().toLowerCase();
    if (!emailToUse || !code.trim()) {
      setError("Email and code are required");
      return;
    }
    setLoading(true);
    try {
      await verifyOtp(emailToUse, code.trim());
      router.push(redirectParam || "/onboarding");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid or expired code");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--background)] px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">Check your email</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">Enter the code we sent to your inbox</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading || isInviteEmailLocked}
            />
            {isInviteEmailLocked && (
              <FieldHint>
                This invitation can only be accepted with this email address.
              </FieldHint>
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor="code">Code</FieldLabel>
            <Input
              id="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              className="text-center text-lg tracking-widest"
              maxLength={6}
              disabled={loading}
            />
          </Field>
          {error && <FieldError>{error}</FieldError>}
          <Button
            type="submit"
            disabled={loading}
            fullWidth
          >
            {loading ? "Verifying…" : "Verify and sign in"}
          </Button>
        </form>
        <p className="text-center text-sm text-[var(--muted)]">
          <Link href="/login" className="text-[var(--brand-primary)] hover:underline">Use a different email</Link>
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
