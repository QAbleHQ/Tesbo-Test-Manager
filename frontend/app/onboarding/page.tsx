"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { addWorkspaceMember, authMe, createWorkspace, getWorkspace } from "@/lib/api";
import { Button, Field, FieldError, FieldHint, FieldLabel, Input, Textarea } from "@/components/ui";

export default function OnboardingPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [step, setStep] = useState<"workspace" | "team">("workspace");
  const [orgName, setOrgName] = useState("");
  const [teamEmails, setTeamEmails] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
    if (!orgName.trim()) {
      setError("Workspace name is required");
      return;
    }

    setLoading(true);
    try {
      await createWorkspace({
        orgName: orgName.trim(),
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
      const emails = Array.from(
        new Set(
          teamEmails
            .split(/[\n,;]+/)
            .map((v) => v.trim().toLowerCase())
            .filter(Boolean)
        )
      );

      for (const email of emails) {
        await addWorkspaceMember({ email, role: "member" });
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
              <FieldLabel htmlFor="orgName">Organization / workspace name</FieldLabel>
              <Input
                id="orgName"
                type="text"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="My Team"
                disabled={loading}
              />
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
