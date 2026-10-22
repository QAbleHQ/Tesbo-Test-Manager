import type * as ExcelJS from "exceljs";

/*
 * Writing user data into CSV and XLSX without handing the person who opens it a formula to run.
 *
 * A test case title, a step, a run name or a custom field value is typed by a project member and
 * opened by someone else in Excel, Sheets or LibreOffice. Opened as CSV, a cell that begins with
 * `=`, `+`, `-` or `@` is a formula (`=HYPERLINK(...)` to exfiltrate, `=cmd|' /C ...'!A0` where DDE is
 * still on), and so is one that begins with a tab or carriage return that a spreadsheet strips off.
 *
 * CSV and XLSX need different handling:
 *   - CSV has no cell types, so the only defence is text: prefix a single quote, which Excel and
 *     Sheets display as a literal and never evaluate. That changes the cell, so the importer undoes it
 *     (see restoreNeutralized, mirrored in Tesbo-Frontend/lib/spreadsheet.ts), keeping an
 *     export -> import round trip exact.
 *   - XLSX does have cell types, and ExcelJS writes every string as a string cell, never as a
 *     formula (tests pin this), so a spreadsheet opens it as text with nothing to run. Adding a quote
 *     there would only corrupt the data, so XLSX values are written as they are.
 */

// What a spreadsheet may read as the start of a formula, optionally behind quotes we added ourselves.
// The leading `'*` is what makes neutralize/restore exact inverses: a value that is already
// `'=x` gets a second quote, so restoring one quote gives `'=x` back rather than `=x`.
const FORMULA_START = /^'*[=+\-@\t\r]/;
// A real number is not a payload: `-5` and `+1.5e3` are what a numeric column holds, and quoting them
// would make every negative number in an export read as text. `-2+3` is not matched, so it is quoted.
const PLAIN_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const NEUTRALIZED = /^'+[=+\-@\t\r]/;

/** The CSV form of a cell value: unchanged unless a spreadsheet could take it for a formula. */
export function neutralizeFormula(text: string): string {
  return FORMULA_START.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text;
}

/** The inverse of neutralizeFormula, for reading back a CSV this product wrote. Strips exactly one quote. */
export function restoreNeutralized(text: string): string {
  return NEUTRALIZED.test(text) ? text.slice(1) : text;
}

/**
 * One CSV field: formula-neutralised first, then quoted if it contains a comma, quote or line break.
 * Used for headers as well as data, so a column named `Steps, notes` no longer splits the header row.
 */
export function csvEscape(value: unknown): string {
  const text = neutralizeFormula(String(value ?? ""));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function rowsToCsv(headers: string[], rows: Record<string, unknown>[]): string {
  return [
    headers.map((header) => csvEscape(header)).join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))
  ].join("\n");
}

// exceljs writes whatever it is handed, and a plain object or an array would land as a formula or
// rich-text cell rather than a value. Numbers, booleans and dates have to stay typed — a real 0
// must survive as the number 0 (see longRow) — so only those pass through untouched; null and
// undefined become an empty cell, and anything else is stringified. Strings stay strings, which is
// what keeps a spreadsheet from evaluating them (see the note at the top of this file).
export function cellValue(value: unknown): ExcelJS.CellValue {
  if (value == null) return null;
  if (typeof value === "number" || typeof value === "boolean" || value instanceof Date) return value;
  return String(value);
}
