import { analyse, parseSteps, rescorePair, stateFingerprintOf, toComparable, type TestcaseSource } from "./review-board.analysis";

let n = 0;
function tc(over: Partial<TestcaseSource> & { steps?: unknown }): TestcaseSource {
  n += 1;
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return {
    id,
    external_id: `TC-${n}`,
    title: "Login with valid credentials",
    preconditions: "User exists",
    postconditions: null,
    test_data: "user=alice",
    description: "Verifies sign-in",
    status: "Active",
    suite_id: "suite-1",
    priority: "P2",
    severity: "Major",
    type: "Functional",
    component: "Auth",
    owner_id: "owner-1",
    jira_issue_key: "TES-1",
    linear_issue_key: null,
    notion_page_id: null,
    steps: [
      { action: "Open the login page", expectedResult: "Form is shown" },
      { action: "Submit valid credentials", expectedResult: "Dashboard opens" }
    ],
    ...over
  };
}

const run = (...cases: TestcaseSource[]) => analyse(cases.map(toComparable));

describe("review-board analysis", () => {
  it("reports exact duplicates that differ only in case, spacing and punctuation", () => {
    const a = tc({});
    const b = tc({
      title: "  login WITH valid credentials!! ",
      steps: [
        { action: "open the login page.", expectedResult: "form  is shown" },
        { action: "Submit valid credentials", expectedResult: "Dashboard opens." }
      ]
    });
    const { findings } = run(a, b);
    expect(findings).toHaveLength(1);
    expect(findings[0].classification).toBe("exact_duplicate");
    expect(findings[0].similarity).toBe(1);
    expect(findings[0].differences).toEqual([]);
  });

  it("does not call cases exact when expected results differ", () => {
    const a = tc({});
    const b = tc({
      steps: [
        { action: "Open the login page", expectedResult: "Form is shown" },
        { action: "Submit valid credentials", expectedResult: "An error banner appears" }
      ]
    });
    const { findings } = run(a, b);
    expect(findings).toHaveLength(1);
    expect(findings[0].classification).toBe("similar");
    expect(findings[0].differences.map((d) => d.field)).toContain("expectedResults");
  });

  it("does not call cases exact when only test data differs, and lists test data as the difference", () => {
    const { findings } = run(tc({}), tc({ test_data: "user=bob" }));
    expect(findings[0].classification).toBe("similar");
    expect(findings[0].differences.map((d) => d.field)).toEqual(["testData"]);
  });

  it("does not call cases exact when preconditions differ", () => {
    const { findings } = run(tc({}), tc({ preconditions: "User is locked out" }));
    expect(findings[0].classification).toBe("similar");
    expect(findings[0].differences.map((d) => d.field)).toContain("preconditions");
  });

  it("never reports unrelated cases", () => {
    const other = tc({
      title: "Export report as PDF",
      preconditions: "Report exists",
      test_data: "format=pdf",
      steps: [{ action: "Click export", expectedResult: "A PDF downloads" }]
    });
    expect(run(tc({}), other).findings).toEqual([]);
  });

  it("does not treat title-only stubs with no steps as exact duplicates", () => {
    const { findings } = run(tc({ steps: [], test_data: null, preconditions: null }), tc({ steps: [], test_data: null, preconditions: null }));
    expect(findings).toHaveLength(1);
    expect(findings[0].classification).toBe("similar");
    expect(findings[0].explanation).toMatch(/no steps/i);
  });

  it("reports each unordered pair once, with ordered ids, regardless of input order", () => {
    const a = tc({});
    const b = tc({});
    const forward = run(a, b).findings;
    const backward = run(b, a).findings;
    expect(forward).toHaveLength(1);
    expect(backward).toHaveLength(1);
    expect(forward[0].aId < forward[0].bId).toBe(true);
    expect([forward[0].aId, forward[0].bId]).toEqual([backward[0].aId, backward[0].bId]);
  });

  it("makes every pair in a group of three identical cases", () => {
    expect(run(tc({}), tc({}), tc({})).findings).toHaveLength(3);
  });

  it("produces identical fingerprints for identical content and different ones after a material change", () => {
    const a = toComparable(tc({}));
    const same = toComparable({ ...tc({}), title: "LOGIN with valid credentials." });
    const changed = toComparable({ ...tc({}), test_data: "user=carol" });
    expect(same.fingerprint).toBe(a.fingerprint);
    expect(changed.fingerprint).not.toBe(a.fingerprint);
  });

  it("is not fooled by a different step order", () => {
    const a = tc({});
    const b = tc({
      steps: [
        { action: "Submit valid credentials", expectedResult: "Dashboard opens" },
        { action: "Open the login page", expectedResult: "Form is shown" }
      ]
    });
    const { findings } = run(a, b);
    expect(findings[0]?.classification).not.toBe("exact_duplicate");
  });
});

describe("parseSteps", () => {
  it("reads a JSON-encoded string, plain-string steps and step/expected aliases", () => {
    expect(parseSteps(JSON.stringify([{ step: "A", expected: "B" }, "C"]))).toEqual([
      { action: "A", expected: "B" },
      { action: "C", expected: "" }
    ]);
  });
  it("tolerates garbage", () => {
    expect(parseSteps(null)).toEqual([]);
    expect(parseSteps("")).toEqual([]);
    expect(parseSteps({})).toEqual([]);
    expect(parseSteps("not json")).toEqual([{ action: "not json", expected: "" }]);
  });
});

