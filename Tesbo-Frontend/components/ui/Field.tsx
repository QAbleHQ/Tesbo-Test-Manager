import type { HTMLAttributes, LabelHTMLAttributes } from "react";
import { cx } from "@/components/ui/cx";

export function Field({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("space-y-2", className)} {...props} />;
}

export function FieldLabel({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cx("block text-[15px] font-medium text-[var(--foreground)]", className)} {...props} />;
}

export function FieldHint({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cx("text-[13px] text-[var(--muted)]", className)} {...props} />;
}

export function FieldError({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cx("text-[13px] text-[var(--error)]", className)} role="alert" {...props} />;
}
