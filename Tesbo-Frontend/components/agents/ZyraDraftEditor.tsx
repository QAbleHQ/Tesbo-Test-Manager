"use client";

import { useState } from "react";
import { Button, Field, FieldLabel, Input, Select, Textarea } from "@/components/ui";
import type { ZyraChatTestcaseRow } from "@/lib/api";
import { useZyraText } from "@/lib/zyra-i18n";

type Step = { action: string; expectedResult: string };

const PRIORITIES = ["P0", "P1", "P2", "P3"];
// Same vocabulary as testcases/page.tsx's TESTCASE_SEVERITIES and the backend's BUG_SEVERITIES
// allow-list (normalizeZyraSeverity) — keeps this Select from ever offering a value the server
// would silently drop back to null.
const SEVERITIES = ["Critical", "High", "Medium", "Low"];

// Same shape editZyraTaskDraft accepts server-side (legacy.service.ts sanitizeZyraUpdateFields) —
// title/priority/preconditions/description/stepsJson/testData/severity/component cover a proposed
// draft either way (a new test case, or a proposed change to an existing one).
export type ZyraDraftEditValues = {
  title: string;
  priority: string;
  preconditions: string;
  description: string;
  stepsJson: string;
  /** Only present when the user changed it — see handleSave. */
  testData?: string;
  severity: string;
  component: string;
};

function parseSteps(raw: unknown): Step[] {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed) || parsed.length === 0) return [{ action: "", expectedResult: "" }];
    return parsed.map((step): Step => {
      if (typeof step === "string") return { action: step, expectedResult: "" };
      if (step && typeof step === "object") {
        const value = step as Record<string, unknown>;
        return {
          action: String(value.action || value.step || value.description || ""),
          expectedResult: String(value.expectedResult || value.expected || ""),
        };
      }
      return { action: "", expectedResult: "" };
    });
  } catch {
    return [{ action: "", expectedResult: "" }];
  }
}

/** Inline editor for one proposed draft's fields — the review step's "edit" action. */
export function ZyraDraftEditor({
  row,
  saving,
  onCancel,
  onSave,
}: {
  row: ZyraChatTestcaseRow;
  saving: boolean;
  onCancel: () => void;
  onSave: (values: ZyraDraftEditValues) => void;
}) {
  const [title, setTitle] = useState(row.title || "");
  const [priority, setPriority] = useState(row.priority || "P2");
  const [preconditions, setPreconditions] = useState(row.preconditions || "");
  const [description, setDescription] = useState(row.expectedSummary || "");
  const [steps, setSteps] = useState<Step[]>(parseSteps(row.stepsJson));
  const initialTestData = row.testData ?? "";
  const [testData, setTestData] = useState(initialTestData);
  const [severity, setSeverity] = useState(row.severity || "");
  const [component, setComponent] = useState(row.component || "");
  const t = useZyraText();

  function addStep() {
    setSteps((prev) => [...prev, { action: "", expectedResult: "" }]);
  }
  function removeStep(index: number) {
    setSteps((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }
  function updateStep(index: number, field: keyof Step, value: string) {
    setSteps((prev) => prev.map((step, i) => (i === index ? { ...step, [field]: value } : step)));
  }

  function handleSave() {
    onSave({
      title: title.trim(),
      priority,
      preconditions,
      description,
      stepsJson: JSON.stringify(steps.map((step, index) => ({ stepNumber: index + 1, action: step.action, expectedResult: step.expectedResult }))),
      // Sent only when edited: a row snapshotted onto a chat message before it carried testData
      // opens this field blank even though the stored draft has a value, and the server merges
      // whatever it's sent — an untouched blank would silently wipe that value on any other edit.
      ...(testData !== initialTestData ? { testData } : {}),
      severity,
      component: component.trim(),
    });
  }

  return (
    <div className="space-y-3 rounded-lg border border-[var(--brand-border)] bg-[var(--surface)] p-3">
      <Field>
        <FieldLabel>{t("col.title")}</FieldLabel>
        <Input value={title} onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <Field>
        <FieldLabel>{t("col.priority")}</FieldLabel>
        <Select value={priority} onChange={(event) => setPriority(event.target.value)}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </Select>
      </Field>
      <Field>
        <FieldLabel>{t("col.severity")}</FieldLabel>
        <Select value={severity} onChange={(event) => setSeverity(event.target.value)}>
          <option value="">{t("editor.select")}</option>
          {/* The option value stays the English severity the API stores; only the label is localized. */}
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>{t.value("severity", s)}</option>
          ))}
        </Select>
      </Field>
      <Field>
        <FieldLabel>{t("col.component")}</FieldLabel>
        <Input value={component} onChange={(event) => setComponent(event.target.value)} placeholder={t("editor.componentPlaceholder")} />
      </Field>
      <Field>
        <FieldLabel>{t("col.preconditions")}</FieldLabel>
        <Textarea value={preconditions} onChange={(event) => setPreconditions(event.target.value)} rows={2} />
      </Field>
      {/* Bound to the draft's description — what zyraSave writes to the test case's Description
          column, and what the repository's edit form shows under that same label. */}
      <Field>
        <FieldLabel>{t("drawer.description")}</FieldLabel>
        <Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} />
      </Field>
      <Field>
        <FieldLabel>{t("drawer.testData")}</FieldLabel>
        <Textarea value={testData} onChange={(event) => setTestData(event.target.value)} rows={2} placeholder="Input data, sample values, or setup-specific data" />
      </Field>
      <div>
        <FieldLabel>{t("col.steps")}</FieldLabel>
        <div className="mt-1.5 space-y-2">
          {steps.map((step, index) => (
            <div key={index} className="flex gap-2">
              <Textarea
                value={step.action}
                onChange={(event) => updateStep(index, "action", event.target.value)}
                rows={1}
                placeholder={t("editor.stepAction", { n: index + 1 })}
                className="flex-1"
              />
              <Textarea
                value={step.expectedResult}
                onChange={(event) => updateStep(index, "expectedResult", event.target.value)}
                rows={1}
                placeholder={t("col.expectedResult")}
                className="flex-1"
              />
              <Button variant="secondary" size="sm" onClick={() => removeStep(index)} disabled={steps.length <= 1}>{t("editor.remove")}</Button>
            </div>
          ))}
        </div>
        <Button variant="secondary" size="sm" className="mt-2" onClick={addStep}>{t("editor.addStep")}</Button>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={saving}>{t("cancel")}</Button>
        <Button size="sm" onClick={handleSave} disabled={saving || !title.trim()}>{saving ? t("savingDots") : t("editor.saveEdit")}</Button>
      </div>
    </div>
  );
}