describe("state fingerprint (review freshness)", () => {
  const base = () => tc({});

  it("changes when ANY review-state field changes", () => {
    const original = stateFingerprintOf(base());
    const changes: Array<Partial<TestcaseSource>> = [
      { description: "A genuinely different description" },
      { status: "Deprecated" },
      { suite_id: "suite-2" },
      { suite_id: null },
      { priority: "P0" },
      { severity: "Critical" },
      { type: "Regression" },
      { component: "Billing" },
      { owner_id: "owner-2" },
      { owner_id: null },
      { jira_issue_key: "TES-2" },
      { linear_issue_key: "LIN-1" },
      { notion_page_id: "page-1" }
    ];
    for (const change of changes) {
      expect(stateFingerprintOf({ ...base(), ...change })).not.toBe(original);
    }
  });

  it("ignores cosmetic description edits and surrounding whitespace in identifiers", () => {
    const original = stateFingerprintOf(base());
    expect(stateFingerprintOf({ ...base(), description: "  VERIFIES   sign-in!! " })).toBe(original);
    expect(stateFingerprintOf({ ...base(), status: " Active " })).toBe(original);
  });

  it("does not depend on fields outside the defined set, or on content fields", () => {
    const original = stateFingerprintOf(base());
    expect(stateFingerprintOf({ ...base(), title: "Another title", steps: [], test_data: "x", preconditions: "y" })).toBe(original);
  });

  it("never affects the content fingerprint or exact-duplicate detection", () => {
    const a = base();
    const b = { ...base(), status: "Deprecated", suite_id: "suite-9", priority: "P0", owner_id: null, description: "Totally different" };
    expect(toComparable(a).fingerprint).toBe(toComparable(b).fingerprint);
    expect(toComparable(a).stateFingerprint).not.toBe(toComparable(b).stateFingerprint);
    const { findings } = analyse([toComparable(a), toComparable(b)]);
    expect(findings).toHaveLength(1);
    expect(findings[0].classification).toBe("exact_duplicate");
  });

  it("is carried on every finding, ordered like the pair, and differs per side when the sides differ", () => {
    const a = base();
    const b = { ...base(), status: "Deprecated" };
    const [finding] = analyse([toComparable(a), toComparable(b)]).findings;
    const byId = new Map([[a.id, toComparable(a)], [b.id, toComparable(b)]]);
    expect(finding.stateFingerprintA).toBe(byId.get(finding.aId)!.stateFingerprint);
    expect(finding.stateFingerprintB).toBe(byId.get(finding.bId)!.stateFingerprint);
    expect(finding.stateFingerprintA).not.toBe(finding.stateFingerprintB);
  });
});

describe("rescorePair (match after an edit)", () => {
  const pair = (over: Partial<TestcaseSource>) => [toComparable(tc({})), toComparable(tc(over))] as const;

  it("always answers, even for pairs far below the analysis threshold, with the real (low) score", () => {
    const [a, b] = pair({
      title: "Export report as PDF",
      preconditions: "Report exists",
      test_data: "pdf",
      steps: [{ action: "Click export", expectedResult: "A PDF downloads" }]
    });
    expect(analyse([a, b]).findings).toEqual([]); // the analysis would drop this pair...
    const f = rescorePair(a, b); // ...but an edited finding must still show its current match
    expect(f.classification).toBe("similar");
    expect(f.similarity).toBeGreaterThanOrEqual(0);
    expect(f.similarity).toBeLessThan(0.7);
    expect(f.differences.length).toBeGreaterThan(0);
  });

  it("becomes an exact duplicate at 100% when an edit makes the two cases identical", () => {
    const [a, b] = pair({});
    const f = rescorePair(a, b);
    expect(f).toMatchObject({ classification: "exact_duplicate", similarity: 1, differences: [] });
  });

  it("matches what the analysis itself reports for a pair that is above the threshold", () => {
    const [a, b] = pair({ test_data: "user=bob" });
    const [fromAnalysis] = analyse([a, b]).findings;
    const rescored = rescorePair(a, b);
    expect(rescored.similarity).toBe(fromAnalysis.similarity);
    expect(rescored.explanation).toBe(fromAnalysis.explanation);
    expect(rescored.classification).toBe(fromAnalysis.classification);
  });

  it("goes DOWN when an edit moves the cases apart, and UP when it moves them together", () => {
    const original = toComparable(tc({ test_data: "user=bob", preconditions: "Different setup" }));
    const other = toComparable(tc({}));
    const before = rescorePair(other, original).similarity;
    const editedApart = toComparable({ ...tc({}), id: original.id, test_data: "completely other data", preconditions: "Another setup entirely", title: "Something else", steps: [] });
    const editedTogether = toComparable({ ...tc({}), id: original.id });
    expect(rescorePair(other, editedApart).similarity).toBeLessThan(before);
    expect(rescorePair(other, editedTogether).similarity).toBeGreaterThan(before);
  });

  it("carries both fingerprints on the result, ordered like the pair", () => {
    const [a, b] = pair({ test_data: "user=bob" });
    const f = rescorePair(a, b);
    expect([f.fingerprintA, f.fingerprintB].sort()).toEqual([a.fingerprint, b.fingerprint].sort());
    expect(f.aId < f.bId).toBe(true);
  });
});
