"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconPencil } from "@tabler/icons-react";
import { changePassword, updateProfile } from "@/lib/api";
import { Button, Card, Field, FieldError, FieldHint, FieldLabel, Input, Modal, PageLoader, PasswordInput, PhoneInput } from "@/components/ui";
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
  const { currentUser, refetchCurrentUser } = useAppData();
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
  // First name, last name, and mobile number each read as a plain, locked field until their own
  // pencil button is clicked — matching the read-only treatment Email already has, instead of
  // always-open inputs. Each field has its own independent edit flag: clicking one field's pencil
  // must not unlock the others (Basecamp report — a single shared flag used to do exactly that).
  // They still save together through one "Save profile" submission regardless of which are unlocked.
  const [isEditingFirstName, setIsEditingFirstName] = useState(false);
  const [isEditingLastName, setIsEditingLastName] = useState(false);
  const [isEditingMobile, setIsEditingMobile] = useState(false);
  const firstNameInputRef = useRef<HTMLInputElement>(null);
  const lastNameInputRef = useRef<HTMLInputElement>(null);

  const [isChangePasswordOpen, setIsChangePasswordOpen] = useState(false);
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

  // Save is enabled the moment any field is unlocked for editing — not gated on an actual value
  // change — so clicking a pencil and immediately hitting Save (a no-op resubmit of the same,
  // already-valid value) is a normal, safe path rather than a dead button.
  const anyFieldEditing = isEditingFirstName || isEditingLastName || isEditingMobile;

  function startEditingFirstName() {
    setIsEditingFirstName(true);
    // readOnly doesn't block focusing (only `disabled` would), so this can run immediately.
    firstNameInputRef.current?.focus();
  }

  function startEditingLastName() {
    setIsEditingLastName(true);
    lastNameInputRef.current?.focus();
  }

  function startEditingMobile() {
    setIsEditingMobile(true);
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
      setIsEditingFirstName(false);
      setIsEditingLastName(false);
      setIsEditingMobile(false);
      // AppDataProvider's currentUser is fetched once on mount and otherwise never updated — without
      // this, the TopBar/Sidebar avatar initials would keep showing the pre-edit name, and returning
      // to this page after navigating away would read the stale value straight back out of context.
      refetchCurrentUser();
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

  function openChangePassword() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    clearErrors();
    setIsChangePasswordOpen(true);
  }

  function closeChangePassword() {
    setIsChangePasswordOpen(false);
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
                readOnly={!isEditingFirstName}
                disabled={profileSaving}
                maxLength={SIGNUP_NAME_MAX_LENGTH}
                className={!isEditingFirstName ? "cursor-default bg-[var(--surface-secondary)]" : undefined}
              />
              {!isEditingFirstName && (
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  onClick={startEditingFirstName}
                  disabled={profileSaving}
                  title="Edit first name"
                  aria-label="Edit first name"
                  className="shrink-0"
                >
                  <IconPencil size={14} stroke={1.75} />
                </Button>
              )}
            </div>
          </Field>

          <Field>
            <FieldLabel htmlFor="account-last-name">Last name</FieldLabel>
            <div className="flex items-center gap-2">
              <Input
                id="account-last-name"
                ref={lastNameInputRef}
                type="text"
                value={lastNameDraft}
                onChange={(e) => {
                  setLastNameDraft(e.target.value);
                  if (profileError) setProfileError("");
                  setProfileSuccess(false);
                }}
                placeholder="Your last name"
                readOnly={!isEditingLastName}
                disabled={profileSaving}
                maxLength={SIGNUP_NAME_MAX_LENGTH}
                className={!isEditingLastName ? "cursor-default bg-[var(--surface-secondary)]" : undefined}
              />
              {!isEditingLastName && (
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  onClick={startEditingLastName}
                  disabled={profileSaving}
                  title="Edit last name"
                  aria-label="Edit last name"
                  className="shrink-0"
                >
                  <IconPencil size={14} stroke={1.75} />
                </Button>
              )}
            </div>
          </Field>

          <Field>
            <FieldLabel htmlFor="account-mobile-number">
              Mobile number <span className="font-normal text-[var(--muted-soft)]">(Optional)</span>
            </FieldLabel>
            <div className="flex items-center gap-2">
              <PhoneInput
                id="account-mobile-number"
                value={mobileNumberDraft}
                onChange={(value) => {
                  setMobileNumberDraft(value);
                  if (profileError) setProfileError("");
                  setProfileSuccess(false);
                }}
                disabled={profileSaving || !isEditingMobile}
                locked={!isEditingMobile}
                maxLength={MOBILE_NUMBER_MAX_LENGTH}
                className="flex-1"
              />
              {!isEditingMobile && (
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  onClick={startEditingMobile}
                  disabled={profileSaving}
                  title="Edit mobile number"
                  aria-label="Edit mobile number"
                  className="shrink-0"
                >
                  <IconPencil size={14} stroke={1.75} />
                </Button>
              )}
            </div>
          </Field>

          <Field>
            <FieldLabel htmlFor="account-email">Email</FieldLabel>
            <Input
              id="account-email"
              type="email"
              value={email}
              readOnly
              disabled={profileSaving}
              className="cursor-default bg-[var(--surface-secondary)]"
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="account-password">Password</FieldLabel>
            <div className="flex items-center gap-2">
              <Input
                id="account-password"
                type="text"
                value="••••••••••••"
                readOnly
                disabled
                className="cursor-default bg-[var(--surface-secondary)] tracking-widest"
              />
            </div>
            <button
              type="button"
              onClick={openChangePassword}
              className="w-fit text-[13px] font-medium text-[var(--accent-light)] hover:underline"
            >
              {hasPassword ? "Change password" : "Set a password"}
            </button>
          </Field>

          {profileError && <FieldError>{profileError}</FieldError>}
          {profileSuccess && !profileError && (
            <p className="text-[13px] text-[var(--success-foreground)]">Profile updated.</p>
          )}

          <div className="flex justify-end">
            <Button type="submit" disabled={profileSaving || !anyFieldEditing}>
              {profileSaving ? "Saving…" : "Save profile"}
            </Button>
          </div>
        </form>
      </Card>

      <Modal
        open={isChangePasswordOpen}
        onClose={closeChangePassword}
        title={hasPassword ? "Change password" : "Set a password"}
      >
        <p className="mb-4 text-sm text-[var(--muted)]">
          {hasPassword
            ? "You'll be signed out everywhere, including here, after changing your password."
            : "You signed in with a one-time code so far. Set a password to also sign in that way — you'll be signed out everywhere afterward, so you can sign back in with it."}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
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

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={closeChangePassword} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : hasPassword ? "Change password" : "Set password"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
