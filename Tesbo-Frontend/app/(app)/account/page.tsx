"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { changePassword } from "@/lib/api";
import { Button, Card, Field, FieldError, FieldHint, FieldLabel, PageLoader, PasswordInput } from "@/components/ui";
import { PASSWORD_MAX_LENGTH, PASSWORD_RULES_HINT, validatePasswordValue } from "@/lib/validation";
import { useAppData } from "@/components/app/AppDataProvider";

export default function AccountPage() {
  const router = useRouter();
  const { currentUser } = useAppData();
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [mobileNumber, setMobileNumber] = useState("");
  const [hasPassword, setHasPassword] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [currentPasswordError, setCurrentPasswordError] = useState("");
  const [newPasswordError, setNewPasswordError] = useState("");
  const [confirmPasswordError, setConfirmPasswordError] = useState("");
  const [formError, setFormError] = useState("");

  const load = useCallback(() => {
    if (!currentUser) {
      router.replace("/login");
      return;
    }
    setEmail(currentUser.email ?? "");
    setFirstName((currentUser.firstName ?? "").trim());
    setLastName((currentUser.lastName ?? "").trim());
    setMobileNumber((currentUser.mobileNumber ?? "").trim());
    setHasPassword(Boolean(currentUser.hasPassword));
    setLoading(false);
  }, [router, currentUser]);

  useEffect(() => { load(); }, [load]);

  function clearErrors() {
    setCurrentPasswordError("");
    setNewPasswordError("");
    setConfirmPasswordError("");
    setFormError("");
  }

  // Maps server-side rejections (auth.service.ts changePassword) back to the field they concern,
  // so the message lands next to the input it's about instead of as a generic form error.
  function applyServerError(message: string) {
    if (message === "invalid_current_password") {
      setCurrentPasswordError("Current password is incorrect");
      return;
    }
    if (message === "current password required") {
      setCurrentPasswordError("Current password is required");
      return;
    }
    if (message === "new password required" || /^Password must/.test(message)) {
      setNewPasswordError(message === "new password required" ? "New password is required" : message);
      return;
    }
    if (message === "New password must be different from your current password") {
      setNewPasswordError(message);
      return;
    }
    setFormError(message);
  }

  function validate(): boolean {
    let valid = true;
    const trimmedCurrent = currentPassword.trim();

    if (hasPassword && !trimmedCurrent) {
      setCurrentPasswordError("Current password is required");
      valid = false;
    }

    const passwordError = validatePasswordValue(newPassword);
    if (passwordError) {
      setNewPasswordError(passwordError);
      valid = false;
    } else if (hasPassword && trimmedCurrent && newPassword === currentPassword) {
      setNewPasswordError("New password must be different from your current password");
      valid = false;
    }

    if (!confirmPassword) {
      setConfirmPasswordError("Confirm your new password");
      valid = false;
    } else if (newPassword !== confirmPassword) {
      setConfirmPasswordError("New passwords do not match");
      valid = false;
    }

    return valid;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    clearErrors();
    if (!validate()) return;

    setSaving(true);
    try {
      await changePassword(hasPassword ? currentPassword : null, newPassword);
      // The backend invalidates every session on a successful change, including this one, so the
      // current tab is signed out along with everywhere else — send it to /login to reflect that
      // rather than leaving the form sitting on a session that no longer exists server-side.
      router.push("/login?passwordChanged=1");
    } catch (err) {
      applyServerError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <PageLoader variant="screen" />;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <div>
        <h1 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-[var(--foreground)]">My Account</h1>
        <p className="mt-1 text-[13px] text-[var(--muted-soft)]">Manage your personal account settings.</p>
      </div>

      <Card className="p-5 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--foreground)]">Profile</h2>
        </div>
        {/*
          * Basecamp 10212498688 — the profile showed nothing but the email. First name, Last name and
          * Mobile number are now collected at signup, invite registration, and (via the one-time
          * /complete-profile step) passwordless OTP sign-in — see SignupService, AuthService.me/
          * completeProfile, and app/complete-profile/page.tsx. Read-only for now: there is no PATCH
          * /me to edit these after the fact.
          */}
        <Field>
          <FieldLabel htmlFor="account-first-name">First name</FieldLabel>
          <div id="account-first-name" className="text-sm text-[var(--foreground)]">
            {firstName || <span className="text-[var(--muted-soft)]">Not set</span>}
          </div>
        </Field>
        <Field>
          <FieldLabel htmlFor="account-last-name">Surname</FieldLabel>
          <div id="account-last-name" className="text-sm text-[var(--foreground)]">
            {lastName || <span className="text-[var(--muted-soft)]">Not set</span>}
          </div>
        </Field>
        <Field>
          <FieldLabel htmlFor="account-mobile">Mobile number</FieldLabel>
          <div id="account-mobile" className="text-sm text-[var(--foreground)]">
            {mobileNumber || <span className="text-[var(--muted-soft)]">Not set</span>}
          </div>
        </Field>
        <Field>
          <FieldLabel htmlFor="account-email">Email</FieldLabel>
          <div id="account-email" className="text-sm text-[var(--foreground)]">
            {email}
          </div>
        </Field>
      </Card>

      <Card className="p-5">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-[var(--foreground)]">
            {hasPassword ? "Change password" : "Set a password"}
          </h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {hasPassword
              ? "You'll be signed out everywhere, including here, after changing your password."
              : "You signed in with a one-time code so far. Set a password to also sign in that way — you'll be signed out everywhere afterward, so you can sign back in with it."}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="max-w-md space-y-4">
          {hasPassword && (
            <Field>
              <FieldLabel htmlFor="current-password">Current password</FieldLabel>
              <PasswordInput
                id="current-password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => {
                  setCurrentPassword(e.target.value);
                  if (currentPasswordError) setCurrentPasswordError("");
                }}
                placeholder="Your current password"
                disabled={saving}
                maxLength={PASSWORD_MAX_LENGTH}
                aria-invalid={Boolean(currentPasswordError)}
                aria-describedby={currentPasswordError ? "current-password-error" : undefined}
              />
              {currentPasswordError && <FieldError id="current-password-error">{currentPasswordError}</FieldError>}
            </Field>
          )}

          <Field>
            <FieldLabel htmlFor="new-password">New password</FieldLabel>
            <PasswordInput
              id="new-password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => {
                setNewPassword(e.target.value);
                if (newPasswordError) setNewPasswordError("");
              }}
              placeholder="At least 8 characters"
              disabled={saving}
              maxLength={PASSWORD_MAX_LENGTH}
              aria-invalid={Boolean(newPasswordError)}
              aria-describedby={newPasswordError ? "new-password-error" : "new-password-hint"}
            />
            {newPasswordError && <FieldError id="new-password-error">{newPasswordError}</FieldError>}
            <FieldHint id="new-password-hint">{PASSWORD_RULES_HINT}</FieldHint>
          </Field>

          <Field>
            <FieldLabel htmlFor="confirm-new-password">Confirm new password</FieldLabel>
            <PasswordInput
              id="confirm-new-password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                if (confirmPasswordError) setConfirmPasswordError("");
              }}
              placeholder="Re-enter your new password"
              disabled={saving}
              maxLength={PASSWORD_MAX_LENGTH}
              aria-invalid={Boolean(confirmPasswordError)}
              aria-describedby={confirmPasswordError ? "confirm-password-error" : undefined}
            />
            {confirmPasswordError && <FieldError id="confirm-password-error">{confirmPasswordError}</FieldError>}
          </Field>

          {formError && <FieldError>{formError}</FieldError>}

          <div className="flex justify-end">
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : hasPassword ? "Change password" : "Set password"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
