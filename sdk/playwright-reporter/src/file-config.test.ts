import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CONFIG_FILENAME,
  detectsDotenv,
  readConfigFile,
  writeConfigFile,
  NO_FILE_CONFIG
} from "./file-config";
import { resolveConfig } from "./config";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tesbo-cfg-"));
}

function write(dir: string, body: string): void {
  fs.writeFileSync(path.join(dir, CONFIG_FILENAME), body);
}

function read(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILENAME), "utf-8"));
}

/* ── reading ──────────────────────────────────────────────────────────────── */

test("no file is the ordinary state, not an error", () => {
  const result = readConfigFile(tmp());
  assert.deepEqual(result.values, {});
  assert.equal(result.path, null);
  assert.equal(result.error, undefined);
});

test("a complete file supplies all three values", () => {
  const dir = tmp();
  write(dir, JSON.stringify({ baseUrl: "https://api.example.com", projectId: "p-1", token: "tsbo_abc" }));
  const result = readConfigFile(dir);
  assert.deepEqual(result.values, { baseUrl: "https://api.example.com", projectId: "p-1", token: "tsbo_abc" });
  assert.equal(result.error, undefined);
});

test("values are trimmed, matching how the env vars are read", () => {
  const dir = tmp();
  write(dir, JSON.stringify({ baseUrl: "  https://api.example.com  ", projectId: "p-1\n" }));
  assert.equal(readConfigFile(dir).values.baseUrl, "https://api.example.com");
  assert.equal(readConfigFile(dir).values.projectId, "p-1");
});

test("a whitespace-only value counts as unset rather than as an empty string", () => {
  const dir = tmp();
  write(dir, JSON.stringify({ baseUrl: "   ", projectId: "p-1" }));
  const result = readConfigFile(dir);
  assert.equal(result.values.baseUrl, undefined);
  assert.equal(result.values.projectId, "p-1");
});

test("malformed JSON is reported, never silently treated as absent", () => {
  const dir = tmp();
  write(dir, "{ baseUrl: nope }");
  const result = readConfigFile(dir);
  assert.match(result.error ?? "", /not valid JSON/);
  assert.deepEqual(result.values, {});
});

test("a JSON array or scalar is refused — the file must be an object", () => {
  for (const body of ["[]", '"a string"', "42", "null"]) {
    const dir = tmp();
    write(dir, body);
    assert.match(readConfigFile(dir).error ?? "", /must contain a JSON object/, `for ${body}`);
  }
});

test("a non-string value is named rather than coerced", () => {
  const dir = tmp();
  write(dir, JSON.stringify({ baseUrl: 1021 }));
  const result = readConfigFile(dir);
  assert.match(result.error ?? "", /"baseUrl" must be a string, got number/);
});

test("an array in a string position says array, not object", () => {
  const dir = tmp();
  write(dir, JSON.stringify({ projectId: ["a"] }));
  assert.match(readConfigFile(dir).error ?? "", /"projectId" must be a string, got array/);
});

test("keys the SDK does not own are kept apart from the values it resolves", () => {
  const dir = tmp();
  write(dir, JSON.stringify({ baseUrl: "https://api.example.com", environment: "staging", $schema: "./s.json" }));
  const result = readConfigFile(dir);
  assert.deepEqual(result.values, { baseUrl: "https://api.example.com" });
  assert.deepEqual(result.extra, { environment: "staging", $schema: "./s.json" });
});

/* ── writing ──────────────────────────────────────────────────────────────── */

test("writing creates the file with the values given", () => {
  const dir = tmp();
  writeConfigFile({ baseUrl: "https://api.example.com", projectId: "p-1" }, { cwd: dir });
  assert.deepEqual(read(dir), { baseUrl: "https://api.example.com", projectId: "p-1" });
});

