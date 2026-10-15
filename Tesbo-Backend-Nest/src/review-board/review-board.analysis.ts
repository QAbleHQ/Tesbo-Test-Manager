import { createHash } from "crypto";
import { MAX_PAIRS_PER_RUN, SIMILAR_THRESHOLD } from "./review-board.constants";

/*
 * Deterministic duplicate / similar detection over the fields that define what a test case DOES:
 * title, preconditions, steps (action + expected result per step), test data and postconditions.
 * Description, priority, suite, tags etc. are deliberately not compared — two cases that perform the
 * same checks are duplicates whatever their labels say, and a relabel is not a material change.
 *
 * No I/O in this file, so every rule below is unit-testable.
 */

export interface TestcaseSource {
  id: string;
  external_id: string;
  title: string | null;
  preconditions: string | null;
  postconditions: string | null;
  test_data: string | null;
  /** jsonb array, or a JSON-encoded string of one (both shapes are persisted — see legacy.safeSteps). */
  steps: unknown;
  // Review-state fields (see stateFingerprintOf). Required, so a query that forgets to select one fails to compile
  // instead of silently hashing "empty" and making every finding look stale.
  description: string | null;
  status: string | null;
  suite_id: string | null;
  priority: string | null;
  severity: string | null;
  type: string | null;
  component: string | null;
  owner_id: string | null;
  jira_issue_key: string | null;
  linear_issue_key: string | null;
  notion_page_id: string | null;
}

/** Every testcases column a TestcaseSource is read from, in one place, so each SELECT stays in step with the type. */
export const TESTCASE_SOURCE_COLUMNS = [
  "external_id", "title", "preconditions", "postconditions", "test_data", "steps",
  "description", "status", "suite_id", "priority", "severity", "type", "component", "owner_id",
  "jira_issue_key", "linear_issue_key", "notion_page_id"
] as const;

export interface Step {
  action: string;
  expected: string;
}

export interface ComparableCase {
  id: string;
  externalId: string;
  title: string;
  preconditions: string;
  postconditions: string;
  testData: string;
  steps: Step[];
  /** Hash of the normalised compared fields: equal fingerprints == exact duplicate content. */
  fingerprint: string;
  /** Hash of the review-state fields. Never used for duplicate detection — only to judge whether a finding is still current. */
  stateFingerprint: string;
  norm: {
    title: string;
    preconditions: string;
    postconditions: string;
    testData: string;
    actions: string;
    expected: string;
  };
}

export type Classification = "exact_duplicate" | "similar";

export interface Difference {
  field: "title" | "preconditions" | "steps" | "expectedResults" | "testData" | "postconditions";
  a: string;
  b: string;
}

export interface Finding {
  aId: string;
  bId: string;
  classification: Classification;
  similarity: number;
  explanation: string;
  differences: Difference[];
  fingerprintA: string;
  fingerprintB: string;
  stateFingerprintA: string;
  stateFingerprintB: string;
}

const DIFF_TEXT_CAP = 1000;

export function normalizeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function scalarText(value: unknown): string {
  // Only real text/numbers count. Anything else (nested objects, arrays, booleans) would stringify to
  // junk such as "[object Object]", and two such junk values would compare as identical.
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function decodeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Reads every shape `testcases.steps` is known to hold: a jsonb array of strings and/or
 * { action | step | description, expectedResult | expected } objects; a JSON-encoded string of such an
 * array (what the create/edit modal persists); that same string encoded twice; or plain text.
 */
export function parseSteps(raw: unknown): Step[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return [];
    let value = decodeJson(text);
    if (typeof value === "string") {
      const inner = decodeJson(value.trim());
      if (Array.isArray(inner)) value = inner;
    }
    if (!Array.isArray(value)) {
      const action = typeof value === "string" ? value.trim() : text;
      return action ? [{ action, expected: "" }] : [];
    }
    list = value;
  }
  if (!Array.isArray(list)) return [];
  const steps: Step[] = [];
  for (const item of list) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const step = item as Record<string, unknown>;
      const action = scalarText(step.action) || scalarText(step.step) || scalarText(step.description);
      const expected = scalarText(step.expectedResult) || scalarText(step.expected);
      if (action || expected) steps.push({ action, expected });
    } else {
      const action = scalarText(item);
      if (action) steps.push({ action, expected: "" });
    }
  }
  return steps;
}

