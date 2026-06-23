import type { InputHTMLAttributes } from "react";
import { cx } from "@/components/ui/cx";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export default function Input({ className, ...props }: InputProps) {
  return (
    <input
      className={cx(
        "h-9 w-full rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface)] px-3 text-[14px] text-[var(--foreground)] placeholder:text-[var(--ink-300)]",
        "transition-[border-color,box-shadow,background-color] duration-150",
        "focus:border-[var(--denim-200)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklab,var(--denim-200)_22%,transparent)]",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}
