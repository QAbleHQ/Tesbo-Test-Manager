import { parseSteps } from "./review-board.analysis";

/*
 * Before / after of a Review Board edit, as plain display text. Pure, so the rules are unit-testable.
 *
 * It reads either a testcases row (snake_case, what the edit endpoint holds) or the camelCase row the standard
 * `testcase_updated` audit entry stores, so the same function can describe an edit recorded by the Review Board and
 * recover one from the older audit entry for edits saved before the Review Board recorded its own before/after.
 */

export type EditField = "title" | "description" | "preconditions" | "steps" | "testData" | "postconditions";

export interface FieldChange {
  field: EditField;
  before: string;
  after: string;
}

type Row = Record<string, unknown>;

// Order is the order a reader expects a test case to be laid out in.
const FIELDS: Array<{ field: EditField; snake: string; camel: string }> = [
  { field: "title", snake: "title", camel: "title" },
  { field: "description", snake: "description", camel: "description" },
  { field: "preconditions", snake: "preconditions", camel: "preconditions" },
  { field: "steps", snake: "steps", camel: "steps" },
  { field: "testData", snake: "test_data", camel: "testData" },
  { field: "postconditions", snake: "postconditions", camel: "postconditions" }
];

const pick = (row: Row, snake: string, camel: string): unknown => row[snake] ?? row[camel];
const text = (v: unknown): string => (v === null || v === undefined ? "" : String(v)).trim();

/** Steps as numbered lines, each with its expected result underneath — whatever shape the steps are stored in. */
export function stepsText(raw: unknown): string {
  return parseSteps(raw)
    .map((s, i) => `${i + 1}. ${s.action}${s.expected ? `\n   Expected: ${s.expected}` : ""}`)
    .join("\n");
}

/** The fields that actually differ, in reading order. Surrounding whitespace is not a change. */
export function changesBetween(before: Row, after: Row): FieldChange[] {
  const out: FieldChange[] = [];
  for (const f of FIELDS) {
    const b = f.field === "steps" ? stepsText(pick(before, f.snake, f.camel)) : text(pick(before, f.snake, f.camel));
    const a = f.field === "steps" ? stepsText(pick(after, f.snake, f.camel)) : text(pick(after, f.snake, f.camel));
    if (b !== a) out.push({ field: f.field, before: b, after: a });
  }
  return out;
}
