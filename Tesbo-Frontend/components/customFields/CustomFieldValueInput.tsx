"use client";

import type { CustomFieldConfig, CustomFieldType } from "@/lib/api";
import { Input, Select, Textarea } from "@/components/ui";

export interface CustomFieldInputDefinition {
  id: string;
  name: string;
  fieldType: CustomFieldType;
  config: CustomFieldConfig;
}

export default function CustomFieldValueInput({
  definition,
  value,
  onChange,
  disabled,
}: {
  definition: CustomFieldInputDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  const { fieldType, config } = definition;

  if (fieldType === "text") {
    return (
      <Input
        type="text"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={config.placeholder || undefined}
        maxLength={config.maxLength ?? undefined}
        disabled={disabled}
      />
    );
  }

  if (fieldType === "long_text") {
    return (
      <Textarea
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={config.placeholder || undefined}
        maxLength={config.maxLength ?? undefined}
        rows={3}
        disabled={disabled}
      />
    );
  }

  if (fieldType === "boolean") {
    const trueFalse = config.displayFormat === "true_false";
    return (
      <Select
        value={value === true ? "true" : value === false ? "false" : ""}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "true")}
        disabled={disabled}
      >
        <option value="">Select…</option>
        <option value="true">{trueFalse ? "True" : "Yes"}</option>
        <option value="false">{trueFalse ? "False" : "No"}</option>
      </Select>
    );
  }

  if (fieldType === "single_select") {
    const options = config.options || [];
    const selectable = options.filter((o) => o.active || o.id === value);
    return (
      <Select value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)} disabled={disabled}>
        <option value="">Select…</option>
        {selectable.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
            {!option.active ? " (inactive)" : ""}
          </option>
        ))}
      </Select>
    );
  }

  if (fieldType === "multi_select") {
    const options = config.options || [];
    const selected = new Set(Array.isArray(value) ? (value as string[]) : []);
    const selectable = options.filter((o) => o.active || selected.has(o.id));
    return (
      <div className="flex flex-wrap gap-3 rounded-lg border border-[var(--border)] p-2.5">
        {selectable.length === 0 && <span className="text-sm text-[var(--muted)]">No options</span>}
        {selectable.map((option) => (
          <label key={option.id} className="flex items-center gap-1.5 text-sm text-[var(--foreground)]">
            <input
              type="checkbox"
              checked={selected.has(option.id)}
              disabled={disabled}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(option.id);
                else next.delete(option.id);
                onChange(Array.from(next));
              }}
            />
            {option.label}
            {!option.active ? " (inactive)" : ""}
          </label>
        ))}
      </div>
    );
  }

  if (fieldType === "number") {
    return (
      <div className="flex items-center gap-2">
        <Input
          type="number"
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          min={config.min ?? undefined}
          max={config.max ?? undefined}
          step={config.decimalsAllowed === false ? 1 : "any"}
          disabled={disabled}
        />
        {config.unit && <span className="text-sm text-[var(--muted)]">{config.unit}</span>}
      </div>
    );
  }

  if (fieldType === "date") {
    return (
      <Input
        type="date"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={disabled}
      />
    );
  }

  return null;
}
