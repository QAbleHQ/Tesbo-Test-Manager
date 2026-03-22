import type { ReactNode } from "react";
import { cx } from "@/components/ui/cx";

type DetailWorkspaceLayoutProps = {
  header?: ReactNode;
  left: ReactNode;
  right?: ReactNode;
  className?: string;
};

export default function DetailWorkspaceLayout({
  header,
  left,
  right,
  className,
}: DetailWorkspaceLayoutProps) {
  return (
    <div className={cx("w-full", className)}>
      {header}
      <div className={cx("grid gap-5", right ? "lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]" : "grid-cols-1")}>
        <div>{left}</div>
        {right ? <aside>{right}</aside> : null}
      </div>
    </div>
  );
}
