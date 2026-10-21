"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { IconCircleCheck } from "@tabler/icons-react";
import { checkPasswordResetToken, resetPassword } from "@/lib/api";
import { AuthSplitShell } from "@/components/auth/AuthSplitShell";
import { AuthLoadingScreen } from "@/components/auth/AuthLoadingScreen";
import { ResetImpactNotice } from "@/components/auth/ResetImpactNotice";
import { Button, Field, FieldError, FieldHint, FieldLabel, PasswordInput } from "@/components/ui";
import { PASSWORD_MAX_LENGTH, PASSWORD_RULES_HINT, validatePasswordValue } from "@/lib/validation";

export default function ResetPasswordPage() {
  const params = useParams();
  const router = useRouter();
  const token = params.token as string;

  const [checking, setChecking] = useState(true);
  const [tokenValid, setTokenValid] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [confirmPasswordError, setConfirmPasswordError] = useState("");
  const [formError, setFormError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    checkPasswordResetToken(token)
      .then((res) => setTokenValid(res.valid))
      .catch(() => setTokenValid(false))
      .finally(() => setChecking(false));
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setPasswordError("");
    setConfirmPasswordError("");
    setFormError("");

    let valid = true;
    const passwordMsg = validatePasswordValue(password);
    if (passwordMsg) {
      setPasswordError(passwordMsg);
      valid = false;
    } else if (!confirmPassword) {
      setConfirmPasswordError("Confirm your new password");
      valid = false;
    } else if (password !== confirmPassword) {
      setConfirmPasswordError("Passwords do not match");
      valid = false;
    }
    if (!valid) return;

    setLoading(true);
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to reset password");
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return <AuthLoadingScreen />;
  }

  if (done) {
    return (
      <AuthSplitShell>
        <div className="auth-fade-slide text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full border border-[rgba(123,110,224,.3)] bg-[rgba(123,110,224,.15)]">
            <IconCircleCheck size={26} stroke={1.5} className="text-[var(--brand-primary)]" />
          </div>
          <div className="mb-2 text-[20px] font-bold tracking-tight text-[var(--foreground)]">Password reset</div>
          <p className="mb-7 text-[13px] leading-relaxed text-[var(--muted)]">
            Your password has been updated and you have been signed out of every device. Sign in again with your new password.
          </p>
          <p className="mb-7 text-[13px] leading-relaxed text-[var(--muted)]" data-testid="reset-tokens-revoked">
            Your API tokens have been revoked. Create new tokens under Project Settings, API tokens before reconnecting CI
            pipelines, MCP clients or the Playwright reporter.
          </p>
          <Button
            type="button"
            fullWidth
            onClick={() => router.push("/login")}
            style={{ background: "linear-gradient(135deg, var(--cta-primary), var(--denim-200))" }}
          >
            Back to sign in
          </Button>
        </div>
      </AuthSplitShell>
    );
  }

  if (!tokenValid) {
    return (
      <AuthSplitShell>
        <div className="auth-fade-slide text-center">
          <div className="mb-2 text-[20px] font-bold tracking-tight text-[var(--foreground)]">Link expired</div>
          <p className="mb-7 text-[13px] leading-relaxed text-[var(--muted)]">
            This password reset link is invalid or has expired. Request a new one to continue.
          </p>
          <Link href="/forgot-password" className="text-[13px] font-medium text-[var(--brand-primary)] hover:underline">
            Request a new link
          </Link>
        </div>
      </AuthSplitShell>
    );
  }

  return (
    <AuthSplitShell>
      <div className="auth-fade-slide">
        <div className="mb-1 text-[22px] font-bold tracking-tight text-[var(--foreground)]">Set a new password</div>
        <p className="mb-5 text-[13px] text-[var(--muted)]">Choose a new password for your account.</p>
        <ResetImpactNotice className="mb-6" />

        <form onSubmit={handleSubmit} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="password">New password</FieldLabel>
            <PasswordInput
              id="password"
              autoComplete="new-password"
              autoFocus
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (passwordError) setPasswordError("");
              }}
              placeholder="At least 8 characters"
              disabled={loading}
              maxLength={PASSWORD_MAX_LENGTH}
              aria-invalid={Boolean(passwordError)}
            />
            {passwordError && <FieldError>{passwordError}</FieldError>}
            <FieldHint>{PASSWORD_RULES_HINT}</FieldHint>
          </Field>

          <Field>
            <FieldLabel htmlFor="confirmPassword">Confirm new password</FieldLabel>
            <PasswordInput
              id="confirmPassword"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                if (confirmPasswordError) setConfirmPasswordError("");
              }}
              placeholder="Re-enter your new password"
              disabled={loading}
              maxLength={PASSWORD_MAX_LENGTH}
              aria-invalid={Boolean(confirmPasswordError)}
            />
            {confirmPasswordError && <FieldError>{confirmPasswordError}</FieldError>}
          </Field>

          {formError && <FieldError>{formError}</FieldError>}

          <Button
            type="submit"
            disabled={loading}
            fullWidth
            style={{ background: "linear-gradient(135deg, var(--cta-primary), var(--denim-200))" }}
          >
            {loading ? "Resetting..." : "Reset password"}
          </Button>
        </form>
      </div>
    </AuthSplitShell>
  );
}
