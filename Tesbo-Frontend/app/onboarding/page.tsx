"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { authMe, createWorkspace, createWorkspaceInvitation, getWorkspace, type WorkspaceRole } from "@/lib/api";
import { countryOptions } from "@/lib/countries";
import { DEFAULT_INVITE_ROLE, inviteRoleDescription, invitableRoleOptions } from "@/lib/workspaceRoles";
import { Button, Field, FieldError, FieldHint, FieldLabel, Input, Select, Textarea } from "@/components/ui";

// Whoever reaches the team step just created this workspace in step 1, so they are its owner (step 1
// says as much). The server still enforces what an owner may invite — see createInvitation.
const ONBOARDING_INVITER_ROLE: WorkspaceRole = "owner";

/** One address per line, comma or semicolon — lower-cased and de-duplicated, in the order typed. */
function parseTeamEmails(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\n,;]+/)
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

/** Best-effort default from the browser locale (e.g. "en-IN" → "IN"); empty when it has no region. */
function guessCountryFromLocale(): string {
  try {
    const region = new Intl.Locale(navigator.language).region;
    return region && /^[A-Z]{2}$/.test(region) ? region : "";
  } catch {
    return "";
  }
}

export default function OnboardingPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [step, setStep] = useState<"workspace" | "team">("workspace");
  const [orgName, setOrgName] = useState("");
  // Prefilled from the browser's own locale as a sensible default — it's only a soft pricing signal,
  // and pre-selecting the likely answer beats making everyone scroll a 240-entry list.
  const [country, setCountry] = useState(() => guessCountryFromLocale());
  const [teamEmails, setTeamEmails] = useState("");
  // Role chosen per invited address. An address with no entry uses DEFAULT_INVITE_ROLE, so a newly
  // typed email starts on the same default Settings › Members does — visible and changeable, where
  // this step used to invite everyone as a QA Engineer with no way to say otherwise.
  const [roleByEmail, setRoleByEmail] = useState<Record<string, WorkspaceRole>>({});
  const parsedTeamEmails = useMemo(() => parseTeamEmails(teamEmails), [teamEmails]);
  const inviteRoleOptions = useMemo(() => invitableRoleOptions(ONBOARDING_INVITER_ROLE), []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [orgNameError, setOrgNameError] = useState("");
  const countries = useMemo(() => countryOptions(), []);

  useEffect(() => {
    async function guardOnboardingAccess() {
      const me = await authMe();
      if (!me) {
        setChecking(false);
        router.replace("/login");
        return;
      }

      try {
        await getWorkspace();
        router.replace("/projects");
        return;
      } catch {
        // No workspace yet; user should continue onboarding.
      }

      setChecking(false);
    }

    guardOnboardingAccess();
  }, [router]);

  async function handleCreateWorkspace(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setOrgNameError("");
    if (!orgName.trim()) {
      setOrgNameError("Workspace name is required");
      return;
    }

    setLoading(true);
    try {
      await createWorkspace({
        orgName: orgName.trim(),
        ...(country && { country }),
      });
      setStep("team");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create workspace");
    } finally {
      setLoading(false);
    }
  }

  async function handleTeamStep(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      for (const email of parsedTeamEmails) {
        await createWorkspaceInvitation({ email, role: roleByEmail[email] ?? DEFAULT_INVITE_ROLE });
      }

      router.push("/projects?create=1&fromOnboarding=1");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add team members");
    } finally {
      setLoading(false);
    }
  }

  function skipTeamStep() {
    router.push("/projects?create=1&fromOnboarding=1");
    router.refresh();
  }

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--background)]">
        <p className="text-[var(--muted)]">Loading…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--background)] px-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">
            {step === "workspace" ? "Create your workspace" : "Invite your team (optional)"}
          </h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {step === "workspace"
              ? "Step 1 of 2: set up your organization. You will be the workspace owner."
              : "Step 2 of 2: add team members now, or skip and do this later from workspace settings."}
          </p>
        </div>
        {step === "workspace" ? (
          <form onSubmit={handleCreateWorkspace} className="space-y-4">
            <Field>
              <FieldLabel htmlFor="orgName">Organization / workspace name *</FieldLabel>
              <Input
                id="orgName"
                type="text"
                value={orgName}
                onChange={(e) => {
                  const value = e.target.value;
                  setOrgName(value);
                  if (orgNameError && value.trim()) setOrgNameError("");
                }}
                placeholder="My Team"
                disabled={loading}
                aria-invalid={Boolean(orgNameError)}
              />
              {orgNameError && <FieldError>{orgNameError}</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor="country">Country</FieldLabel>
              <Select id="country" value={country} onChange={(e) => setCountry(e.target.value)} disabled={loading}>
                <option value="">Select a country…</option>
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </Select>
              <FieldHint>Used to show the right currency at checkout. You can change this later in workspace settings.</FieldHint>
            </Field>
            {error && <FieldError>{error}</FieldError>}
            <Button type="submit" disabled={loading} fullWidth>
              {loading ? "Creating…" : "Continue"}
            </Button>
          </form>
        ) : (
          <form onSubmit={handleTeamStep} className="space-y-4">
            <Field>
              <FieldLabel htmlFor="teamEmails">Team member emails</FieldLabel>
              <Textarea
                id="teamEmails"
                value={teamEmails}
                onChange={(e) => setTeamEmails(e.target.value)}
                rows={5}
                placeholder={"alice@company.com\nbob@company.com"}
                disabled={loading}
              />
              <FieldHint>One email per line (or comma separated).</FieldHint>
            </Field>
            {parsedTeamEmails.length > 0 && (
              <Field>
                <FieldLabel>Roles</FieldLabel>
                <ul className="space-y-2">
                  {parsedTeamEmails.map((email) => {
                    const role = roleByEmail[email] ?? DEFAULT_INVITE_ROLE;
                    return (
                      <li key={email} className="flex items-center gap-3">
                        <span className="min-w-0 flex-1 truncate text-sm text-[var(--foreground)]" title={email}>
                          {email}
                        </span>
                        {/* Sized by this wrapper, not a className on Select: Select always carries
                            w-full and cx() is a plain join, so a `w-40` there races w-full in the
                            stylesheet — w-full won, the select took the whole row, and the email
                            beside it collapsed to zero width. */}
                        <div className="w-40 shrink-0">
                          <Select
                            aria-label={`Role for ${email}`}
                            value={role}
                            onChange={(e) => {
                              const next = e.target.value as WorkspaceRole;
                              setRoleByEmail((prev) => ({ ...prev, [email]: next }));
                            }}
                            disabled={loading}
                          >
                            {inviteRoleOptions.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </Select>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <FieldHint>
                  {inviteRoleOptions.map((opt) => `${opt.label}: ${inviteRoleDescription(opt.value)}`).join(" ")}
                </FieldHint>
              </Field>
            )}
            {error && <FieldError>{error}</FieldError>}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={skipTeamStep}
                disabled={loading}
                className="flex-1"
              >
                Skip for now
              </Button>
              <Button type="submit" disabled={loading} className="flex-1">
                {loading ? "Adding…" : "Continue"}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