function plain(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

/**
 * The details a reviewer weighs before keeping, editing or deleting a case. Free text (description) is normalised like
 * the compared content, so a cosmetic edit is not a change; the rest are identifiers/enumerations and compared as stored.
 * Versioned, so the definition can change deliberately later without silently matching old hashes.
 */
export function stateFingerprintOf(source: TestcaseSource): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "state:v1",
        normalizeText(source.description),
        plain(source.status),
        plain(source.suite_id),
        plain(source.priority),
        plain(source.severity),
        plain(source.type),
        plain(source.component),
        plain(source.owner_id),
        plain(source.jira_issue_key),
        plain(source.linear_issue_key),
        plain(source.notion_page_id)
      ])
    )
    .digest("hex");
}

export function toComparable(source: TestcaseSource): ComparableCase {
  const steps = parseSteps(source.steps);
  const norm = {
    title: normalizeText(source.title),
    preconditions: normalizeText(source.preconditions),
    postconditions: normalizeText(source.postconditions),
    testData: normalizeText(source.test_data),
    actions: steps.map((s) => normalizeText(s.action)).join("\n"),
    expected: steps.map((s) => normalizeText(s.expected)).join("\n")
  };
  // Step order and pairing matter, so hash the (action, expected) pairs rather than the two joined strings.
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        norm.title,
        norm.preconditions,
        norm.postconditions,
        norm.testData,
        steps.map((s) => [normalizeText(s.action), normalizeText(s.expected)])
      ])
    )
    .digest("hex");
  return {
    id: source.id,
    externalId: source.external_id,
    title: String(source.title ?? ""),
    preconditions: String(source.preconditions ?? ""),
    postconditions: String(source.postconditions ?? ""),
    testData: String(source.test_data ?? ""),
    steps,
    fingerprint,
    stateFingerprint: stateFingerprintOf(source),
    norm
  };
}

function tokens(text: string): Set<string> {
  return new Set(text.split(/\s+/).filter(Boolean));
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) shared++;
  return (2 * shared) / (a.size + b.size);
}

const WEIGHTS = { title: 0.25, steps: 0.3, expectedResults: 0.25, preconditions: 0.1, testData: 0.1 } as const;
type ScoredField = keyof typeof WEIGHTS;

const FIELD_LABEL: Record<Difference["field"], string> = {
  title: "title",
  preconditions: "preconditions",
  steps: "steps",
  expectedResults: "expected results",
  testData: "test data",
  postconditions: "postconditions"
};

function scoreFields(a: ComparableCase, b: ComparableCase): { score: number; parts: Partial<Record<ScoredField, number>> } {
  const inputs: Record<ScoredField, [string, string]> = {
    title: [a.norm.title, b.norm.title],
    steps: [a.norm.actions, b.norm.actions],
    expectedResults: [a.norm.expected, b.norm.expected],
    preconditions: [a.norm.preconditions, b.norm.preconditions],
    testData: [a.norm.testData, b.norm.testData]
  };
  let weighted = 0;
  let weight = 0;
  const parts: Partial<Record<ScoredField, number>> = {};
  for (const field of Object.keys(WEIGHTS) as ScoredField[]) {
    const [x, y] = inputs[field];
    // Empty on BOTH sides says nothing about similarity, so the field is left out of the average.
    if (!x.trim() && !y.trim()) continue;
    const sim = dice(tokens(x), tokens(y));
    parts[field] = sim;
    weighted += WEIGHTS[field] * sim;
    weight += WEIGHTS[field];
  }
  return { score: weight === 0 ? 0 : weighted / weight, parts };
}

function clip(text: string): string {
  return text.length > DIFF_TEXT_CAP ? `${text.slice(0, DIFF_TEXT_CAP)}…` : text;
}

function numbered(steps: Step[], pick: (s: Step) => string): string {
  return clip(steps.map((s, i) => `${i + 1}. ${pick(s)}`).join("\n"));
}

