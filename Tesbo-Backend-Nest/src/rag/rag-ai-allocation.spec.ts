import { DatabaseService } from "../database/database.service";
import { resolveEmbeddingAllocation } from "./rag-ai-allocation";
import { RAG_EMBEDDING_DIMENSION } from "./rag.constants";

/*
 * Which key gets used to produce embeddings, and what we say when none can be.
 *
 * This is a unit test rather than e2e because the interesting cases are combinations of
 * workspace key state — an Anthropic chat key with a Gemini key sitting beside it, an inactive
 * allocation, an organization with nothing capable — and provisioning six workspaces through
 * the real API to assert on a resolution decision would be slow and would obscure the thing
 * being tested. The end-to-end proof that a resolved allocation actually retrieves a document
 * lives in e2e/api/knowledge-base.spec.ts.
 *
 * The regression these lock down: resolveEmbeddingAllocation used to accept only `openai` and
 * return a bare `null` for everything else. Every allocated key in production is Anthropic, so
 * it returned null for every project, and because null is also what "nothing relevant" looks
 * like, semantic search was off everywhere for months with no error, no alert and no log line.
 */

type Row = Record<string, unknown>;

function fakeDb(opts: { allocated?: Row | null; organizationId?: string | null; workspaceKeys?: Row[] }): DatabaseService {
  const { allocated = null, organizationId = "org-1", workspaceKeys = [] } = opts;
  return {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("project_ai_key_allocations")) return { rows: allocated ? [allocated] : [] };
      if (sql.includes("FROM projects")) return { rows: organizationId ? [{ organization_id: organizationId }] : [] };
      if (sql.includes("FROM workspace_ai_keys")) {
        // Mirrors the real query's filter so the test exercises the selection rule, not a stub
        // that hands back whatever it was given.
        const capable = params[1] as string[];
        const matching = workspaceKeys.filter((k) => k.is_active && capable.includes(String(k.provider).toLowerCase()));
        return { rows: matching.slice(0, 1) };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    }
  } as unknown as DatabaseService;
}

const anthropicKey = { name: "Claude", provider: "anthropic", api_key: "sk-ant-x", base_url: null, auth_header_name: null, auth_scheme: null, is_active: true };
const openaiKey = { name: "OpenAI", provider: "openai", api_key: "sk-x", base_url: null, auth_header_name: null, auth_scheme: null, is_active: true };
const mistralKey = { name: "Mistral", provider: "mistral", api_key: "m-x", base_url: null, auth_header_name: null, auth_scheme: null, is_active: true };

