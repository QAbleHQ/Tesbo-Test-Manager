import type { ReactNode } from "react";

type SplitWorkspaceProps = {
  left: ReactNode;
  center: ReactNode;
  right?: ReactNode;
};

export default function SplitWorkspace({ left, center, right }: SplitWorkspaceProps) {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(280px,1fr)_minmax(0,1.6fr)_minmax(300px,1fr)]">
      <section className="tesbo-card p-4">{left}</section>
      <section className="tesbo-card p-4">{center}</section>
      {right ? <aside className="tesbo-card p-4">{right}</aside> : null}
    </div>
  );
}