test("re-running with a new server updates it in place — the whole point of the file", () => {
  const dir = tmp();
  writeConfigFile({ baseUrl: "http://localhost:1021", projectId: "p-1" }, { cwd: dir });
  writeConfigFile({ baseUrl: "https://api-app.tesbo.io", projectId: "p-1" }, { cwd: dir });
  const body = read(dir);
  assert.equal(body.baseUrl, "https://api-app.tesbo.io");
  // One entry, not two: rewriting is why init is safe to run repeatedly.
  assert.equal(Object.keys(body).length, 2);
});

test("a partial write leaves the values it was not given alone", () => {
  const dir = tmp();
  writeConfigFile({ baseUrl: "https://api.example.com", projectId: "p-1" }, { cwd: dir });
  writeConfigFile({ projectId: "p-2" }, { cwd: dir });
  assert.deepEqual(read(dir), { baseUrl: "https://api.example.com", projectId: "p-2" });
});

test("the user's own keys survive a rewrite", () => {
  const dir = tmp();
  write(dir, JSON.stringify({ baseUrl: "https://old.example.com", environment: "staging", strict: true }));
  writeConfigFile({ baseUrl: "https://new.example.com" }, { cwd: dir });
  const body = read(dir);
  assert.equal(body.baseUrl, "https://new.example.com");
  assert.equal(body.environment, "staging");
  assert.equal(body.strict, true);
});

test("an explicitly absent token removes one a previous run stored", () => {
  const dir = tmp();
  writeConfigFile({ baseUrl: "https://api.example.com", projectId: "p-1", token: "tsbo_abc" }, { cwd: dir });
  assert.equal(read(dir).token, "tsbo_abc");
  // undefined means "not given" for baseUrl/projectId, but the caller passes it deliberately for the
  // token when the answer to "store it here?" is no.
  writeConfigFile({ token: undefined }, { cwd: dir });
  assert.equal(read(dir).token, "tsbo_abc", "an omitted token must not wipe a stored one");
  writeConfigFile({ token: "" }, { cwd: dir });
  assert.equal("token" in read(dir), false, "an empty token removes the key");
});

test("a file holding a token is written 600, not world-readable", () => {
  const dir = tmp();
  const written = writeConfigFile({ baseUrl: "https://api.example.com", token: "tsbo_abc" }, { cwd: dir });
  assert.equal(written.hasToken, true);
  assert.equal(fs.statSync(written.path).mode & 0o777, 0o600);
});

test("a file gaining a token is chmodded, not left at its old permissions", () => {
  const dir = tmp();
  const written = writeConfigFile({ baseUrl: "https://api.example.com" }, { cwd: dir });
  assert.equal(fs.statSync(written.path).mode & 0o777, 0o644);
  writeConfigFile({ token: "tsbo_abc" }, { cwd: dir });
  assert.equal(fs.statSync(written.path).mode & 0o777, 0o600);
});

test("a malformed file is replaced rather than merged into", () => {
  const dir = tmp();
  write(dir, "{ not json");
  writeConfigFile({ baseUrl: "https://api.example.com" }, { cwd: dir });
  assert.deepEqual(read(dir), { baseUrl: "https://api.example.com" });
});

test("the file ends with a newline, so it does not fight a text editor", () => {
  const dir = tmp();
  const written = writeConfigFile({ baseUrl: "https://api.example.com" }, { cwd: dir });
  assert.ok(fs.readFileSync(written.path, "utf-8").endsWith("}\n"));
});

/* ── precedence ───────────────────────────────────────────────────────────── */

test("the file supplies all three when nothing else does", () => {
  const dir = tmp();
  write(dir, JSON.stringify({ baseUrl: "https://api.example.com", projectId: "p-1", token: "tsbo_abc" }));
  const resolution = resolveConfig({}, {}, readConfigFile(dir));
  assert.equal(resolution.state, "ok");
  if (resolution.state !== "ok") return;
  assert.equal(resolution.config.baseUrl, "https://api.example.com");
  assert.equal(resolution.config.token, "tsbo_abc");
});

