"use client";

import { useEffect, useState, type FormEvent } from "react";
import { startNyraRun, type NyraEnvironment, type NyraRun } from "@/lib/nyra";
import { Button, Field, FieldError, FieldHint, FieldLabel, Input, Modal, Select } from "@/components/ui";

// NYRA's own ceilings; the backend checks them too.
const LIMITS = {
  maxPages: { label: "Max pages", min: 1, max: 500, hint: "Stop after this many pages." },
  maxMinutes: { label: "Max minutes", min: 1, max: 120, hint: "Stop after this long." },
  maxDepth: { label: "Max depth", min: 1, max: 20, hint: "How many links deep to follow." },
} as const;
type BudgetKey = keyof typeof LIMITS;
const DEFAULTS: Record<BudgetKey, string> = { maxPages: "25", maxMinutes: "10", maxDepth: "4" };

export default function NewScanModal({
  open,
  projectId,
  nyraId,
  environments,
  onClose,
  onStarted,
}: {
  open: boolean;
  projectId: string;
  nyraId: string;
  environments: NyraEnvironment[];
  onClose: () => void;
  onStarted: (run: NyraRun) => void;
}) {
  const [envId, setEnvId] = useState("");
  const [budget, setBudget] = useState(DEFAULTS);
  const [errors, setErrors] = useState<Partial<Record<BudgetKey, string>>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEnvId(environments[0]?.id ?? "");
    setBudget(DEFAULTS);
    setErrors({});
    setSubmitError(null);
  }, [open, environments]);

  function validate(): Record<BudgetKey, number> | null {
    const next: Partial<Record<BudgetKey, string>> = {};
    const out = {} as Record<BudgetKey, number>;
    for (const key of Object.keys(LIMITS) as BudgetKey[]) {
      const { label, min, max } = LIMITS[key];
      const n = Number(budget[key]);
      if (!budget[key].trim() || !Number.isInteger(n) || n < min || n > max) next[key] = `${label} must be a whole number from ${min} to ${max}`;
      else out[key] = n;
    }
    setErrors(next);
    return Object.keys(next).length ? null : out;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const values = validate();
    if (!values) return;
    if (!envId) {
      setSubmitError("This project has no environment to scan. Add one in Settings first.");
      return;
    }
    setSaving(true);
    setSubmitError(null);
    try {
      onStarted(await startNyraRun(projectId, nyraId, { environmentId: envId, budget: values }));
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not start the scan.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={() => !saving && onClose()} title="New scan" className="max-w-[560px]">
      <form onSubmit={submit} noValidate className="space-y-4">
        <FieldHint>NYRA opens your app in a browser, follows links within the limits below, and records what it finds. It reads pages; it does not submit forms.</FieldHint>

        {environments.length > 1 && (
          <Field>
            <FieldLabel htmlFor="nyra-scan-env">Environment</FieldLabel>
            <Select id="nyra-scan-env" value={envId} onChange={(e) => setEnvId(e.target.value)}>
              {environments.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name} ({env.baseUrl})
                </option>
              ))}
            </Select>
          </Field>
        )}
        {environments.length === 1 && <FieldHint>Scanning {environments[0].baseUrl}</FieldHint>}

        <div className="grid grid-cols-3 gap-3">
          {(Object.keys(LIMITS) as BudgetKey[]).map((key) => (
            <Field key={key}>
              <FieldLabel htmlFor={`nyra-scan-${key}`}>{LIMITS[key].label}</FieldLabel>
              <Input
                id={`nyra-scan-${key}`}
                inputMode="numeric"
                value={budget[key]}
                onChange={(e) => setBudget((b) => ({ ...b, [key]: e.target.value }))}
              />
              {errors[key] ? <FieldError>{errors[key]}</FieldError> : <FieldHint>{LIMITS[key].hint}</FieldHint>}
            </Field>
          ))}
        </div>

        {submitError && <FieldError>{submitError}</FieldError>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Starting…" : "Start scan"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
