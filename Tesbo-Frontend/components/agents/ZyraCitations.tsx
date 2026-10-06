"use client";

import { useState } from "react";
import type { ZyraSourceRef } from "@/lib/api";
import { useZyraText } from "@/lib/zyra-i18n";
import { ZyraContextDrawer } from "./ZyraContextDrawer";

// Source-type pill labels live in lib/zyra-i18n.ts ("cite.type.<type>"), localized with the chat.

/**
 * Which knowledge-base doc/file, Jira ticket, existing test case, or bug actually informed one
 * generated test case — resolved and verified server-side (sanitizeZyraSourceRefs in
 * legacy.service.ts never lets a case cite a source it wasn't actually shown), so this is a list
 * of real, checkable provenance, not the model's own unverified claim.
 *
 * Collapsed by default: most rows in a results table are scanned, not read line by line, and a
 * fully-expanded citation list per row would make an ordinary 5-case batch unreadable.
 */
export function ZyraCitationsList({ refs, projectId }: { refs: ZyraSourceRef[] | undefined; projectId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<ZyraSourceRef | null>(null);
  const t = useZyraText();
  if (!refs || !refs.length) return <span className="text-[10px] text-[var(--muted)]">{t("cite.none")}</span>;

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="text-[10px] font-medium text-[var(--info-foreground)] underline decoration-dotted underline-offset-2 hover:no-underline"
      >
        {t("cite.used", { n: refs.length })}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="self-start text-[10px] font-medium text-[var(--muted)] underline decoration-dotted underline-offset-2 hover:no-underline"
      >
        {t("cite.hide")}
      </button>
      <ul className="flex flex-col gap-1">
        {refs.map((ref, index) => (
          <li key={`${ref.type}-${ref.id}-${index}`}>
            <button
              type="button"
              onClick={() => setSelected(ref)}
              className="flex w-full items-start gap-1.5 rounded px-0.5 text-left hover:bg-[var(--surface-secondary)]"
            >
              <span className="mt-[1px] shrink-0 rounded-full bg-[var(--surface-secondary)] px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-[var(--muted-soft)]">
                {t.opt(`cite.type.${ref.type}`) || ref.type}
              </span>
              <span className="text-[11px] leading-snug text-[var(--info-foreground)] underline decoration-dotted underline-offset-2" title={ref.id}>
                {ref.title || ref.id}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {selected && <ZyraContextDrawer projectId={projectId} reference={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
