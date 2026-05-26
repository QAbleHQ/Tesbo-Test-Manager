import type { ButtonHTMLAttributes } from "react";
import { cx } from "@/components/ui/cx";

type ButtonVariant = "primary" | "secondary" | "ai" | "destructive" | "confidence";
type ButtonSize = "sm" | "md" | "lg";

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "border border-transparent bg-[var(--brand-primary)] text-white shadow-sm hover:bg-[var(--brand-hover)]",
  secondary:
    "border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] shadow-sm hover:bg-[var(--surface-secondary)]",
  ai: "border border-[var(--ai-border)] bg-[var(--ai-soft)] text-[var(--ai-primary)] hover:bg-[var(--ai-surface)]",
  destructive:
    "border border-[var(--error-border)] bg-[var(--error)] text-white shadow-sm hover:opacity-95",
  confidence:
    "border border-[var(--confidence-high-border)] bg-[var(--confidence-high-soft)] text-[var(--confidence-high-foreground)] hover:bg-[color-mix(in_oklab,var(--confidence-high-soft)_82%,white)]",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-9 rounded-[10px] px-3.5 text-[13px] font-semibold",
  md: "h-11 rounded-xl px-5 text-[15px] font-medium",
  lg: "h-12 rounded-xl px-6 text-[15px] font-semibold",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
};

export default function Button({
  className,
  variant = "primary",
  size = "md",
  fullWidth = false,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap transition-[background-color,border-color,color,box-shadow] duration-150",
        "focus:outline-none focus-visible:ring-4 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_20%,transparent)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        variantClasses[variant],
        sizeClasses[size],
        fullWidth && "w-full",
        className,
      )}
      {...props}
    />
  );
}
