"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { requestOtp } from "@/lib/api";
import { Button, Field, FieldError, FieldHint, FieldLabel, Input } from "@/components/ui";

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
    <div className="min-h-screen flex items-center justify-center bg-[var(--background)] px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <Image
            src="/tesbox-logo-transparent.png"
            alt="TesboX"
            width={280}
            height={80}
            priority
            className="mx-auto h-14 w-auto"
          />
          <p className="mt-1 text-sm text-[var(--muted)]">Sign in with your email</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={loading || isInviteEmailLocked}
            />
            {isInviteEmailLocked && (
              <FieldHint>
                This invitation can only be accepted with this email address.
              </FieldHint>
            )}
          </Field>
          {error && <FieldError>{error}</FieldError>}
          <Button
            type="submit"
            disabled={loading}
            fullWidth
          >
            {loading ? "Sending…" : "Send login code"}
          </Button>
        </form>
        <p className="text-center text-sm text-[var(--muted)]">
          We’ll send a one-time code to your email. No password needed.
        </p>
        <p className="text-center text-xs text-[var(--muted-soft)]">
          <Link href="/privacy-policy" className="hover:underline">
            Privacy Policy
          </Link>{" "}
          ·{" "}
          <Link href="/terms-and-conditions" className="hover:underline">
            Terms and Conditions
          </Link>
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
