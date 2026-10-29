"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useParams } from "@/lib/routeParams";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { IconPlus } from "@tabler/icons-react";
import {
  createNyraProject,
  getBillingInfo,
  getNyraAgent,
  listNyraProjects,
  type BillingInfo,
  type NyraProject,
} from "@/lib/api";
import { Button, Card, Field, FieldError, FieldHint, FieldLabel, Input, Modal, PageLoader, PasswordInput, Select, StatusChip } from "@/components/ui";
import PricingModal from "@/components/PricingModal";
import { ListWorkspaceLayout, PageHeader, Breadcrumbs } from "@/components/workflows";
import { useAppData } from "@/components/app/AppDataProvider";
import { useProjectData } from "@/components/project/ProjectDataProvider";
import { formatDate } from "@/lib/date";

const errorBox = "rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error-foreground)]";
const errText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

function normalizeRole(role: string): "owner" | "manager" | "qa_engineer" {
  const n = (role ?? "").trim().toLowerCase().replace(/-/g, "_").replace(/ /g, "_");
  if (n === "owner") return "owner";
  if (["manager", "admin", "test_manager"].includes(n)) return "manager";
  return "qa_engineer";
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const EMPTY = { name: "", appUrl: "", loginUrl: "", username: "", password: "" };

export default function NyraPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const { currentUser } = useAppData();
  const { project, projectMembers } = useProjectData();
  const projectName = String(project.name || "");
  const role = currentUser ? normalizeRole(projectMembers.find((m) => m.userId === currentUser.userId)?.role ?? "qa_engineer") : "qa_engineer";
  const canCreate = role !== "qa_engineer";

  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [billingError, setBillingError] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<NyraProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const isPro = !!billing && (billing.enabled === false || billing.plan === "pro" || billing.inGracePeriod);

  useEffect(() => {
    if (!currentUser) router.replace("/login");
  }, [currentUser, router]);

  useEffect(() => {
    getBillingInfo().then(setBilling).catch(() => setBillingError(true));
  }, []);

  const load = useCallback(async () => {
    try {
      const state = await getNyraAgent(projectId);
      setConfigured(state.configured);
      if (state.configured) setProjects((await listNyraProjects(projectId)).list);
      setError(null);
    } catch (err) {
      setError(errText(err, "Failed to load NYRA projects."));
    }
  }, [projectId]);

  useEffect(() => {
    if (isPro) void load();
  }, [isPro, load]);

  const header = (
    <PageHeader
      title="NYRA"
      subtitle="Create a NYRA project for each app you want explored. Runs, recordings and reports never mix between projects."
      breadcrumb={
        <Breadcrumbs
          items={[
            { label: "Projects", href: "/projects" },
            { label: projectName || "Project", href: `/projects/${projectId}/dashboard` },
            { label: "Agents", href: `/projects/${projectId}/agents` },
            { label: "NYRA" },
          ]}
        />
      }
      actions={
        isPro && configured && canCreate ? (
          <Button type="button" onClick={() => setModalOpen(true)}>
            <IconPlus size={16} stroke={1.75} /> New project
          </Button>
        ) : undefined
      }
    />
  );

  if (billingError) {
    return (
      <ListWorkspaceLayout header={header}>
        <p className={errorBox}>Couldn&apos;t verify your plan. Reload to try again.</p>
      </ListWorkspaceLayout>
    );
  }
  if (!billing) {
    return (
      <ListWorkspaceLayout header={header}>
        <PageLoader label="Checking your plan…" />
      </ListWorkspaceLayout>
    );
  }
  if (!isPro) {
    return (
      <ListWorkspaceLayout header={header}>
        <Card className="p-5">
          <h2 className="text-base font-semibold text-[var(--foreground)]">NYRA is a Pro plan feature</h2>
          <p className="mt-1.5 text-sm text-[var(--muted)]">Upgrade to Pro to create NYRA projects for the apps you test.</p>
          <Button type="button" className="mt-3" onClick={() => setPricingOpen(true)}>
            Upgrade to Pro
          </Button>
        </Card>
        <PricingModal open={pricingOpen} onClose={() => setPricingOpen(false)} billingInfo={billing} />
      </ListWorkspaceLayout>
    );
  }

  return (
    <ListWorkspaceLayout header={header}>
      {error && <p className={errorBox}>{error}</p>}

      {configured === false && (
        <Card className="p-5">
          <h2 className="text-base font-semibold text-[var(--foreground)]">NYRA is not configured</h2>
          <p className="mt-1.5 text-sm text-[var(--muted)]">An administrator needs to set NYRA_API_KEY and NYRA_BASE_URL on the server.</p>
        </Card>
      )}

      {configured && projects === null && !error && <PageLoader label="Loading NYRA projects…" />}

      {projects && projects.length === 0 && (
        <Card className="p-5">
          <h2 className="text-base font-semibold text-[var(--foreground)]">No NYRA projects yet</h2>
          <p className="mt-1.5 text-sm text-[var(--muted)]">
            {canCreate ? "Create one to point NYRA at an app." : "Ask a project owner or manager to create one."}
          </p>
        </Card>
      )}

      {projects && projects.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Link key={p.id} href={`/projects/${projectId}/agents/nyra/${p.id}`} className="block rounded-[10px] transition hover:shadow-[var(--shadow-card)]">
              <Card className="h-full p-5 transition hover:border-[var(--brand-primary)]" data-testid="nyra-project">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="min-w-0 break-words text-[15px] font-semibold text-[var(--foreground)]">{p.name}</h3>
                  <StatusChip tone={p.hasTestAccount ? "success" : "neutral"}>{p.hasTestAccount ? "Test account" : "No test account"}</StatusChip>
                </div>
                <p className="mt-1 break-all text-[13px] text-[var(--muted)]">{p.appUrl}</p>
                {p.username && <p className="mt-1 text-[12px] text-[var(--muted-soft)]">Signs in as {p.username}</p>}
                <div className="mt-3 flex items-center justify-between text-[11px] text-[var(--muted-soft)]">
                  <span>{p.createdAt ? `Created ${formatDate(new Date(p.createdAt))}` : ""}</span>
                  <span className="font-medium text-[var(--accent-light)]">Open</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <NewProjectModal
        open={modalOpen}
        projectId={projectId}
        onClose={() => setModalOpen(false)}
        onCreated={(created) => {
          setProjects((prev) => [...(prev ?? []), created]);
          setModalOpen(false);
        }}
      />
    </ListWorkspaceLayout>
  );
}

function NewProjectModal({
  open,
  projectId,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onCreated: (p: NyraProject) => void;
}) {
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof typeof EMPTY, string>>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  // A closed modal must not keep a typed password around for the next open.
  useEffect(() => {
    if (!open) {
      setForm(EMPTY);
      setErrors({});
      setSubmitError(null);
    }
  }, [open]);

  const set = (key: keyof typeof EMPTY) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  function validate() {
    const next: Partial<Record<keyof typeof EMPTY, string>> = {};
    if (!form.name.trim()) next.name = "Project name is required";
    else if (form.name.trim().length > 120) next.name = "Project name must be at most 120 characters";
    if (!form.appUrl.trim()) next.appUrl = "App URL is required";
    else if (!isHttpUrl(form.appUrl.trim())) next.appUrl = "Enter a valid URL starting with http:// or https://";
    if (form.loginUrl.trim() && !isHttpUrl(form.loginUrl.trim())) next.loginUrl = "Enter a valid URL starting with http:// or https://";
    const anyAccount = form.loginUrl.trim() || form.username.trim() || form.password;
    if (anyAccount && !form.username.trim()) next.username = "Username or email is required for the test account";
    if (anyAccount && !form.password) next.password = "Password is required for the test account";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving || !validate()) return;
    setSaving(true);
    setSubmitError(null);
    try {
      const anyAccount = form.loginUrl.trim() || form.username.trim() || form.password;
      const created = await createNyraProject(projectId, {
        name: form.name.trim(),
        appUrl: form.appUrl.trim(),
        ...(anyAccount && {
          testAccount: {
            loginUrl: form.loginUrl.trim() || undefined,
            username: form.username.trim(),
            loginMethod: "password" as const,
            password: form.password,
          },
        }),
      });
      onCreated(created);
    } catch (err) {
      setSubmitError(errText(err, "Failed to create the project."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={() => !saving && onClose()} title="New project" className="max-w-[640px]">
      <form onSubmit={submit} noValidate className="space-y-4">
        <FieldHint>
          A project is a separate workspace for one app you are testing, such as an online shop or its admin portal. Runs, recordings and reports never mix between projects.
        </FieldHint>

        <Field>
          <FieldLabel htmlFor="nyra-name">Project name</FieldLabel>
          <Input id="nyra-name" placeholder="Online shop" value={form.name} onChange={set("name")} maxLength={120} autoComplete="off" />
          {errors.name && <FieldError>{errors.name}</FieldError>}
        </Field>
        <Field>
          <FieldLabel htmlFor="nyra-app-url">App URL</FieldLabel>
          <Input id="nyra-app-url" placeholder="https://staging.example.com" value={form.appUrl} onChange={set("appUrl")} autoComplete="off" />
          {errors.appUrl && <FieldError>{errors.appUrl}</FieldError>}
        </Field>

        <fieldset className="space-y-3 rounded-lg border border-[var(--border-subtle)] p-4">
          <legend className="px-1 text-[13px] text-[var(--muted)]">Test account (optional). Use a dedicated test user, never a real one.</legend>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="nyra-login-url">Login page URL</FieldLabel>
              <Input id="nyra-login-url" placeholder="Defaults to the app URL" value={form.loginUrl} onChange={set("loginUrl")} autoComplete="off" />
              {errors.loginUrl && <FieldError>{errors.loginUrl}</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor="nyra-username">Username or email</FieldLabel>
              <Input id="nyra-username" value={form.username} onChange={set("username")} maxLength={255} autoComplete="off" />
              {errors.username && <FieldError>{errors.username}</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor="nyra-login-method">Login method</FieldLabel>
              {/* Password only: the other NYRA methods need an emailed code a person must read. */}
              <Select id="nyra-login-method" value="password" onChange={() => undefined}>
                <option value="password">Password</option>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="nyra-password">Password</FieldLabel>
              <PasswordInput id="nyra-password" value={form.password} onChange={set("password")} maxLength={512} autoComplete="new-password" />
              {errors.password && <FieldError>{errors.password}</FieldError>}
            </Field>
          </div>
          <FieldHint>The password is sent to NYRA once and is not stored or shown by Tesbo.</FieldHint>
        </fieldset>

        {submitError && <FieldError>{submitError}</FieldError>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Creating…" : "Create project"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
