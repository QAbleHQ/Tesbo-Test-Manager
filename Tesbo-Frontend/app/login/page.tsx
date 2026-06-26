"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { getSetupStatus, loginWithPassword, requestOtp } from "@/lib/api";
import { BrandLogo } from "@/components/BrandLogo";
import { Button, Field, FieldError, FieldHint, FieldLabel, Input } from "@/components/ui";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirect = searchParams.get("redirect");
  const inviteEmail = searchParams.get("inviteEmail")?.trim().toLowerCase() || "";
  const isInviteEmailLocked = Boolean(inviteEmail);
  const [email, setEmail] = useState(inviteEmail);
  const [password, setPassword] = useState("");
  const [otpMode, setOtpMode] = useState(Boolean(inviteEmail));
  const [checkingSetup, setCheckingSetup] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getSetupStatus()
      .then((status) => {
        if (status.required) {
          router.replace("/setup");
          return;
        }
        setCheckingSetup(false);
      })
      .catch(() => setCheckingSetup(false));
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const emailToUse = (isInviteEmailLocked ? inviteEmail : email).trim().toLowerCase();
    if (!emailToUse) {
      setError("Email is required");
      return;
    }
    if (!otpMode && !password) {
      setError("Password is required");
      return;
    }

    setLoading(true);
    try {
      if (otpMode) {
        await requestOtp(emailToUse);
        const qp = new URLSearchParams({ email: emailToUse });
        if (redirect) qp.set("redirect", redirect);
        if (isInviteEmailLocked) {
          qp.set("inviteEmail", inviteEmail);
          qp.set("lockEmail", "1");
        }
        router.push(`/verify-otp?${qp.toString()}`);
      } else {
        await loginWithPassword(emailToUse, password);
        router.push(redirect || "/projects");
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed.");
    } finally {
      setLoading(false);
    }
  }

  if (checkingSetup) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--background)]">
        <p className="text-[var(--muted)]">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--background)] px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <BrandLogo className="mx-auto h-14 max-w-[280px] object-contain" />
          <p className="mt-1 text-sm text-[var(--muted)]">
            {otpMode ? "Sign in with a one-time code" : "Sign in with your admin password"}
          </p>
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
          {!otpMode && (
            <Field>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
                disabled={loading}
              />
            </Field>
          )}
          {error && <FieldError>{error}</FieldError>}
          <Button type="submit" disabled={loading} fullWidth>
            {loading ? (otpMode ? "Sending..." : "Signing in...") : (otpMode ? "Send login code" : "Sign in")}
          </Button>
        </form>
        {!isInviteEmailLocked && (
          <button
            type="button"
            onClick={() => {
              setError("");
              setOtpMode((value) => !value);
            }}
            className="w-full text-center text-sm font-medium text-[var(--brand-primary)] hover:underline"
          >
            {otpMode ? "Sign in with password" : "Use email code instead"}
          </button>
        )}
        <p className="text-center text-sm text-[var(--muted)]">
          {otpMode ? "We will send a one-time code to your email." : "Use the password created during initial setup."}
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
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">Loading...</div>}>
      <LoginForm />
    </Suspense>
  );
}
