import { nyraValidationMessage, parseCreateBody } from "./nyra.service";

const ok = { name: "  Shop ", appUrl: "https://staging.example.com" };

describe("parseCreateBody", () => {
  it("trims the name and omits an empty test account", () => {
    expect(parseCreateBody(ok)).toEqual({ name: "Shop", appUrl: "https://staging.example.com", testAccount: null });
    expect(parseCreateBody({ ...ok, testAccount: { loginUrl: "", username: " ", password: "", loginMethod: "password" } }).testAccount).toBeNull();
  });

  it.each([
    [{ ...ok, name: "   " }],
    [{ ...ok, name: "x".repeat(121) }],
    [{ ...ok, appUrl: "" }],
    [{ ...ok, appUrl: "ftp://example.com" }],
    [{ ...ok, appUrl: "not a url" }],
    [{ ...ok, testAccount: { username: "qa@x.com" } }],
    [{ ...ok, testAccount: { password: "pw" } }],
    [{ ...ok, testAccount: { loginUrl: "https://x.com/login" } }],
    [{ ...ok, testAccount: { username: "qa@x.com", password: "pw", loginMethod: "otp" } }],
    [{ ...ok, testAccount: { username: "u".repeat(256), password: "pw" } }],
    [{ ...ok, testAccount: { username: "qa@x.com", password: "pw", loginUrl: "javascript:alert(1)" } }]
  ])("rejects %j", (body) => {
    expect(() => parseCreateBody(body as any)).toThrow();
  });

  it("keeps a full password test account", () => {
    const out = parseCreateBody({ ...ok, testAccount: { loginUrl: "https://x.com/login", username: " qa@x.com ", password: " pw ", loginMethod: "password" } });
    expect(out.testAccount).toEqual({ loginUrl: "https://x.com/login", username: "qa@x.com", password: " pw " });
  });
});

describe("nyraValidationMessage", () => {
  it("keeps only msg and never echoes input (the submitted password)", () => {
    const msg = nyraValidationMessage([{ type: "x", loc: ["body"], msg: "Password login needs a password", input: { password: "hunter2" } }]);
    expect(msg).toBe("Password login needs a password");
    expect(msg).not.toContain("hunter2");
  });
  it("falls back on an unknown shape", () => {
    expect(nyraValidationMessage(undefined)).toBe("NYRA rejected the project details");
  });
});
