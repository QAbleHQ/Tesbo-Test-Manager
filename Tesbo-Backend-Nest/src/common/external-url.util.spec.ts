import { externallyReachableBaseUrl } from "./external-url.util";

/*
 * Which configured addresses may appear in a link written into another system (a Jira/Linear
 * comment). Anything that could only work on the machine or network that wrote it must come back
 * null, so the caller writes plain text instead of a link that opens each reader's own localhost.
 */
describe("externallyReachableBaseUrl", () => {
  it.each([
    ["https://app.tesbo.io", "https://app.tesbo.io"],
    ["https://app.tesbo.io/", "https://app.tesbo.io"],
    ["https://stage.tesbo.io:8443/", "https://stage.tesbo.io:8443"],
    ["https://example.com/tesbo/", "https://example.com/tesbo"],
    ["http://tesbo.example.org", "http://tesbo.example.org"],
    ["  https://app.tesbo.io  ", "https://app.tesbo.io"],
    ["https://8.8.8.8", "https://8.8.8.8"],
    ["https://[2001:4860:4860::8888]", "https://[2001:4860:4860::8888]"]
  ])("keeps a public address: %s", (input, expected) => {
    expect(externallyReachableBaseUrl(input)).toBe(expected);
  });

  it.each([
    // the local stack's own value — the reported bug
    "http://localhost:1020",
    "http://localhost:1010",
    "http://LOCALHOST:3000",
    "http://app.localhost",
    "http://127.0.0.1:1020",
    "http://127.10.0.5",
    "http://0.0.0.0:1020",
    "http://10.0.0.12",
    "http://172.16.4.1",
    "http://172.31.255.254",
    "http://192.168.1.20:1020",
    "http://169.254.10.10",
    "http://100.64.0.1",
    "http://[::1]:1020",
    "http://[fd12:3456::1]",
    "http://[fe80::1]",
    "http://[::ffff:127.0.0.1]",
    "http://frontend:3000",
    "http://host.docker.internal:1020",
    "http://tesbo.local",
    "http://router.home.arpa",
    "",
    "   ",
    null,
    undefined,
    "not a url",
    "ftp://app.tesbo.io",
    "javascript:alert(1)",
    "https://user:pass@app.tesbo.io"
  ])("refuses a machine-local or unusable address: %s", (input) => {
    expect(externallyReachableBaseUrl(input as string)).toBeNull();
  });

  it("does not mistake public ranges next to private ones for private", () => {
    expect(externallyReachableBaseUrl("http://172.32.0.1")).toBe("http://172.32.0.1");
    expect(externallyReachableBaseUrl("http://100.128.0.1")).toBe("http://100.128.0.1");
    expect(externallyReachableBaseUrl("http://192.169.0.1")).toBe("http://192.169.0.1");
  });
});
