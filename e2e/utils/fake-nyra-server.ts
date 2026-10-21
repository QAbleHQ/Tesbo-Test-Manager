import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { env } from "./env";

/*
 * A stand-in for NYRA's /api/v1 API, so the Tesbo NYRA agent can be driven end to end without ever
 * creating projects or scans in a real NYRA.
 *
 * The backend reads NYRA_BASE_URL once at boot and runs in a container, so the fake only receives
 * traffic when the stack was started with NYRA_BASE_URL=http://host.docker.internal:<NYRA_FAKE_PORT>
 * (default 2906). nyraFakeIsWired() says whether it was; specs that need it skip, with that reason,
 * when it was not. Never point this at a real NYRA: the gate is what stops a test run creating real
 * projects, and it compares the exact address.
 *
 * Mirrors what NYRA's audit documented: Bearer auth, POST /projects with an optional
 * environment/test_account, has_password instead of the password, a 422 that ECHOES the submitted
 * input (so Tesbo's refusal to forward it is observable), one active scan per environment (409),
 * results saved before the status changes, Range support on files, 204 for "nothing yet", and an
 * events stream that replays and then idles.
 *
 * Magic project names script project failures, because the backend decides what to send:
 *   "force-422" -> 422 with the input echoed   "force-401" -> 401   "force-500" -> 500
 */

export const NYRA_FAKE_PORT = Number(process.env.NYRA_FAKE_PORT || 2906);
export const NYRA_FAKE_BASE_URL = `http://host.docker.internal:${NYRA_FAKE_PORT}`;

export function nyraFakeIsWired(): boolean {
  return env.nyraBaseUrl.replace(/\/+$/, "") === NYRA_FAKE_BASE_URL;
}

export const NYRA_FAKE_SKIP_REASON =
  `the backend was not started against the fake NYRA. Boot the stack with NYRA_BASE_URL=${NYRA_FAKE_BASE_URL} ` +
  "(and any NYRA_API_KEY) to run these; it is skipped otherwise so a run never creates projects in a real NYRA.";

export const FAKE_RECORDING = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
// A 1x1 JPEG, so an <img> and a content-type check both have something real.
export const FAKE_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

export interface FakeNyraCall {
  method: string;
  path: string;
  authorization: string | undefined;
  body: any;
  headers: Record<string, string | string[] | undefined>;
}

export interface FakeNyraServer {
  /** Every request received, oldest first. */
  calls: FakeNyraCall[];
  projects: any[];
  runs: any[];
  /** Ends a scan the way NYRA does: results saved first, then the status set. */
  finishRun(runId: string, status?: string): void;
  /** Sends one event down every open events stream of a run. */
  emit(runId: string, event: string, data: Record<string, unknown>): void;
  reset(): void;
  close(): Promise<void>;
}

// What a finished scan "found": one of each kind a screen shows, plus a title a spreadsheet would run.
export const FAKE_ITEMS = [
  {
    kind: "screen",
    key: "/login",
    title: "Sign in",
    data: { url_pattern: "/login", example_url: "https://staging.example.com/login", headings: ["Sign in"], element_count: 5, screenshot: "screen-001.jpg", purpose: "Sign in to the shop" },
    review_status: "waiting",
  },
  { kind: "feature", key: "sign-in", title: "Account sign in", data: { module: "Account", description: "Log in with email", screens: ["/login"] }, review_status: "waiting" },
  { kind: "workflow", key: "login-flow", title: "Login flow", data: { goal: "Get in", steps: ["Open /login", "Submit"], screens: ["/login"], status: "inferred" }, review_status: "waiting" },
  {
    kind: "business_rule",
    key: "enf-1",
    title: '"Email" is required',
    data: { confidence: "verified", category: "validation", explanation: "Declared required", screens: ["/login"] },
    review_status: "waiting",
  },
  {
    kind: "test_case",
    key: "valid-login",
    title: '=HYPERLINK("http://evil.example")',
    data: { priority: "high", steps: ["Open /login"], expected: "Dashboard", screen: "/login" },
    review_status: "waiting",
  },
];

