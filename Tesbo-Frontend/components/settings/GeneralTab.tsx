"use client";

import { useMemo, useState } from "react";
import { updateWorkspace } from "@/lib/api";
import { countryOptions } from "@/lib/countries";
import { Button, Card, Field, FieldError, FieldHint, FieldLabel, Input, Select } from "@/components/ui";
import { useAppData } from "@/components/app/AppDataProvider";

export default function GeneralTab() {
  // workspace is already resolved by AppDataProvider by the time this tab mounts (settings/page.tsx
  // redirects away before rendering any tab if it's missing), so edit state seeds directly from
  // context on first render instead of independently re-fetching it. Saving still does a full page
  // reload (below), which is what keeps this in sync with the rest of the app after a change.
  const { workspace } = useAppData();
  const [name, setName] = useState(() => workspace?.name || "");
  const [savedName] = useState(() => workspace?.name || "");
  const [country, setCountry] = useState(() => workspace?.country || "");
  const [savedCountry] = useState(() => workspace?.country || "");
  const countries = useMemo(() => countryOptions(), []);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState("");
  const [formError, setFormError] = useState(() => (workspace ? "" : "Failed to load workspace"));
  const [toast, setToast] = useState("");

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setNameError("");
    setFormError("");
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("Workspace name is required");
      return;
    }
    if (trimmed === savedName && country === savedCountry) return;
    setSaving(true);
    try {
      await updateWorkspace({ name: trimmed, country });
      showToast("Workspace details updated");
      // Sidebar, workspace switcher, and this page's header all read the name
      // from separate client-side fetches — reload so they all pick it up.
      //
      // Delayed, because reloading on the same tick tore the toast down before it could be read: the
      // save appeared to produce no confirmation at all, which is the other half of Basecamp
      // 10212550781. Short enough that the header still updates promptly.
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to update workspace");
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-[var(--foreground)]">General</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Basic details for this workspace.
        </p>
      </div>

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 rounded-[var(--radius-control)] bg-[var(--toast-surface)] px-4 py-2.5 text-sm text-[var(--toast-foreground)] shadow-lg">
          {toast}
        </div>
      )}

      <Card className="p-5">
        <form onSubmit={handleSubmit} className="max-w-md space-y-4">
          <Field>
            <FieldLabel htmlFor="workspace-name">Workspace name</FieldLabel>
            <Input
              id="workspace-name"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError("");
              }}
              placeholder="My Team"
              disabled={saving}
              maxLength={255}
              aria-invalid={Boolean(nameError)}
            />
            {nameError && <FieldError>{nameError}</FieldError>}
          </Field>

          <Field>
            <FieldLabel htmlFor="workspace-country">Country</FieldLabel>
            <Select id="workspace-country" value={country} onChange={(e) => setCountry(e.target.value)} disabled={saving}>
              <option value="">Not set</option>
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </Select>
            <FieldHint>
              Helps pick the right currency at checkout. Your location is detected automatically at checkout — this is only used as
              a fallback when that isn&apos;t possible.
            </FieldHint>
          </Field>

          {formError && <FieldError>{formError}</FieldError>}

          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={saving || !name.trim() || (name.trim() === savedName && country === savedCountry)}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