/** Field-by-field differences, judged on the normalised text (case/spacing/punctuation are not differences). */
export function diffCases(a: ComparableCase, b: ComparableCase): Difference[] {
  const out: Difference[] = [];
  if (a.norm.title !== b.norm.title) out.push({ field: "title", a: clip(a.title), b: clip(b.title) });
  if (a.norm.preconditions !== b.norm.preconditions) out.push({ field: "preconditions", a: clip(a.preconditions), b: clip(b.preconditions) });
  if (a.norm.actions !== b.norm.actions || a.steps.length !== b.steps.length) {
    out.push({ field: "steps", a: numbered(a.steps, (s) => s.action), b: numbered(b.steps, (s) => s.action) });
  }
  if (a.norm.expected !== b.norm.expected) {
    out.push({ field: "expectedResults", a: numbered(a.steps, (s) => s.expected), b: numbered(b.steps, (s) => s.expected) });
  }
  if (a.norm.testData !== b.norm.testData) out.push({ field: "testData", a: clip(a.testData), b: clip(b.testData) });
  if (a.norm.postconditions !== b.norm.postconditions) out.push({ field: "postconditions", a: clip(a.postconditions), b: clip(b.postconditions) });
  return out;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function orderedPair(x: ComparableCase, y: ComparableCase): [ComparableCase, ComparableCase] {
  return x.id < y.id ? [x, y] : [y, x];
}

export interface StepAgreement {
  /** Steps present in BOTH cases with the same action AND expected result (after normalisation), matched regardless of order. */
  identical: number;
  /** The larger of the two cases' step counts. */
  total: number;
}

/**
 * How many steps two cases really share. Word overlap alone cannot see this: two cases whose steps read almost the same
 * but differ in the values that matter ("1.5" vs "-1", "Creativity" vs "Adaptability") overlap on nearly every word yet
 * share no step at all. Matching is by multiset, so inserting one step does not make every later step look different.
 */
export function stepAgreement(a: ComparableCase, b: ComparableCase): StepAgreement {
  const key = (s: Step) => `${normalizeText(s.action)}\u0001${normalizeText(s.expected)}`;
  const pool = new Map<string, number>();
  for (const s of a.steps) pool.set(key(s), (pool.get(key(s)) ?? 0) + 1);
  let identical = 0;
  for (const s of b.steps) {
    const left = pool.get(key(s)) ?? 0;
    if (left > 0) {
      pool.set(key(s), left - 1);
      identical += 1;
    }
  }
  return { identical, total: Math.max(a.steps.length, b.steps.length) };
}

/** Half wording similarity, half the share of identical steps — only when there are steps to compare. */
function blendedScore(wording: number, agreement: StepAgreement): number {
  if (agreement.total === 0) return wording;
  return 0.5 * wording + 0.5 * (agreement.identical / agreement.total);
}

function buildFinding(x: ComparableCase, y: ComparableCase, minScore: number = SIMILAR_THRESHOLD): Finding | null {
  const [a, b] = orderedPair(x, y);
  const differences = diffCases(a, b);
  const sameContent = a.fingerprint === b.fingerprint;
  const hasSteps = a.steps.length > 0 && b.steps.length > 0;

  if (sameContent && hasSteps) {
    return {
      aId: a.id,
      bId: b.id,
      classification: "exact_duplicate",
      similarity: 1,
      explanation:
        "Title, preconditions, steps, expected results, test data and postconditions are identical once case, spacing and punctuation are ignored.",
      differences,
      fingerprintA: a.fingerprint,
      fingerprintB: b.fingerprint,
      stateFingerprintA: a.stateFingerprint,
      stateFingerprintB: b.stateFingerprint
    };
  }

  const { score: wording, parts } = scoreFields(a, b);
  const agreement = stepAgreement(a, b);
  const score = blendedScore(wording, agreement);
  if (score < minScore) return null;

  const breakdown = (Object.keys(parts) as ScoredField[])
    .map((f) => `${f === "steps" ? "steps" : FIELD_LABEL[f]} ${pct(parts[f] as number)}`)
    .join(", ");
  let explanation: string;
  if (sameContent) {
    // Identical on every compared field, but with no steps neither side shows what it actually checks.
    explanation = "Identical title and details, but at least one of the two has no steps, so their behaviour cannot be compared. Not treated as an exact duplicate.";
  } else {
    const differing = differences.map((d) => FIELD_LABEL[d.field]).join(", ");
    const stepsNote = agreement.total > 0 ? `${agreement.identical} of ${agreement.total} step${agreement.total === 1 ? "" : "s"} identical; ` : "";
    explanation = `${pct(score)} match (${stepsNote}wording similarity: ${breakdown}). Differs in: ${differing}.`;
  }
  return {
    aId: a.id,
    bId: b.id,
    classification: "similar",
    similarity: Math.round(score * 1000) / 1000,
    explanation,
    differences,
    fingerprintA: a.fingerprint,
    fingerprintB: b.fingerprint,
    stateFingerprintA: a.stateFingerprint,
    stateFingerprintB: b.stateFingerprint
  };
}

/**
 * Scores one pair exactly as the analysis would, but WITHOUT the similarity cut-off, so it always answers.
 * Used right after a reviewer edits a test case: the finding must show the pair's match as it is now (even if
 * the edit pushed it below the analysis threshold, or made the two identical), not the score from before the edit.
 */
export function rescorePair(x: ComparableCase, y: ComparableCase): Finding {
  return buildFinding(x, y, 0) as Finding;
}

const MAX_CANDIDATES_PER_CASE = 25;

export function analyse(cases: ComparableCase[]): { findings: Finding[]; truncated: boolean } {
  const seen = new Set<string>();
  const findings: Finding[] = [];
  const consider = (x: ComparableCase, y: ComparableCase) => {
    const key = x.id < y.id ? `${x.id}|${y.id}` : `${y.id}|${x.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const finding = buildFinding(x, y);
    if (finding) findings.push(finding);
  };

  // Exact duplicates: group by content fingerprint (only cases that have steps — see buildFinding).
  const byFingerprint = new Map<string, ComparableCase[]>();
  for (const c of cases) {
    if (c.steps.length === 0) continue;
    const group = byFingerprint.get(c.fingerprint);
    if (group) group.push(c);
    else byFingerprint.set(c.fingerprint, [c]);
  }
  for (const group of byFingerprint.values()) {
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) consider(group[i], group[j]);
  }

  // Similar: an inverted index over title + step-action tokens proposes candidates, so the work is
  // proportional to shared vocabulary instead of n². Tokens common to a large share of the project
  // ("click", "the") carry no signal and are skipped when proposing — never when scoring.
  const indexTokens = cases.map((c) => tokens(`${c.norm.title} ${c.norm.actions}`));
  const postings = new Map<string, number[]>();
  indexTokens.forEach((set, i) => {
    for (const t of set) {
      const list = postings.get(t);
      if (list) list.push(i);
      else postings.set(t, [i]);
    }
  });
  const dfCap = Math.max(30, Math.floor(cases.length * 0.1));
  for (let i = 0; i < cases.length; i++) {
    const shared = new Map<number, number>();
    for (const t of indexTokens[i]) {
      const list = postings.get(t)!;
      if (list.length > dfCap) continue;
      for (const j of list) if (j > i) shared.set(j, (shared.get(j) ?? 0) + 1);
    }
    const candidates = [...shared.entries()]
      .filter(([, n]) => n >= 2)
      .sort((p, q) => q[1] - p[1] || p[0] - q[0])
      .slice(0, MAX_CANDIDATES_PER_CASE);
    for (const [j] of candidates) consider(cases[i], cases[j]);
  }

  findings.sort(
    (p, q) =>
      Number(q.classification === "exact_duplicate") - Number(p.classification === "exact_duplicate") ||
      q.similarity - p.similarity ||
      (p.aId + p.bId < q.aId + q.bId ? -1 : 1)
  );
  const truncated = findings.length > MAX_PAIRS_PER_RUN;
  return { findings: truncated ? findings.slice(0, MAX_PAIRS_PER_RUN) : findings, truncated };
}
