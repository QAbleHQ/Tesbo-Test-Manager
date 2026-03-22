import { runPlaywrightScript } from "../playwrightScriptRunner.js";

export async function runWithDefaultProvider(payload) {
  return runPlaywrightScript(
    String(payload.executionId || ""),
    String(payload.script || ""),
    typeof payload.startUrl === "string" ? payload.startUrl : null
  );
}
