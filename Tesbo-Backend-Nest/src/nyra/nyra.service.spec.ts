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

describe("parseEnvironmentUpdate", () => {
  const { parseEnvironmentUpdate } = require("./nyra.service");
  it("maps the fields NYRA expects and drops unknown ones", () => {
    expect(parseEnvironmentUpdate({ baseUrl: "https://a.example.com", mode: "sandbox", allowedDomains: ["Accounts.Example.com", "accounts.example.com"], junk: 1 })).toEqual({
      base_url: "https://a.example.com",
      mode: "sandbox",
      allowed_domains: ["accounts.example.com"]
    });
  });
  it("always sends login_url and keeps the saved password when none is typed", () => {
    expect(parseEnvironmentUpdate({ testAccount: { username: "qa@x.com", password: "" } }).test_account).toEqual({ login_url: null, username: "qa@x.com", login_method: "password" });
    expect(parseEnvironmentUpdate({ testAccount: { username: "qa@x.com", password: "pw", loginUrl: "https://x.com/login" } }).test_account).toEqual({
      login_url: "https://x.com/login",
      username: "qa@x.com",
      login_method: "password",
      password: "pw"
    });
  });
  it.each([
    [{}],
    [{ name: " " }],
    [{ name: "n".repeat(61) }],
    [{ mode: "yolo" }],
    [{ baseUrl: "ftp://x" }],
    [{ allowedDomains: ["com"] }],
    [{ allowedDomains: "x.com" }],
    [{ allowedDomains: Array.from({ length: 51 }, (_, i) => `d${i}.example.com`) }],
    [{ testAccount: { username: "" } }],
    [{ testAccount: { username: "u", loginMethod: "otp" } }]
  ])("rejects %j", (body) => {
    expect(() => parseEnvironmentUpdate(body)).toThrow();
  });
});

describe("neutralizeCsv", () => {
  const { neutralizeCsv } = require("./nyra-runs.service");
  it("quotes formula cells, keeps multiline cells and doubled quotes intact", () => {
    const csv = '"Title","Steps"\r\n"=HYPERLINK(""http://x"")","1. Open\n2. Click"\r\n"-5","+cmd|x"';
    expect(neutralizeCsv(csv)).toBe('"Title","Steps"\r\n"\'=HYPERLINK(""http://x"")","1. Open\n2. Click"\r\n"-5","\'+cmd|x"');
  });
});
