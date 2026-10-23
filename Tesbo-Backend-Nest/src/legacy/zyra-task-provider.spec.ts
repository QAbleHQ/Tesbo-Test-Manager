import { LegacyService } from "./legacy.service";

const resolve = (LegacyService as unknown as {
  zyraTaskProviderAndModel: (row: Record<string, unknown>, allocation: Record<string, unknown>) => { provider: string; model: string };
}).zyraTaskProviderAndModel;

describe("zyraTaskProviderAndModel — a task is (re)generated with the provider of the key it is signed with", () => {
  const anthropicKey = { provider: "anthropic", default_model: "claude-sonnet-4-6" };

  it("regression: an archive-sweep row's marker provider never reaches the provider call (Anthropic key was sent to OpenAI)", () => {
    const out = resolve({ provider: "zyra_archive_sweep", model: null }, anthropicKey);
    expect(out.provider).toBe("anthropic");
    expect(out.model).toBe("claude-sonnet-4-6");
  });

  it("a row recorded under another provider than the allocated key uses the key's provider and default model", () => {
    const out = resolve({ provider: "openai", model: "gpt-4o" }, anthropicKey);
    expect(out).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  it("keeps the row's own model when it is the same provider", () => {
    const out = resolve({ provider: "openai", model: "gpt-4o-mini" }, { provider: "openai", default_model: "gpt-4o" });
    expect(out).toEqual({ provider: "openai", model: "gpt-4o-mini" });
  });

  it("falls back to openai when the allocation names no provider", () => {
    expect(resolve({ provider: "zyra_archive_sweep" }, { default_model: "gpt-4o" }).provider).toBe("openai");
  });
});
