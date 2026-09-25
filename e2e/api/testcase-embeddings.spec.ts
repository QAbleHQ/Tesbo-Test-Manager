import { expect, test, type APIRequestContext } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { column, exec, literal, scalar } from "../utils/psql";
import { loginAs, provisionRbacTenant, rbacSuiteSkipReason, type RbacTenant } from "../utils/rbac-tenant";

/*
 * Semantic test-case similarity storage — testcase_embeddings, the same pgvector/ANN mechanics
 * knowledge_document_chunks already uses (see rag/rag-retrieval.service.ts), reused for a second
 * collection rather than a parallel pipeline. See rag-embedding.processor.ts's processTestcase and
 * rag-ingestion.service.ts's enqueueTestcaseEmbedding.
 *
 * NOT covered here, deliberately:
 *  - findSimilarTestcases()/TESTCASE_SIMILARITY_THRESHOLD feeding an actual Add-vs-Update decision:
 *    nothing calls that method yet (wiring it into Zyra's ticket workflow is a separate, later
 *    step) — scenario 6 below proves the underlying ANN ranking works via direct SQL, the same way
 *    the KB-embeddings suite's paraphrase test does, without a classification consumer to assert on.
 *  - Racing a soft-delete against an in-flight embedding job: timing-dependent and not reliably
 *    reproducible from black-box API tests (unlike the KB suite's "no extractable text" case, which
 *    is deterministic).
 *  - bulkCreateTestCases (import) and the Zyra staged-draft save path: not hooked into the
 *    embedding pipeline in this pass by design (see legacy.service.ts's enqueueTestcaseEmbedding
 *    comment) — those rows stay at the embedding_status column default ('pending') until either
 *    hook is widened or a backfill decision covers them.
 *
 * Own tenant (not "kb-embeddings") because both attach/detach workspace AI keys and would fight
 * over the same key set if shared; "zyra"/"ai-keys" assert on their own tenants' keys too.
 *
 * Same local stub-server approach as kb-embeddings.spec.ts, for the same reason: a real key would
 * make this suite depend on a paid third party over test quality, not embedding quality.
 */

const EMBEDDING_DIMENSION = 1024;

/**
 * Deterministic stand-in for an embeddings API, tuned to test-case-shaped text instead of KB
 * prose. Two axes so "paraphrases of the same scenario, different words" can be told apart from
 * "a genuinely different scenario" — the property scenario 6 below is built to exercise.
 */
function embeddingFor(text: string): number[] {
  const lower = text.toLowerCase();
  const vector = new Array(EMBEDDING_DIMENSION).fill(0);
  const login = /log[\s-]?in|sign[\s-]?in|authenticate|credentials/.test(lower);
  const logout = /log[\s-]?out|sign[\s-]?out|end session/.test(lower);
  vector[0] = login ? 1 : 0;
  vector[1] = logout ? 1 : 0;
  // Never a zero vector: cosine distance against one is undefined and pgvector would rank it
  // arbitrarily, which would make a failure here look like a ranking bug.
  if (!login && !logout) vector[2] = 1;
  return vector;
}

interface StubState {
  server: Server;
  baseUrl: string;
  requests: Array<{ model: string; input: string[]; dimensions?: number }>;
  failWith: number | null;
}

async function startEmbeddingStub(): Promise<StubState> {
  const state: Partial<StubState> = { requests: [], failWith: null };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (state.failWith) {
        res.writeHead(state.failWith, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "stubbed embeddings failure" } }));
        return;
      }
      const body = JSON.parse(raw || "{}") as { model: string; input: string[]; dimensions?: number };
      state.requests!.push(body);
      const inputs = Array.isArray(body.input) ? body.input : [String(body.input)];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: inputs.map((text, index) => ({ index, embedding: embeddingFor(text), object: "embedding" })),
          model: body.model
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = (server.address() as { port: number }).port;
  return Object.assign(state, { server, baseUrl: `http://host.docker.internal:${port}/v1` }) as StubState;
}

