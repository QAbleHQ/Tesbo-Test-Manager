import * as http from "http";
import type { AddressInfo } from "net";
import { allowPrivateAiHosts, assertSafeBaseUrl, assertSafeUrlSyntax, classifyAddress, resolveSafeTarget, safeFetch, UnsafeOutboundUrlError } from "./safe-fetch";

/*
 * A workspace owner chooses an AI provider's base URL and the server then calls it with the stored
 * key, so the URL is untrusted input. These pin what is refused, that the connection goes to the
 * address that was checked, and that the rest behaves like fetch for the callers that replaced it.
 */

describe("classifyAddress", () => {
  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "104.18.2.55",
    "93.184.216.34",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "11.0.0.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
    "::ffff:808:808"
  ])("%s is public", (address) => {
    expect(classifyAddress(address)).toBe("public");
  });

  it.each([
    "10.0.0.1",
    "10.255.255.255",
    "127.0.0.1",
    "127.255.255.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "192.168.255.255",
    "100.64.0.1",
    "100.127.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "::1",
    "fc00::1",
    "fd12:3456:789a::1",
    "fec0::1",
    "2001:db8::1",
    "2001::1",
    "2002:7f00:1::1",
    "64:ff9b::7f00:1",
    "100::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:a00:1",
    "::ffff:192.168.1.1"
  ])("%s is private", (address) => {
    expect(classifyAddress(address)).toBe("private");
  });

  it.each([
    "0.0.0.0",
    "0.1.2.3",
    "169.254.169.254",
    "169.254.0.1",
    "100.100.100.200",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::2",
    "fe80::1",
    "febf::1",
    "ff02::1",
    "fd00:ec2::254",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "::ffff:0.0.0.0"
  ])("%s is always blocked", (address) => {
    expect(classifyAddress(address)).toBe("blocked");
  });

  it.each(["not-an-ip", "", "999.1.1.1", "1.2.3", "localhost", "example.com"])("treats %j, which is not an address, as blocked rather than public", (value) => {
    expect(classifyAddress(value)).toBe("blocked");
  });

  it("strips brackets and zone ids", () => {
    expect(classifyAddress("[::1]")).toBe("private");
    expect(classifyAddress("fe80::1%eth0")).toBe("blocked");
  });
});

describe("assertSafeUrlSyntax, hosted (private addresses not allowed)", () => {
  const refuse = (url: string) => expect(() => assertSafeUrlSyntax(url, false)).toThrow(UnsafeOutboundUrlError);
  const accept = (url: string) => expect(() => assertSafeUrlSyntax(url, false)).not.toThrow();

  it.each([
    "https://api.openai.com/v1",
    "https://api.groq.com/openai/v1",
    "https://my-resource.openai.azure.com/",
    "https://llm.example.co.uk:8443/v1/",
    "https://1.1.1.1/v1",
    "https://[2606:4700:4700::1111]/v1",
    "https://xn--80ak6aa92e.example/v1",
    "HTTPS://API.EXAMPLE.COM/V1"
  ])("accepts %s", accept);

  it.each([
    ["http://api.example.com/v1", "plain http"],
    ["ftp://api.example.com/", "ftp"],
    ["file:///etc/passwd", "file"],
    ["gopher://api.example.com/", "gopher"],
    ["javascript:alert(1)", "javascript"],
    ["data:text/plain,hi", "data"],
    ["ws://api.example.com/", "websocket"],
    ["//api.example.com/v1", "scheme-relative"],
    ["api.example.com/v1", "no scheme"],
    ["https://user:pass@api.example.com/", "userinfo"],
    ["https://user@api.example.com/", "username only"],
    ["https://api.example.com@evil.example.com/", "userinfo that looks like a host"],
    ["https://", "no host"],
    ["", "empty"],
    ["   ", "blank"],
    ["https://exa mple.com/", "space in host"],
    [`https://${"a".repeat(3000)}.example.com/`, "over-long"]
  ])("refuses %s (%s)", (url) => refuse(url));

  it.each([
    "https://localhost/v1",
    "https://LOCALHOST/v1",
    "https://localhost./v1",
    "https://api.localhost/v1",
    "https://db.internal/v1",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://printer.local/",
    "https://router.home.arpa/",
    "https://backend/",
    "https://backend:1021/",
    "https://redis:6379/",
    "https://postgres/",
    "https://host.docker.internal/",
    "https://svc.cluster.local/",
    "https://thing.lan/",
    "https://thing.corp/",
    "https://thing.intranet/",
    "https://thing.localdomain/"
  ])("refuses the local name %s", refuse);

  it.each([
    "https://127.0.0.1/",
    "https://127.1/",
    "https://2130706433/",
    "https://0x7f.0.0.1/",
    "https://017700000001/",
    "https://0177.0.0.1/",
    "https://0/",
    "https://0.0.0.0/",
    "https://10.0.0.1/",
    "https://172.16.0.1/",
    "https://192.168.1.1/",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://[::ffff:7f00:1]/",
    "https://[fe80::1]/",
    "https://[fd00:ec2::254]/latest/",
    "https://[fc00::1]/",
    "https://127.0.0.1./",
    "https://100.100.100.200/"
  ])("refuses the address literal %s in every spelling the URL parser folds to it", refuse);

  it("says nothing about what the address was", () => {
    try {
      assertSafeUrlSyntax("https://169.254.169.254/", false);
      throw new Error("should have refused");
    } catch (error) {
      expect((error as Error).message).not.toMatch(/169|254/);
    }
  });
});