export async function startFakeNyraServer(): Promise<FakeNyraServer> {
  const calls: FakeNyraCall[] = [];
  const projects: any[] = [];
  const runs: any[] = [];
  const itemsByRun = new Map<string, any[]>();
  const streams = new Map<string, Set<ServerResponse>>();

  const sse = (res: ServerResponse, id: number, event: string, data: unknown) =>
    res.write(`id: ${Date.now()}-${id}\r\nevent: ${event}\r\ndata: ${JSON.stringify({ ts: new Date().toISOString(), data })}\r\n\r\n`);

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const path = (req.url || "").split("?")[0];
      let body: any = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      const call: FakeNyraCall = { method: req.method || "", path, authorization: req.headers.authorization, body, headers: req.headers };
      calls.push(call);
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (!/^Bearer .{8,}/.test(req.headers.authorization || "")) {
        return send(401, { detail: "Missing API key.", code: "invalid_api_key" });
      }

      // ---- projects
      if (path === "/api/v1/projects" && req.method === "GET") return send(200, projects);
      if (path === "/api/v1/projects" && req.method === "POST") {
        const name = typeof body?.name === "string" ? body.name : "";
        if (name.includes("force-401")) return send(401, { detail: "Invalid API key", code: "invalid_api_key" });
        if (name.includes("force-500")) return send(500, { detail: "boom" });
        if (name.includes("force-422")) {
          return send(422, {
            code: "validation_error",
            detail: [{ type: "value_error", loc: ["body", "environment"], msg: "Fake NYRA says no", input: body?.environment }],
          });
        }
        if (!name.trim() || !body?.environment?.base_url) {
          return send(422, { code: "validation_error", detail: [{ type: "missing", loc: ["body"], msg: "Field required", input: body }] });
        }
        const id = randomUUID();
        const acct = body.environment.test_account;
        const project = {
          id,
          name: name.trim(),
          description: null,
          tesbo_project_id: "fake",
          created_at: new Date().toISOString(),
          environments: [
            {
              id: randomUUID(),
              project_id: id,
              name: "staging",
              base_url: body.environment.base_url,
              mode: "observe",
              allowed_domains: [],
              login_url: acct?.login_url ?? null,
              username: acct?.username ?? null,
              login_method: acct?.login_method ?? "password",
              has_password: !!acct?.password,
              created_at: new Date().toISOString(),
            },
          ],
        };
        projects.push(project);
        return send(201, project);
      }

      const one = /^\/api\/v1\/projects\/([^/]+)$/.exec(path);
      if (one && req.method === "GET") {
        const p = projects.find((x) => x.id === one[1]);
        return p ? send(200, p) : send(404, { detail: "Project not found", code: "not_found" });
      }
      const envRoute = /^\/api\/v1\/projects\/([^/]+)\/environments\/([^/]+)$/.exec(path);
      if (envRoute && req.method === "PATCH") {
        const e = projects.find((x) => x.id === envRoute[1])?.environments.find((x: any) => x.id === envRoute[2]);
        if (!e) return send(404, { detail: "Environment not found", code: "not_found" });
        if (body?.name === "force-422") return send(422, { code: "validation_error", detail: [{ msg: "Fake NYRA says no", input: body }] });
        for (const k of ["name", "base_url", "mode", "allowed_domains"]) if (body?.[k] !== undefined) e[k] = body[k];
        if (body?.test_account) {
          e.login_url = body.test_account.login_url ?? null;
          e.username = body.test_account.username;
          if (body.test_account.password) e.has_password = true;
        }
        return send(200, e);
      }

      // ---- scans
      const m = /^\/api\/v1\/projects\/([^/]+)\/runs(?:\/([^/]+)(?:\/(.*))?)?$/.exec(path);
      if (m) {
        const [, pid, rid, rest] = m;
        const project = projects.find((p) => p.id === pid);
        if (!project) return send(404, { detail: "Project not found", code: "not_found" });
        if (!rid && req.method === "GET") return send(200, runs.filter((r) => r.project_id === pid).slice().reverse());
        if (!rid && req.method === "POST") {
          const environment = project.environments.find((e: any) => e.id === body?.environment_id);
          if (!environment) return send(404, { detail: "Environment not found", code: "not_found" });
          if (runs.some((r) => r.environment_id === environment.id && (r.status === "running" || r.status === "queued"))) {
            return send(409, { detail: "A scan is already running on this environment", code: "conflict" });
          }
          const b = body?.budget ?? {};
          const run = {
            id: randomUUID(),
            project_id: pid,
            environment_id: environment.id,
            status: "running",
            budget: { max_pages: b.max_pages ?? 25, max_minutes: b.max_minutes ?? 10, max_depth: b.max_depth ?? 4 },
            summary: {},
            created_by: "fake",
            created_at: new Date().toISOString(),
            started_at: new Date().toISOString(),
            finished_at: null,
          };
          runs.push(run);
          return send(201, run);
        }
        const run = runs.find((r) => r.id === rid && r.project_id === pid);
        if (!run) return send(404, { detail: "Run not found", code: "not_found" });
        if (!rest && req.method === "GET") return send(200, run);
        if (rest === "stop" && req.method === "POST") return send(202, { status: run.status === "running" || run.status === "queued" ? "stopping" : run.status });
        if (rest === "items") return send(200, itemsByRun.get(run.id) ?? []);
        if (rest === "recordings") {
          const url = `/api/v1/projects/${pid}/runs/${rid}/files/recordings/session-1.webm`;
          return send(200, run.status === "running" ? [] : [{ name: "session-1.webm", url, size_bytes: FAKE_RECORDING.length }]);
        }
        if (rest === "live.jpg") {
          if (run.status === "running") {
            res.writeHead(204);
            return res.end();
          }
          res.writeHead(200, { "content-type": "image/jpeg" });
          return res.end(FAKE_JPEG);
        }
        const file = /^files\/(recordings|screens)\/([A-Za-z0-9_.-]+)$/.exec(rest ?? "");
        if (file) {
          const isVideo = file[1] === "recordings";
          const data = isVideo ? FAKE_RECORDING : FAKE_JPEG;
          // The recording is served as text/html on purpose: Tesbo must not pass a type it did not choose.
          const type = isVideo ? (file[2].startsWith("evil") ? "text/html" : "video/webm") : "image/jpeg";
          const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));
          if (range) {
            const start = Number(range[1]);
            const end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
            if (start >= data.length) {
              res.writeHead(416, { "content-range": `bytes */${data.length}` });
              return res.end();
            }
            res.writeHead(206, {
              "content-type": type,
              "accept-ranges": "bytes",
              "content-range": `bytes ${start}-${end}/${data.length}`,
              "content-length": end - start + 1,
            });
            return res.end(data.subarray(start, end + 1));
          }
          res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": data.length });
          return res.end(data);
        }
        const exp = /^export\/(.+)$/.exec(rest ?? "");
        if (exp) {
          const rows = itemsByRun.get(run.id) ?? [];
          if (exp[1] === "test-cases.csv") {
            res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
            const cells = rows.filter((i) => i.kind === "test_case").map((i) => `"${String(i.title).replace(/"/g, '""')}","high"`);
            return res.end(['"Title","Priority"', ...cells].join("\r\n"));
          }
          if (exp[1] === "knowledge.md") {
            res.writeHead(200, { "content-type": "text/markdown" });
            return res.end("# Fake: knowledge file\n\n## Screens\n- Sign in\n");
          }
          if (exp[1] === "business-rules.md") {
            if (!rows.some((i) => i.kind === "business_rule")) {
              res.writeHead(204);
              return res.end();
            }
            res.writeHead(200, { "content-type": "text/markdown" });
            return res.end("# Fake: business rules\n");
          }
        }
        if (rest === "events") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          sse(res, 1, "log", { level: "info", message: `Starting scan ${run.id}` });
          sse(res, 2, "status", { status: "running" });
          sse(res, 3, "digest", { url: "https://staging.example.com/login", pattern: "/login", text: "URL: /login\nTitle: Sign in" });
          sse(res, 4, "item", FAKE_ITEMS[0]);
          const set = streams.get(run.id) ?? new Set<ServerResponse>();
          set.add(res);
          streams.set(run.id, set);
          req.on("close", () => set.delete(res));
          return;
        }
      }
      return send(404, { detail: "Not found", code: "not_found" });
    });
  });

  // The backend knows exactly one NYRA address, so only one spec file can hold the fake at a time.
  // The API and UI files run in different workers; the second one waits here for the first to finish.
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(NYRA_FAKE_PORT, "0.0.0.0", () => resolve());
      });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return {
    calls,
    projects,
    runs,
    finishRun(runId, status = "completed") {
      const run = runs.find((r) => r.id === runId);
      if (!run) throw new Error(`fake NYRA has no run ${runId}`);
      itemsByRun.set(runId, FAKE_ITEMS);
      run.status = status;
      run.finished_at = new Date().toISOString();
      run.summary = { reason: null, pages_visited: 1, counts: { screen: 1, feature: 1, workflow: 1, business_rule: 1, test_case: 1 }, recordings: 1 };
    },
    emit(runId, event, data) {
      let n = 100;
      for (const res of streams.get(runId) ?? []) sse(res, n++, event, data);
    },
    reset() {
      calls.length = 0;
      projects.length = 0;
      runs.length = 0;
      itemsByRun.clear();
      for (const set of streams.values()) for (const res of set) res.end();
      streams.clear();
    },
    close() {
      for (const set of streams.values()) for (const res of set) res.end();
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
