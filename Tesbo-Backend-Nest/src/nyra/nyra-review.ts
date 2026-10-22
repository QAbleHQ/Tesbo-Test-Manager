import { BadRequestException } from "@nestjs/common";

/*
 * Pure rules for reviewing NYRA findings and turning approved ones into Knowledge Base text.
 * Everything here is text a scanned site and a model wrote, so it is only ever escaped or stored as text.
 */

export const NYRA_KINDS = ["screen", "feature", "workflow", "business_rule", "test_case", "form", "api_call", "issue", "tech"] as const;
export type NyraKind = (typeof NYRA_KINDS)[number];

export const KIND_LABEL: Record<NyraKind, string> = {
  screen: "Screens",
  feature: "Features",
  workflow: "Workflows",
  business_rule: "Business rules",
  test_case: "Test cases",
  form: "Forms",
  api_call: "API calls",
  issue: "Issues",
  tech: "Technical profile"
};

export const isKind = (v: unknown): v is NyraKind => typeof v === "string" && (NYRA_KINDS as readonly string[]).includes(v);

/**
 * What is reviewed and ends up in the Knowledge Base: the findings that explain the product. The rest
 * (test cases, API calls, console issues) is QA data that stays in the report. Forms and the technical
 * profile are reviewed too but only go into the document's appendix.
 */
export const DOC_KINDS = ["screen", "feature", "workflow", "business_rule", "form", "tech"] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const isDocKind = (v: unknown): v is DocKind => typeof v === "string" && (DOC_KINDS as readonly string[]).includes(v);
/** An approval needs at least one of these: a document of only forms and a tech profile explains nothing. */
export const STORY_KINDS: readonly DocKind[] = ["screen", "feature", "workflow", "business_rule"];

const TITLE_MAX = 300;
const TEXT_MAX = 2000;
const STEP_MAX = 1000;
const STEPS_MAX = 50;

type FieldSpec = { text?: string[]; list?: string[]; oneOf?: Record<string, string[]> };

/** What a person may change per kind. Anything else about a finding (urls, ids, screenshots) is NYRA's. */
const EDITABLE: Partial<Record<NyraKind, FieldSpec>> = {
  screen: { text: ["purpose"] },
  feature: { text: ["module", "description"] },
  workflow: { text: ["goal"], list: ["steps"] },
  business_rule: { text: ["explanation"] }
};

const bad = (error: string) => new BadRequestException({ error });

export function editableFields(kind: NyraKind): FieldSpec {
  return EDITABLE[kind] ?? {};
}

/**
 * The finding as it should read after a person's edit: NYRA's data with only the editable fields replaced.
 * Unknown fields in `edit` are dropped, not rejected, so a form can send the whole object back.
 */
export function applyEdit(kind: NyraKind, original: { title: string; data: Record<string, any> }, edit: { title?: unknown; data?: unknown }) {
  const title = edit.title === undefined ? original.title : typeof edit.title === "string" ? edit.title.trim() : "";
  if (!title) throw bad("A finding needs a title");
  if (title.length > TITLE_MAX) throw bad(`Title must be at most ${TITLE_MAX} characters`);

  const spec = editableFields(kind);
  const input = edit.data && typeof edit.data === "object" && !Array.isArray(edit.data) ? (edit.data as Record<string, unknown>) : {};
  const data: Record<string, any> = { ...original.data };

  for (const field of spec.text ?? []) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== "string") throw bad(`${field} must be text`);
    const value = (input[field] as string).trim();
    if (value.length > TEXT_MAX) throw bad(`${field} must be at most ${TEXT_MAX} characters`);
    data[field] = value;
  }
  for (const field of spec.list ?? []) {
    if (input[field] === undefined) continue;
    const list = input[field];
    if (!Array.isArray(list) || list.some((s) => typeof s !== "string")) throw bad(`${field} must be a list of text`);
    const steps = (list as string[]).map((s) => s.trim()).filter(Boolean);
    if (steps.length > STEPS_MAX) throw bad(`${field} must have at most ${STEPS_MAX} entries`);
    if (steps.some((s) => s.length > STEP_MAX)) throw bad(`Each entry in ${field} must be at most ${STEP_MAX} characters`);
    data[field] = steps;
  }
  for (const [field, allowed] of Object.entries(spec.oneOf ?? {})) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== "string" || !allowed.includes(input[field] as string)) throw bad(`${field} must be one of ${allowed.join(", ")}`);
    data[field] = input[field];
  }
  return { title, data };
}

