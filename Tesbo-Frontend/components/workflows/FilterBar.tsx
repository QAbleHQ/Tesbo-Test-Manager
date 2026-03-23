import type { ReactNode } from "react";
import { cx } from "@/components/ui/cx";

type FilterBarProps = {
  children: ReactNode;
  className?: string;
};

export default function FilterBar({ children, className }: FilterBarProps) {
  return (
    <section className={cx("tesbo-card mb-5 flex flex-wrap items-center gap-3 p-3", className)}>
      {children}
    </section>
  );
}
