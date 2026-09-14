export type FieldType = "text" | "long_text" | "boolean" | "single_select" | "multi_select" | "number" | "date";
export type FieldStatus = "active" | "inactive" | "archived";

// Every fixed test case column, across the CSV/XLSX export, the import template, and the bulk
// import commit — normalized the same way ImportTestCasesModal.tsx's autoMap/autoMapCustomFields
// normalize an uploaded header (lowercase, strip non-alphanumeric). A custom field named e.g.
// "Title" or "externalId" would otherwise land on the exact same normalized header as a base
// column once it starts appearing as a real column in the same file. Shared by CustomFieldsService
// (rejects the name at creation) and LegacyController (defensively renames a pre-existing offender
// in a generated file) so the two can't drift.
export const RESERVED_TESTCASE_HEADERS = new Set(
  [
    "externalId",
    "title",
    "description",
    "preconditions",
    "postconditions",
    "steps",
    "testData",
    "priority",
    "severity",
    "type",
    "status",
    "suite",
    "component",
    "estimatedDuration",
    "automationStatus",
    "attachments"
  ].map((h) => h.toLowerCase().replace(/[^a-z0-9]+/g, ""))
);

export function normalizeTestcaseHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export interface FieldOption {
  id: string;
  label: string;
  active: boolean;
  order: number;
}

// All per-type configuration lives in one loosely-typed bag rather than a union of
// per-type interfaces — every field is optional and only the ones relevant to the
// definition's `fieldType` are read/validated (see custom-field-validation.ts).
export interface FieldConfig {
  placeholder?: string | null;
  maxLength?: number | null;
  displayFormat?: "yes_no" | "true_false";
  options?: FieldOption[];
  defaultOptionId?: string | null;
  defaultOptionIds?: string[];
  minSelected?: number | null;
  maxSelected?: number | null;
  min?: number | null;
  max?: number | null;
  decimalsAllowed?: boolean;
  unit?: string | null;
  allowPastDates?: boolean;
  allowFutureDates?: boolean;
  // The configured default value, in the same shape setValuesForTestCase expects on
  // input for this field type (string / number / boolean / "YYYY-MM-DD" / option id /
  // option id array).
  defaultValue?: unknown;
}

export interface CustomFieldDefinitionDto {
  id: string;
  projectId: string;
  key: string;
  name: string;
  description: string | null;
  fieldType: FieldType;
  status: FieldStatus;
  required: boolean;
  displayOrder: number;
  config: FieldConfig;
  isUsed: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomFieldValueDto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  fieldType: FieldType;
  status: FieldStatus;
  required: boolean;
  displayOrder: number;
  config: FieldConfig;
  value: unknown;
}

// Structural typing lets QueryRunner accept either DatabaseService or a pg PoolClient
// handed out by DatabaseService.transaction(), so service methods can optionally run
// inside a caller's existing transaction.
export interface QueryRunner {
  query<T extends Record<string, any> = Record<string, any>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export type CustomFieldFilterOperator =
  | "contains"
  | "does_not_contain"
  | "equals"
  | "is_empty"
  | "is_not_empty"
  | "is"
  | "is_not"
  | "includes_any"
  | "includes_all"
  | "yes"
  | "no"
  | "greater_than"
  | "less_than"
  | "between"
  | "before"
  | "after"
  | "on"
  | "is_overdue";

export interface CustomFieldFilterInput {
  definitionId: string;
  operator: CustomFieldFilterOperator;
  value?: unknown;
  valueTo?: unknown;
}
