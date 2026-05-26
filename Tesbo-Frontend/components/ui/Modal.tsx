import type { ReactNode } from "react";
import { cx } from "@/components/ui/cx";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
};

export default function Modal({ open, onClose, title, children, className }: ModalProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay-backdrop)] p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={cx(
          "w-full rounded-2xl border border-[var(--border)] bg-[var(--surface-overlay)] p-6 shadow-[var(--shadow-elevated)]",
          className === undefined ? "max-w-lg" : className,
        )}
        onClick={(event) => event.stopPropagation()}
      >
        {title ? (
          <h2 className="mb-4 shrink-0 text-[22px] font-semibold tracking-tight text-[var(--foreground)]">{title}</h2>
        ) : null}
        {children}
      </div>
    </div>
  );
}
