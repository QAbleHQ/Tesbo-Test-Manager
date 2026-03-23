import test from "node:test";
import assert from "node:assert/strict";

import { resolveExecutionProvider, runExecutionWithProvider } from "../src/providers/index.js";

test("resolveExecutionProvider defaults to default", () => {
  assert.equal(resolveExecutionProvider({}), "default");
  assert.equal(resolveExecutionProvider({ executionProvider: "DEFAULT" }), "default");
});

test("cloud providers are gated behind feature flags", async () => {
  await assert.rejects(
    runExecutionWithProvider({ executionProvider: "lambdatest" }),
    /disabled/i
  );
  await assert.rejects(
    runExecutionWithProvider({ executionProvider: "browserstack" }),
    /disabled/i
  );
});
