import { changesBetween, stepsText } from "./review-board.edit-diff";

describe("review-board edit diff (before / after)", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    title: "Login",
    description: "d",
    preconditions: "User exists",
    postconditions: null,
    test_data: "user=alice",
    steps: [{ action: "Open", expectedResult: "Shown" }],
    ...over
  });

  it("lists only the fields that changed, in reading order, with before and after", () => {
    const changes = changesBetween(row(), row({ test_data: "user=bob", title: "Login (v2)" }));
    expect(changes).toEqual([
      { field: "title", before: "Login", after: "Login (v2)" },
      { field: "testData", before: "user=alice", after: "user=bob" }
    ]);
  });

  it("returns nothing when nothing changed, and ignores surrounding whitespace", () => {
    expect(changesBetween(row(), row())).toEqual([]);
    expect(changesBetween(row(), row({ title: "  Login  ", preconditions: "User exists\n" }))).toEqual([]);
  });

  it("renders steps as numbered lines with the expected result under each", () => {
    expect(stepsText([{ action: "Open", expectedResult: "Shown" }, "Plain step"])).toBe("1. Open\n   Expected: Shown\n2. Plain step");
    const changes = changesBetween(row(), row({ steps: [{ action: "Open", expectedResult: "Shown" }, { action: "Save", expectedResult: "Saved" }] }));
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe("steps");
    expect(changes[0].before).toBe("1. Open\n   Expected: Shown");
    expect(changes[0].after).toBe("1. Open\n   Expected: Shown\n2. Save\n   Expected: Saved");
  });

  it("treats a step stored as a JSON string the same as an array (both shapes exist)", () => {
    const asString = row({ steps: JSON.stringify([{ action: "Open", expectedResult: "Shown" }]) });
    expect(changesBetween(row(), asString)).toEqual([]);
  });

  it("reads camelCase rows (the standard audit entry) as well as snake_case rows", () => {
    const before = { title: "A", testData: "x", steps: [] };
    const after = { title: "B", testData: "y", steps: [] };
    expect(changesBetween(before, after).map((c) => c.field)).toEqual(["title", "testData"]);
  });

  it("shows null and empty as the same empty text", () => {
    expect(changesBetween(row({ description: null }), row({ description: "" }))).toEqual([]);
    expect(changesBetween(row({ description: null }), row({ description: "now set" }))).toEqual([{ field: "description", before: "", after: "now set" }]);
  });
});
