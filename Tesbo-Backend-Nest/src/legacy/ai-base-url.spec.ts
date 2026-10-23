import { LegacyService } from "./legacy.service";

/*
 * The AI provider base URL is typed by a workspace owner and then called by the server with the stored
 * key. These pin the two things the service decides: which URLs it will save (common/safe-fetch.ts
 * decides the rest, and has its own spec), and that a saved key is never sent somewhere it was not
 * saved for.
 */

type Any = Record<string, any>;

const original = process.env.ALLOW_PRIVATE_AI_HOSTS;
afterEach(() => {
  if (original === undefined) delete process.env.ALLOW_PRIVATE_AI_HOSTS;
  else process.env.ALLOW_PRIVATE_AI_HOSTS = original;
});

function makeService(opts: { stored?: Any | null } = {}) {
  const svc = Object.create(LegacyService.prototype) as Any;
  const inserts: unknown[][] = [];
  svc.workspace = async () => ({ id: "org-1", role: "owner" });
  svc.db = {
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("INSERT INTO workspace_ai_keys")) {
        inserts.push(values);
        return { rows: [{ id: "key-1", name: values[1], provider: values[2], api_key: values[3], base_url: values[5], is_active: true }] };
      }
      if (sql.includes("FROM workspace_ai_keys")) return { rows: opts.stored ? [opts.stored] : [] };
      return { rows: [] };
    })
  };
  svc.fetchProviderModels = jest.fn(async () => [{ id: "gpt-4o", displayName: "gpt-4o" }]);
  return { svc, inserts };
}

async function refusal(promise: Promise<unknown>): Promise<Any> {
  try {
    await promise;
  } catch (err) {
    return (err as Any).getResponse ? (err as Any).getResponse() : { thrown: String(err) };
  }
  throw new Error("expected a refusal, but it resolved");
}

describe("createAiKey: which base URLs are saved", () => {
  const create = (svc: Any, body: Any) => svc.createAiKey("user-1", { name: "k", apiKey: "sk-secret", ...body });

  it.each([
    ["plain http", "http://8.8.8.8/v1"],
    ["a loopback name", "https://localhost:11434/v1"],
    ["a Docker service name", "https://backend:1021/"],
    ["the cloud metadata address", "https://169.254.169.254/latest/meta-data/"],
    ["the metadata address as one integer", "https://2852039166/"],
    ["a private address", "https://10.0.0.5/v1"],
    ["a private address in another spelling", "https://0x0a.0.0.5/v1"],
    ["IPv6 loopback", "https://[::1]/v1"],
    ["IPv4-mapped loopback", "https://[::ffff:127.0.0.1]/v1"],
    ["credentials in the URL", "https://user:pw@8.8.8.8/v1"],
    ["a file URL", "file:///etc/passwd"],
    ["something that is not a URL", "not a url"],
    ["a name that only resolves inside a network", "https://redis/"]
  ])("refuses %s, saving nothing", async (_label, baseUrl) => {
    delete process.env.ALLOW_PRIVATE_AI_HOSTS;
    const { svc, inserts } = makeService();
    const error = await refusal(create(svc, { provider: "custom", baseUrl }));
    expect(error.code).toBe("ai_base_url_blocked");
    expect(String(error.error)).toMatch(/^Base URL not allowed:/);
    expect(inserts).toHaveLength(0);
  });

  it("does not echo back what the address resolved to", async () => {
    delete process.env.ALLOW_PRIVATE_AI_HOSTS;
    const error = await refusal(create(makeService().svc, { provider: "custom", baseUrl: "https://169.254.169.254/" }));
    expect(String(error.error)).not.toMatch(/169|254/);
  });

  it("saves a public address exactly as typed", async () => {
    delete process.env.ALLOW_PRIVATE_AI_HOSTS;
    const { svc, inserts } = makeService();
    await create(svc, { provider: "custom", baseUrl: "https://8.8.8.8/v1" });
    expect(inserts).toHaveLength(1);
    expect(inserts[0][5]).toBe("https://8.8.8.8/v1");
  });

  it("checks nothing for a provider that has no custom URL: the catalog's own public address is the destination", async () => {
    delete process.env.ALLOW_PRIVATE_AI_HOSTS;
    const { svc, inserts } = makeService();
    await create(svc, { provider: "openai" });
    expect(inserts).toHaveLength(1);
    expect(inserts[0][5]).toBeNull();
  });

  it("refuses Ollama on a hosted deployment, because its default address is the server's own localhost", async () => {
    delete process.env.ALLOW_PRIVATE_AI_HOSTS;
    const { svc, inserts } = makeService();
    const error = await refusal(create(svc, { provider: "ollama", apiKey: "" }));
    expect(error.code).toBe("ai_base_url_blocked");
    expect(inserts).toHaveLength(0);
  });

  it("allows Ollama and other private runtimes when ALLOW_PRIVATE_AI_HOSTS is true", async () => {
    process.env.ALLOW_PRIVATE_AI_HOSTS = "true";
    // Address literals and localhost only: any other name is looked up in real DNS at save time (which is
    // what makes a Docker service name work in a self-hosted stack), and a unit test has no such network.
    for (const baseUrl of ["http://localhost:11434/v1", "http://192.168.1.50:8000/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8080/v1"]) {
      const { svc, inserts } = makeService();
      await create(svc, { provider: "custom", baseUrl });
      expect(inserts).toHaveLength(1);
      expect(inserts[0][5]).toBe(baseUrl);
    }
    const { svc, inserts } = makeService();
    await create(svc, { provider: "ollama", apiKey: "" });
    expect(inserts).toHaveLength(1);
  });

  it.each(["http://169.254.169.254/", "http://0.0.0.0:8080/", "http://[fd00:ec2::254]/", "http://224.0.0.1/", "http://2852039166/"])(
    "still refuses %s with ALLOW_PRIVATE_AI_HOSTS on: no self-hosted runtime lives there",
    async (baseUrl) => {
      process.env.ALLOW_PRIVATE_AI_HOSTS = "true";
      const { svc, inserts } = makeService();
      const error = await refusal(create(svc, { provider: "custom", baseUrl }));
      expect(error.code).toBe("ai_base_url_blocked");
      expect(inserts).toHaveLength(0);
    }
  );

  it("only the exact word 'true' turns private hosts on", async () => {
    for (const value of ["1", "yes", "TRUE1", "on", ""]) {
      process.env.ALLOW_PRIVATE_AI_HOSTS = value;
      const { svc, inserts } = makeService();
      await refusal(create(svc, { provider: "custom", baseUrl: "http://192.168.1.50:8000/v1" }));
      expect(inserts).toHaveLength(0);
    }
  });

  it("is checked after the cheap validation, so a missing name still says so", async () => {
    delete process.env.ALLOW_PRIVATE_AI_HOSTS;
    const error = await refusal(create(makeService().svc, { name: "", provider: "custom", baseUrl: "https://10.0.0.1/" }));
    expect(String(error.error)).toBe("name is required");
  });
});

