import { describe, it } from "node:test";
import assert from "node:assert";
import { planScenario, selectObservedCandidate } from "../src/telemetry/executor.js";

describe("planScenario", () => {
  it("parses only actionable steps from step section", () => {
    const scenario = `
### Steps to Execute (ALL steps are REQUIRED)
1. Open login page
2. Enter username and password
3. Click Log in

### Completion Checklist (3 steps total)
- [ ] Step 1: Open login page
- [ ] Step 2: Enter username and password

### Execution Guidelines
- Adapt to the actual DOM structure
- Do NOT use placeholder credentials
`;
    const plan = planScenario(scenario);
    assert.strictEqual(plan.length, 3);
    assert.strictEqual(plan[0].instruction, "Open login page");
    assert.strictEqual(plan[1].instruction, "Enter username and password");
    assert.strictEqual(plan[2].instruction, "Click Log in");
  });
});

describe("selectObservedCandidate", () => {
  it("avoids scrollTo candidate for click instruction", () => {
    const candidates = [
      { method: "scrollTo", description: "Login button", selector: "xpath=/a" },
      { method: "click", description: "Login button", selector: "xpath=/b" },
    ];
    const picked = selectObservedCandidate(candidates, "Click the login button");
    assert.strictEqual(picked.index, 1);
  });

  it("falls back to direct act when only scroll candidates exist", () => {
    const candidates = [
      { method: "scrollTo", description: "Email input", selector: "xpath=/x" },
      { method: "scroll", description: "Password field", selector: "xpath=/y" },
    ];
    const picked = selectObservedCandidate(candidates, "Type password in password field");
    assert.strictEqual(picked.index, -1);
  });
});