describe("resolveEmbeddingAllocation", () => {
  describe("tier 1 — the project's own key can embed", () => {
    it("uses the allocated key directly, asking nothing of the user", async () => {
      const result = await resolveEmbeddingAllocation(fakeDb({ allocated: openaiKey }), "p1");
      expect(result.allocation).not.toBeNull();
      expect(result.allocation?.provider).toBe("openai");
      expect(result.allocation?.model).toBe("text-embedding-3-small");
    });

    it("asks a natively-wider model to emit the platform width rather than truncating it later", async () => {
      const result = await resolveEmbeddingAllocation(fakeDb({ allocated: openaiKey }), "p1");
      expect(result.allocation?.sendDimensionParam).toBe(true);
      expect(result.allocation?.dimension).toBe(RAG_EMBEDDING_DIMENSION);
    });

    it("leaves a natively-1024 model alone — there is nothing to reduce", async () => {
      const result = await resolveEmbeddingAllocation(fakeDb({ allocated: mistralKey }), "p1");
      expect(result.allocation?.sendDimensionParam).toBe(false);
      expect(result.allocation?.dimension).toBe(RAG_EMBEDDING_DIMENSION);
    });
  });

  describe("tier 2 — the chat provider cannot embed", () => {
    it("borrows an embeddings-capable key from the same workspace", async () => {
      const db = fakeDb({ allocated: anthropicKey, workspaceKeys: [anthropicKey, openaiKey] });
      const result = await resolveEmbeddingAllocation(db, "p1");
      expect(result.allocation?.provider).toBe("openai");
      expect(result.reason).toContain("cannot embed");
    });

    it("never picks a chat-only provider as the embeddings source", async () => {
      // The bug this guards against is subtle: Anthropic is active, allocated, and first in the
      // list. Only the capability registry keeps it from being chosen, and choosing it would
      // fail at request time with a 404 on an endpoint that does not exist.
      const db = fakeDb({ allocated: anthropicKey, workspaceKeys: [anthropicKey, mistralKey] });
      const result = await resolveEmbeddingAllocation(db, "p1");
      expect(result.allocation?.provider).toBe("mistral");
    });

    it("ignores an inactive key when looking for a fallback", async () => {
      const db = fakeDb({ allocated: anthropicKey, workspaceKeys: [{ ...openaiKey, is_active: false }] });
      const result = await resolveEmbeddingAllocation(db, "p1");
      expect(result.allocation).toBeNull();
    });
  });

  describe("tier 3 — nothing can embed, and that must be said out loud", () => {
    it("explains that the chat provider has no embeddings endpoint and names what would fix it", async () => {
      const result = await resolveEmbeddingAllocation(fakeDb({ allocated: anthropicKey }), "p1");
      expect(result.allocation).toBeNull();
      expect(result.reason).toContain("anthropic");
      expect(result.reason).toContain("openai");
      expect(result.reason).toMatch(/keyword only/i);
    });

    it("distinguishes an inactive allocation from an absent one", async () => {
      const inactive = await resolveEmbeddingAllocation(fakeDb({ allocated: { ...anthropicKey, is_active: false } }), "p1");
      expect(inactive.reason).toContain("inactive");

      const absent = await resolveEmbeddingAllocation(fakeDb({ allocated: null }), "p1");
      expect(absent.reason).toContain("No AI key is allocated");
    });

    it("never returns an empty reason — silence is the failure mode this replaced", async () => {
      const cases = [
        fakeDb({ allocated: anthropicKey }),
        fakeDb({ allocated: null }),
        fakeDb({ allocated: { ...anthropicKey, is_active: false } }),
        fakeDb({ allocated: anthropicKey, organizationId: null })
      ];
      for (const db of cases) {
        const result = await resolveEmbeddingAllocation(db, "p1");
        expect(result.allocation).toBeNull();
        expect(result.reason.trim().length).toBeGreaterThan(0);
      }
    });
  });

  it("reports a reason even on the happy path, so callers can log which key was chosen", async () => {
    const result = await resolveEmbeddingAllocation(fakeDb({ allocated: openaiKey }), "p1");
    expect(result.reason.trim().length).toBeGreaterThan(0);
  });
  describe("tier 0 — platform VOYAGE_API_KEY", () => {
    const saved = process.env.VOYAGE_API_KEY;
    afterEach(() => {
      if (saved === undefined) delete process.env.VOYAGE_API_KEY;
      else process.env.VOYAGE_API_KEY = saved;
    });

    it("supplies embeddings for an Anthropic project that has no embedding-capable key of its own", async () => {
      process.env.VOYAGE_API_KEY = "pa-test";
      const result = await resolveEmbeddingAllocation(fakeDb({ allocated: anthropicKey }), "p1");
      expect(result.allocation?.provider).toBe("voyage");
      expect(result.allocation?.api_key).toBe("pa-test");
      expect(result.allocation?.base_url).toBe("https://api.voyageai.com/v1");
      expect(result.allocation?.dimension).toBe(RAG_EMBEDDING_DIMENSION);
      expect(result.allocation?.sendDimensionParam).toBe(false);
    });

    it("wins over a workspace OpenAI key, so every vector shares one embedding space", async () => {
      process.env.VOYAGE_API_KEY = "pa-test";
      const result = await resolveEmbeddingAllocation(fakeDb({ allocated: openaiKey, workspaceKeys: [openaiKey] }), "p1");
      expect(result.allocation?.provider).toBe("voyage");
    });

    it("is ignored when blank, falling back to the workspace keys", async () => {
      process.env.VOYAGE_API_KEY = "   ";
      const result = await resolveEmbeddingAllocation(fakeDb({ allocated: anthropicKey, workspaceKeys: [mistralKey] }), "p1");
      expect(result.allocation?.provider).toBe("mistral");
    });
  });

});
