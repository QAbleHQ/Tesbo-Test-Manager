import { analyse, descriptionDifference, diffCases, parseSteps, rescorePair, stateFingerprintOf, stepAgreement, toComparable, type TestcaseSource } from "./review-board.analysis";
import { SIMILAR_THRESHOLD } from "./review-board.constants";

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

describe("match score: wording similarity blended with identical steps", () => {
  const S = (action: string, expectedResult: string) => ({ action, expectedResult });

  // Reported from the Review Board: shown as 79% although only 1 of the 4 steps is the same.
  const decimal = () =>
    tc({
      title: "Verify minimum rating field rejects decimal/floating-point values if only integers are expected",
      preconditions: "User is logged in as an HR manager. Navigate to the KPI configuration form with a valid job title and KPI title. Assumption: rating fields expect integer values.",
      test_data: "KPI title: 'Creativity', Min rating: 1.5, Max rating: 5",
      steps: [
        S("Select a valid job title and enter KPI title 'Creativity'.", "Fields are populated."),
        S("Enter 1.5 in the minimum rating field.", "Field accepts or flags the decimal value."),
        S("Enter 5 in the maximum rating field.", "Max rating is set to 5."),
        S("Click Save.", "If decimal values are not allowed, a validation error is displayed indicating only integer values are accepted. If decimals are allowed, KPI is saved — document actual behaviour.")
      ]
    });
  const negative = () =>
    tc({
      title: "Verify minimum rating field rejects negative values",
      preconditions: "User is logged in as an HR manager. Navigate to the KPI configuration form with a valid job title and KPI title.",
      test_data: "KPI title: 'Adaptability', Min rating: -1, Max rating: 5",
      steps: [
        S("Select a valid job title and enter KPI title 'Adaptability'.", "Fields are populated."),
        S("Enter -1 in the minimum rating field.", "Field accepts or flags the negative value."),
        S("Enter 5 in the maximum rating field.", "Max rating is set to 5."),
        S("Click Save.", "If negative ratings are not allowed, a validation error is displayed. If negative ratings are permitted, the KPI is saved — note expected behaviour as per business rules.")
      ]
    });

  it("reported case: same wording but 1 of 4 steps identical is no longer shown as ~79%", () => {
    const a = toComparable(decimal());
    const b = toComparable(negative());
    expect(stepAgreement(a, b)).toEqual({ identical: 1, total: 4 });
    const f = rescorePair(a, b);
    expect(f.similarity).toBeLessThan(0.6);
    expect(f.similarity).toBeGreaterThan(0.45);
    expect(f.explanation).toMatch(/1 of 4 steps identical/);
    expect(f.explanation).toMatch(/wording similarity/);
  });

  it("a pair that low is not listed by the analysis (below the cut-off)", () => {
    expect(SIMILAR_THRESHOLD).toBe(0.6);
    expect(analyse([toComparable(decimal()), toComparable(negative())]).findings).toEqual([]);
  });

  it("counts shared steps regardless of order, so one inserted step does not zero the rest", () => {
    const steps = [S("Open the page", "It loads"), S("Click Save", "Saved"), S("Log out", "Signed out")];
    const a = toComparable(tc({ steps }));
    const b = toComparable(tc({ steps: [S("A brand new first step", "Something"), ...steps] }));
    expect(stepAgreement(a, b)).toEqual({ identical: 3, total: 4 });
    const reordered = toComparable(tc({ steps: [steps[2], steps[0], steps[1]] }));
    expect(stepAgreement(a, reordered)).toEqual({ identical: 3, total: 3 });
  });

  it("a step is shared only when BOTH action and expected result match", () => {
    const a = toComparable(tc({ steps: [S("Click Save", "Saved")] }));
    expect(stepAgreement(a, toComparable(tc({ steps: [S("Click Save", "An error is shown")] })))).toEqual({ identical: 0, total: 1 });
    expect(stepAgreement(a, toComparable(tc({ steps: [S("click  SAVE!", "saved.")] })))).toEqual({ identical: 1, total: 1 }); // case/punctuation are not differences
  });

  it("repeated identical steps count by multiplicity", () => {
    const s = S("Click Next", "The next page opens");
    expect(stepAgreement(toComparable(tc({ steps: [s, s] })), toComparable(tc({ steps: [s] })))).toEqual({ identical: 1, total: 2 });
  });

  it("one changed step out of ten keeps a high score, so true near-duplicates stay listed", () => {
    const steps = Array.from({ length: 10 }, (_, i) => S(`Do the numbered action ${i + 1}`, `Result number ${i + 1} is shown`));
    const a = toComparable(tc({ steps }));
    const changed = steps.map((x, i) => (i === 4 ? S("Do a different thing entirely", "Something else happens") : x));
    const b = toComparable(tc({ steps: changed }));
    const f = analyse([a, b]).findings[0];
    expect(f.classification).toBe("similar");
    expect(f.similarity).toBeGreaterThan(0.85);
    expect(f.explanation).toMatch(/9 of 10 steps identical/);
  });

  it("exact duplicates are still 100%, and cases with no steps are scored on wording only", () => {
    expect(rescorePair(toComparable(tc({})), toComparable(tc({})))).toMatchObject({ classification: "exact_duplicate", similarity: 1 });
    const stubA = toComparable(tc({ steps: [], test_data: null, preconditions: null }));
    const stubB = toComparable(tc({ steps: [], test_data: null, preconditions: null }));
    expect(stepAgreement(stubA, stubB)).toEqual({ identical: 0, total: 0 });
    expect(rescorePair(stubA, stubB).similarity).toBe(1);
  });

  it("a case with steps against one without shares none of them", () => {
    expect(stepAgreement(toComparable(tc({})), toComparable(tc({ steps: [] })))).toEqual({ identical: 0, total: 2 });
  });
});

