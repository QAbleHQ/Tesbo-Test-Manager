"use client";

import { useState } from "react";
import type { ZyraSourceRef } from "@/lib/api";
import { Menu } from "@/components/knowledge-base/Menu";
import { ZyraContextDrawer } from "./ZyraContextDrawer";

const TYPE_LABEL: Record<ZyraSourceRef["type"], string> = {
  knowledge_document: "Knowledge base",
  knowledge_file: "Knowledge base",
  jira_ticket: "Jira",
  testcase: "Test case",
  bug: "Bug",
};

/**
 * Table-row variant of ZyraCitationsList: a table cell can't grow to fit an inline-expanded list
 * without breaking every other row's height, so this opens the same citation list in a floating
 * menu (via the generic Menu component) instead of expanding in place. Same placeholder text and
 * same drawer on click-through as the row/panel variant, just a different container for the list.
 */
export function ZyraCitationsBadge({ refs, projectId }: { refs: ZyraSourceRef[] | undefined; projectId: string }) {
  const [selected, setSelected] = useState<ZyraSourceRef | null>(null);

  if (!refs || !refs.length) {
    return <span className="text-[10px] text-[var(--muted)]">No specific source cited</span>;
  }

  return (
    <>
      <Menu
        trigger={
          <button
            type="button"
            className="text-[10px] font-medium text-[var(--info-foreground)] underline decoration-dotted underline-offset-2 hover:no-underline"
          >
            Context used ({refs.length})
          </button>
        }
      >
        {(close) => (
          <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto p-1">
            {refs.map((ref, index) => (
              <li key={`${ref.type}-${ref.id}-${index}`}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(ref);
                    close();
                  }}
                  className="flex w-full items-start gap-1.5 rounded px-2 py-1.5 text-left hover:bg-[var(--surface-secondary)]"
                >
                  <span className="mt-[1px] shrink-0 rounded-full bg-[var(--surface-secondary)] px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-[var(--muted-soft)]">
                    {TYPE_LABEL[ref.type] || ref.type}
                  </span>
                  <span className="text-[11px] leading-snug text-[var(--foreground)]" title={ref.id}>
                    {ref.title || ref.id}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Menu>
      {selected && <ZyraContextDrawer projectId={projectId} reference={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
