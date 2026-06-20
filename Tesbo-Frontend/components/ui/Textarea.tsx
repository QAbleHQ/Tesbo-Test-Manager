import type { TextareaHTMLAttributes } from "react";
import { cx } from "@/components/ui/cx";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export default function Textarea({ className, ...props }: TextareaProps) {
  return (
    <textarea
      className={cx(
        "w-full rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[14px] text-[var(--foreground)] placeholder:text-[var(--ink-300)]",
        "transition-[border-color,box-shadow,background-color] duration-150",
        "focus:border-[var(--denim-200)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklab,var(--denim-200)_22%,transparent)]",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}