describe("explanation text lists only the fields that actually resemble each other", () => {
  const zero = /\b(title|steps|expected results|preconditions|test data) (0|1)%/;

  it("a pair with nothing in common has no wall of 0% fields (reported after an edit moved two cases fully apart)", () => {
    const base = toComparable(tc({}));
    const apart = toComparable(
      tc({
        title: "zzz qqq",
        preconditions: "aaa",
        test_data: "bbb",
        steps: [{ action: "xxx yyy", expectedResult: "ppp" }]
      })
    );
    const f = rescorePair(base, apart);
    expect(f.similarity).toBeLessThan(0.1);
    expect(f.explanation).not.toMatch(zero);
    expect(f.explanation).not.toMatch(/wording similarity/);
    expect(f.explanation).toMatch(/^\d+% match \(0 of 2 steps identical\)\. Differs in: /);
  });

  it("shows only the fields with real similarity, not the zero ones beside them", () => {
    const base = toComparable(tc({}));
    const titleOnly = toComparable(
      tc({ title: "Login flow", preconditions: "aaa", test_data: "bbb", steps: [{ action: "xxx yyy", expectedResult: "ppp" }] })
    );
    const f = rescorePair(base, titleOnly);
    expect(f.explanation).toMatch(/wording similarity: title \d+%\)/); // title is the only field listed
    expect(f.explanation).not.toMatch(/steps \d+%|expected results \d+%|preconditions \d+%|test data \d+%/);
  });

  it("keeps the full breakdown when every field resembles the other", () => {
    const f = rescorePair(toComparable(tc({})), toComparable(tc({ test_data: "user=bob" })));
    expect(f.explanation).toMatch(/wording similarity: title \d+%, steps \d+%, expected results \d+%, preconditions \d+%, test data \d+%/);
  });

  it("cases with no steps get no steps clause, and a zero-only breakdown disappears cleanly", () => {
    const a = toComparable(tc({ steps: [], title: "alpha beta", preconditions: null, test_data: null }));
    const b = toComparable(tc({ steps: [], title: "gamma delta", preconditions: null, test_data: null }));
    const f = rescorePair(a, b);
    expect(f.explanation).toBe("0% match. Differs in: title.");
  });
});

describe("description in 'What is different' (shown, never compared)", () => {
  const withDesc = (description: string | null) => toComparable(tc({ description }));

  it("lists a differing description, trimmed, with each side's text", () => {
    expect(descriptionDifference(withDesc("  Checks the happy path  "), withDesc("Checks the error path"))).toEqual({
      field: "description",
      a: "Checks the happy path",
      b: "Checks the error path"
    });
  });

  it("does not list it when the descriptions only differ in case, spacing or punctuation, or are both empty", () => {
    expect(descriptionDifference(withDesc("Checks the happy path"), withDesc("  CHECKS   the happy path!! "))).toBeNull();
    expect(descriptionDifference(withDesc(null), withDesc(""))).toBeNull();
  });

  it("shows an empty side as empty when only one case has a description", () => {
    expect(descriptionDifference(withDesc(null), withDesc("Now described"))).toEqual({ field: "description", a: "", b: "Now described" });
  });

  it("never affects matching: exact duplicates with different descriptions are still exact, at 100%, with equal fingerprints", () => {
    const a = toComparable(tc({ description: "One wording" }));
    const b = toComparable(tc({ description: "A completely different description" }));
    expect(a.fingerprint).toBe(b.fingerprint);
    const [f] = analyse([a, b]).findings;
    expect(f).toMatchObject({ classification: "exact_duplicate", similarity: 1 });
    expect(f.differences).toEqual([]); // the analysis' own list never contains it; the API adds it for display
    expect(diffCases(a, b)).toEqual([]);
  });

  it("does not change the score of a similar pair", () => {
    const same = rescorePair(toComparable(tc({ description: "x" })), toComparable(tc({ test_data: "user=bob", description: "x" })));
    const differ = rescorePair(toComparable(tc({ description: "x" })), toComparable(tc({ test_data: "user=bob", description: "something else entirely" })));
    expect(differ.similarity).toBe(same.similarity);
    expect(differ.explanation).toBe(same.explanation);
  });
});
