"use client";

import { Button, Field, FieldError, FieldHint, FieldLabel, Input } from "@/components/ui";
import { formatDay } from "@/lib/date";

/** Where a due date stands, as the API reports it (workspace timezone, null for a finished item). */
export type DueState = "due_soon" | "due_today" | "overdue" | null | undefined;

/** The message to show when the range is inverted, or null when it is fine. Mirrors the API's rule. */
export function dateRangeError(startDate: string, dueDate: string): string | null {
  return startDate && dueDate && dueDate < startDate ? "Due date cannot be earlier than the start date." : null;
}

/**
 * Start Date (required) and Due Date (optional) for a test plan or test run. Both are native date
 * pickers; the due picker's `min` is the start date, and the due date has its own Clear button
 * because a browser's date input cannot always be emptied by hand.
 */
export function DateRangeFields({
  idPrefix,
  startDate,
  dueDate,
  onStartDateChange,
  onDueDateChange,
  disabled,
}: {
  idPrefix: string;
  startDate: string;
  dueDate: string;
  onStartDateChange: (value: string) => void;
  onDueDateChange: (value: string) => void;
  disabled?: boolean;
}) {
  const error = dateRangeError(startDate, dueDate);
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-start-date`}>
          Start Date <span className="text-[var(--error)]">*</span>
        </FieldLabel>
        <Input
          id={`${idPrefix}-start-date`}
          type="date"
          value={startDate}
          onChange={(e) => onStartDateChange(e.target.value)}
          disabled={disabled}
          required
          aria-label="Start date"
        />
      </Field>
      <Field>
        <div className="flex items-center justify-between gap-2">
          <FieldLabel htmlFor={`${idPrefix}-due-date`}>Due Date</FieldLabel>
          {dueDate && (
            <Button type="button" variant="ghost" size="sm" onClick={() => onDueDateChange("")} disabled={disabled} data-testid={`${idPrefix}-clear-due-date`}>
              Clear
            </Button>
          )}
        </div>
        <Input
          id={`${idPrefix}-due-date`}
          type="date"
          value={dueDate}
          min={startDate || undefined}
          onChange={(e) => onDueDateChange(e.target.value)}
          disabled={disabled}
          aria-label="Due date"
          aria-invalid={error ? true : undefined}
        />
        {error ? <FieldError data-testid={`${idPrefix}-date-error`}>{error}</FieldError> : <FieldHint>Optional. Reminders go out the day before and on the day.</FieldHint>}
      </Field>
    </div>
  );
}

const STATE_LABEL: Record<"due_soon" | "due_today" | "overdue", string> = {
  due_soon: "Due tomorrow",
  due_today: "Due today",
  overdue: "Overdue",
};

/** The chip beside a due date: red Overdue, amber when it is due today or tomorrow. Nothing otherwise. */
export function DueStateBadge({ dueState }: { dueState: DueState }) {
  if (!dueState) return null;
  const overdue = dueState === "overdue";
  return (
    <span
      data-testid={overdue ? "overdue-badge" : "due-soon-badge"}
      className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-medium"
      style={{
        background: overdue ? "var(--status-fail-fill)" : "var(--status-blocked-fill)",
        color: overdue ? "var(--status-fail-text)" : "var(--status-blocked-text)",
      }}
    >
      {STATE_LABEL[dueState]}
    </span>
  );
}

/** "Start 21 Oct 2026 · Due 25 Oct 2026" — read-only, for cards and detail headers. */
export function DateRangeSummary({
  startDate,
  dueDate,
  dueState,
  className,
}: {
  startDate?: string | null;
  dueDate?: string | null;
  dueState?: DueState;
  className?: string;
}) {
  return (
    <span className={className ?? "inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--muted)]"} data-testid="date-range">
      <span data-testid="start-date-value">Start: {formatDay(startDate)}</span>
      <span data-testid="due-date-value">Due: {dueDate ? formatDay(dueDate) : "No due date"}</span>
      <DueStateBadge dueState={dueState} />
    </span>
  );
}
