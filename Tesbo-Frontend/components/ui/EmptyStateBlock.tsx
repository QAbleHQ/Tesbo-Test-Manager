import type { ReactNode } from "react";
import { cx } from "@/components/ui/cx";

type EmptyStateBlockProps = {
  title: string;
  description: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
};

export default function EmptyStateBlock({
  title,
  description,
  icon,
  action,
  className,
}: EmptyStateBlockProps) {
  return (
    <div className={cx("tesbo-card border-dashed p-10 text-center", className)}>
      {icon ? (
        <div className="mx-auto mb-4 inline-flex rounded-2xl bg-[var(--surface-secondary)] p-3 text-[var(--muted)]">
          {icon}
        </div>
      ) : null}
      <p className="text-lg font-semibold text-[var(--foreground)]">{title}</p>
      <p className="mt-2 text-[15px] leading-6 text-[var(--muted)]">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
