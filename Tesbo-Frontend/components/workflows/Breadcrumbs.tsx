import Link from "next/link";

export type BreadcrumbItem = {
  label: string;
  href?: string;
};

type BreadcrumbsProps = {
  items: BreadcrumbItem[];
};

/**
 * Single canonical breadcrumb trail. Every page passes the same `items` shape
 * into this instead of hand-rolling its own separator/typography, so trails
 * stay visually identical regardless of whether the caller hosts this inside
 * PageHeader's `breadcrumb` slot or the TopBar start slot.
 */
export default function Breadcrumbs({ items }: BreadcrumbsProps) {
  if (items.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-[var(--muted)]">
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        return (
          <span key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
            {index > 0 ? <span aria-hidden="true">/</span> : null}
            {item.href && !isLast ? (
              <Link href={item.href} className="truncate hover:text-[var(--foreground)] hover:underline">
                {item.label}
              </Link>
            ) : (
              <span aria-current={isLast ? "page" : undefined} className={`truncate ${isLast ? "font-medium text-[var(--foreground)]" : ""}`}>
                {item.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
