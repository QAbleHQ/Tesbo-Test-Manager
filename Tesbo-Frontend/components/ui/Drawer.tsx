"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { IconX } from "@tabler/icons-react";
import { cx } from "@/components/ui/cx";

type DrawerProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Rendered in the header, between the title and the close button — e.g. a Share icon button. */
  headerExtra?: ReactNode;
  children: ReactNode;
  className?: string;
};

export default function Drawer({ open, onClose, title, headerExtra, children, className }: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex justify-end bg-[var(--overlay-backdrop)] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="presentation"
        className={cx(
          "flex h-full w-full flex-col border-l border-[var(--border)] bg-[var(--surface-overlay)] shadow-[var(--shadow-elevated)]",
          className === undefined ? "max-w-[480px]" : className,
        )}
        onClick={(event) => event.stopPropagation()}
      >
        {title ? (
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
            <div className="min-w-0 flex-1">{title}</div>
            {headerExtra && <div className="flex shrink-0 items-center">{headerExtra}</div>}
            <button
              type="button"
              onClick={onClose}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-[var(--muted-soft)] hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
            >
              <IconX size={16} />
            </button>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body
  );
}
