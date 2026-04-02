"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  type TesboAlertRule,
  createTesboAlertRule,
  deleteTesboAlertRule,
  listTesboAlertRules,
  sendTesboAlertTest,
  toggleTesboAlertRule,
  updateTesboAlertRule,
} from "@/lib/api";

export function TesboAlertSettings({ projectId }: { projectId: string }) {
  const [rules, setRules] = useState<TesboAlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [form, setForm] = useState<{
    name: string;
    conditionType: "FAILURE_RATIO" | "PASS_RATIO" | "BUILD_UPDATE";
    comparator: "GREATER_THAN" | "GREATER_OR_EQUAL";
    threshold: number;
    recipientsText: string;
    frequency: "IMMEDIATE" | "DAILY";
    enabled: boolean;
  }>({
    name: "",
    conditionType: "FAILURE_RATIO",
    comparator: "GREATER_OR_EQUAL",
    threshold: 90,
    recipientsText: "",
    frequency: "IMMEDIATE",
    enabled: true,
  });
  const thresholdDisabled = useMemo(() => form.conditionType === "BUILD_UPDATE", [form.conditionType]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRules(await listTesboAlertRules(projectId));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  function parseRecipients(text: string): string[] {
    return Array.from(
      new Set(
        text
          .split(/[\n,]/)
          .map((value) => value.trim())
          .filter(Boolean)
      )
    );
  }

  function startNew() {
    setEditingId(null);
    setForm({
      name: "",
      conditionType: "FAILURE_RATIO",
      comparator: "GREATER_OR_EQUAL",
      threshold: 90,
      recipientsText: "",
      frequency: "IMMEDIATE",
      enabled: true,
    });
  }

  function editRule(rule: TesboAlertRule) {
    setEditingId(rule.id);
    setForm({
      name: rule.name,
      conditionType: rule.conditionType,
      comparator: rule.comparator,
      threshold: rule.threshold ?? 0,
      recipientsText: (rule.recipients ?? []).join(", "),
      frequency: rule.frequency,
      enabled: rule.enabled,
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    setBanner(null);
    try {
      const payload = {
        name: form.name.trim(),
        conditionType: form.conditionType,
        comparator: form.conditionType === "BUILD_UPDATE" ? "GREATER_OR_EQUAL" : form.comparator,
        threshold: form.conditionType === "BUILD_UPDATE" ? 0 : form.threshold,
        recipients: parseRecipients(form.recipientsText),
        frequency: form.frequency,
        enabled: form.enabled,
      };
      if (editingId) {
        await updateTesboAlertRule(projectId, editingId, payload);
        setBanner("Alert updated.");
      } else {
        await createTesboAlertRule(projectId, payload);
        setBanner("Alert created.");
      }
      await load();
      startNew();
    } catch {
      setBanner("Failed to save alert.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <h2 className="text-base font-semibold text-[var(--foreground)]">Tesbo Alerts</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Manage alert rules for Tesbo run quality thresholds.
      </p>
      {banner && <p className="mt-3 text-sm text-[var(--muted)]">{banner}</p>}

      <form className="mt-4 space-y-3 rounded-lg border border-[var(--border)] p-3" onSubmit={handleSubmit}>
        <input
          value={form.name}
          onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
          placeholder="Rule name"
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-soft)]"
          required
        />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <select
            value={form.conditionType}
            onChange={(e) =>
              setForm((prev) => ({
                ...prev,
                conditionType: e.target.value as "FAILURE_RATIO" | "PASS_RATIO" | "BUILD_UPDATE",
              }))
            }
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--foreground)]"
          >
            <option value="FAILURE_RATIO">Failure ratio</option>
            <option value="PASS_RATIO">Pass ratio</option>
            <option value="BUILD_UPDATE">Every build update</option>
          </select>
          <select
            value={form.comparator}
            onChange={(e) =>
              setForm((prev) => ({ ...prev, comparator: e.target.value as "GREATER_THAN" | "GREATER_OR_EQUAL" }))
            }
            disabled={thresholdDisabled}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--foreground)] disabled:opacity-60"
          >
            <option value="GREATER_OR_EQUAL">Greater or equal</option>
            <option value="GREATER_THAN">Greater than</option>
          </select>
          <input
            type="number"
            min={0}
            max={100}
            value={form.threshold}
            onChange={(e) => setForm((prev) => ({ ...prev, threshold: Number(e.target.value || 0) }))}
            disabled={thresholdDisabled}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--foreground)] disabled:opacity-60"
          />
        </div>
        <textarea
          value={form.recipientsText}
          onChange={(e) => setForm((prev) => ({ ...prev, recipientsText: e.target.value }))}
          placeholder="Recipients (comma or newline separated)"
          className="h-20 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-soft)]"
        />
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={form.frequency}
            onChange={(e) => setForm((prev) => ({ ...prev, frequency: e.target.value as "IMMEDIATE" | "DAILY" }))}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--foreground)]"
          >
            <option value="IMMEDIATE">Immediate</option>
            <option value="DAILY">Daily</option>
          </select>
          <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((prev) => ({ ...prev, enabled: e.target.checked }))}
            />
            Enabled
          </label>
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg border border-transparent bg-[var(--brand-primary)] px-3 py-2 text-sm text-white transition-colors hover:bg-[var(--brand-hover)] disabled:opacity-50"
          >
            {saving ? "Saving..." : editingId ? "Update alert" : "Create alert"}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={startNew}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--surface-secondary)]"
            >
              Clear
            </button>
          )}
        </div>
      </form>

      {loading ? (
        <p className="mt-4 text-sm text-[var(--muted)]">Loading alerts…</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2"
            >
              <div>
                <p className="text-sm font-medium text-[var(--foreground)]">{rule.name}</p>
                <p className="text-xs text-[var(--muted)]">
                  {rule.conditionType} {rule.comparator} {rule.threshold ?? 0}
                </p>
                <p className="text-xs text-[var(--muted)]">
                  {(rule.recipients ?? []).length > 0 ? (rule.recipients ?? []).join(", ") : "No recipients"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setBusyId(rule.id);
                    toggleTesboAlertRule(projectId, rule.id, !rule.enabled)
                      .then(load)
                      .finally(() => setBusyId(null));
                  }}
                  className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--surface-secondary)]"
                  disabled={busyId === rule.id}
                >
                  {rule.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setBusyId(rule.id);
                    sendTesboAlertTest(projectId, rule.id)
                      .then(() => setBanner("Test alert sent."))
                      .finally(() => setBusyId(null));
                  }}
                  className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--surface-secondary)]"
                  disabled={busyId === rule.id}
                >
                  Send test
                </button>
                <button
                  type="button"
                  onClick={() => editRule(rule)}
                  className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--surface-secondary)]"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setBusyId(rule.id);
                    deleteTesboAlertRule(projectId, rule.id)
                      .then(load)
                      .finally(() => setBusyId(null));
                  }}
                  className="rounded border border-[var(--error-border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--error)] transition-colors hover:bg-[var(--error-soft)]"
                  disabled={busyId === rule.id}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
          {rules.length === 0 && (
            <li className="text-sm text-[var(--muted)]">No alert rules configured.</li>
          )}
        </ul>
      )}
    </div>
  );
}
