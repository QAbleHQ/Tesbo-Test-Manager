"use client";

import { useEffect, useState } from "react";
import { getTestCase } from "@/lib/api";
import {
  changedEditFields,
  DIFFERENCE_LABEL,
  editReviewRecommendation,
  parseSteps,
  type ReviewEditResult,
  type ReviewRecommendation,
  type Step,
} from "@/lib/reviewBoard";
import { Button, Field, FieldLabel, Input, Modal, PageLoader, Textarea } from "@/components/ui";

type Draft = { title: string; description: string; preconditions: string; postconditions: string; testData: string; steps: Step[] };
type Loaded = { targetId: string; original: Record<string, unknown>; draft: Draft };

function toDraft(row: Record<string, unknown>): Draft {
  const text = (k: string) => (typeof row[k] === "string" ? (row[k] as string) : "");
  const steps = parseSteps(row.steps);
  return {
    title: text("title"),
    description: text("description"),
    preconditions: text("preconditions"),
    postconditions: text("postconditions"),
    testData: text("testData"),
    steps: steps.length ? steps : [{ action: "", expected: "" }],
  };
}

const FIELD_LABEL: Record<string, string> = { ...DIFFERENCE_LABEL, description: "Description" };

/**
 * Edits ONE test case of a finding. The case is re-read through getTestCase when the modal opens (and when
 * the reviewer switches case), so the form never starts from stale analysis-time content. Saving is a
 * deliberate two-step: review which fields changed, then confirm. Only changed fields are sent, to the
 * Review Board's own edit endpoint (owner/manager + Pro enforced server-side).
 */
export default function ReviewEditModal({
  projectId,
  recommendation,
  onClose,
  onSaved,
}: {
  projectId: string;
  recommendation: ReviewRecommendation | null;
  onClose: () => void;
  onSaved: (result: ReviewEditResult) => void;
}) {
  const [saving, setSaving] = useState(false);
  return (
    <Modal open={!!recommendation} onClose={() => !saving && onClose()} title="Edit a test case" className="max-w-3xl">
      {/* Keyed by finding, so opening another one starts from a clean state. */}
      {recommendation && (
        <EditBody key={recommendation.id} projectId={projectId} rec={recommendation} saving={saving} setSaving={setSaving} onClose={onClose} onSaved={onSaved} />
      )}
    </Modal>
  );
}