test.describe("test case embeddings — semantic similarity storage", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let stub: StubState;
  const createdKeyIds: string[] = [];

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("testcase-embeddings");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    stub = await startEmbeddingStub();
  });

  test.afterAll(async () => {
    if (stub?.server) await new Promise<void>((resolve) => stub.server.close(() => resolve()));
    if (!tenant) return;
    for (const keyId of createdKeyIds) {
      await asOwner.delete(`/api/workspace/ai-keys/${keyId}`, { failOnStatusCode: false });
    }
    exec(`DELETE FROM testcase_embeddings WHERE project_id = ${literal(tenant.mainProjectId)}`);
    exec(`DELETE FROM testcases WHERE project_id = ${literal(tenant.mainProjectId)}`);
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(Boolean(reason), reason ?? "");
    if (stub) {
      stub.requests.length = 0;
      stub.failWith = null;
    }
  });

  async function addKey(name: string, provider: string, baseUrl?: string): Promise<string> {
    const res = await asOwner.post("/api/workspace/ai-keys", {
      data: { name: `${name} ${Date.now()}`, provider, apiKey: `stub-${provider}-key`, ...(baseUrl ? { baseUrl } : {}) }
    });
    expect(res.ok(), `creating a ${provider} key should succeed: ${await res.text()}`).toBeTruthy();
    const id = String((await res.json()).id ?? "");
    expect(id).not.toBe("");
    createdKeyIds.push(id);
    return id;
  }

  async function allocate(keyId: string): Promise<void> {
    const res = await asOwner.post("/api/workspace/ai-keys/allocations", {
      data: { projectId: tenant!.mainProjectId, workspaceAiKeyId: keyId }
    });
    expect(res.ok(), `allocating the key should succeed: ${await res.text()}`).toBeTruthy();
  }

  async function createTestcase(title: string, description: string, projectId = tenant!.mainProjectId): Promise<string> {
    const res = await asOwner.post(`/api/projects/${projectId}/testcases`, { data: { title, description } });
    expect(res.ok(), `creating the test case should succeed: ${await res.text()}`).toBeTruthy();
    return String((await res.json()).id);
  }

  async function updateTestcase(projectId: string, id: string, data: Record<string, unknown>): Promise<void> {
    const res = await asOwner.put(`/api/projects/${projectId}/testcases/${id}`, { data });
    expect(res.ok(), `updating the test case should succeed: ${await res.text()}`).toBeTruthy();
  }

  /** Embedding runs on the same BullMQ worker as KB documents, so status arrives asynchronously. */
  async function waitForStatus(testcaseId: string, wanted: string[], timeoutMs = 30_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let status = "";
    while (Date.now() < deadline) {
      status = scalar(`SELECT embedding_status FROM testcases WHERE id = ${literal(testcaseId)}`).trim();
      if (wanted.includes(status)) return status;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return status;
  }

  function embeddingCount(projectId: string, testcaseId: string): number {
    return Number(
      scalar(
        `SELECT count(*) FROM testcase_embeddings WHERE project_id = ${literal(projectId)} AND testcase_id = ${literal(testcaseId)}`
      ).trim()
    );
  }

  test("a workspace with no embeddings-capable key leaves test cases retryable, not permanently unsupported", async () => {
    const anthropic = await addKey("Claude chat", "anthropic");
    await allocate(anthropic);

    const testcaseId = await createTestcase(`E2E anthropic-only ${Date.now()}`, "User can log in with valid credentials.");
    const status = await waitForStatus(testcaseId, ["pending", "unsupported", "ready", "failed"]);

    expect(status, "a missing workspace key is a property of the workspace, not of the test case — it must stay retryable").toBe("pending");
    expect(embeddingCount(tenant!.mainProjectId, testcaseId)).toBe(0);
    expect(stub.requests, "no embeddings endpoint should have been called at all").toHaveLength(0);

    exec(`DELETE FROM testcases WHERE id = ${literal(testcaseId)}`);
  });

  test("a workspace OpenAI key embeds a new test case at the platform width", async () => {
    const openai = await addKey("Embeddings", "openai", stub.baseUrl);
    await allocate(openai);

    const testcaseId = await createTestcase(`E2E tier2 ${Date.now()}`, "User can log in with valid credentials.");
    const status = await waitForStatus(testcaseId, ["ready", "failed", "unsupported"]);
    expect(status, "the workspace OpenAI key should have supplied an embedding for this test case").toBe("ready");

    expect(embeddingCount(tenant!.mainProjectId, testcaseId)).toBe(1);
    expect(stub.requests.length, "the embeddings endpoint should have been called").toBeGreaterThan(0);
    expect(stub.requests[0].model).toBe("text-embedding-3-small");
    expect(stub.requests[0].dimensions, "a natively-1536 model must be asked for the platform width, not truncated afterwards").toBe(
      EMBEDDING_DIMENSION
    );

    const widths = column(
      `SELECT DISTINCT vector_dims(embedding) FROM testcase_embeddings WHERE testcase_id = ${literal(testcaseId)} AND project_id = ${literal(tenant!.mainProjectId)}`
    ).map((v) => Number(v.trim()));
    expect(widths, "the stored vector must match the column and its HNSW index").toEqual([EMBEDDING_DIMENSION]);

    const models = column(
      `SELECT DISTINCT embedding_model FROM testcase_embeddings WHERE testcase_id = ${literal(testcaseId)} AND project_id = ${literal(tenant!.mainProjectId)}`
    ).map((v) => v.trim());
    expect(models).toEqual(["text-embedding-3-small"]);

    exec(`DELETE FROM testcase_embeddings WHERE testcase_id = ${literal(testcaseId)}`);
    exec(`DELETE FROM testcases WHERE id = ${literal(testcaseId)}`);
  });

  test("editing a test case's title/description re-embeds it", async () => {
    await addKey("Embeddings update", "openai", stub.baseUrl);

    const testcaseId = await createTestcase(`E2E update ${Date.now()}`, "User can log in with valid credentials.");
    expect(await waitForStatus(testcaseId, ["ready", "failed", "unsupported"])).toBe("ready");
    const hashBefore = scalar(`SELECT embedding_content_hash FROM testcases WHERE id = ${literal(testcaseId)}`).trim();
    const callsBefore = stub.requests.length;

    await updateTestcase(tenant!.mainProjectId, testcaseId, { description: "User can log out and end their session." });
    // The update re-queues the same test case, so 'ready' is reached a second time once the new
    // text is embedded — waiting for it is what proves the re-embed actually ran, not just that
    // the row was touched.
    expect(await waitForStatus(testcaseId, ["ready", "failed", "unsupported"])).toBe("ready");

    const hashAfter = scalar(`SELECT embedding_content_hash FROM testcases WHERE id = ${literal(testcaseId)}`).trim();
    expect(hashAfter, "changed embeddable text must produce a new content hash").not.toBe(hashBefore);
    expect(stub.requests.length, "changed text must trigger a second embeddings call").toBeGreaterThan(callsBefore);

    exec(`DELETE FROM testcase_embeddings WHERE testcase_id = ${literal(testcaseId)}`);
    exec(`DELETE FROM testcases WHERE id = ${literal(testcaseId)}`);
  });

  test("an embeddings API failure marks the test case failed and never throws into the caller", async () => {
    await addKey("Embeddings failing", "openai", stub.baseUrl);
    stub.failWith = 401;

    const testcaseId = await createTestcase(`E2E apifail ${Date.now()}`, "Failure-path test case.");
    const status = await waitForStatus(testcaseId, ["failed", "ready", "unsupported"], 45_000);
    expect(status, "a rejected key is a real failure, distinct from 'nothing to embed'").toBe("failed");
    expect(embeddingCount(tenant!.mainProjectId, testcaseId)).toBe(0);

    // The create call itself must still have succeeded — enqueueing is fire-and-forget.
    const getRes = await asOwner.get(`/api/projects/${tenant!.mainProjectId}/testcases/${testcaseId}`);
    expect(getRes.ok(), "the test case must exist and be readable regardless of embedding failure").toBeTruthy();

    exec(`DELETE FROM testcases WHERE id = ${literal(testcaseId)}`);
  });

  test("embeddings never leak across projects", async () => {
    await addKey("Embeddings tenancy", "openai", stub.baseUrl);

    const testcaseId = await createTestcase(`E2E tenancy ${Date.now()}`, "User can log in with valid credentials.");
    expect(await waitForStatus(testcaseId, ["ready", "failed", "unsupported"])).toBe("ready");

    const strayCount = Number(
      scalar(`SELECT count(*) FROM testcase_embeddings WHERE testcase_id = ${literal(testcaseId)} AND project_id <> ${literal(tenant!.mainProjectId)}`).trim()
    );
    expect(strayCount, "an embedding must exist only under the project that owns its test case").toBe(0);

    const secondProjectEmbeddings = Number(
      scalar(`SELECT count(*) FROM testcase_embeddings WHERE project_id = ${literal(tenant!.secondProjectId)}`).trim()
    );
    expect(secondProjectEmbeddings, "the sibling project shares a workspace but must share no vectors").toBe(0);

    exec(`DELETE FROM testcase_embeddings WHERE testcase_id = ${literal(testcaseId)}`);
    exec(`DELETE FROM testcases WHERE id = ${literal(testcaseId)}`);
  });

  test("the stored vectors rank paraphrases of the same scenario above an unrelated one", async () => {
    // Proves the ANN mechanics (the same `<=>` cosine operator and platform vector width
    // knowledge_document_chunks uses) work end to end for this second collection, even though
    // nothing calls findSimilarTestcases() yet — there is no classification consumer to assert on,
    // so this asserts directly on the ranking a future caller would get.
    await addKey("Embeddings ranking", "openai", stub.baseUrl);

    const loginA = await createTestcase(`E2E rank login-a ${Date.now()}`, "User can sign in with valid credentials.");
    const loginB = await createTestcase(`E2E rank login-b ${Date.now()}`, "Authenticate with a correct username and password.");
    const logout = await createTestcase(`E2E rank logout ${Date.now()}`, "User can log out and end their session.");
    for (const id of [loginA, loginB, logout]) {
      expect(await waitForStatus(id, ["ready", "failed", "unsupported"])).toBe("ready");
    }

    const queryVector = `[${embeddingFor("how do I authenticate a user").join(",")}]`;
    const nearest = column(
      `SELECT testcase_id FROM testcase_embeddings
       WHERE project_id = ${literal(tenant!.mainProjectId)} AND testcase_id = ANY(ARRAY[${literal(loginA)}, ${literal(loginB)}, ${literal(logout)}]::uuid[])
       ORDER BY embedding <=> ${literal(queryVector)}::vector
       LIMIT 2`
    ).map((v) => v.trim());
    expect(nearest, "both login paraphrases must rank above the unrelated logout case").toEqual(expect.arrayContaining([loginA, loginB]));
    expect(nearest).not.toContain(logout);

    exec(`DELETE FROM testcase_embeddings WHERE testcase_id = ANY(ARRAY[${literal(loginA)}, ${literal(loginB)}, ${literal(logout)}]::uuid[])`);
    exec(`DELETE FROM testcases WHERE id = ANY(ARRAY[${literal(loginA)}, ${literal(loginB)}, ${literal(logout)}]::uuid[])`);
  });
});
