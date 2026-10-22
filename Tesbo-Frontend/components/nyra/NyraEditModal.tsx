"use client";

import { useEffect, useState, type FormEvent } from "react";
import { NYRA_EDITABLE, reviewNyraItem, type NyraItem } from "@/lib/nyra";
import { Button, Field, FieldError, FieldHint, FieldLabel, Input, Modal, Select, Textarea } from "@/components/ui";

type Draft = { title: string; text: Record<string, string>; list: Record<string, string>; oneOf: Record<string, string> };

/** The text a person may change is what NYRA found, or what they last edited. The original is kept beside it. */
function toDraft(item: NyraItem): Draft {
  const spec = NYRA_EDITABLE[item.kind] ?? {};
  const d = item.data ?? {};
  return {
    title: item.title,
    text: Object.fromEntries((spec.text ?? []).map((f) => [f.key, typeof d[f.key] === "string" ? d[f.key] : ""])),
    list: Object.fromEntries((spec.list ?? []).map((f) => [f.key, Array.isArray(d[f.key]) ? d[f.key].join("\n") : ""])),
    oneOf: Object.fromEntries((spec.oneOf ?? []).map((f) => [f.key, typeof d[f.key] === "string" ? d[f.key] : f.options[0]])),
  };
}

export default function NyraEditModal({
  item,
  projectId,
  nyraId,
  runId,
  onClose,
  onSaved,
}: {
  item: NyraItem | null;
  projectId: string;
  nyraId: string;
  runId: string;
  onClose: () => void;
  onSaved: (item: NyraItem) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(item ? toDraft(item) : null);
    setError(null);
  }, [item]);

  if (!item || !draft) return <Modal open={false} onClose={onClose}>{null}</Modal>;
  const spec = NYRA_EDITABLE[item.kind] ?? {};

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (!draft!.title.trim()) {
      setError("A finding needs a title");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onSaved(
        await reviewNyraItem(projectId, nyraId, runId, {
          kind: item!.kind,
          key: item!.key,
          status: "edited",
          title: draft!.title.trim(),
          data: {
            ...draft!.text,
            ...Object.fromEntries(Object.entries(draft!.list).map(([k, v]) => [k, v.split("\n").map((l) => l.trim()).filter(Boolean)])),
            ...draft!.oneOf,
          },
        })
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the edit.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={() => !saving && onClose()} title="Edit finding" className="max-w-[640px]">
      <form onSubmit={submit} noValidate className="space-y-4">
        <FieldHint>Your wording is what goes into the Knowledge Base. NYRA&apos;s original stays visible on the finding.</FieldHint>
        <Field>
          <FieldLabel htmlFor="nyra-edit-title">Title</FieldLabel>
          <Input id="nyra-edit-title" value={draft.title} maxLength={300} onChange={(e) => setDraft((d) => d && { ...d, title: e.target.value })} />
        </Field>
        {(spec.oneOf ?? []).map((f) => (
          <Field key={f.key}>
            <FieldLabel htmlFor={`nyra-edit-${f.key}`}>{f.label}</FieldLabel>
            <Select id={`nyra-edit-${f.key}`} value={draft.oneOf[f.key]} onChange={(e) => setDraft((d) => d && { ...d, oneOf: { ...d.oneOf, [f.key]: e.target.value } })}>
              {f.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
          </Field>
        ))}
        {(spec.text ?? []).map((f) => (
          <Field key={f.key}>
            <FieldLabel htmlFor={`nyra-edit-${f.key}`}>{f.label}</FieldLabel>
            {f.long ? (
              <Textarea id={`nyra-edit-${f.key}`} rows={3} value={draft.text[f.key]} maxLength={2000} onChange={(e) => setDraft((d) => d && { ...d, text: { ...d.text, [f.key]: e.target.value } })} />
            ) : (
              <Input id={`nyra-edit-${f.key}`} value={draft.text[f.key]} maxLength={2000} onChange={(e) => setDraft((d) => d && { ...d, text: { ...d.text, [f.key]: e.target.value } })} />
            )}
          </Field>
        ))}
        {(spec.list ?? []).map((f) => (
          <Field key={f.key}>
            <FieldLabel htmlFor={`nyra-edit-${f.key}`}>{f.label}</FieldLabel>
            <Textarea id={`nyra-edit-${f.key}`} rows={5} value={draft.list[f.key]} onChange={(e) => setDraft((d) => d && { ...d, list: { ...d.list, [f.key]: e.target.value } })} />
            <FieldHint>One per line.</FieldHint>
          </Field>
        ))}
        {error && <FieldError>{error}</FieldError>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save edit"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
