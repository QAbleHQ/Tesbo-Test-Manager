"use client";

import { nyraFileUrl, type NyraItem } from "@/lib/nyra";
import { StatusChip } from "@/components/ui";

const muted = "text-[12px] text-[var(--muted)]";
const label = "text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-soft)]";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : []);

function Steps({ steps }: { steps: string[] }) {
  if (!steps.length) return null;
  return (
    <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-[13px] text-[var(--foreground)]">
      {steps.map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ol>
  );
}

function Line({ name, children }: { name: string; children: React.ReactNode }) {
  if (children === null || children === undefined || children === "") return null;
  return (
    <div className="mt-2">
      <div className={label}>{name}</div>
      <div className="text-[13px] text-[var(--foreground)]">{children}</div>
    </div>
  );
}

const severityTone = (s: string) => (s === "high" ? "error" : s === "medium" ? "warning" : "neutral");

/** One finding, laid out for its kind. Everything shown is page-derived text, rendered as text only. */
export default function NyraItemCard({ item, projectId, nyraId, runId }: { item: NyraItem; projectId: string; nyraId: string; runId: string }) {
  const d = item.data ?? {};
  let badge: React.ReactNode = null;
  let body: React.ReactNode = null;

  switch (item.kind) {
    case "screen":
      body = (
        <>
          <div className={`${muted} break-all`}>{str(d.example_url) || str(d.url_pattern)}</div>
          <Line name="Purpose">{str(d.purpose)}</Line>
          <Line name="Headings">{list(d.headings).join(" · ")}</Line>
          {d.element_count ? <div className={`${muted} mt-2`}>{d.element_count} interactive elements</div> : null}
          {str(d.screenshot) && (
            // loading="lazy" matters: a scan can have 500 screens, and each one is a request to NYRA.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={nyraFileUrl(projectId, nyraId, runId, "screens", str(d.screenshot))}
              alt={`Screenshot of ${item.title}`}
              loading="lazy"
              className="mt-3 w-full rounded-md border border-[var(--border-subtle)]"
            />
          )}
        </>
      );
      break;
    case "feature":
      body = (
        <>
          <Line name="Module">{str(d.module)}</Line>
          <Line name="Description">{str(d.description)}</Line>
          <Line name="Screens">{list(d.screens).join(", ")}</Line>
        </>
      );
      break;
    case "workflow":
      badge = d.status ? <StatusChip tone="neutral">{str(d.status)}</StatusChip> : null;
      body = (
        <>
          <Line name="Goal">{str(d.goal)}</Line>
          <Steps steps={list(d.steps)} />
          <Line name="Screens">{list(d.screens).join(", ")}</Line>
        </>
      );
      break;
    case "business_rule":
      badge = d.confidence ? <StatusChip tone={d.confidence === "verified" ? "success" : "warning"}>{str(d.confidence)}</StatusChip> : null;
      body = (
        <>
          <div className={muted}>{[str(d.category).replace(/_/g, " "), str(d.area)].filter(Boolean).join(" · ")}</div>
          <Line name="Why">{str(d.explanation) || str(d.evidence)}</Line>
          {Array.isArray(d.evidence_items) && d.evidence_items.length > 0 && (
            <Line name="Evidence">
              <ul className="list-disc pl-5">
                {d.evidence_items.map((e: Record<string, unknown>, i: number) => (
                  <li key={i}>{[str(e.ref), str(e.quote)].filter(Boolean).join(": ")}</li>
                ))}
              </ul>
            </Line>
          )}
          <Line name="Screens">{list(d.screens).join(", ")}</Line>
        </>
      );
      break;
    case "test_case":
      badge = d.priority ? <StatusChip tone={d.priority === "high" ? "error" : d.priority === "low" ? "neutral" : "warning"}>{str(d.priority)}</StatusChip> : null;
      body = (
        <>
          <Line name="Screen">{str(d.screen)}</Line>
          <Line name="Preconditions">{str(d.preconditions)}</Line>
          <Steps steps={list(d.steps)} />
          <Line name="Expected">{str(d.expected)}</Line>
        </>
      );
      break;
    case "form":
      body = (
        <>
          <div className={muted}>
            {str(d.method).toUpperCase()} {str(d.action)} on {list(d.screens).join(", ") || str(d.screen)}
          </div>
          <ul className="mt-2 space-y-0.5 text-[13px]">
            {(Array.isArray(d.fields) ? d.fields : []).map((f: Record<string, any>, i: number) => (
              <li key={i} className="flex flex-wrap gap-x-2">
                <span className="font-medium text-[var(--foreground)]">{str(f.label) || str(f.name) || "(unlabelled)"}</span>
                <span className={muted}>{[str(f.type), f.required ? "required" : ""].filter(Boolean).join(" · ")}</span>
              </li>
            ))}
          </ul>
        </>
      );
      break;
    case "api_call":
      body = (
        <>
          <div className={muted}>
            {Array.isArray(d.statuses) ? d.statuses.join(", ") : ""} · seen {d.count ?? 0}× · {str(d.content_type)}
          </div>
          <Line name="First seen on">{str(d.first_seen_on)}</Line>
          <Line name="Response fields">{list(d.response_shape?.fields).join(", ")}</Line>
        </>
      );
      break;
    case "issue":
      badge = d.severity ? <StatusChip tone={severityTone(str(d.severity))}>{str(d.severity)}</StatusChip> : null;
      body = (
        <>
          <div className={muted}>{str(d.category).replace(/_/g, " ")}</div>
          <Line name="Detail">{str(d.message) || (d.status ? `HTTP ${d.status}` : "") || str(d.header)}</Line>
          <Line name="Where">{list(d.pages).join(", ") || str(d.page) || str(d.found_on) || str(d.url)}</Line>
        </>
      );
      break;
    case "tech":
      body = (
        <>
          <Line name="Frameworks">{Object.keys(d.frameworks ?? {}).join(", ")}</Line>
          <Line name="Missing security headers">{list(d.missing_security_headers).join(", ")}</Line>
          <Line name="TLS">{d.tls ? `${str(d.tls.protocol)} · ${str(d.tls.issuer)}` : ""}</Line>
        </>
      );
      break;
  }

  return (
    <div className="tesbo-card p-4" data-testid="nyra-item">
      <div className="flex items-start justify-between gap-3">
        <h4 className="min-w-0 break-words text-[14px] font-semibold text-[var(--foreground)]">{item.title}</h4>
        {badge}
      </div>
      {body}
    </div>
  );
}