describe("assertSafeUrlSyntax, self-hosted (ALLOW_PRIVATE_AI_HOSTS)", () => {
  it.each([
    "http://localhost:11434/v1",
    "http://127.0.0.1:1234/v1",
    "http://192.168.1.50:8000/v1",
    "http://ollama:11434/v1",
    "http://host.docker.internal:11434/v1",
    "https://llm.internal/v1",
    "http://[::1]:8080/"
  ])("accepts %s", (url) => {
    expect(() => assertSafeUrlSyntax(url, true)).not.toThrow();
  });

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "https://169.254.169.254/",
    "http://0.0.0.0:8080/",
    "http://0/",
    "http://[fd00:ec2::254]/",
    "http://[fe80::1]/",
    "http://224.0.0.1/",
    "http://255.255.255.255/",
    "http://100.100.100.200/",
    "http://[::ffff:169.254.169.254]/",
    "http://2852039166/" // 169.254.169.254 as one integer
  ])("still refuses %s, which no runtime lives on", (url) => {
    expect(() => assertSafeUrlSyntax(url, true)).toThrow(UnsafeOutboundUrlError);
  });

  it.each(["ftp://localhost/", "file:///etc/passwd", "http://user:pass@localhost/"])("still refuses %s", (url) => {
    expect(() => assertSafeUrlSyntax(url, true)).toThrow(UnsafeOutboundUrlError);
  });
});

describe("allowPrivateAiHosts", () => {
  const original = process.env.ALLOW_PRIVATE_AI_HOSTS;
  afterEach(() => {
    if (original === undefined) delete process.env.ALLOW_PRIVATE_AI_HOSTS;
    else process.env.ALLOW_PRIVATE_AI_HOSTS = original;
  });

  it("is off unless exactly 'true', whatever else is set", () => {
    delete process.env.ALLOW_PRIVATE_AI_HOSTS;
    expect(allowPrivateAiHosts()).toBe(false);
    for (const value of ["", "false", "0", "1", "yes", "on", "TRUE ", "no", "enabled"]) {
      process.env.ALLOW_PRIVATE_AI_HOSTS = value;
      expect(allowPrivateAiHosts()).toBe(value.trim().toLowerCase() === "true");
    }
    process.env.ALLOW_PRIVATE_AI_HOSTS = "true";
    expect(allowPrivateAiHosts()).toBe(true);
  });
});