describe("listProviderModels: a saved key is only used where it was saved for", () => {
  const STORED = { api_key: "sk-real-secret", base_url: "https://8.8.8.8/v1", auth_header_name: null, auth_scheme: null };
  const KEY_ID = "11111111-1111-4111-8111-111111111111";
  const list = (svc: Any, body: Any) => svc.listProviderModels("user-1", { provider: "custom", ...body });

  it("refuses to send the stored key to a different base URL, and does not call it", async () => {
    const { svc } = makeService({ stored: STORED });
    const error = await refusal(list(svc, { keyId: KEY_ID, baseUrl: "https://attacker.example/v1" }));
    expect(error.code).toBe("ai_key_reentry_required");
    expect(svc.fetchProviderModels).not.toHaveBeenCalled();
  });

  it.each([
    "https://8.8.4.4/v1",
    "https://8.8.8.8/v2",
    "http://8.8.8.8/v1",
    "https://8.8.8.8:8443/v1",
    "https://8.8.8.8.attacker.example/v1",
    "https://attacker.example/",
    "https://169.254.169.254/",
    "http://127.0.0.1:9999/"
  ])("refuses %s as a new destination for the stored key", async (baseUrl) => {
    const { svc } = makeService({ stored: STORED });
    const error = await refusal(list(svc, { keyId: KEY_ID, baseUrl }));
    expect(error.code).toBe("ai_key_reentry_required");
    expect(svc.fetchProviderModels).not.toHaveBeenCalled();
  });

  it("still lists models for the same URL, whatever the trailing slash", async () => {
    for (const baseUrl of ["https://8.8.8.8/v1", "https://8.8.8.8/v1/", "https://8.8.8.8/v1///"]) {
      const { svc } = makeService({ stored: STORED });
      const result = await list(svc, { keyId: KEY_ID, baseUrl });
      expect(result.source).toBe("live");
      expect(svc.fetchProviderModels).toHaveBeenCalledWith("custom", "sk-real-secret", baseUrl, null, null);
    }
  });

  it("uses the stored URL when none is sent", async () => {
    const { svc } = makeService({ stored: STORED });
    await list(svc, { keyId: KEY_ID });
    expect(svc.fetchProviderModels).toHaveBeenCalledWith("custom", "sk-real-secret", "https://8.8.8.8/v1", null, null);
  });

  it("lets the owner try a different URL with a key they type, because that key is theirs to send", async () => {
    const { svc } = makeService({ stored: STORED });
    await list(svc, { keyId: KEY_ID, baseUrl: "https://8.8.4.4/v1", apiKey: "sk-typed" });
    expect(svc.fetchProviderModels).toHaveBeenCalledWith("custom", "sk-typed", "https://8.8.4.4/v1", null, null);
  });

  it("never uses the stored key when the owner typed their own", async () => {
    const { svc } = makeService({ stored: STORED });
    await list(svc, { keyId: KEY_ID, apiKey: "sk-typed" });
    expect((svc.fetchProviderModels as jest.Mock).mock.calls[0][1]).toBe("sk-typed");
  });

  it("treats the provider's own default as the same destination for a key saved without a URL", async () => {
    const { svc } = makeService({ stored: { ...STORED, base_url: null } });
    const sameAsDefault = await svc.listProviderModels("user-1", { provider: "groq", keyId: KEY_ID, baseUrl: "https://api.groq.com/openai/v1/" });
    expect(sameAsDefault.source).toBe("live");
    const elsewhere = await refusal(svc.listProviderModels("user-1", { provider: "groq", keyId: KEY_ID, baseUrl: "https://attacker.example/" }));
    expect(elsewhere.code).toBe("ai_key_reentry_required");
  });

  it("answers 404 for a key that is not this workspace's", async () => {
    const { svc } = makeService({ stored: null });
    const error = await refusal(list(svc, { keyId: KEY_ID, baseUrl: "https://8.8.8.8/v1" }));
    expect(String(error.error)).toBe("AI key not found");
    expect(svc.fetchProviderModels).not.toHaveBeenCalled();
  });

  it("looks the key up inside the caller's workspace only", async () => {
    const { svc } = makeService({ stored: STORED });
    await list(svc, { keyId: KEY_ID });
    const lookup = (svc.db.query as jest.Mock).mock.calls.find(([sql]) => String(sql).includes("FROM workspace_ai_keys"))!;
    expect(String(lookup[0])).toContain("organization_id = $2");
    expect(lookup[1]).toEqual([KEY_ID, "org-1"]);
  });

  it("reports an unsafe URL as the reason the live list is unavailable, never as a crash", async () => {
    const { svc } = makeService();
    svc.fetchProviderModels = jest.fn(async () => {
      throw new Error("The URL points at a private or internal address, which is not allowed.");
    });
    const result = await list(svc, { apiKey: "sk-typed", baseUrl: "https://10.0.0.5/v1" });
    expect(result.source).toBe("fallback");
    expect(result.reason).toContain("private or internal address");
  });
});

