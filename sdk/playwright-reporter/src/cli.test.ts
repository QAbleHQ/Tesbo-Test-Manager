import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { configFileIsGitIgnored } from "./cli";
import { CONFIG_FILENAME } from "./file-config";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tesbo-cli-"));
}

/*
 * The CLI is a bin script that used to call main() at import time. These tests exist partly to hold
 * the `require.main === module` guard in place: without it, importing this module under `node --test`
 * parses argv, prompts, and exits the test runner.
 */
test("importing the CLI does not execute it", () => {
  // Reaching this line at all proves the guard: the import above would otherwise have run the CLI,
  // which calls process.exit() and would take the runner down with it.
  assert.equal(typeof configFileIsGitIgnored, "function");
});

test("the compiled bin runs as a script and reports its version", () => {
  const cli = path.resolve(__dirname, "../dist/cli.js");
  if (!fs.existsSync(cli)) return; // dist is built by `npm run build`; skip in a test-only compile
  const out = execFileSync(process.execPath, [cli, "--version"], { encoding: "utf-8" });
  assert.match(out.trim(), /^\d+\.\d+\.\d+$/);
});

test("the bin prints usage and exits 0 for help, so it is safe in a pipeline", () => {
  const cli = path.resolve(__dirname, "../dist/cli.js");
  if (!fs.existsSync(cli)) return;
  const out = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf-8" });
  assert.match(out, /doctor/);
  assert.match(out, /init/);
});

test("doctor exits 2 without a TTY rather than hanging a CI job waiting to prompt", () => {
  const cli = path.resolve(__dirname, "../dist/cli.js");
  if (!fs.existsSync(cli)) return;
  const dir = tmp();
  try {
    execFileSync(process.execPath, [cli, "doctor"], {
      encoding: "utf-8",
      cwd: dir,
      stdio: "pipe",
      // A clean environment, so the developer's own TESBO_* values cannot configure this run.
      env: { PATH: process.env.PATH ?? "", HOME: dir }
    });
    assert.fail("expected a non-zero exit");
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    assert.equal(e.status, 2, "not-configured is exit 2");
    assert.match(e.stderr ?? "", /not a TTY|nobody to ask/i);
  }
});

test("an unknown command exits non-zero instead of doing something surprising", () => {
  const cli = path.resolve(__dirname, "../dist/cli.js");
  if (!fs.existsSync(cli)) return;
  try {
    execFileSync(process.execPath, [cli, "publish-everything"], { encoding: "utf-8", stdio: "pipe" });
    assert.fail("expected a non-zero exit");
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    assert.notEqual(e.status, 0);
    assert.match(e.stderr ?? "", /Unknown command/);
  }
});

/* ── the gitignore check that gates storing a token in the file ───────────── */

test("a literal entry counts as ignored", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, ".gitignore"), `node_modules\n${CONFIG_FILENAME}\n`);
  assert.equal(configFileIsGitIgnored(dir), true);
});

test("a rooted entry counts too", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, ".gitignore"), `/${CONFIG_FILENAME}\n`);
  assert.equal(configFileIsGitIgnored(dir), true);
});

test("trailing whitespace is fine, because git strips it", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, ".gitignore"), `${CONFIG_FILENAME}  \n`);
  assert.equal(configFileIsGitIgnored(dir), true);
});

test("a CRLF checkout still matches", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, ".gitignore"), `node_modules\r\n${CONFIG_FILENAME}\r\n`);
  assert.equal(configFileIsGitIgnored(dir), true);
});

/*
 * Verified against git itself: `git check-ignore` reports NOT ignored for a pattern with leading
 * whitespace, because git takes the spaces as part of the filename. Treating it as ignored would tell
 * the user their token is safe from the repository when it is about to be committed.
 */
test("leading whitespace is NOT ignored by git, so it must not be treated as ignored here", () => {
  for (const body of [`  ${CONFIG_FILENAME}\n`, `\t${CONFIG_FILENAME}\n`]) {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, ".gitignore"), body);
    assert.equal(configFileIsGitIgnored(dir), false, `for ${JSON.stringify(body)}`);
  }
});

test("no .gitignore at all is not ignored", () => {
  assert.equal(configFileIsGitIgnored(tmp()), false);
});

test("a .gitignore that does not name the file is not ignored", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules\ndist\n.env\n");
  assert.equal(configFileIsGitIgnored(dir), false);
});

test("a near-miss is not accepted — reporting a token as safe when it is not is unrecoverable", () => {
  for (const body of ["tesbo.config.json.bak\n", "# tesbo.config.json\n", "tesbo\n", "my-tesbo.config.json\n"]) {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, ".gitignore"), body);
    assert.equal(configFileIsGitIgnored(dir), false, `for ${JSON.stringify(body)}`);
  }
});
