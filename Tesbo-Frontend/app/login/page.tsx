"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { authMe, getSetupStatus, loginWithPassword, requestOtp } from "@/lib/api";
import {
  clearRedirectAttempts,
  isRedirectBounce,
  noteRedirectAttempt,
  safeRedirectPath,
} from "@/lib/redirect";
import { AuthSplitShell } from "@/components/auth/AuthSplitShell";
import { AuthModeToggle } from "@/components/auth/AuthModeToggle";
import { AuthLoadingScreen } from "@/components/auth/AuthLoadingScreen";
import { Button, Field, FieldError, FieldHint, FieldLabel, Input, PasswordInput } from "@/components/ui";
import { validateEmailValue } from "@/lib/validation";

function unreachableDestinationMessage(target: string): string {
  return `Signed in, but we could not open ${target}. Sign in again to continue.`;
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Sanitised once, here, so every consumer below — the mount-time redirect, the password path and
  // the OTP hand-off — inherits the same guarantee that this is a path on our own origin.
  const redirect = safeRedirectPath(searchParams.get("redirect"));
  const inviteEmail = searchParams.get("inviteEmail")?.trim().toLowerCase() || "";
  const passwordChanged = searchParams.get("passwordChanged") === "1";
  const isInviteEmailLocked = Boolean(inviteEmail);
  const [email, setEmail] = useState(inviteEmail);
  const [password, setPassword] = useState("");
  const [otpMode, setOtpMode] = useState(Boolean(inviteEmail));
  const [checkingSetup, setCheckingSetup] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");

  /*
   * One decision per mount. React re-invokes effects in development, and without this the second
   * pass would read the marker the first pass had just written and mistake our own attempt for a
   * bounce — refusing to redirect anyone who signs in with `next dev` running.
   */
  const decided = useRef(false);
  // The destination of a redirect we have asked for but not yet observed leaving for. Also selects
  // which message the deadline below reports, since "we never got you there" and "the auth check
  // never answered" are different problems to the person reading it.
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);

  useEffect(() => {
    if (decided.current) return;
    decided.current = true;
    getSetupStatus()
      .then((status) => {
        if (status.required) {
          router.replace("/setup");
          return undefined;
        }
        return authMe();
      })
      .then((me) => {
        if (!me) {
          // Signed out for real, so whatever bounce may have brought the user here is over.
          clearRedirectAttempts();
          setCheckingSetup(false);
          return;
        }
        /*
         * The invite page sends a signed-in user here to switch accounts — "Sign in with
         * {invite.email}" — without signing them out first, because /login is what owns that. The
         * still-active session is for the *wrong* account by definition of the user having clicked
         * that link, so auto-redirecting back to the invite page would only bounce again and, on
         * the way, misreport a normal account switch as "we could not open" the destination. This
         * visit's whole purpose is the form below, not a redirect.
         */
        if (isInviteEmailLocked && me.email && me.email.trim().toLowerCase() !== inviteEmail) {
          clearRedirectAttempts();
          setCheckingSetup(false);
          return;
        }
        const target = redirect || "/projects";
        /*
         * Arriving back with a session still intact means the destination refused us. Redirecting
         * again would refuse us again, so stop and hand the user the form: the redirect below never
         * cleared `checkingSetup`, so a destination that bounced left them on "Loading..."
         * indefinitely with no form, no error and nothing to act on.
         */
        if (isRedirectBounce(target)) {
          clearRedirectAttempts();
          setError(unreachableDestinationMessage(target));
          setCheckingSetup(false);
          return;
        }
        noteRedirectAttempt(target);
        setPendingTarget(target);
        router.replace(target);
      })
      .catch(() => setCheckingSetup(false));
  }, [router, redirect]);

  /*
   * A deadline on the loading screen, so it is never a terminal state.
   *
   * The marker check above only gets a chance to run if this component is mounted again, and that
   * turns out not to be guaranteed: when the destination's RSC request answers with a redirect back
   * to /login, the router re-renders this same page instance rather than remounting it, so the
   * effect never re-runs and nothing above ever concludes anything. The reported session got the
   * harder version of the same shape — nothing resolved, and the loading screen was all there was.
   *
   * So the deadline, not the marker, is what actually guarantees the user reaches the form. Two
   * lengths because the two failures are not equally patient: a redirect we have already asked for
   * has either committed in a couple of seconds or is not going to, while an auth check still in
   * flight deserves longer before we give up on it. Either way the timer is cancelled the moment
   * something else resolves, and a navigation that does commit unmounts this before it can land.
   */
  useEffect(() => {
    if (!checkingSetup) return;
    const timer = setTimeout(() => {
      // Handled — so the marker has done its job and must not outlive it, or the next visit in this
      // tab would be refused a redirect it never attempted.
      clearRedirectAttempts();
      setError(
        pendingTarget
          ? unreachableDestinationMessage(pendingTarget)
          : "Signing you in is taking longer than expected. Sign in again to continue.",
      );
      setCheckingSetup(false);
    }, pendingTarget ? 2_500 : 6_000);
    return () => clearTimeout(timer);
  }, [checkingSetup, pendingTarget]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setEmailError("");
    setPasswordError("");
    // A deliberate sign-in starts the redirect budget over: the user is asking to be sent onward
    // again, and a marker left by an earlier bounce must not pre-empt that.
    clearRedirectAttempts();
    const emailToUse = (isInviteEmailLocked ? inviteEmail : email).trim().toLowerCase();
    // The invite-locked email came from the server, not this field, so there is nothing for the
    // user to correct here even if it were somehow malformed — only validate what they can edit.
    const emailValidationError = isInviteEmailLocked ? "" : validateEmailValue(emailToUse) || "";
    // Login only needs a non-empty password — full complexity rules (validatePasswordValue) belong
    // to signup/reset, where the password is being *set*. Re-checking them here would reject a
    // correct password on an older account created before a rule was tightened.
    const passwordValidationError = !otpMode && !password.trim() ? "Password is required" : "";
    if (emailValidationError || passwordValidationError) {
      setEmailError(emailValidationError);
      setPasswordError(passwordValidationError);
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
    return <AuthLoadingScreen />;
  }

  return (
    <AuthSplitShell>
      <div className="auth-fade-slide">
        <div className="mb-1 text-[22px] font-bold tracking-tight text-[var(--foreground)]">Welcome back</div>
        <p className="mb-7 text-[13px] text-[var(--muted)]">
          {otpMode ? "Sign in with a one-time code" : "Sign in to your workspace"}
        </p>

        {passwordChanged && (
          <p className="mb-5 rounded-lg border border-[var(--success)] bg-[var(--success-soft)] px-3 py-2 text-[13px] text-[var(--success-foreground)]">
            Password changed. Sign in with your new password.
          </p>
        )}

        {!isInviteEmailLocked && (
          <AuthModeToggle
            mode={otpMode ? "otp" : "password"}
            onChange={(mode) => setOtpMode(mode === "otp")}
            disabled={loading}
          />
        )}

        {/* noValidate: without it, the browser's own "not a valid email" bubble intercepts
            submit on type="email" before onSubmit ever runs, so our inline message below the
            field never gets a chance to show. */}
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <Field>
            <FieldLabel htmlFor="email">Email *</FieldLabel>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => {
                const value = e.target.value;
                setEmail(value);
                if (emailError && !validateEmailValue(value)) setEmailError("");
              }}
              placeholder="you@company.com"
              disabled={loading || isInviteEmailLocked}
              aria-invalid={Boolean(emailError)}
            />
            {emailError && <FieldError>{emailError}</FieldError>}
            {isInviteEmailLocked && (
              <FieldHint>This invitation can only be accepted with this email address.</FieldHint>
            )}
          </Field>

          {!otpMode && (
            <Field>
              <div className="flex items-center justify-between">
                <FieldLabel htmlFor="password">Password *</FieldLabel>
                <Link href="/forgot-password" className="text-xs font-medium text-[var(--brand-primary)] hover:underline">
                  Forgot password?
                </Link>
              </div>
              <PasswordInput
                id="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => {
                  const value = e.target.value;
                  setPassword(value);
                  if (passwordError && value.trim()) setPasswordError("");
                }}
                placeholder="Your password"
                disabled={loading}
                aria-invalid={Boolean(passwordError)}
              />
              {passwordError && <FieldError>{passwordError}</FieldError>}
              <FieldHint>Use the password created during initial setup.</FieldHint>
            </Field>
          )}

          {otpMode && <FieldHint>We&apos;ll send a one-time code to your email address.</FieldHint>}

          {error && <FieldError>{error}</FieldError>}

          <Button
            type="submit"
            disabled={loading}
            fullWidth
            style={{ background: "linear-gradient(135deg, var(--cta-primary), var(--denim-200))" }}
          >
            {loading ? (otpMode ? "Sending..." : "Signing in...") : otpMode ? "Send login code" : "Sign in"}
          </Button>
        </form>

        {!isInviteEmailLocked && (
          <p className="mt-6 text-center text-[13px] text-[var(--muted)]">
            Don&apos;t have an account?{" "}
            <Link href="/signup" className="font-medium text-[var(--accent-light)] hover:underline">
              Sign up
            </Link>
          </p>
        )}

        <p className="mt-6 text-center text-xs text-[var(--muted-soft)]">
          <Link href="/privacy-policy" className="hover:underline">
            Privacy Policy
          </Link>{" "}
          ·{" "}
          <Link href="/terms-and-conditions" className="hover:underline">
            Terms and Conditions
          </Link>
        </p>
      </div>
    </AuthSplitShell>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<AuthLoadingScreen />}>
      <LoginForm />
    </Suspense>
  );
}
