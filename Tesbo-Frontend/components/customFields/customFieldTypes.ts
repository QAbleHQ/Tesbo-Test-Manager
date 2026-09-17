import type { CustomFieldConfig, CustomFieldFilterOperator, CustomFieldType } from "@/lib/api";

export const FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: "Text",
  long_text: "Long Text",
  boolean: "Boolean (Yes/No)",
  single_select: "Single-Select Dropdown",
  multi_select: "Multi-Select Dropdown",
  number: "Number",
  date: "Date",
};

export const FIELD_TYPE_OPTIONS: { value: CustomFieldType; label: string }[] = (
  Object.entries(FIELD_TYPE_LABELS) as [CustomFieldType, string][]
).map(([value, label]) => ({ value, label }));

export function isCustomFieldValueEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

export interface CustomFieldLike {
  name: string;
  fieldType: CustomFieldType;
  required: boolean;
  status: string;
  config: CustomFieldConfig;
}

/** Client-side mirror of the backend's per-type checks, used to validate before submit. */
export function validateCustomFieldValue(field: CustomFieldLike, value: unknown): string | null {
  if (field.status !== "active") return null;
  if (isCustomFieldValueEmpty(value)) {
    return field.required ? `${field.name} is required` : null;
  }
  switch (field.fieldType) {
    case "text":
    case "long_text": {
      if (typeof value !== "string") return `${field.name} must be text`;
      if (field.config.maxLength != null && value.length > field.config.maxLength) {
        return `${field.name} must be ${field.config.maxLength} characters or fewer`;
      }
      return null;
    }
    case "number": {
      const num = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(num)) return `${field.name} must be a number`;
      if (field.config.min != null && num < field.config.min) return `${field.name} must be at least ${field.config.min}`;
      if (field.config.max != null && num > field.config.max) return `${field.name} must be at most ${field.config.max}`;
      if (field.config.decimalsAllowed === false && !Number.isInteger(num)) return `${field.name} must be a whole number`;
      return null;
    }
    case "date": {
      if (typeof value !== "string") return `${field.name} must be a date`;
      const today = new Date().toISOString().slice(0, 10);
      if (field.config.allowPastDates === false && value < today) return `${field.name} cannot be a past date`;
      if (field.config.allowFutureDates === false && value > today) return `${field.name} cannot be a future date`;
      return null;
    }
    case "multi_select": {
      if (!Array.isArray(value)) return `${field.name} must be a list of options`;
      if (field.config.minSelected != null && value.length < field.config.minSelected) {
        return `Select at least ${field.config.minSelected} option(s) for ${field.name}`;
      }
      if (field.config.maxSelected != null && value.length > field.config.maxSelected) {
        return `Select at most ${field.config.maxSelected} option(s) for ${field.name}`;
      }
      return null;
    }
    default:
      return null;
  }
}

export function validateCustomFieldValues(
  definitions: Array<CustomFieldLike & { id: string }>,
  values: Record<string, unknown>
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const def of definitions) {
    const message = validateCustomFieldValue(def, values[def.id]);
    if (message) errors[def.id] = message;
  }
  return errors;
}

export function formatCustomFieldValueForDisplay(field: { fieldType: CustomFieldType; config: CustomFieldConfig }, value: unknown): string {
  // An inactive/archived field renders through this plain-text path instead of
  // CustomFieldValueInput (see CustomFieldsSection.tsx) — every field type's empty state now
  // reads "Select…" here, the same wording CustomFieldValueInput's own placeholder <option> uses
  // for an unset dropdown, instead of the bare "—" this used to fall back to for all of them.
  if (isCustomFieldValueEmpty(value)) return "Select…";
  switch (field.fieldType) {
    case "boolean": {
      const trueFalse = field.config.displayFormat === "true_false";
      return value ? (trueFalse ? "True" : "Yes") : trueFalse ? "False" : "No";
    }
    case "single_select": {
      const option = (field.config.options || []).find((o) => o.id === value);
      return option?.label || "—";
    }
    case "multi_select": {
      const options = field.config.options || [];
      const labels = (Array.isArray(value) ? value : [])
        .map((id) => options.find((o) => o.id === id)?.label)
        .filter((label): label is string => Boolean(label));
      return labels.length ? labels.join(", ") : "—";
    }
    case "number":
      return field.config.unit ? `${value} ${field.config.unit}` : String(value);
    default:
      return String(value);
  }
}

export function getConfiguredDefaultValue(field: { fieldType: CustomFieldType; config: CustomFieldConfig }): unknown {
  if (field.config.defaultValue !== undefined) return field.config.defaultValue;
  if (field.fieldType === "single_select" && field.config.defaultOptionId) return field.config.defaultOptionId;
  if (field.fieldType === "multi_select" && field.config.defaultOptionIds?.length) return field.config.defaultOptionIds;
  return undefined;
}

export function slugPreview(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "field"
  );
}

export interface FilterOperatorMeta {
  value: CustomFieldFilterOperator;
  label: string;
  needsValue: boolean;
  needsSecondValue?: boolean;
}

const TEXT_OPERATORS: FilterOperatorMeta[] = [
  { value: "contains", label: "Contains", needsValue: true },
  { value: "does_not_contain", label: "Does not contain", needsValue: true },
  { value: "equals", label: "Equals", needsValue: true },
  { value: "is_empty", label: "Is empty", needsValue: false },
  { value: "is_not_empty", label: "Is not empty", needsValue: false },
];

export const FILTER_OPERATORS_BY_TYPE: Record<CustomFieldType, FilterOperatorMeta[]> = {
  text: TEXT_OPERATORS,
  long_text: TEXT_OPERATORS,
  boolean: [
    { value: "yes", label: "Yes", needsValue: false },
    { value: "no", label: "No", needsValue: false },
    { value: "is_empty", label: "Is empty", needsValue: false },
  ],
  single_select: [
    { value: "is", label: "Is", needsValue: true },
    { value: "is_not", label: "Is not", needsValue: true },
    { value: "is_empty", label: "Is empty", needsValue: false },
    { value: "is_not_empty", label: "Is not empty", needsValue: false },
  ],
  multi_select: [
    { value: "includes_any", label: "Includes any", needsValue: true },
    { value: "includes_all", label: "Includes all", needsValue: true },
    { value: "is_empty", label: "Is empty", needsValue: false },
    { value: "is_not_empty", label: "Is not empty", needsValue: false },
  ],
  number: [
    { value: "equals", label: "Equals", needsValue: true },
    { value: "greater_than", label: "Greater than", needsValue: true },
    { value: "less_than", label: "Less than", needsValue: true },
    { value: "between", label: "Between", needsValue: true, needsSecondValue: true },
    { value: "is_empty", label: "Is empty", needsValue: false },
  ],
  date: [
    { value: "before", label: "Before", needsValue: true },
    { value: "after", label: "After", needsValue: true },
    { value: "on", label: "On", needsValue: true },
    { value: "between", label: "Between", needsValue: true, needsSecondValue: true },
    { value: "is_overdue", label: "Is overdue", needsValue: false },
    { value: "is_empty", label: "Is empty", needsValue: false },
  ],
};
