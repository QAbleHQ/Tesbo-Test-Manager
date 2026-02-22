"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { addWorkspaceMember, authMe, createWorkspace, getWorkspace } from "@/lib/api";

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
      <div className="min-h-screen flex items-center justify-center bg-[var(--background)] dark:bg-zinc-950">
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--background)] dark:bg-zinc-950 px-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-[var(--foreground)] dark:text-zinc-100">
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
            <div>
              <label htmlFor="orgName" className="block text-sm font-medium text-[var(--muted)] dark:text-zinc-300 mb-1">
                Organization / workspace name
              </label>
              <input
                id="orgName"
                type="text"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="My Team"
                className="w-full rounded-lg border border-[var(--border)] dark:border-zinc-600 bg-[var(--surface)] dark:bg-zinc-900 px-3 py-2 text-[var(--foreground)] dark:text-zinc-100"
                disabled={loading}
              />
            </div>
            {error && (
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-[var(--primary)] text-white py-2 px-4 font-medium hover:opacity-90 disabled:opacity-50"
            >
              {loading ? "Creating…" : "Continue"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleTeamStep} className="space-y-4">
            <div>
              <label htmlFor="teamEmails" className="block text-sm font-medium text-[var(--muted)] dark:text-zinc-300 mb-1">
                Team member emails
              </label>
              <textarea
                id="teamEmails"
                value={teamEmails}
                onChange={(e) => setTeamEmails(e.target.value)}
                rows={5}
                placeholder={"alice@company.com\nbob@company.com"}
                className="w-full rounded-lg border border-[var(--border)] dark:border-zinc-600 bg-[var(--surface)] dark:bg-zinc-900 px-3 py-2 text-[var(--foreground)] dark:text-zinc-100"
                disabled={loading}
              />
              <p className="mt-1 text-xs text-[var(--muted)]">One email per line (or comma separated).</p>
            </div>
            {error && (
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={skipTeamStep}
                disabled={loading}
                className="w-1/2 rounded-lg border border-[var(--border)] dark:border-zinc-600 py-2 px-4 font-medium text-[var(--foreground)] dark:text-zinc-100 hover:bg-zinc-50 dark:hover:bg-zinc-900 disabled:opacity-50"
              >
                Skip for now
              </button>
              <button
                type="submit"
                disabled={loading}
                className="w-1/2 rounded-lg bg-[var(--primary)] text-white py-2 px-4 font-medium hover:opacity-90 disabled:opacity-50"
              >
                {loading ? "Adding…" : "Continue"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
