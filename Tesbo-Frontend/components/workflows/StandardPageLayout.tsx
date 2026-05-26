import type { ReactNode } from "react";
import { cx } from "@/components/ui/cx";

type StandardPageLayoutProps = {
  header?: ReactNode;
  children: ReactNode;
  className?: string;
};

export default function StandardPageLayout({ header, children, className }: StandardPageLayoutProps) {
  return (
    <div className={cx("w-full", className)}>
      {header}
      <div className="space-y-6">{children}</div>
    </div>
  );
}
