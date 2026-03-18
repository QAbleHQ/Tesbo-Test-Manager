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
    <div className={cx("tesbo-card p-10 text-center", className)}>
      {icon ? <div className="mx-auto mb-3 inline-flex text-[var(--muted)]">{icon}</div> : null}
      <p className="text-lg font-semibold text-[var(--foreground)]">{title}</p>
      <p className="mt-1.5 text-[15px] text-[var(--muted)]">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
