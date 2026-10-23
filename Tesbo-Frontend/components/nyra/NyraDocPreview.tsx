"use client";

import type { NyraDocPreview } from "@/lib/nyra";
import { Card } from "@/components/ui";

/**
 * The Knowledge Base document as the server will write it. Everything in it came from a scanned page
 * or a model, so it is shown as plain React text, never as HTML.
 */
export default function NyraDocPreviewCard({ preview, loading, error }: { preview: NyraDocPreview | null; loading: boolean; error: string | null }) {
  if (error) return <Card className="p-5 text-sm text-[var(--error-foreground)]">{error}</Card>;
  if (!preview) return <Card className="p-5 text-sm text-[var(--muted)]">{loading ? "Building the document…" : "No preview yet."}</Card>;
  const empty = preview.sections.length === 0;
  return (
    <Card className="p-5" data-testid="nyra-doc-preview" aria-busy={loading}>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-soft)]">Document preview</div>
      <h3 className="text-[17px] font-semibold text-[var(--foreground)]">{preview.title}</h3>
      <div className="mt-3 max-h-[60vh] space-y-5 overflow-auto pr-2 text-[13px] leading-6 text-[var(--foreground)]">
        <section aria-label="Overview">
          <h4 className="text-[14px] font-semibold">Overview</h4>
          {preview.intro.map((line) => (
            <p key={line} className="text-[var(--muted)]">
              {line}
            </p>
          ))}
        </section>
        {empty && <p className="text-[var(--muted)]">Nothing is marked Correct yet. Findings you mark Correct, or edit, appear here as the document.</p>}
        {preview.sections.map((section) => (
          <section key={section.id} aria-label={section.heading}>
            <h4 className="text-[14px] font-semibold">{section.heading}</h4>
            {section.groups.map((group) => (
              <div key={group.heading ?? "all"} className="mt-2">
                {group.heading && <h5 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-soft)]">{group.heading}</h5>}
                <div className="mt-1 space-y-3">
                  {group.blocks.map((b, i) => (
                    <div key={`${b.heading}:${i}`} data-testid="nyra-doc-block">
                      <div className="font-medium">{b.heading}</div>
                      {b.facts.map(([label, value]) => (
                        <div key={label} className="text-[var(--muted)]">
                          <span className="font-medium text-[var(--foreground)]">{label}:</span> {value}
                        </div>
                      ))}
                      {b.steps.length > 0 && (
                        <ol className="ml-5 list-decimal text-[var(--muted)]">
                          {b.steps.map((s, n) => (
                            <li key={`${n}:${s}`}>{s}</li>
                          ))}
                        </ol>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
      {preview.clipped && <p className="mt-3 text-[12px] text-[var(--warning-foreground,var(--muted))]">Some very long values were shortened to keep the document readable.</p>}
    </Card>
  );
}
