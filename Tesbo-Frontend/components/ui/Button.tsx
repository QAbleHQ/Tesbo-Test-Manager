import type { ButtonHTMLAttributes } from "react";
import { cx } from "@/components/ui/cx";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "destructive" | "ai" | "confidence";
type ButtonSize = "sm" | "md" | "lg";

const variantClasses: Record<ButtonVariant, string> = {
  // Denim primary — main action buttons
  primary:
    "border-0 bg-[var(--denim)] text-white shadow-sm hover:bg-[var(--denim-400)] active:opacity-90",
  // Transparent with subtle border — supporting actions
  secondary:
    "border border-[var(--ink-200)] bg-transparent text-[var(--ink-600)] hover:bg-[var(--ink-100)] active:bg-[var(--ink-200)]",
  // Borderless — tertiary actions
  ghost:
    "border-0 bg-transparent text-[var(--ink-400)] hover:bg-[var(--ink-100)] hover:text-[var(--ink-600)]",
  // Destructive (danger and destructive are identical — destructive kept for backward compat)
  danger:
    "border border-[#F09595] bg-[#FDEAEA] text-[var(--status-fail-text)] hover:bg-[#FCCFCF] active:opacity-90",
  destructive:
    "border border-[#F09595] bg-[#FDEAEA] text-[var(--status-fail-text)] hover:bg-[#FCCFCF] active:opacity-90",
  // AI actions
  ai: "border border-[var(--ai-border)] bg-[var(--ai-soft)] text-[var(--ai-primary)] hover:bg-[var(--ai-surface)]",
  // Confidence
  confidence:
    "border border-[var(--confidence-high-border)] bg-[var(--confidence-high-soft)] text-[var(--confidence-high-foreground)] hover:bg-[color-mix(in_oklab,var(--confidence-high-soft)_82%,white)]",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 rounded-[6px] px-3 text-[13px] font-medium",
  md: "h-9 rounded-[6px] px-4 text-[13px] font-medium",
  lg: "h-10 rounded-[6px] px-5 text-[14px] font-medium",
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
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap transition-[background-color,border-color,color,opacity] duration-150",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--denim)_30%,transparent)] focus-visible:ring-offset-1",
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