test("a value read from the file is stated in the notes, so it is traceable", () => {
  const dir = tmp();
  write(dir, JSON.stringify({ baseUrl: "https://api.example.com", projectId: "p-1", token: "tsbo_abc" }));
  const resolution = resolveConfig({}, {}, readConfigFile(dir));
  assert.equal(resolution.state, "ok");
  if (resolution.state !== "ok") return;
  assert.ok(resolution.notes.some((n) => n.includes(CONFIG_FILENAME)));
});

test("the environment beats the file, because CI secrets must win over a committed value", () => {
  const dir = tmp();
  write(dir, JSON.stringify({ baseUrl: "https://committed.example.com", projectId: "p-1", token: "tsbo_old" }));
  const resolution = resolveConfig({}, { TESBO_API_TOKEN: "tsbo_from_ci" }, readConfigFile(dir));
  assert.equal(resolution.state, "ok");
  if (resolution.state !== "ok") return;
  assert.equal(resolution.config.token, "tsbo_from_ci");
  assert.equal(resolution.config.baseUrl, "https://committed.example.com");
});

test("inline options beat both", () => {
  const dir = tmp();
  write(dir, JSON.stringify({ baseUrl: "https://file.example.com", projectId: "p-1", token: "tsbo_abc" }));
  const resolution = resolveConfig(
    { baseUrl: "https://inline.example.com" },
    { TESBO_BASE_URL: "https://env.example.com" },
    readConfigFile(dir)
  );
  assert.equal(resolution.state, "ok");
  if (resolution.state !== "ok") return;
  assert.equal(resolution.config.baseUrl, "https://inline.example.com");
});

test("a file supplying only some values is incomplete, never a silent opt-out", () => {
  const dir = tmp();
  write(dir, JSON.stringify({ baseUrl: "https://api.example.com", projectId: "p-1" }));
  const resolution = resolveConfig({}, {}, readConfigFile(dir));
  assert.equal(resolution.state, "incomplete");
  if (resolution.state !== "incomplete") return;
  assert.deepEqual(resolution.missing, ["TESBO_API_TOKEN"]);
});

test("an unreadable file is invalid, so the run says so instead of reporting nowhere", () => {
  const dir = tmp();
  write(dir, "{ broken");
  const resolution = resolveConfig({}, {}, readConfigFile(dir));
  assert.equal(resolution.state, "invalid");
});

test("resolveConfig does not touch the disk unless a file is handed to it", () => {
  const dir = tmp();
  write(dir, JSON.stringify({ baseUrl: "https://api.example.com", projectId: "p-1", token: "tsbo_abc" }));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    // Two-argument form: a pure function. A default that read cwd would make every existing test
    // depend on whatever happened to be on disk.
    assert.equal(resolveConfig({}, {}).state, "unconfigured");
    assert.deepEqual(NO_FILE_CONFIG.values, {});
  } finally {
    process.chdir(cwd);
  }
});

/* ── dotenv detection ─────────────────────────────────────────────────────── */

test("dotenv is detected as a dependency", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { dotenv: "^16.0.0" } }));
  assert.equal(detectsDotenv(dir), true);
});

test("dotenv is detected as a devDependency", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ devDependencies: { dotenv: "^16.0.0" } }));
  assert.equal(detectsDotenv(dir), true);
});

test("dotenv imported by the Playwright config counts, even without the dependency listed", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "playwright.config.ts"), "import 'dotenv/config';\nexport default {};");
  assert.equal(detectsDotenv(dir), true);
});

test("a project with no loader is reported as such — this is what the .env warning turns on", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ devDependencies: { "@playwright/test": "^1.58.0" } }));
  fs.writeFileSync(path.join(dir, "playwright.config.ts"), "export default { reporter: [['list']] };");
  assert.equal(detectsDotenv(dir), false);
});

test("an empty directory is not mistaken for a project that loads .env", () => {
  assert.equal(detectsDotenv(tmp()), false);
});
