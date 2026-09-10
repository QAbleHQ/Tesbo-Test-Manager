"use client";

import { Suspense, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authMe, completeProfile } from "@/lib/api";
import { AuthSplitShell } from "@/components/auth/AuthSplitShell";
import { AuthLoadingScreen } from "@/components/auth/AuthLoadingScreen";
import { Button, Field, FieldError, FieldHint, FieldLabel, Input } from "@/components/ui";
import {
  MOBILE_NUMBER_MAX_LENGTH,
  SIGNUP_NAME_MAX_LENGTH,
  normalizeMobileNumber,
  validateMobileNumber,
  validateName,
} from "@/lib/validation";
import { safeRedirectPath } from "@/lib/redirect";

function CompleteProfileForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Where verify-otp was headed before detouring here — same default it already uses for a
  // brand-new account, so finishing this step lands exactly where OTP sign-in always has.
  const redirect = safeRedirectPath(searchParams.get("redirect")) || "/onboarding";

  const [checking, setChecking] = useState(true);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [mobileNumber, setMobileNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [firstNameError, setFirstNameError] = useState("");
  const [lastNameError, setLastNameError] = useState("");
  const [mobileNumberError, setMobileNumberError] = useState("");
  const [formError, setFormError] = useState("");

  useEffect(() => {
    let active = true;
    authMe().then((me) => {
      if (!active) return;
      if (!me) {
        router.replace("/login");
        return;
      }
      // Nothing to complete — a direct visit, a reload after already finishing, or a stale link.
      if (me.profileComplete) {
        router.replace(redirect);
        return;
      }
      setChecking(false);
    });
    return () => { active = false; };
    // Deliberately once on mount: `redirect` is derived from the URL and stable for the page's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFirstNameError("");
    setLastNameError("");
    setMobileNumberError("");
    setFormError("");

    const firstNameMsg = validateName(firstName, "First name", SIGNUP_NAME_MAX_LENGTH) || "";
    const lastNameMsg = validateName(lastName, "Last name", SIGNUP_NAME_MAX_LENGTH) || "";
    const mobileMsg = validateMobileNumber(mobileNumber) || "";
    if (firstNameMsg || lastNameMsg || mobileMsg) {
      setFirstNameError(firstNameMsg);
      setLastNameError(lastNameMsg);
      setMobileNumberError(mobileMsg);
      return;
    }

    setSubmitting(true);
    try {
      await completeProfile({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        mobileNumber: mobileNumber.trim() ? normalizeMobileNumber(mobileNumber.trim()) : undefined,
      });
      router.push(redirect);
      router.refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save your profile");
    } finally {
      setSubmitting(false);
    }
  }

  if (checking) {
    return <AuthLoadingScreen />;
  }

  return (
    <AuthSplitShell>
      <div className="auth-fade-slide">
        <div className="mb-1 text-[22px] font-bold tracking-tight text-[var(--foreground)]">
          A couple more details
        </div>
        <p className="mb-7 text-[13px] text-[var(--muted)]">
          You signed in with a one-time code, so we still need your name.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="flex gap-3">
            <Field className="flex-1">
              <FieldLabel htmlFor="complete-first-name">First name *</FieldLabel>
              <Input
                id="complete-first-name"
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
              <FieldLabel htmlFor="complete-last-name">Last name *</FieldLabel>
              <Input
                id="complete-last-name"
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
                aria-invalid={Boolean(lastNameError)}
              />
              {lastNameError && <FieldError>{lastNameError}</FieldError>}
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="complete-mobile">Mobile number</FieldLabel>
            <Input
              id="complete-mobile"
              type="tel"
              autoComplete="tel"
              value={mobileNumber}
              onChange={(e) => {
                const value = e.target.value;
                setMobileNumber(value);
                if (mobileNumberError && !validateMobileNumber(value)) setMobileNumberError("");
              }}
              placeholder="+14155551234"
              disabled={submitting}
              maxLength={MOBILE_NUMBER_MAX_LENGTH}
              aria-invalid={Boolean(mobileNumberError)}
            />
            {mobileNumberError ? (
              <FieldError>{mobileNumberError}</FieldError>
            ) : (
              <FieldHint>Optional. Include a country code, e.g. +1 for the US.</FieldHint>
            )}
          </Field>

          {formError && <FieldError>{formError}</FieldError>}

          <Button
            type="submit"
            disabled={submitting}
            fullWidth
            style={{ background: "linear-gradient(135deg, var(--cta-primary), var(--denim-200))" }}
          >
            {submitting ? "Saving..." : "Continue"}
          </Button>
        </form>
      </div>
    </AuthSplitShell>
  );
}

export default function CompleteProfilePage() {
  return (
    <Suspense fallback={<AuthLoadingScreen />}>
      <CompleteProfileForm />
    </Suspense>
  );
}