function EditBody({
  projectId,
  rec,
  saving,
  setSaving,
  onClose,
  onSaved,
}: {
  projectId: string;
  rec: ReviewRecommendation;
  saving: boolean;
  setSaving: (value: boolean) => void;
  onClose: () => void;
  onSaved: (result: ReviewEditResult) => void;
}) {
  const [targetId, setTargetId] = useState(rec.testcaseA.id);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [loadError, setLoadError] = useState<{ targetId: string; message: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTestCase(projectId, targetId)
      .then((row) => {
        if (!cancelled) setLoaded({ targetId, original: row, draft: toDraft(row) });
      })
      .catch((err) => {
        if (!cancelled) setLoadError({ targetId, message: err instanceof Error ? err.message : "Failed to load the test case." });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, targetId]);

  // Loading is derived: whatever is held belongs to a different case than the one selected.
  const current = loaded && loaded.targetId === targetId ? loaded : null;
  const error = loadError && loadError.targetId === targetId ? loadError.message : null;
  const target = [rec.testcaseA, rec.testcaseB].find((t) => t.id === targetId);
  const changes = current ? changedEditFields(current.original, current.draft) : {};
  const changedKeys = Object.keys(changes) as Array<keyof typeof changes>;
  const canReview = !!current && changedKeys.length > 0 && current.draft.title.trim().length > 0;

  function patch(part: Partial<Draft>) {
    setLoaded((l) => (l ? { ...l, draft: { ...l.draft, ...part } } : l));
  }

  function patchStep(index: number, part: Partial<Step>) {
    setLoaded((l) => (l ? { ...l, draft: { ...l.draft, steps: l.draft.steps.map((s, i) => (i === index ? { ...s, ...part } : s)) } } : l));
  }

  function selectTarget(id: string) {
    setTargetId(id);
    setConfirming(false);
    setSaveError(null);
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await editReviewRecommendation(projectId, rec.id, targetId, changes);
      onSaved(result);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save the changes.");
      setConfirming(false);
    } finally {
      setSaving(false);
    }
  }

  const draft = current?.draft;
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2" disabled={saving}>
        <legend className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">Which test case do you want to edit?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {[rec.testcaseA, rec.testcaseB].map((t) => (
            <label
              key={t.id}
              className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
                targetId === t.id ? "border-[var(--brand-primary)] bg-[var(--surface-secondary)]" : "border-[var(--border)]"
              }`}
            >
              <input type="radio" name="review-edit-target" className="mt-1" checked={targetId === t.id} onChange={() => selectTarget(t.id)} />
              <span className="min-w-0">
                <span className="block font-mono text-xs text-[var(--muted)]">{t.externalId}</span>
                <span className="line-clamp-2 font-medium text-[var(--foreground)]">{t.title}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {error && <p className="rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error-foreground)]">{error}</p>}
      {!draft && !error && <PageLoader variant="inline" label="Loading test case…" />}

      {draft && !confirming && (
        <div className="space-y-3">
          <Field>
            <FieldLabel>Title</FieldLabel>
            <Input value={draft.title} onChange={(e) => patch({ title: e.target.value })} maxLength={512} />
          </Field>
          <Field>
            <FieldLabel>Description</FieldLabel>
            <Textarea rows={2} value={draft.description} onChange={(e) => patch({ description: e.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel>Preconditions</FieldLabel>
              <Textarea rows={3} value={draft.preconditions} onChange={(e) => patch({ preconditions: e.target.value })} />
            </Field>
            <Field>
              <FieldLabel>Test data</FieldLabel>
              <Textarea rows={3} value={draft.testData} onChange={(e) => patch({ testData: e.target.value })} />
            </Field>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <FieldLabel>Steps</FieldLabel>
              <Button type="button" size="sm" variant="secondary" onClick={() => patch({ steps: [...draft.steps, { action: "", expected: "" }] })}>
                Add step
              </Button>
            </div>
            {draft.steps.map((step, index) => (
              <div key={index} className="grid gap-2 rounded-lg border border-[var(--border)] p-2 sm:grid-cols-[1fr_1fr_auto]">
                <Textarea rows={2} aria-label={`Step ${index + 1} action`} placeholder={`Step ${index + 1} action`} value={step.action} onChange={(e) => patchStep(index, { action: e.target.value })} />
                <Textarea rows={2} aria-label={`Step ${index + 1} expected result`} placeholder="Expected result" value={step.expected} onChange={(e) => patchStep(index, { expected: e.target.value })} />
                <Button type="button" size="sm" variant="ghost" aria-label={`Remove step ${index + 1}`} onClick={() => patch({ steps: draft.steps.filter((_, i) => i !== index) })}>
                  Remove
                </Button>
              </div>
            ))}
          </div>
          <Field>
            <FieldLabel>Postconditions</FieldLabel>
            <Textarea rows={2} value={draft.postconditions} onChange={(e) => patch({ postconditions: e.target.value })} />
          </Field>
        </div>
      )}

      {draft && confirming && target && (
        <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3 text-sm">
          <p className="font-medium text-[var(--foreground)]">
            Save changes to <span className="font-mono">{target.externalId}</span>?
          </p>
          <p className="text-[var(--muted)]">
            Changing: {changedKeys.map((k) => FIELD_LABEL[k] ?? k).join(", ")}. The other test case is not touched, and this edit is recorded in the audit log.
          </p>
        </div>
      )}

      {saveError && <p className="rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error-foreground)]">{saveError}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={confirming ? () => setConfirming(false) : onClose} disabled={saving}>
          {confirming ? "Back" : "Cancel"}
        </Button>
        {confirming ? (
          <Button type="button" onClick={() => void handleSave()} disabled={saving}>{saving ? "Saving..." : "Confirm and save"}</Button>
        ) : (
          <Button type="button" onClick={() => setConfirming(true)} disabled={!canReview}>Review changes</Button>
        )}
      </div>
    </div>
  );
}
