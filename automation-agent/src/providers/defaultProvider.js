import { runPlaywrightScript } from "../sessionStore.js";

export async function runWithDefaultProvider(payload) {
  return runPlaywrightScript(
    String(payload.executionId || ""),
    String(payload.script || ""),
    typeof payload.startUrl === "string" ? payload.startUrl : null,
    {
      modelProvider: typeof payload.modelProvider === "string" ? payload.modelProvider : "openai",
      modelApiKey: typeof payload.modelApiKey === "string" ? payload.modelApiKey : "",
      model: typeof payload.model === "string" ? payload.model : "",
      browserbaseApiKey: typeof payload.browserbaseApiKey === "string" ? payload.browserbaseApiKey : "",
      browserbaseProjectId: typeof payload.browserbaseProjectId === "string" ? payload.browserbaseProjectId : "",
      cacheScope: typeof payload.cacheScope === "string" ? payload.cacheScope : "",
    }
  );
}
