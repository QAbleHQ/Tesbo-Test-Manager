"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";
import { requestOtp, startSignup, verifySignup } from "@/lib/api";
import { AuthSplitShell } from "@/components/auth/AuthSplitShell";
import { AuthModeToggle, type AuthMode } from "@/components/auth/AuthModeToggle";
import { OtpBoxInput } from "@/components/auth/OtpBoxInput";
import { Button, Field, FieldError, FieldHint, FieldLabel, Input, PasswordInput } from "@/components/ui";
import {
  EMAIL_MAX_LENGTH,
  SIGNUP_NAME_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_RULES_HINT,
  validateEmailValue,
  validateName,
  validatePasswordValue,
} from "@/lib/validation";

type Step = "form" | "code";

export default function SignupPage() {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>("password");
  const [step, setStep] = useState<Step>("form");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [firstNameError, setFirstNameError] = useState("");
  const [lastNameError, setLastNameError] = useState("");
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [formError, setFormError] = useState("");

  function clearFormErrors() {
    setFirstNameError("");
    setLastNameError("");
    setEmailError("");
    setPasswordError("");
    setFormError("");
  }

  function switchMode(next: AuthMode) {
    setMode(next);
    setStep("form");
    setError("");
    clearFormErrors();
  }

  async function handlePasswordFormSubmit(e: FormEvent) {
    e.preventDefault();
    clearFormErrors();
    // All four are checked together (not stopping at the first) so the user sees every field that
    // needs fixing in one pass instead of one error at a time.
    const firstNameValidationError = validateName(firstName, "First name", SIGNUP_NAME_MAX_LENGTH) || "";
    const lastNameValidationError = validateName(lastName, "Last name", SIGNUP_NAME_MAX_LENGTH) || "";
    const emailValidationError = validateEmailValue(email) || "";
    const passwordValidationError = validatePasswordValue(password) || "";
    if (firstNameValidationError || lastNameValidationError || emailValidationError || passwordValidationError) {
      setFirstNameError(firstNameValidationError);
      setLastNameError(lastNameValidationError);
      setEmailError(emailValidationError);
      setPasswordError(passwordValidationError);
      return;
    }

    setSubmitting(true);
    try {
      await startSignup({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim().toLowerCase(),
        password,
      });
      setStep("code");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to start signup");
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePasswordCodeSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (code.trim().length < 6) {
      setError("Enter the 6-digit code");
      return;
    }
    setSubmitting(true);
    try {
      await verifySignup(email.trim().toLowerCase(), code.trim());
      router.push("/onboarding");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid or expired code");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleOtpSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setEmailError("");
    const emailToUse = email.trim().toLowerCase();
    const emailValidationError = validateEmailValue(emailToUse) || "";
    if (emailValidationError) {
      setEmailError(emailValidationError);
      return;
    }
    setSubmitting(true);
    try {
      await requestOtp(emailToUse);
      const qp = new URLSearchParams({ email: emailToUse, redirect: "/onboarding" });
      router.push(`/verify-otp?${qp.toString()}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send code");
    } finally {
      setSubmitting(false);
    }
  }

  const gradientCta = { background: "linear-gradient(135deg, var(--cta-primary), var(--denim-200))" };

  return (
    <AuthSplitShell>
      <div className="auth-fade-slide">
        {mode === "password" && step === "code" && (
          <button
            type="button"
            onClick={() => {
              setStep("form");
              setError("");
            }}
            className="mb-6 flex items-center gap-1.5 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            <IconArrowLeft size={14} />
            Back
          </button>
        )}

        <div className="mb-1 text-[22px] font-bold tracking-tight text-[var(--foreground)]">
          {mode === "password" && step === "code" ? "Check your email" : "Create account"}
        </div>
        <p className="mb-7 text-[13px] text-[var(--muted)]">
          {mode === "password" && step === "code"
            ? `We sent a code to ${email}`
            : "Start managing your test suite today"}
        </p>

        {step === "form" && <AuthModeToggle mode={mode} onChange={switchMode} disabled={submitting} />}

        {mode === "password" && step === "form" && (
          /* noValidate: without it, the browser's own "not a valid email" bubble intercepts
             submit on type="email" before onSubmit ever runs, so our inline messages below each
             field never get a chance to show. */
          <form onSubmit={handlePasswordFormSubmit} className="space-y-4" noValidate>
            <div className="flex gap-3">
              <Field className="flex-1">
                <FieldLabel htmlFor="signup-first-name">First name *</FieldLabel>
                <Input
                  id="signup-first-name"
                  type="text"
                  value={firstName}
                  onChange={(e) => {
                    const value = e.target.value;
                    setFirstName(value);
                    if (firstNameError && !validateName(value, "First name", SIGNUP_NAME_MAX_LENGTH)) setFirstNameError("");
                  }}
                  placeholder="Jane"
                  disabled={submitting}
                  maxLength={SIGNUP_NAME_MAX_LENGTH}
                  autoFocus
                  aria-invalid={Boolean(firstNameError)}
                />
                {firstNameError && <FieldError>{firstNameError}</FieldError>}
              </Field>
              <Field className="flex-1">
                <FieldLabel htmlFor="signup-last-name">Last name *</FieldLabel>
                <Input
                  id="signup-last-name"
                  type="text"
                  value={lastName}
                  onChange={(e) => {
                    const value = e.target.value;
                    setLastName(value);
                    if (lastNameError && !validateName(value, "Last name", SIGNUP_NAME_MAX_LENGTH)) setLastNameError("");
                  }}
                  placeholder="Smith"
                  disabled={submitting}
                  maxLength={SIGNUP_NAME_MAX_LENGTH}
                />
                {lastNameError && <FieldError>{lastNameError}</FieldError>}
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="signup-email">Work email *</FieldLabel>
              <Input
                id="signup-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => {
                  const value = e.target.value;
                  setEmail(value);
                  if (emailError && !validateEmailValue(value)) setEmailError("");
                }}
                placeholder="you@company.com"
                disabled={submitting}
                maxLength={EMAIL_MAX_LENGTH}
                aria-invalid={Boolean(emailError)}
              />
              {emailError && <FieldError>{emailError}</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor="signup-password">Password *</FieldLabel>
              <PasswordInput
                id="signup-password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => {
                  const value = e.target.value;
                  setPassword(value);
                  if (passwordError && !validatePasswordValue(value)) setPasswordError("");
                }}
                placeholder="At least 8 characters"
                disabled={submitting}
                maxLength={PASSWORD_MAX_LENGTH}
                aria-invalid={Boolean(passwordError)}
              />
              {passwordError && <FieldError>{passwordError}</FieldError>}
              <FieldHint>{PASSWORD_RULES_HINT}</FieldHint>
            </Field>
            {formError && <FieldError>{formError}</FieldError>}
            <Button type="submit" disabled={submitting} fullWidth style={gradientCta}>
              {submitting ? "Sending code..." : "Create account"}
            </Button>
            <p className="text-center text-[11px] leading-relaxed text-[var(--muted-soft)]">
              By signing up you agree to our{" "}
              <Link href="/terms-and-conditions" className="hover:underline">
                Terms
              </Link>{" "}
              and{" "}
              <Link href="/privacy-policy" className="hover:underline">
                Privacy Policy
              </Link>
            </p>
          </form>
        )}

        {mode === "password" && step === "code" && (
          <form onSubmit={handlePasswordCodeSubmit} className="space-y-5">
            <OtpBoxInput value={code} onChange={setCode} disabled={submitting} autoFocus />
            {error && <FieldError>{error}</FieldError>}
            <Button type="submit" disabled={submitting} fullWidth style={gradientCta}>
              {submitting ? "Verifying..." : "Verify and create account"}
            </Button>
          </form>
        )}

        {mode === "otp" && (
          <form onSubmit={handleOtpSubmit} className="space-y-4" noValidate>
            <Field>
              <FieldLabel htmlFor="signup-otp-email">Email *</FieldLabel>
              <Input
                id="signup-otp-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => {
                  const value = e.target.value;
                  setEmail(value);
                  if (emailError && !validateEmailValue(value)) setEmailError("");
                }}
                placeholder="you@company.com"
                disabled={submitting}
                maxLength={EMAIL_MAX_LENGTH}
                autoFocus
              />
              <FieldHint>We will send a one-time code to your email. No password needed.</FieldHint>
              {emailError && <FieldError>{emailError}</FieldError>}
            </Field>
            {error && <FieldError>{error}</FieldError>}
            <Button type="submit" disabled={submitting} fullWidth style={gradientCta}>
              {submitting ? "Sending..." : "Send login code"}
            </Button>
          </form>
        )}

        {step === "form" && (
          <p className="mt-6 text-center text-[13px] text-[var(--muted)]">
            Already have an account?{" "}
            <Link href="/login" className="font-medium text-[var(--accent-light)] hover:underline">
              Sign in
            </Link>
          </p>
        )}
      </div>
    </AuthSplitShell>
  );
}
