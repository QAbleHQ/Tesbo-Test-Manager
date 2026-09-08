import { createServer, type Server } from "node:http";

/*
 * A local stand-in for an OpenAI-compatible /v1/chat/completions endpoint, so a Zyra chat turn can
 * be driven through the REAL router and generation code (buildZyraChatDecision,
 * applyZyraChatOperations, zyraSaveAttempt) without a live provider call or spend.
 *
 * docs/e2e-coverage-waves.md, Wave 0 item 3 — the prerequisite api/zyra-chat-consistency.spec.ts's
 * own header names as missing: "the 'reply claimed 15, saved 10' half of the report is out of reach
 * until utils/fake-ai-server.ts exists". This is that file.
 *
 * Modelled directly on the embeddings stub in api/kb-embeddings.spec.ts (startEmbeddingStub) — same
 * reason for host.docker.internal (the backend runs in a container; `localhost`/`127.0.0.1` there is
 * the container, not this process), same 0.0.0.0 bind so the container's Docker bridge can reach it,
 * same per-test throwaway server. Generalized here into e2e/utils because more than one spec needs a
 * scripted model now (chat router + chat generation, in the same turn).
 *
 * Responses are scripted per test via queueReply(), served FIFO. A caller doesn't need to know
 * whether a given HTTP call is the chat router or a follow-up drafting call (buildZyraChatDecision
 * dispatches "create" to a second call, generateZyraChatTestcasesWithAi) — it queues as many
 * responses as the scenario needs, in the order the backend will make the calls, and this server
 * hands them out one per request.
 */

export interface FakeAiRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
}

export interface FakeAiServer {
  /** Pass as `baseUrl` when creating a workspace AI key (provider "openai" or a custom gateway). */
  baseUrl: string;
  /** Every request this server received, in arrival order — for asserting on what the backend sent. */
  requests: FakeAiRequest[];
  /**
   * Queue one scripted chat-completion reply, consumed FIFO. `content` becomes
   * `choices[0].message.content` verbatim — pass the JSON envelope buildZyraChatDecision (or
   * generateZyraChatTestcasesWithAi) expects, as an object (JSON-stringified here) or a raw string
   * for a test that wants to exercise the "model returned prose instead of JSON" fallback.
   */
  queueReply(content: Record<string, unknown> | string): void;
  /** Set to a status code to make the NEXT call fail (consumed once), exercising the error path. */
  failNextWith(status: number, message?: string): void;
  close(): Promise<void>;
}

export async function startFakeAiServer(): Promise<FakeAiServer> {
  const queue: string[] = [];
  const requests: FakeAiRequest[] = [];
  let failStatus: number | null = null;
  let failMessage = "stubbed provider failure";

  const server: Server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (failStatus !== null) {
        const status = failStatus;
        failStatus = null;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: failMessage } }));
        return;
      }
      let body: FakeAiRequest;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid JSON body" } }));
        return;
      }
      requests.push({ model: String(body.model || ""), messages: Array.isArray(body.messages) ? body.messages : [] });
      const next = queue.shift();
      const content = next ?? JSON.stringify({
        reply: "fake-ai-server: no scripted response was queued for this call.",
        reasoningSummary: "fake-ai-server exhausted its queue.",
        action: "answer",
        actionType: "answer",
        operations: [],
        testcases: []
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "fake-chatcmpl",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    baseUrl: `http://host.docker.internal:${port}/v1`,
    requests,
    queueReply(content) {
      queue.push(typeof content === "string" ? content : JSON.stringify(content));
    },
    failNextWith(status, message) {
      failStatus = status;
      if (message) failMessage = message;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  };
}
