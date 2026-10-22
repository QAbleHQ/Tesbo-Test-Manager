"use client";

import { useEffect, useState, type FormEvent } from "react";
import { updateNyraEnvironment, type NyraEnvironment, type NyraProjectDetail } from "@/lib/nyra";
import { Button, Field, FieldError, FieldHint, FieldLabel, Input, Modal, PasswordInput, Select, Textarea } from "@/components/ui";

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

type Form = { name: string; baseUrl: string; mode: "observe" | "sandbox"; domains: string; loginUrl: string; username: string; password: string };

function toForm(env: NyraEnvironment): Form {
  return {
    name: env.name,
    baseUrl: env.baseUrl ?? "",
    mode: env.mode,
    domains: env.allowedDomains.join("\n"),
    loginUrl: env.loginUrl ?? "",
    username: env.username ?? "",
    password: "",
  };
}

/** Edits the project's environment (NYRA uses the first one), as standalone NYRA's Settings does. */
export default function NyraSettingsModal({
  open,
  projectId,
  nyraId,
  environment,
  onClose,
  onSaved,
}: {
  open: boolean;
  projectId: string;
  nyraId: string;
  environment: NyraEnvironment | null;
  onClose: () => void;
  onSaved: (project: NyraProjectDetail) => void;
}) {
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(environment ? toForm(environment) : null);
    setErrors({});
    setSubmitError(null);
  }, [open, environment]);

  if (!environment || !form) return <Modal open={open} onClose={onClose} title="Settings"><FieldHint>This project has no environment yet.</FieldHint></Modal>;

  const set = (key: keyof Form) => (e: { target: { value: string } }) => setForm((f) => (f ? { ...f, [key]: e.target.value } : f));
  const domainList = () => form.domains.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);

  function validate() {
    const next: Partial<Record<keyof Form, string>> = {};
    if (!form!.name.trim()) next.name = "Environment name is required";
    else if (form!.name.trim().length > 60) next.name = "Environment name must be at most 60 characters";
    if (!isHttpUrl(form!.baseUrl.trim())) next.baseUrl = "Enter a valid URL starting with http:// or https://";
    if (domainList().some((d) => !DOMAIN.test(d))) next.domains = "Each domain must be a full hostname such as accounts.example.com";
    if (form!.loginUrl.trim() && !isHttpUrl(form!.loginUrl.trim())) next.loginUrl = "Enter a valid URL starting with http:// or https://";
    const hasAccount = form!.loginUrl.trim() || form!.username.trim() || form!.password;
    if (hasAccount && !form!.username.trim()) next.username = "Username or email is required for the test account";
    // A blank password keeps the saved one, which only exists if one was saved.
    if (hasAccount && !form!.password && !environment!.hasPassword) next.password = "Password is required for the test account";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving || !validate()) return;
    setSaving(true);
    setSubmitError(null);
    try {
      const hasAccount = form!.loginUrl.trim() || form!.username.trim() || form!.password;
      const saved = await updateNyraEnvironment(projectId, nyraId, environment!.id, {
        name: form!.name.trim(),
        baseUrl: form!.baseUrl.trim(),
        mode: form!.mode,
        allowedDomains: domainList(),
        ...(hasAccount && {
          testAccount: { loginUrl: form!.loginUrl.trim() || undefined, username: form!.username.trim(), loginMethod: "password" as const, ...(form!.password && { password: form!.password }) },
        }),
      });
      onSaved(saved);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not save the settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={() => !saving && onClose()} title="Settings" className="max-w-[640px]">
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor="nyra-env-name">Environment name</FieldLabel>
            <Input id="nyra-env-name" value={form.name} onChange={set("name")} maxLength={60} autoComplete="off" />
            {errors.name && <FieldError>{errors.name}</FieldError>}
          </Field>
          <Field>
            <FieldLabel htmlFor="nyra-env-mode">Mode</FieldLabel>
            <Select id="nyra-env-mode" value={form.mode} onChange={set("mode")}>
              <option value="observe">Observe (read only)</option>
              <option value="sandbox">Sandbox (allows most writes)</option>
            </Select>
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="nyra-env-url">App URL</FieldLabel>
          <Input id="nyra-env-url" value={form.baseUrl} onChange={set("baseUrl")} autoComplete="off" />
          {errors.baseUrl && <FieldError>{errors.baseUrl}</FieldError>}
        </Field>
        <Field>
          <FieldLabel htmlFor="nyra-env-domains">Extra allowed domains</FieldLabel>
          <Textarea id="nyra-env-domains" rows={3} value={form.domains} onChange={set("domains")} placeholder="accounts.example.com" />
          {errors.domains ? <FieldError>{errors.domains}</FieldError> : <FieldHint>One per line. NYRA follows links to these hosts as well as the app URL.</FieldHint>}
        </Field>

        <fieldset className="space-y-3 rounded-lg border border-[var(--border-subtle)] p-4">
          <legend className="px-1 text-[13px] text-[var(--muted)]">Test account (optional). Use a dedicated test user, never a real one.</legend>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="nyra-env-login-url">Login page URL</FieldLabel>
              <Input id="nyra-env-login-url" placeholder="Defaults to the app URL" value={form.loginUrl} onChange={set("loginUrl")} autoComplete="off" />
              {errors.loginUrl && <FieldError>{errors.loginUrl}</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor="nyra-env-username">Username or email</FieldLabel>
              <Input id="nyra-env-username" value={form.username} onChange={set("username")} maxLength={255} autoComplete="off" />
              {errors.username && <FieldError>{errors.username}</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor="nyra-env-method">Login method</FieldLabel>
              <Select id="nyra-env-method" value="password" onChange={() => undefined}>
                <option value="password">Password</option>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="nyra-env-password">Password</FieldLabel>
              <PasswordInput
                id="nyra-env-password"
                value={form.password}
                onChange={set("password")}
                maxLength={512}
                autoComplete="new-password"
                placeholder={environment.hasPassword ? "Leave blank to keep the saved password" : ""}
              />
              {errors.password && <FieldError>{errors.password}</FieldError>}
            </Field>
          </div>
          <FieldHint>The password is sent to NYRA and is not stored or shown by Tesbo. A saved test account cannot be removed from here.</FieldHint>
        </fieldset>

        {submitError && <FieldError>{submitError}</FieldError>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save settings"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
