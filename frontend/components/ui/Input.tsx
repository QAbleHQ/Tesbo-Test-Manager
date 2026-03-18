import type { InputHTMLAttributes } from "react";
import { cx } from "@/components/ui/cx";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export default function Input({ className, ...props }: InputProps) {
  return (
    <input
      className={cx(
        "h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 text-[15px] text-[var(--foreground)] placeholder:text-[var(--muted-soft)]",
        "focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/25",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}
