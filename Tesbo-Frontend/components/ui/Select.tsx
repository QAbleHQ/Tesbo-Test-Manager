import type { SelectHTMLAttributes } from "react";
import { cx } from "@/components/ui/cx";

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export default function Select({ className, ...props }: SelectProps) {
  return (
    <select
      className={cx(
        "h-9 w-full rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface)] px-3 text-[14px] text-[var(--foreground)]",
        "transition-[border-color,box-shadow,background-color] duration-150",
        "focus:border-[var(--denim-200)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklab,var(--denim-200)_22%,transparent)]",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}
