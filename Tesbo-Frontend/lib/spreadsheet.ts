/**
 * Undoes the quote the CSV exports add in front of a cell that a spreadsheet could read as a formula
 * (`=`, `+`, `-`, `@`, tab, carriage return), so importing a file Tesbo exported gives back exactly
 * what was exported. Mirrors `restoreNeutralized` in Tesbo-Backend-Nest/src/common/spreadsheet-safe.ts,
 * which has the reasoning; keep the two regexes identical.
 *
 * Strips exactly one quote and only when what follows the quotes is a formula trigger, so an
 * ordinary `'quoted` value and a real number are left alone. Applied to CSV only: the XLSX export
 * writes text cells that no spreadsheet evaluates, so it adds no quote and has nothing to undo.
 */
const NEUTRALIZED = /^'+[=+\-@\t\r]/;

export function restoreNeutralized(text: string): string {
  return NEUTRALIZED.test(text) ? text.slice(1) : text;
}
