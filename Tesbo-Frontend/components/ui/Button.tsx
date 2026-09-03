import type { ButtonHTMLAttributes } from "react";
import { cx } from "@/components/ui/cx";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "destructive" | "ai" | "confidence";
type ButtonSize = "sm" | "md" | "lg" | "icon";

const variantClasses: Record<ButtonVariant, string> = {
  // Violet CTA — main action buttons
  primary:
    "border-0 bg-[var(--cta-primary)] text-white shadow-sm hover:bg-[var(--cta-hover)] active:opacity-90",
  // Transparent with subtle border — supporting actions
  secondary:
    "border border-[var(--ink-200)] bg-transparent text-[var(--ink-600)] hover:bg-[var(--ink-100)] active:bg-[var(--ink-200)]",
  // Borderless — tertiary actions
  ghost:
    "border-0 bg-transparent text-[var(--ink-400)] hover:bg-[var(--ink-100)] hover:text-[var(--ink-600)]",
  // Destructive (danger and destructive are identical — destructive kept for backward compat)
  // Themed, not the literal #FDEAEA these carried: that pale red stayed put in dark mode while the
  // label followed the theme, leaving the two a shade apart from each other.
  danger:
    "border border-[var(--error-border)] bg-[var(--error-soft)] text-[var(--status-fail-text)] hover:bg-[color-mix(in_oklab,var(--error-soft)_82%,var(--error))] active:opacity-90",
  destructive:
    "border border-[var(--error-border)] bg-[var(--error-soft)] text-[var(--status-fail-text)] hover:bg-[color-mix(in_oklab,var(--error-soft)_82%,var(--error))] active:opacity-90",
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
  // Square icon-only button. cx() is a plain className join (no tailwind-merge dedup), so this
  // carries no padding utility of its own — callers that need icon buttons use this instead of
  // fighting sizeClasses.sm's `px-3` with an ad-hoc `p-0` override, which is a cascade-order race
  // that can leave the padding in place and squeeze/clip the icon inside a fixed h-8 w-8 box.
  icon: "h-8 w-8 rounded-[6px]",
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
        "cursor-pointer disabled:cursor-not-allowed disabled:opacity-50",
        variantClasses[variant],
        sizeClasses[size],
        fullWidth && "w-full",
        className,
      )}
      {...props}
    />
  );
}
