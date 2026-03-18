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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className={cx(
          "w-full max-w-lg rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 shadow-[var(--shadow-elevated)]",
          className,
        )}
        onClick={(event) => event.stopPropagation()}
      >
        {title ? <h2 className="mb-5 text-xl font-semibold text-[var(--foreground)]">{title}</h2> : null}
        {children}
      </div>
    </div>
  );
}
