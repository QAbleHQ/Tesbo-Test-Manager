#!/usr/bin/env node
/*
 * A lint gate that can be switched on today without first fixing every existing finding.
 *
 * Both packages have lint errors that predate the gate (backend: unused variables; frontend: React
 * compiler rules about state set in effects). Making `eslint` blocking would stop every deploy until
 * they were all cleaned up, and cleaning them up is not this change. So the gate is a RATCHET: the
 * number of lint errors may never go UP, and the committed baseline in lint-baseline.json is the
 * number it is held to. New code cannot add an error; old ones are paid down on their own schedule,
 * and each fix is followed by lowering the number.
 *
 *   node scripts/lint-ratchet.js <package-dir>
 *
 * Exit status: 0 at or below the baseline, 1 above it, 2 if ESLint itself could not run (a broken
 * config must never read as "zero errors").
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const BASELINE_FILE = path.join(__dirname, "lint-baseline.json");

/** Counts the errors (severity 2) in ESLint's `-f json` output, and which files hold them. */
function summarise(results) {
  let errors = 0;
  const files = [];
  for (const file of results) {
    const count = file.messages.filter((message) => message.severity === 2).length;
    errors += count;
    if (count) files.push({ file: file.filePath, count });
  }
  files.sort((a, b) => b.count - a.count);
  return { errors, files };
}

/** The verdict for a count against its baseline. Pure, so it can be tested without running ESLint. */
function evaluate(errors, baseline) {
  if (typeof baseline !== "number" || !Number.isInteger(baseline) || baseline < 0) {
    return { ok: false, code: 2, message: `No valid baseline for this package (got ${JSON.stringify(baseline)}). Add it to scripts/lint-baseline.json.` };
  }
  if (!Number.isInteger(errors) || errors < 0) return { ok: false, code: 2, message: `ESLint reported an impossible error count: ${errors}.` };
  if (errors > baseline) {
    return { ok: false, code: 1, message: `Lint errors went UP: ${errors} now, baseline ${baseline} (+${errors - baseline}). Fix the new ones; do not raise the baseline.` };
  }
  if (errors < baseline) {
    return { ok: true, code: 0, message: `Lint errors are DOWN: ${errors} now, baseline ${baseline}. Lower the baseline in scripts/lint-baseline.json to ${errors} so the improvement cannot be undone.` };
  }
  return { ok: true, code: 0, message: `Lint errors unchanged at ${errors} (the baseline).` };
}

function main(argv) {
  const dir = path.resolve(argv[2] || ".");
  const name = path.basename(dir);
  let baselines;
  try {
    baselines = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
  } catch (error) {
    console.error(`Cannot read ${BASELINE_FILE}: ${error.message}`);
    return 2;
  }

  // The backend's own script lints src only; the frontend's lints the whole package by default.
  const args = ["eslint", ...(name === "Tesbo-Backend-Nest" ? ["src/**/*.ts"] : []), "-f", "json"];
  const run = spawnSync("npx", args, { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, shell: process.platform === "win32" });
  let results;
  try {
    results = JSON.parse(run.stdout);
    if (!Array.isArray(results)) throw new Error("not an array");
  } catch {
    console.error("ESLint did not produce a report, so the lint gate cannot judge this run.");
    console.error((run.stderr || run.stdout || "").slice(0, 2000));
    return 2;
  }

  const { errors, files } = summarise(results);
  const verdict = evaluate(errors, baselines[name]);
  console.log(verdict.message);
  if (verdict.code === 1) {
    console.log("Files with the most errors:");
    for (const entry of files.slice(0, 8)) console.log(`  ${entry.count}  ${path.relative(dir, entry.file)}`);
  }
  return verdict.code;
}

if (require.main === module) process.exit(main(process.argv));

module.exports = { summarise, evaluate };
