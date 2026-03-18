import type { ReactNode } from "react";

type PageHeaderProps = {
  title: string;
  subtitle?: ReactNode;
  breadcrumb?: ReactNode;
  actions?: ReactNode;
};

export default function PageHeader({ title, subtitle, breadcrumb, actions }: PageHeaderProps) {
  return (
    <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {breadcrumb ? <div className="mb-1.5 text-[14px] text-[var(--muted)]">{breadcrumb}</div> : null}
        <h1 className="text-[26px] font-semibold tracking-tight text-[var(--foreground)]">{title}</h1>
        {subtitle ? <p className="mt-1.5 text-[15px] text-[var(--muted)]">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2.5">{actions}</div> : null}
    </header>
  );
}
