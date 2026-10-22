// Run with: node --test scripts/
// Covers the parts of the CI gates that are logic rather than shell: the lint ratchet's verdicts.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { evaluate, summarise } = require("./lint-ratchet");

test("a count equal to the baseline passes", () => {
  const verdict = evaluate(12, 12);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.code, 0);
});

test("a count above the baseline fails with exit code 1 and says by how much", () => {
  const verdict = evaluate(15, 12);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 1);
  assert.match(verdict.message, /\+3/);
});

test("a single new error is enough to fail", () => {
  assert.equal(evaluate(13, 12).code, 1);
  assert.equal(evaluate(1, 0).code, 1);
});

test("a count below the baseline passes but tells the author to lower it", () => {
  const verdict = evaluate(9, 12);
  assert.equal(verdict.ok, true);
  assert.match(verdict.message, /Lower the baseline/);
  assert.match(verdict.message, /to 9/);
});

test("zero errors against a zero baseline passes", () => {
  assert.equal(evaluate(0, 0).ok, true);
});

test("a missing, non-numeric, negative or fractional baseline is a configuration error (2), never a pass", () => {
  for (const baseline of [undefined, null, "12", -1, 1.5, NaN, {}, []]) {
    const verdict = evaluate(0, baseline);
    assert.equal(verdict.ok, false, JSON.stringify(baseline));
    assert.equal(verdict.code, 2, JSON.stringify(baseline));
  }
});

test("an impossible error count is a configuration error (2), never a pass", () => {
  for (const errors of [-1, 1.5, NaN, undefined]) assert.equal(evaluate(errors, 12).code, 2, String(errors));
});

test("summarise counts only errors (severity 2), not warnings, and ranks files by count", () => {
  const { errors, files } = summarise([
    { filePath: "/a.ts", messages: [{ severity: 2 }, { severity: 1 }, { severity: 2 }] },
    { filePath: "/b.ts", messages: [{ severity: 1 }, { severity: 1 }] },
    { filePath: "/c.ts", messages: [{ severity: 2 }] },
    { filePath: "/d.ts", messages: [] }
  ]);
  assert.equal(errors, 3);
  assert.deepEqual(files, [
    { file: "/a.ts", count: 2 },
    { file: "/c.ts", count: 1 }
  ]);
});

test("summarise of an empty report is zero", () => {
  assert.deepEqual(summarise([]), { errors: 0, files: [] });
});

test("the committed baseline file names both packages with whole non-negative numbers", () => {
  const baselines = JSON.parse(fs.readFileSync(path.join(__dirname, "lint-baseline.json"), "utf8"));
  for (const name of ["Tesbo-Backend-Nest", "Tesbo-Frontend"]) {
    assert.ok(Number.isInteger(baselines[name]) && baselines[name] >= 0, `${name} baseline`);
  }
});