export const sameFinding = (a: { title: string; data: unknown }, b: { title: string; data: unknown }) =>
  a.title === b.title && JSON.stringify(a.data) === JSON.stringify(b.data);

// ---------------------------------------------------------------- Knowledge Base text

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : []);

/** NYRA's own fields are not length-limited the way a person's edits are; the document must stay a readable size. */
const VALUE_MAX = 2000;
const HEADING_MAX = 300;

export interface DocBlock {
  heading: string;
  /** label: text pairs; an empty value is skipped. */
  facts: Array<[string, string]>;
  steps: string[];
}
export interface DocSection {
  id: string;
  heading: string;
  /** A group heading is shown only when there is one (features by module, rules by category). */
  groups: Array<{ heading: string | null; blocks: DocBlock[] }>;
}
export interface ProductDocument {
  title: string;
  /** Plain lines under the title, before the first section. */
  intro: string[];
  sections: DocSection[];
  counts: Record<DocKind, number>;
  /** True when a value was cut to fit. The preview says so. */
  clipped: boolean;
}

export const kbTitle = (projectName: string) => `NYRA · ${projectName} · Product knowledge`.slice(0, 512);

const humanize = (v: string) => {
  const t = v.replace(/[_-]+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
};

type Item = { kind: DocKind; title: string; data: Record<string, any> };

function blockOf(kind: DocKind, item: Item, clip: (v: string, max?: number) => string): DocBlock {
  const d = item.data ?? {};
  const facts: Array<[string, string]> = [];
  const add = (label: string, value: string) => value.trim() && facts.push([label, clip(value.trim())]);
  let steps: string[] = [];
  switch (kind) {
    case "screen":
      add("Address", str(d.example_url) || str(d.url_pattern));
      add("Purpose", str(d.purpose));
      add("Headings", strs(d.headings).join(" · "));
      break;
    case "feature":
      add("Description", str(d.description));
      add("Screens", strs(d.screens).join(", "));
      break;
    case "workflow":
      add("Goal", str(d.goal));
      add("Screens", strs(d.screens).join(", "));
      steps = strs(d.steps).map((s) => clip(s));
      break;
    case "business_rule":
      add("Confidence", str(d.confidence));
      add("Area", str(d.area));
      add("Why", str(d.explanation) || str(d.evidence));
      add("Screens", strs(d.screens).join(", "));
      break;
    case "form":
      add("Submits", `${str(d.method).toUpperCase()} ${str(d.action)}`.trim());
      add("Screens", strs(d.screens).join(", ") || str(d.screen));
      add(
        "Fields",
        (Array.isArray(d.fields) ? d.fields : [])
          .map((f: Record<string, any>) => `${str(f?.label) || str(f?.name) || "field"}${f?.required ? " (required)" : ""}`)
          .join(", ")
      );
      break;
    case "tech":
      add("Frameworks", Object.keys(d.frameworks && typeof d.frameworks === "object" ? d.frameworks : {}).join(", "));
      add("Missing security headers", strs(d.missing_security_headers).join(", "));
      break;
  }
  return { heading: clip(item.title.trim() || "Untitled", HEADING_MAX), facts, steps };
}

/**
 * The one document a project's approved findings become. Pure and order-independent, so the preview and
 * the Knowledge Base text are the same thing by construction. `items` are the approved findings only.
 */
export function buildProductDocument(projectName: string, meta: { appUrl?: string | null }, items: Item[]): ProductDocument {
  let clipped = false;
  const clip = (v: string, max = VALUE_MAX) => {
    if (v.length <= max) return v;
    clipped = true;
    return `${v.slice(0, max - 1)}…`;
  };
  const counts = Object.fromEntries(DOC_KINDS.map((k) => [k, 0])) as Record<DocKind, number>;
  const byKind = (k: DocKind) => items.filter((i) => i.kind === k);
  const sorted = (list: Item[]) => [...list].sort((a, b) => a.title.localeCompare(b.title) || JSON.stringify(a.data).localeCompare(JSON.stringify(b.data)));
  for (const i of items) if (isDocKind(i.kind)) counts[i.kind] += 1;

  const grouped = (kind: DocKind, groupOf: (i: Item) => string, last: string) => {
    const groups = new Map<string, DocBlock[]>();
    for (const i of sorted(byKind(kind))) {
      const g = groupOf(i);
      groups.set(g, [...(groups.get(g) ?? []), blockOf(kind, i, clip)]);
    }
    const rank = (g: string) => (g === last ? 1 : 0);
    return [...groups.entries()]
      .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
      .map(([heading, blocks]) => ({ heading, blocks }));
  };
  const flat = (kind: DocKind) => {
    const blocks = sorted(byKind(kind)).map((i) => blockOf(kind, i, clip));
    return blocks.length ? [{ heading: null, blocks }] : [];
  };

  const sections: DocSection[] = [
    { id: "features", heading: "Features", groups: grouped("feature", (i) => clip(humanize(str(i.data?.module)) || "General", HEADING_MAX), "General") },
    { id: "journeys", heading: "Journeys", groups: flat("workflow") },
    { id: "screens", heading: "Screens", groups: flat("screen") },
    { id: "rules", heading: "Business rules", groups: grouped("business_rule", (i) => humanize(str(i.data?.category)) || "Other", "Other") },
    { id: "forms", heading: "Appendix: forms", groups: flat("form") },
    { id: "tech", heading: "Appendix: technical profile", groups: flat("tech") }
  ].filter((s) => s.groups.length);

  const parts = [
    ["screen", "screens", "screen"],
    ["feature", "features", "feature"],
    ["workflow", "journeys", "journey"],
    ["business_rule", "business rules", "business rule"]
  ] as const;
  const summary = parts.filter(([k]) => counts[k]).map(([k, many, one]) => `${counts[k]} ${counts[k] === 1 ? one : many}`);
  const intro = [
    `What ${clip(projectName, HEADING_MAX)} is and how it behaves, from NYRA's exploration of ${meta.appUrl ? clip(meta.appUrl, HEADING_MAX) : "the app"}. A person reviewed every finding in this document and marked it correct, or corrected it.`,
    summary.length ? `Contents: ${summary.join(", ")}.` : ""
  ].filter(Boolean);

  return { title: kbTitle(projectName), intro, sections, counts, clipped };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Plain text (what gets embedded and searched) and HTML (what the editor opens). Scanned text is only ever escaped. */
export function renderDocument(doc: ProductDocument): { text: string; html: string } {
  const text: string[] = ["## Overview", ...doc.intro, ""];
  const html: string[] = ["<h2>Overview</h2>", ...doc.intro.map((l) => `<p>${esc(l)}</p>`)];
  for (const section of doc.sections) {
    text.push(`## ${section.heading}`, "");
    html.push(`<h2>${esc(section.heading)}</h2>`);
    for (const group of section.groups) {
      if (group.heading) {
        text.push(`### ${group.heading}`, "");
        html.push(`<h3>${esc(group.heading)}</h3>`);
      }
      const level = group.heading ? 4 : 3;
      for (const b of group.blocks) {
        text.push(`${"#".repeat(level)} ${b.heading}`);
        html.push(`<h${level}>${esc(b.heading)}</h${level}>`);
        for (const [label, value] of b.facts) {
          text.push(`${label}: ${value}`);
          html.push(`<p><strong>${esc(label)}:</strong> ${esc(value)}</p>`);
        }
        if (b.steps.length) {
          text.push("Steps:", ...b.steps.map((s, i) => `${i + 1}. ${s}`));
          html.push(`<p><strong>Steps:</strong></p><ol>${b.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`);
        }
        text.push("");
      }
    }
  }
  return { text: text.join("\n").trimEnd(), html: html.join("") };
}
