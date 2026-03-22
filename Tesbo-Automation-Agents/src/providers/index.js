import { config } from "../config.js";
import { runWithDefaultProvider } from "./defaultProvider.js";
import { runWithLambdaTestProvider } from "./lambdaTestProvider.js";
import { runWithBrowserStackProvider } from "./browserStackProvider.js";

export function resolveExecutionProvider(payload) {
  return String(payload?.executionProvider || "default").trim().toLowerCase();
}

export async function runExecutionWithProvider(payload) {
  const provider = resolveExecutionProvider(payload);
  if (provider === "lambdatest") {
    if (!config.enableLambdaTestProvider) {
      throw new Error("LambdaTest provider is disabled.");
    }
    return runWithLambdaTestProvider(payload);
  }
  if (provider === "browserstack") {
    if (!config.enableBrowserStackProvider) {
      throw new Error("BrowserStack provider is disabled.");
    }
    return runWithBrowserStackProvider(payload);
  }
  return runWithDefaultProvider(payload);
}