describe("resolveSafeTarget: the name is resolved here and every answer is checked", () => {
  const answers = (...addresses: string[]) => async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

  it("returns the address to connect to", async () => {
    const target = await resolveSafeTarget("https://api.example.com/v1", { allowPrivate: false, lookup: answers("93.184.216.34") });
    expect(target.address).toBe("93.184.216.34");
    expect(target.family).toBe(4);
    expect(target.url.hostname).toBe("api.example.com");
  });

  it("returns an IPv6 address with its family", async () => {
    const target = await resolveSafeTarget("https://api.example.com/", { allowPrivate: false, lookup: answers("2606:4700:4700::1111") });
    expect(target.family).toBe(6);
  });

  it.each([
    ["a name that resolves to loopback", ["127.0.0.1"]],
    ["a name that resolves to a private address", ["10.0.0.5"]],
    ["a name that resolves to the metadata address", ["169.254.169.254"]],
    ["a name that resolves to an IPv4-mapped private address", ["::ffff:10.0.0.5"]],
    ["a name that resolves to IPv6 loopback", ["::1"]],
    ["a name that resolves to a unique-local address", ["fd00::1"]],
    ["rebinding: one public answer and one private one", ["93.184.216.34", "10.0.0.5"]],
    ["rebinding, private answer first", ["10.0.0.5", "93.184.216.34"]],
    ["rebinding to the metadata address among many", ["93.184.216.34", "8.8.8.8", "169.254.169.254"]],
    ["a public IPv6 answer and a private IPv4 one", ["2606:4700:4700::1111", "192.168.0.1"]]
  ])("refuses %s", async (_label, resolved) => {
    await expect(resolveSafeTarget("https://api.example.com/", { allowPrivate: false, lookup: answers(...resolved) })).rejects.toBeInstanceOf(
      UnsafeOutboundUrlError
    );
  });

  it("refuses the metadata address even when private hosts are allowed, including by rebinding", async () => {
    await expect(resolveSafeTarget("https://api.example.com/", { allowPrivate: true, lookup: answers("169.254.169.254") })).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    await expect(resolveSafeTarget("https://api.example.com/", { allowPrivate: true, lookup: answers("10.0.0.1", "169.254.169.254") })).rejects.toBeInstanceOf(
      UnsafeOutboundUrlError
    );
    await expect(resolveSafeTarget("https://api.example.com/", { allowPrivate: true, lookup: answers("10.0.0.1") })).resolves.toBeTruthy();
  });

  it("reports an unresolvable name and an empty answer without leaking the resolver's error", async () => {
    await expect(
      resolveSafeTarget("https://api.example.com/", { allowPrivate: false, lookup: async () => Promise.reject(new Error("getaddrinfo ENOTFOUND api.example.com 10.0.0.2:53")) })
    ).rejects.toThrow("The host name could not be resolved.");
    await expect(resolveSafeTarget("https://api.example.com/", { allowPrivate: false, lookup: async () => [] })).rejects.toThrow("could not be resolved");
  });

  it("does not look up an address literal", async () => {
    const lookup = jest.fn();
    await resolveSafeTarget("https://8.8.8.8/v1", { allowPrivate: false, lookup });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses before any lookup when the syntax is already wrong", async () => {
    const lookup = jest.fn();
    await expect(resolveSafeTarget("http://api.example.com/", { allowPrivate: false, lookup })).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    await expect(resolveSafeTarget("https://localhost/", { allowPrivate: false, lookup })).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("assertSafeBaseUrl applies the same rules at save time", async () => {
    await expect(assertSafeBaseUrl("https://api.example.com/v1", { allowPrivate: false, lookup: answers("93.184.216.34") })).resolves.toBeUndefined();
    await expect(assertSafeBaseUrl("https://api.example.com/v1", { allowPrivate: false, lookup: answers("10.0.0.1") })).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
  });
});

describe("safeFetch against a real server", () => {
  interface Seen {
    method?: string;
    url?: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  }
  let server: http.Server;
  let base: string;
  let port: number;
  const seen: Seen[] = [];
  let hits = 0;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits++;
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        handler(req, res, body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    seen.length = 0;
    hits = 0;
    handler = (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    };
  });

  const allow = { allowPrivate: true };

  it("works like fetch for a JSON POST: method, path, query, headers and body arrive, the Response parses", async () => {
    handler = (_req, res, body) => {
      res.statusCode = 201;
      res.statusMessage = "Created";
      res.setHeader("content-type", "application/json");
      res.setHeader("x-request-id", "abc");
      res.end(JSON.stringify({ echoed: JSON.parse(body) }));
    };
    const res = await safeFetch(`${base}/v1/chat/completions?api-version=2024&x=1`, {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] })
    }, allow);
    expect(res.status).toBe(201);
    expect(res.statusText).toBe("Created");
    expect(res.ok).toBe(true);
    expect(res.headers.get("x-request-id")).toBe("abc");
    expect(await res.json()).toEqual({ echoed: { model: "m", messages: [{ role: "user", content: "hi" }] } });
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/v1/chat/completions?api-version=2024&x=1");
    expect(seen[0].headers.authorization).toBe("Bearer sk-test");
    expect(seen[0].headers["content-length"]).toBe(String(Buffer.byteLength(seen[0].body)));
  });

  it("sends GET with no body, and reports error statuses as a Response, not an exception", async () => {
    handler = (_req, res) => {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "bad key" } }));
    };
    const res = await safeFetch(`${base}/v1/models`, { method: "GET", headers: { authorization: "Bearer x" } }, allow);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { message: "bad key" } });
    expect(seen[0].body).toBe("");
    expect(seen[0].headers["content-length"]).toBeUndefined();
  });

  it("carries a multipart FormData (the audio upload) with its boundary intact", async () => {
    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("file", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/mpeg" }), "clip.mp3");
    const res = await safeFetch(`${base}/v1/audio/transcriptions`, { method: "POST", body: form }, allow);
    expect(res.ok).toBe(true);
    expect(String(seen[0].headers["content-type"])).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen[0].body).toContain('name="model"');
    expect(seen[0].body).toContain("whisper-1");
    expect(seen[0].body).toContain('filename="clip.mp3"');
  });

  it("carries URLSearchParams with the form content type", async () => {
    await safeFetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", a: "b c" }) }, allow);
    expect(String(seen[0].headers["content-type"])).toContain("application/x-www-form-urlencoded");
    expect(seen[0].body).toBe("grant_type=refresh_token&a=b+c");
  });

  it("asks for an uncompressed body unless the caller said otherwise", async () => {
    await safeFetch(`${base}/a`, {}, allow);
    expect(seen[0].headers["accept-encoding"]).toBe("identity");
    await safeFetch(`${base}/b`, { headers: { "accept-encoding": "gzip" } }, allow);
    expect(seen[1].headers["accept-encoding"]).toBe("gzip");
  });

  it("answers null-body statuses and HEAD with an empty body instead of throwing", async () => {
    handler = (_req, res) => {
      res.statusCode = 204;
      res.end();
    };
    const noContent = await safeFetch(`${base}/x`, { method: "DELETE" }, allow);
    expect(noContent.status).toBe(204);
    expect(noContent.body).toBeNull();
    expect(await noContent.text()).toBe("");

    handler = (_req, res) => {
      res.setHeader("content-length", "10");
      res.end();
    };
    const head = await safeFetch(`${base}/x`, { method: "HEAD" }, allow);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("keeps repeated headers such as set-cookie", async () => {
    handler = (_req, res) => {
      res.setHeader("set-cookie", ["a=1", "b=2"]);
      res.end("ok");
    };
    const res = await safeFetch(`${base}/x`, {}, allow);
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });

  it("streams: a caller can read the body chunk by chunk, as the streaming chat code does", async () => {
    handler = (_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.write("data: one\n\n");
      setTimeout(() => {
        res.write("data: two\n\n");
        res.end("data: [DONE]\n\n");
      }, 20);
    };
    const res = await safeFetch(`${base}/stream`, {}, allow);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    let text = "";
    const decoder = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) text += decoder.decode(chunk, { stream: true });
    expect(text).toBe("data: one\n\ndata: two\n\ndata: [DONE]\n\n");
  });

  it("connects to the address it checked, not to the name: a name that does not exist still reaches the checked address", async () => {
    // The injected lookup stands in for DNS. If safeFetch resolved the name again at connect time this
    // would fail with ENOTFOUND, because nothing answers for it.
    const res = await safeFetch(`http://pinned.invalid:${port}/v1`, {}, {
      allowPrivate: true,
      lookup: async () => [{ address: "127.0.0.1", family: 4 }]
    });
    expect(res.ok).toBe(true);
    // The name still goes in the Host header, so virtual hosting and TLS validation keep working.
    expect(seen[0].headers.host).toBe(`pinned.invalid:${port}`);
  });

  it.each([301, 302, 303, 307, 308])("does not follow a %s, and the redirect target is never contacted", async (status) => {
    const other = http.createServer((_req, res) => {
      hits += 100;
      res.end("reached");
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const otherPort = (other.address() as AddressInfo).port;
    handler = (_req, res) => {
      res.statusCode = status;
      res.setHeader("location", `http://127.0.0.1:${otherPort}/secret`);
      res.end();
    };
    try {
      await expect(safeFetch(`${base}/x`, {}, allow)).rejects.toThrow(/redirect/i);
      expect(hits).toBe(1);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it("does not follow a redirect to the metadata address either, and the message does not repeat the target", async () => {
    handler = (_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "http://169.254.169.254/latest/meta-data/");
      res.end();
    };
    const error = await safeFetch(`${base}/x`, {}, allow).catch((e) => e as Error);
    expect(error).toBeInstanceOf(UnsafeOutboundUrlError);
    expect((error as Error).message).not.toContain("169.254");
  });

  it("refuses a response larger than the cap, as a rejected read, not a crash", async () => {
    handler = (_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.write(Buffer.alloc(40_000, 0x61));
      res.write(Buffer.alloc(40_000, 0x61));
      res.end(Buffer.alloc(40_000, 0x61));
    };
    const res = await safeFetch(`${base}/big`, {}, { ...allow, maxBytes: 50_000 });
    await expect(res.text()).rejects.toThrow(/larger than the allowed size/);
  });

  it("accepts a response exactly at the cap", async () => {
    handler = (_req, res) => res.end(Buffer.alloc(1000, 0x62));
    const res = await safeFetch(`${base}/ok`, {}, { ...allow, maxBytes: 1000 });
    expect((await res.text()).length).toBe(1000);
  });

  it("rejects with a TimeoutError when the caller's signal times out, as fetch does", async () => {
    handler = () => undefined; // never answers
    const error = await safeFetch(`${base}/slow`, { signal: AbortSignal.timeout(80) }, allow).catch((e) => e);
    expect((error as Error).name).toBe("TimeoutError");
  });

  it("rejects with an AbortError when the caller aborts, and with the signal's reason", async () => {
    handler = () => undefined;
    const controller = new AbortController();
    const pending = safeFetch(`${base}/slow`, { signal: controller.signal }, allow);
    setTimeout(() => controller.abort(), 40);
    const error = await pending.catch((e) => e);
    expect((error as Error).name).toBe("AbortError");
  });

  it("rejects at once for a signal that is already aborted, without touching the network", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(safeFetch(`${base}/x`, { signal: controller.signal }, allow)).rejects.toMatchObject({ name: "AbortError" });
    expect(hits).toBe(0);
  });

  it("has its own ceiling, so a request with no signal cannot hang forever", async () => {
    handler = () => undefined;
    const error = await safeFetch(`${base}/slow`, {}, { ...allow, timeoutMs: 80 }).catch((e) => e);
    expect((error as Error).name).toBe("TimeoutError");
  });

  it("aborts a body that stalls part-way through", async () => {
    handler = (_req, res) => {
      res.write("partial");
    };
    const res = await safeFetch(`${base}/stall`, {}, { ...allow, timeoutMs: 120 });
    await expect(res.text()).rejects.toBeTruthy();
  });

  it("reports a refused connection as an error, not a hang", async () => {
    const closed = await new Promise<number>((resolve) => {
      const s = http.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    await expect(safeFetch(`http://127.0.0.1:${closed}/`, {}, allow)).rejects.toBeTruthy();
  });

  it("refuses a private address by default, before connecting", async () => {
    delete process.env.ALLOW_PRIVATE_AI_HOSTS;
    await expect(safeFetch(`${base}/x`)).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    expect(hits).toBe(0);
  });

  it.each(["http://169.254.169.254/latest/meta-data/", "http://0.0.0.0:80/", "http://224.0.0.1/", "http://[fd00:ec2::254]/", "http://2852039166/"])(
    "refuses %s even with private hosts allowed",
    async (url) => {
      await expect(safeFetch(url, {}, allow)).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    }
  );

  it("refuses a URL that is not http(s) before doing anything else", async () => {
    await expect(safeFetch("file:///etc/passwd", {}, allow)).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    await expect(safeFetch("gopher://127.0.0.1/", {}, allow)).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    await expect(safeFetch("not a url", {}, allow)).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
  });

  it("accepts a URL object as well as a string", async () => {
    const res = await safeFetch(new URL(`${base}/obj`), {}, allow);
    expect(res.ok).toBe(true);
    expect(seen[0].url).toBe("/obj");
  });

  it("keeps a path that contains encoded characters byte for byte", async () => {
    await safeFetch(`${base}/v1/deployments/gpt%2F4o/chat/completions`, {}, allow);
    expect(seen[0].url).toBe("/v1/deployments/gpt%2F4o/chat/completions");
  });
});
