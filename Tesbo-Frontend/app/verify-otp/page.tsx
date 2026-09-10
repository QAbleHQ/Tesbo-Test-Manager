"use client";

import { Suspense, useState } from "react";
import type { FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { IconMailOpened } from "@tabler/icons-react";
import { authMe, requestOtp, verifyOtp } from "@/lib/api";
import { AuthSplitShell } from "@/components/auth/AuthSplitShell";
import { OtpBoxInput } from "@/components/auth/OtpBoxInput";
import { AuthLoadingScreen } from "@/components/auth/AuthLoadingScreen";
import { Button, FieldError } from "@/components/ui";

function VerifyOtpForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const emailParam = searchParams.get("email") ?? "";
  const inviteEmail = searchParams.get("inviteEmail")?.trim().toLowerCase() || "";
  const isInviteEmailLocked = searchParams.get("lockEmail") === "1" && Boolean(inviteEmail);
  const redirectParam = searchParams.get("redirect");
  const email = isInviteEmailLocked ? inviteEmail : emailParam;
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!email || code.trim().length < 6) {
      setError("Enter the 6-digit code");
      return;
    }
    setLoading(true);
    try {
      await verifyOtp(email, code.trim());
      const destination = redirectParam || "/onboarding";
      // A brand-new account created by this OTP sign-in (OtpService.findOrCreateUser) has no name on
      // file yet — detour through the one-time profile step before continuing on to `destination`.
      const me = await authMe();
      if (me && !me.profileComplete) {
        router.push(`/complete-profile?redirect=${encodeURIComponent(destination)}`);
      } else {
        router.push(destination);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid or expired code");
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (!email || resendState === "sending") return;
    setResendState("sending");
    setError("");
    try {
      await requestOtp(email);
      setCode("");
      setResendState("sent");
      setTimeout(() => setResendState("idle"), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resend code");
      setResendState("idle");
    }
  }

  return (
    <AuthSplitShell>
      <div className="auth-fade-slide text-center">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full border border-[rgba(123,110,224,.3)] bg-[rgba(123,110,224,.15)]">
          <IconMailOpened size={26} stroke={1.5} className="text-[var(--accent-light)]" />
        </div>
        <div className="mb-2 text-[20px] font-bold tracking-tight text-[var(--foreground)]">Check your email</div>
        <p className="mb-7 text-[13px] leading-relaxed text-[var(--muted)]">
          We sent a login code to
          <br />
          <span className="font-medium text-[var(--foreground)]">{email || "your email"}</span>
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          <OtpBoxInput value={code} onChange={setCode} disabled={loading} autoFocus />
          {error && <FieldError>{error}</FieldError>}
          <Button
            type="submit"
            disabled={loading}
            fullWidth
            style={{ background: "linear-gradient(135deg, var(--cta-primary), var(--denim-200))" }}
          >
            {loading ? "Verifying..." : "Verify and sign in"}
          </Button>
        </form>

        <p className="mt-5 text-[13px] text-[var(--muted)]">
          Didn&apos;t get it?{" "}
          <button
            type="button"
            onClick={handleResend}
            disabled={resendState === "sending"}
            className="font-medium text-[var(--accent-light)] hover:underline disabled:cursor-not-allowed disabled:opacity-60"
          >
            {resendState === "sent" ? "Code sent" : resendState === "sending" ? "Sending..." : "Resend code"}
          </button>
        </p>

        {!isInviteEmailLocked && (
          <p className="mt-4 text-sm">
            <Link href="/login" className="text-[var(--accent-light)] hover:underline">
              Use a different email
            </Link>
          </p>
        )}
      </div>
    </AuthSplitShell>
  );
}

export default function VerifyOtpPage() {
  return (
    <Suspense fallback={<AuthLoadingScreen />}>
      <VerifyOtpForm />
    </Suspense>
  );
}
