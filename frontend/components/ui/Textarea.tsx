import type { TextareaHTMLAttributes } from "react";
import { cx } from "@/components/ui/cx";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export default function Textarea({ className, ...props }: TextareaProps) {
  return (
    <textarea
      className={cx(
        "w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-[15px] text-[var(--foreground)] placeholder:text-[var(--muted-soft)]",
        "focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/25",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}
