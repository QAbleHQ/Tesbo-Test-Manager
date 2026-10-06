"use client";

import { useState } from "react";
import type { ZyraSourceRef } from "@/lib/api";
import { Menu } from "@/components/knowledge-base/Menu";
import { useZyraText } from "@/lib/zyra-i18n";
import { ZyraContextDrawer } from "./ZyraContextDrawer";

// Source-type pill labels live in lib/zyra-i18n.ts ("cite.type.<type>"). Outside a Zyra language
// provider (e.g. the Test Cases repository table) the context default is English.

/**
 * Table-row variant of ZyraCitationsList: a table cell can't grow to fit an inline-expanded list
 * without breaking every other row's height, so this opens the same citation list in a floating
 * menu (via the generic Menu component) instead of expanding in place. Same placeholder text and
 * same drawer on click-through as the row/panel variant, just a different container for the list.
 */
export function ZyraCitationsBadge({ refs, projectId }: { refs: ZyraSourceRef[] | undefined; projectId: string }) {
  const [selected, setSelected] = useState<ZyraSourceRef | null>(null);
  const t = useZyraText();

  if (!refs || !refs.length) {
    return <span className="text-[10px] text-[var(--muted)]">{t("cite.none")}</span>;
  }

  return (
    <>
      <Menu
        trigger={
          <button
            type="button"
            className="text-[10px] font-medium text-[var(--info-foreground)] underline decoration-dotted underline-offset-2 hover:no-underline"
          >
            {t("cite.used", { n: refs.length })}
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
                    {t.opt(`cite.type.${ref.type}`) || ref.type}
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
