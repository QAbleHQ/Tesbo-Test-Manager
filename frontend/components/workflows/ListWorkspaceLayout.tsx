import type { ReactNode } from "react";
import { cx } from "@/components/ui/cx";

type ListWorkspaceLayoutProps = {
  header?: ReactNode;
  filterBar?: ReactNode;
  children: ReactNode;
  className?: string;
};

export default function ListWorkspaceLayout({
  header,
  filterBar,
  children,
  className,
}: ListWorkspaceLayoutProps) {
  return (
    <div className={cx("w-full", className)}>
      {header}
      {filterBar}
      <div className="space-y-5">{children}</div>
    </div>
  );
}
