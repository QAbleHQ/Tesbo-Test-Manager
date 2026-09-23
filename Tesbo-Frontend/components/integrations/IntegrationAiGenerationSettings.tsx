"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { getProject, updateProject, type IntegrationProvider } from "@/lib/api";
import { Button, Card } from "@/components/ui";

type ProjectSettingsPayload = Record<string, unknown>;

function parseProjectSettings(raw: unknown): ProjectSettingsPayload {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as ProjectSettingsPayload;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as ProjectSettingsPayload;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * "<Provider> + AI Generation" settings, shown on that provider's project integration page. One
 * shared component for Jira and Linear (and any future provider) — keyed dynamically off `provider`
 * (`project.settings.${provider}AutoComment`) rather than a separate hardcoded component per
 * provider, so a third provider only needs a `provider`/`label` pair passed in here, not a new file.
 */
export function IntegrationAiGenerationSettings({ provider, label }: { provider: IntegrationProvider; label: string }) {
  const params = useParams();
  const projectId = params.id as string;
  const settingsKey = `${provider}AutoComment`;

  const [rawSettings, setRawSettings] = useState<unknown>(null);
  const [autoComment, setAutoComment] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const project = await getProject(projectId);
      const settings = parseProjectSettings(project.settings);
      setRawSettings(project.settings);
      setAutoComment(settings[settingsKey] === true);
    } catch {
      setMessage({ type: "error", text: `Failed to load ${label} settings.` });
    } finally {
      setLoading(false);
    }
  }, [projectId, label, settingsKey]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      const nextSettings: ProjectSettingsPayload = {
        ...parseProjectSettings(rawSettings),
        [settingsKey]: autoComment,
      };
      await updateProject(projectId, { settings: JSON.stringify(nextSettings) });
      const refreshed = await getProject(projectId);
      setRawSettings(refreshed.settings);
      setMessage({ type: "success", text: `${label} settings saved.` });
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : `Failed to save ${label} settings.` });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-4 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-[var(--foreground)]">{label} + AI Generation</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Control how {label} tickets interact with AI test generation in this project.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-[var(--muted)]">Loading…</p>
      ) : (
        <>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={autoComment}
              onChange={(e) => setAutoComment(e.target.checked)}
              className="mt-0.5"
            />
            <div>
              <span className="text-sm font-medium text-[var(--foreground)]">Auto-comment on {label} ticket</span>
              <p className="text-xs text-[var(--muted)] mt-0.5">
                When test cases are generated from a {label} ticket and saved, automatically add a comment to the {label} ticket listing the created test cases.
              </p>
            </div>
          </label>

          {message && (
            <p
              className={`rounded-lg border px-3 py-2 text-sm ${
                message.type === "success"
                  ? "border-[var(--success)]/30 bg-[color-mix(in_oklab,var(--success)_8%,white)] text-[var(--success-foreground)]"
                  : "border-[var(--error)]/30 bg-[color-mix(in_oklab,var(--error)_8%,white)] text-[var(--error-foreground)]"
              }`}
            >
              {message.text}
            </p>
          )}

          <Button type="button" onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      )}
    </Card>
  );
}
