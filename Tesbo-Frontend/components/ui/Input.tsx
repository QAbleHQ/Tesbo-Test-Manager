import type { InputHTMLAttributes } from "react";
import { cx } from "@/components/ui/cx";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export default function Input({ className, ...props }: InputProps) {
  return (
    <input
      className={cx(
        "h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 text-[15px] text-[var(--foreground)] shadow-[var(--shadow-card)] placeholder:text-[var(--muted-soft)]",
        "transition-[border-color,box-shadow,background-color] duration-150",
        "focus:border-[var(--brand-primary)] focus:outline-none focus:ring-4 focus:ring-[color-mix(in_oklab,var(--brand-primary)_18%,transparent)]",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}
