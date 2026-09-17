"use client";

import type { CustomFieldConfig, CustomFieldStatus, CustomFieldType } from "@/lib/api";
import { IconChevronDown } from "@tabler/icons-react";
import { Field, FieldError, FieldHint, FieldLabel, StatusChip } from "@/components/ui";
import CustomFieldValueInput from "./CustomFieldValueInput";
import { formatCustomFieldValueForDisplay } from "./customFieldTypes";

export interface CustomFieldSectionItem {
  id: string;
  name: string;
  description?: string | null;
  fieldType: CustomFieldType;
  status: CustomFieldStatus;
  required: boolean;
  config: CustomFieldConfig;
}

export default function CustomFieldsSection({
  definitions,
  values,
  errors,
  onChange,
  disabled,
}: {
  definitions: CustomFieldSectionItem[];
  values: Record<string, unknown>;
  errors: Record<string, string>;
  onChange: (definitionId: string, value: unknown) => void;
  disabled?: boolean;
}) {
  if (definitions.length === 0) {
    return <p className="text-sm text-[var(--muted)]">No custom fields configured for this project yet.</p>;
  }

  return (
    <div className="space-y-4">
      {definitions.map((definition) => {
        const isActive = definition.status === "active";
        return (
          <Field key={definition.id}>
            <div className="flex items-center gap-2">
              <FieldLabel>
                {definition.name}
                {definition.required && isActive && <span className="text-[var(--error-foreground)]"> *</span>}
              </FieldLabel>
              {!isActive && (
                <StatusChip tone="neutral" className="text-[11px]">
                  {definition.status === "archived" ? "Archived" : "Inactive"}
                </StatusChip>
              )}
            </div>
            {definition.description && <FieldHint>{definition.description}</FieldHint>}
            {isActive ? (
              <>
                <CustomFieldValueInput definition={definition} value={values[definition.id]} onChange={(value) => onChange(definition.id, value)} disabled={disabled} />
                {errors[definition.id] && <FieldError>{errors[definition.id]}</FieldError>}
              </>
            ) : (
              // A deactivated/archived field is intentionally locked — no <select>/<input> here,
              // so there's nothing to click — but still boxed like one, so its value (or "Select…"
              // for an unset one) reads as a real, at-rest form control next to the active fields
              // around it, not a stray line of muted text.
              <div className="flex h-9 items-center justify-between gap-2 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface)] px-3 text-[14px] text-[var(--muted)] opacity-60">
                <span className="truncate">{formatCustomFieldValueForDisplay(definition, values[definition.id])}</span>
                <IconChevronDown size={16} stroke={1.75} className="shrink-0" />
              </div>
            )}
          </Field>
        );
      })}
    </div>
  );
}