describe("createAiKey and listProviderModels: the shape of every field is checked before it is used", () => {
  const create = (svc: Any, body: Any) => svc.createAiKey("user-1", { name: "k", provider: "openai", apiKey: "sk-secret", ...body });
  const refused = async (body: Any) => {
    const { svc, inserts } = makeService();
    const error = await refusal(create(svc, body));
    expect(inserts).toHaveLength(0);
    return String(error.error);
  };

  it("refuses a name over the column width instead of surfacing a Postgres 500", async () => {
    expect(await refused({ name: "n".repeat(129) })).toBe("name must be at most 128 characters");
    const { svc, inserts } = makeService();
    await create(svc, { name: "n".repeat(128) });
    expect(inserts).toHaveLength(1);
  });

  it("refuses a provider over its 32-character column, or with characters that do not belong in an id", async () => {
    expect(await refused({ provider: "p".repeat(33) })).toBe("provider must be at most 32 characters");
    for (const provider of ["a b", "a/b", "../x", "a;b", "a\"b", "é", "-x"]) {
      expect(await refused({ provider, baseUrl: "https://8.8.8.8/v1" })).toMatch(/provider may only contain/);
    }
  });

  it.each([
    ["name", 123],
    ["name", { a: 1 }],
    ["apiKey", 123456],
    ["apiKey", ["sk"]],
    ["provider", { toString: "x" }],
    ["baseUrl", 42],
    ["defaultModel", true],
    ["authScheme", {}],
    ["authHeaderName", 7]
  ])("refuses %s when it is not text (%j), rather than saving '[object Object]'", async (field, value) => {
    expect(await refused({ [field]: value, provider: field === "provider" ? value : "custom", baseUrl: field === "baseUrl" ? value : "https://8.8.8.8/v1" })).toBe(
      `${field} must be text`
    );
  });

  it.each([
    ["apiKey", "sk-abc\r\nX-Injected: 1"],
    ["apiKey", "sk-abc\nnext"],
    ["apiKey", "sk-abc\u0000"],
    ["name", "line1\nline2"],
    ["defaultModel", "gpt\r\n"],
    ["authScheme", "Bearer\r\nX: y"],
    ["baseUrl", "https://8.8.8.8/v1\r\nHost: evil"]
  ])("refuses a control character or line break in %s", async (field, value) => {
    const message = await refused({ [field]: value, provider: "custom", baseUrl: field === "baseUrl" ? value : "https://8.8.8.8/v1" });
    expect(message).toMatch(/control characters or line breaks/);
  });

  it("caps the key at 4096 characters and the other fields at their widths", async () => {
    expect(await refused({ apiKey: "k".repeat(4097) })).toBe("apiKey must be at most 4096 characters");
    expect(await refused({ defaultModel: "m".repeat(129) })).toBe("defaultModel must be at most 128 characters");
    expect(await refused({ authScheme: "s".repeat(65), provider: "custom", baseUrl: "https://8.8.8.8/v1" })).toBe("authScheme must be at most 64 characters");
    expect(await refused({ baseUrl: "https://8.8.8.8/" + "a".repeat(2100), provider: "custom" })).toMatch(/baseUrl must be at most 2048/);
    const { svc, inserts } = makeService();
    await create(svc, { apiKey: "k".repeat(4096) });
    expect(inserts).toHaveLength(1);
  });

  it.each(["Host", "host", "Content-Length", "Content-Type", "Transfer-Encoding", "Connection", "Upgrade", "TE", "Expect", "Proxy-Authorization", "Proxy-Connection", "Cookie", "Set-Cookie", "Accept-Encoding", "Keep-Alive", "Trailer"])(
    "refuses %s as the auth header: it changes how the request is framed or where it is routed",
    async (header) => {
      expect(await refused({ provider: "custom", baseUrl: "https://8.8.8.8/v1", authHeaderName: header })).toMatch(/cannot be used/);
    }
  );

  it.each(["X Api Key", "x-api-key:", "x\r\napi", "api key", "a(b)", "a@b", "a,b", "a/b", "ключ", "x\"y"])("refuses %j as a header name", async (header) => {
    expect(await refused({ provider: "custom", baseUrl: "https://8.8.8.8/v1", authHeaderName: header })).toMatch(/not a valid HTTP header name|control characters/);
  });

  it.each(["x-api-key", "api-key", "Authorization", "X-Custom_Auth.1", "ocp-apim-subscription-key"])("accepts %s as a header name", async (header) => {
    const { svc, inserts } = makeService();
    await create(svc, { provider: "custom", baseUrl: "https://8.8.8.8/v1", authHeaderName: header });
    expect(inserts).toHaveLength(1);
    expect(inserts[0][6]).toBe(header);
  });

  it("does not save the header name for a catalog provider, whatever was sent", async () => {
    const { svc, inserts } = makeService();
    await create(svc, { provider: "openai", authHeaderName: "x-whatever", authScheme: "Token" });
    expect(inserts[0][6]).toBeNull();
    expect(inserts[0][7]).toBeNull();
  });

  it("applies the same checks to the model-listing call", async () => {
    const { svc } = makeService();
    const error = await refusal(svc.listProviderModels("user-1", { provider: "custom", apiKey: "sk\r\nX: 1", baseUrl: "https://8.8.8.8/v1" }));
    expect(String(error.error)).toMatch(/control characters/);
    expect(svc.fetchProviderModels).not.toHaveBeenCalled();
    const typed = await refusal(svc.listProviderModels("user-1", { provider: "custom", apiKey: 12345 }));
    expect(String(typed.error)).toBe("apiKey must be text");
  });

  it("empty optional fields are fine and fall back to defaults", async () => {
    const { svc, inserts } = makeService();
    await create(svc, { defaultModel: "", baseUrl: "", authScheme: "", authHeaderName: "" });
    expect(inserts).toHaveLength(1);
  });
});
