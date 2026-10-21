import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { env } from "./env";

/*
 * A stand-in for NYRA's /api/v1 projects API, so the Tesbo NYRA agent can be driven end to end
 * without ever creating projects in a real NYRA.
 *
 * The backend reads NYRA_BASE_URL once at boot and runs in a container, so the fake only receives
 * traffic when the stack was started with NYRA_BASE_URL=http://host.docker.internal:<NYRA_FAKE_PORT>
 * (default 2906). nyraFakeIsWired() says whether it was; specs that need it skip, with that reason,
 * when it was not. Never point this at a real NYRA: the gate is what stops a test run creating real
 * projects, and it compares the exact address.
 *
 * Mirrors what NYRA's audit documented: Bearer nyra_sk_ auth, POST /projects with an optional
 * environment/test_account, GET /projects, has_password instead of the password, and a 422 that
 * ECHOES the submitted input (so Tesbo's refusal to forward it is observable).
 *
 * Magic project names script the failures, because the backend decides what to send:
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

export interface FakeNyraCall {
  method: string;
  path: string;
  authorization: string | undefined;
  body: any;
}

export interface FakeNyraServer {
  /** Every request received, oldest first. */
  calls: FakeNyraCall[];
  projects: any[];
  reset(): void;
  close(): Promise<void>;
}

export async function startFakeNyraServer(): Promise<FakeNyraServer> {
  const calls: FakeNyraCall[] = [];
  const projects: any[] = [];

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
      calls.push({ method: req.method || "", path, authorization: req.headers.authorization, body });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (!/^Bearer .{8,}/.test(req.headers.authorization || "")) {
        return send(401, { detail: "Missing API key.", code: "invalid_api_key" });
      }
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
      return send(404, { detail: "Not found", code: "not_found" });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(NYRA_FAKE_PORT, "0.0.0.0", () => resolve());
  });

  return {
    calls,
    projects,
    reset() {
      calls.length = 0;
      projects.length = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
