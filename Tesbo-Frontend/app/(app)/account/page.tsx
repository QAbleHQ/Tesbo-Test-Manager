"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconPencil } from "@tabler/icons-react";
import { changePassword, updateProfile } from "@/lib/api";
import { Button, Card, Field, FieldError, FieldHint, FieldLabel, Input, PageLoader, PasswordInput, PhoneInput } from "@/components/ui";
import {
  MOBILE_NUMBER_MAX_LENGTH,
  normalizeMobileNumber,
  PASSWORD_MAX_LENGTH,
  PASSWORD_RULES_HINT,
  SIGNUP_NAME_MAX_LENGTH,
  validateMobileNumber,
  validateName,
  validatePasswordValue,
} from "@/lib/validation";
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

  const [firstNameDraft, setFirstNameDraft] = useState("");
  const [lastNameDraft, setLastNameDraft] = useState("");
  const [mobileNumberDraft, setMobileNumberDraft] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [profileSuccess, setProfileSuccess] = useState(false);
  // First/last name read as plain, non-editable text until the pencil button is clicked — matches
  // the read-only-by-default treatment Email already has, instead of an always-open text box. They
  // share one edit toggle since they're saved together as a pair, not independently.
  const [isEditingName, setIsEditingName] = useState(false);
  const firstNameInputRef = useRef<HTMLInputElement>(null);

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
    const trimmedFirstName = (currentUser.firstName ?? "").trim();
    const trimmedLastName = (currentUser.lastName ?? "").trim();
    setFirstName(trimmedFirstName);
    setFirstNameDraft(trimmedFirstName);
    setLastName(trimmedLastName);
    setLastNameDraft(trimmedLastName);
    setMobileNumber((currentUser.mobileNumber ?? "").trim());
    setMobileNumberDraft((currentUser.mobileNumber ?? "").trim());
    setHasPassword(Boolean(currentUser.hasPassword));
    setLoading(false);
  }, [router, currentUser]);

  useEffect(() => { load(); }, [load]);

  const profileDirty =
    firstNameDraft.trim() !== firstName || lastNameDraft.trim() !== lastName || mobileNumberDraft.trim() !== mobileNumber;

  function startEditingName() {
    setIsEditingName(true);
    // readOnly doesn't block focusing (only `disabled` would), so this can run immediately.
    firstNameInputRef.current?.focus();
  }

  async function handleProfileSubmit(e: React.FormEvent) {
    e.preventDefault();
    setProfileError("");
    setProfileSuccess(false);

    const trimmedFirstName = firstNameDraft.trim();
    const firstNameError = validateName(trimmedFirstName, "First name", SIGNUP_NAME_MAX_LENGTH);
    if (firstNameError) {
      setProfileError(firstNameError);
      return;
    }
    const trimmedLastName = lastNameDraft.trim();
    const lastNameError = validateName(trimmedLastName, "Last name", SIGNUP_NAME_MAX_LENGTH);
    if (lastNameError) {
      setProfileError(lastNameError);
      return;
    }
    const mobileError = validateMobileNumber(mobileNumberDraft);
    if (mobileError) {
      setProfileError(mobileError);
      return;
    }
    const normalizedMobileNumber = normalizeMobileNumber(mobileNumberDraft);

    setProfileSaving(true);
    try {
      const updated = await updateProfile({
        firstName: trimmedFirstName,
        lastName: trimmedLastName,
        mobileNumber: normalizedMobileNumber,
      });
      setFirstName((updated.firstName ?? "").trim());
      setFirstNameDraft((updated.firstName ?? "").trim());
      setLastName((updated.lastName ?? "").trim());
      setLastNameDraft((updated.lastName ?? "").trim());
      setMobileNumber(updated.mobileNumber ?? "");
      setMobileNumberDraft(updated.mobileNumber ?? "");
      setProfileSuccess(true);
      setIsEditingName(false);
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "Failed to save profile");
    } finally {
      setProfileSaving(false);
    }
  }

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
          * Mobile number are collected at signup, invite registration, and (via the one-time
          * /complete-profile step) passwordless OTP sign-in — see SignupService, AuthService.me/
          * completeProfile, and app/complete-profile/page.tsx. They're also editable here afterward
          * through PATCH /api/auth/me, for anyone who mistyped at signup or wants to update them.
          *
          * No profile picture field here: avatar_url exists on the users table but is intentionally
          * not exposed through this screen — the top-right avatar and every other avatar in the app
          * show initials only.
          */}
        <form onSubmit={handleProfileSubmit} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="account-first-name">First name</FieldLabel>
            <div className="flex items-center gap-2">
              <Input
                id="account-first-name"
                ref={firstNameInputRef}
                type="text"
                value={firstNameDraft}
                onChange={(e) => {
                  setFirstNameDraft(e.target.value);
                  if (profileError) setProfileError("");
                  setProfileSuccess(false);
                }}
                placeholder="Your first name"
                readOnly={!isEditingName}
                disabled={profileSaving}
                maxLength={SIGNUP_NAME_MAX_LENGTH}
                className={!isEditingName ? "cursor-default bg-[var(--surface-secondary)]" : undefined}
              />
              {!isEditingName && (
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  onClick={startEditingName}
                  disabled={profileSaving}
                  title="Edit name"
                  aria-label="Edit name"
                  className="shrink-0"
                >
                  <IconPencil size={14} stroke={1.75} />
                </Button>
              )}
            </div>
          </Field>

          <Field>
            <FieldLabel htmlFor="account-last-name">Last name</FieldLabel>
            <Input
              id="account-last-name"
              type="text"
              value={lastNameDraft}
              onChange={(e) => {
                setLastNameDraft(e.target.value);
                if (profileError) setProfileError("");
                setProfileSuccess(false);
              }}
              placeholder="Your last name"
              readOnly={!isEditingName}
              disabled={profileSaving}
              maxLength={SIGNUP_NAME_MAX_LENGTH}
              className={!isEditingName ? "cursor-default bg-[var(--surface-secondary)]" : undefined}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="account-email">Email</FieldLabel>
            <div id="account-email" className="text-sm text-[var(--foreground)]">
              {email}
            </div>
          </Field>

          <Field>
            <FieldLabel htmlFor="account-mobile-number">Mobile number</FieldLabel>
            <PhoneInput
              id="account-mobile-number"
              value={mobileNumberDraft}
              onChange={(value) => {
                setMobileNumberDraft(value);
                if (profileError) setProfileError("");
                setProfileSuccess(false);
              }}
              disabled={profileSaving}
              maxLength={MOBILE_NUMBER_MAX_LENGTH}
            />
            <FieldHint>Optional.</FieldHint>
          </Field>

          {profileError && <FieldError>{profileError}</FieldError>}
          {profileSuccess && !profileError && (
            <p className="text-[13px] text-[var(--success-foreground)]">Profile updated.</p>
          )}

          <div className="flex justify-end">
            <Button type="submit" disabled={profileSaving || !profileDirty}>
              {profileSaving ? "Saving…" : "Save profile"}
            </Button>
          </div>
        </form>
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
