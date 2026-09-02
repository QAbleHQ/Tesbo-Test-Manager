"use client";

import { useState } from "react";
import { Button, Field, FieldLabel, Input, Select, Textarea } from "@/components/ui";
import type { ZyraChatTestcaseRow } from "@/lib/api";

type Step = { action: string; expectedResult: string };

const PRIORITIES = ["P0", "P1", "P2", "P3"];

// Same shape editZyraTaskDraft accepts server-side (legacy.service.ts sanitizeZyraUpdateFields) —
// title/priority/preconditions/description/stepsJson cover a proposed draft either way (a new
// test case, or a proposed change to an existing one).
export type ZyraDraftEditValues = {
  title: string;
  priority: string;
  preconditions: string;
  description: string;
  stepsJson: string;
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
    });
  }

  return (
    <div className="space-y-3 rounded-lg border border-[var(--brand-border)] bg-[var(--surface)] p-3">
      <Field>
        <FieldLabel>Title</FieldLabel>
        <Input value={title} onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <Field>
        <FieldLabel>Priority</FieldLabel>
        <Select value={priority} onChange={(event) => setPriority(event.target.value)}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </Select>
      </Field>
      <Field>
        <FieldLabel>Preconditions</FieldLabel>
        <Textarea value={preconditions} onChange={(event) => setPreconditions(event.target.value)} rows={2} />
      </Field>
      <Field>
        <FieldLabel>Expected result</FieldLabel>
        <Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} />
      </Field>
      <div>
        <FieldLabel>Steps</FieldLabel>
        <div className="mt-1.5 space-y-2">
          {steps.map((step, index) => (
            <div key={index} className="flex gap-2">
              <Textarea
                value={step.action}
                onChange={(event) => updateStep(index, "action", event.target.value)}
                rows={1}
                placeholder={`Step ${index + 1} action`}
                className="flex-1"
              />
              <Textarea
                value={step.expectedResult}
                onChange={(event) => updateStep(index, "expectedResult", event.target.value)}
                rows={1}
                placeholder="Expected result"
                className="flex-1"
              />
              <Button variant="secondary" size="sm" onClick={() => removeStep(index)} disabled={steps.length <= 1}>Remove</Button>
            </div>
          ))}
        </div>
        <Button variant="secondary" size="sm" className="mt-2" onClick={addStep}>+ Add step</Button>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button size="sm" onClick={handleSave} disabled={saving || !title.trim()}>{saving ? "Saving..." : "Save edit"}</Button>
      </div>
    </div>
  );
}
