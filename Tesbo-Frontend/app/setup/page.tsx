"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { createFirstAdmin, getSetupStatus } from "@/lib/api";
import { Button, Field, FieldError, FieldHint, FieldLabel, Input } from "@/components/ui";

type Step = "admin" | "organization" | "data";

export default function SetupPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [step, setStep] = useState<Step>("admin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [demoData, setDemoData] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getSetupStatus()
      .then((status) => {
        if (!status.required) {
          router.replace("/login");
          return;
        }
        setChecking(false);
      })
      .catch(() => setChecking(false));
  }, [router]);

  function continueFromAdmin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      setError("Admin email is required.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setEmail(normalizedEmail);
    setStep("organization");
  }

  function continueFromOrganization(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!orgName.trim()) {
      setError("Organization name is required.");
      return;
    }
    setStep("data");
  }

  async function finishSetup(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await createFirstAdmin({
        email,
        password,
        orgName: orgName.trim(),
        demoData,
      });
      router.push("/projects");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed.");
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--background)]">
        <p className="text-[var(--muted)]">Checking setup...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--background)] px-4 py-10">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-md flex-col justify-center">
        <div className="mb-8 text-center">
          <Image
            src="/tesbox-logo-transparent.png"
            alt="Tesbo"
            width={280}
            height={80}
            priority
            className="mx-auto h-14 w-auto"
          />
          <p className="mt-3 text-sm font-medium text-[var(--muted)]">
            Initial open-source setup
          </p>
        </div>

        <div className="mb-6 grid grid-cols-3 gap-2" aria-hidden="true">
          {["Admin", "Organization", "Data"].map((label, index) => {
            const current = ["admin", "organization", "data"].indexOf(step);
            const active = index <= current;
            return (
              <div key={label} className="space-y-2">
                <div className={`h-1.5 rounded-full ${active ? "bg-[var(--brand-primary)]" : "bg-[var(--surface-tertiary)]"}`} />
                <p className={`text-center text-xs font-medium ${active ? "text-[var(--foreground)]" : "text-[var(--muted-soft)]"}`}>
                  {label}
                </p>
              </div>
            );
          })}
        </div>

        {step === "admin" && (
          <form onSubmit={continueFromAdmin} className="space-y-4">
            <div>
              <h1 className="text-2xl font-semibold text-[var(--foreground)]">Create the admin account</h1>
              <p className="mt-1 text-sm text-[var(--muted)]">
                This email becomes the first platform admin and workspace owner.
              </p>
            </div>
            <Field>
              <FieldLabel htmlFor="setup-email">Admin email</FieldLabel>
              <Input
                id="setup-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@example.com"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="setup-password">Password</FieldLabel>
              <Input
                id="setup-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Choose a password"
              />
              <FieldHint>Use at least 8 characters.</FieldHint>
            </Field>
            <Field>
              <FieldLabel htmlFor="setup-confirm-password">Confirm password</FieldLabel>
              <Input
                id="setup-confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
              />
            </Field>
            {error && <FieldError>{error}</FieldError>}
            <Button type="submit" fullWidth>Continue</Button>
          </form>
        )}

        {step === "organization" && (
          <form onSubmit={continueFromOrganization} className="space-y-4">
            <div>
              <h1 className="text-2xl font-semibold text-[var(--foreground)]">Create your organization</h1>
              <p className="mt-1 text-sm text-[var(--muted)]">
                This workspace will hold projects, members, integrations, and settings.
              </p>
            </div>
            <Field>
              <FieldLabel htmlFor="setup-org">Organization name</FieldLabel>
              <Input
                id="setup-org"
                type="text"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="Acme QA"
                autoFocus
              />
            </Field>
            {error && <FieldError>{error}</FieldError>}
            <div className="flex gap-2">
              <Button type="button" variant="secondary" className="flex-1" onClick={() => setStep("admin")}>
                Back
              </Button>
              <Button type="submit" className="flex-1">Continue</Button>
            </div>
          </form>
        )}

        {step === "data" && (
          <form onSubmit={finishSetup} className="space-y-5">
            <div>
              <h1 className="text-2xl font-semibold text-[var(--foreground)]">Choose your starting point</h1>
              <p className="mt-1 text-sm text-[var(--muted)]">
                Start with a sample project, or keep the workspace empty and create projects yourself.
              </p>
            </div>
            <div className="grid gap-3">
              <button
                type="button"
                onClick={() => setDemoData(true)}
                className={`rounded-lg border p-4 text-left transition ${demoData ? "border-[var(--brand-primary)] bg-[var(--brand-soft)]" : "border-[var(--border-subtle)] bg-[var(--surface-primary)] hover:border-[var(--border-strong)]"}`}
              >
                <span className="block font-semibold text-[var(--foreground)]">Generate demo data</span>
                <span className="mt-1 block text-sm text-[var(--muted)]">Create a sample project with starter test cases.</span>
              </button>
              <button
                type="button"
                onClick={() => setDemoData(false)}
                className={`rounded-lg border p-4 text-left transition ${!demoData ? "border-[var(--brand-primary)] bg-[var(--brand-soft)]" : "border-[var(--border-subtle)] bg-[var(--surface-primary)] hover:border-[var(--border-strong)]"}`}
              >
                <span className="block font-semibold text-[var(--foreground)]">Create from new</span>
                <span className="mt-1 block text-sm text-[var(--muted)]">Go to the project listing with a clean workspace.</span>
              </button>
            </div>
            {error && <FieldError>{error}</FieldError>}
            <div className="flex gap-2">
              <Button type="button" variant="secondary" className="flex-1" onClick={() => setStep("organization")} disabled={loading}>
                Back
              </Button>
              <Button type="submit" className="flex-1" disabled={loading}>
                {loading ? "Finishing..." : "Finish setup"}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
