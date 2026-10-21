import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Request, Response as ExpressResponse } from "express";
import { Readable } from "stream";
import { neutralizeFormula } from "../common/spreadsheet-safe";
import { NyraClient } from "./nyra.client";
import { NyraService } from "./nyra.service";

type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// NYRA's own ceilings (RunCreate budget), checked here so a bad value is a 400 rather than a NYRA 422.
const BUDGET_LIMITS = { maxPages: [1, 500], maxMinutes: [1, 120], maxDepth: [1, 20] } as const;
const FILE_KINDS = new Set(["recordings", "screens"]);
const FILE_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
// NYRA turns a malformed Last-Event-ID into an aborted stream, so only a real stream id is forwarded.
const STREAM_ID = /^\d{1,20}-\d{1,20}$/;
const EXPORTS: Record<string, { type: string }> = {
  "test-cases.csv": { type: "text/csv; charset=utf-8" },
  "knowledge.md": { type: "text/markdown; charset=utf-8" },
  "business-rules.md": { type: "text/markdown; charset=utf-8" }
};
// A scan can run for hours of wall clock at most (120 min budget plus analysis); a recording can be large.
const STREAM_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const FILE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
// Only these ever leave as a body the browser may render; anything else is a download.
const SAFE_FILE_TYPES: Record<string, string> = { "image/jpeg": "image/jpeg", "video/webm": "video/webm" };

/** Every cell of NYRA's CSV is double-quoted; a cell a spreadsheet would read as a formula gets a leading quote. */
export function neutralizeCsv(csv: string): string {
  return csv.replace(/"((?:[^"]|"")*)"/g, (_m, inner: string) => `"${neutralizeFormula(inner)}"`);
}

@Injectable()
export class NyraRunsService {
  constructor(
    private readonly nyra: NyraService,
    private readonly client: NyraClient
  ) {}

  private runPath(nyraId: string, runId: string): string {
    if (!UUID.test(runId)) throw new NotFoundException({ error: "Run not found" });
    return `/projects/${nyraId}/runs/${runId}`;
  }

  async listRuns(userId: string | null | undefined, projectId: string, nyraId: string) {
    await this.nyra.requireLinked(userId, projectId, nyraId);
    const runs = await this.client.json("GET", `/projects/${nyraId}/runs`);
    return { list: (Array.isArray(runs) ? runs : []).map((r) => this.runDto(r)) };
  }

  async getRun(userId: string | null | undefined, projectId: string, nyraId: string, runId: string) {
    await this.nyra.requireLinked(userId, projectId, nyraId);
    return this.runDto(await this.client.json("GET", this.runPath(nyraId, runId)));
  }

  async startRun(userId: string | null | undefined, projectId: string, nyraId: string, body: Row) {
    await this.nyra.requireLinked(userId, projectId, nyraId);
    const environmentId = typeof body?.environmentId === "string" ? body.environmentId : "";
    if (!UUID.test(environmentId)) throw new BadRequestException({ error: "Choose an environment to scan" });
    const budget: Record<string, number> = {};
    for (const [key, [min, max]] of Object.entries(BUDGET_LIMITS)) {
      const value = body?.budget?.[key];
      if (value === undefined || value === null || value === "") continue;
      if (!Number.isInteger(value) || value < min || value > max) {
        throw new BadRequestException({ error: `${LABEL[key]} must be a whole number from ${min} to ${max}` });
      }
      budget[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = value;
    }
    const run = await this.client.json("POST", `/projects/${nyraId}/runs`, {
      body: { environment_id: environmentId, ...(Object.keys(budget).length && { budget }) }
    });
    return this.runDto(run);
  }

  async stopRun(userId: string | null | undefined, projectId: string, nyraId: string, runId: string) {
    await this.nyra.requireLinked(userId, projectId, nyraId);
    const res = await this.client.json("POST", `${this.runPath(nyraId, runId)}/stop`);
    return { status: String(res?.status ?? "stopping") };
  }

  async items(userId: string | null | undefined, projectId: string, nyraId: string, runId: string) {
    await this.nyra.requireLinked(userId, projectId, nyraId);
    const items = await this.client.json("GET", `${this.runPath(nyraId, runId)}/items`);
    return {
      list: (Array.isArray(items) ? items : []).map((i: Row) => ({
        kind: i.kind,
        key: i.key,
        title: i.title,
        data: i.data ?? {},
        reviewStatus: i.review_status ?? "waiting"
      }))
    };
  }

  async recordings(userId: string | null | undefined, projectId: string, nyraId: string, runId: string) {
    await this.nyra.requireLinked(userId, projectId, nyraId);
    const list = await this.client.json("GET", `${this.runPath(nyraId, runId)}/recordings`);
    // The name is all the browser needs; the file itself is served by this server (see file()).
    return { list: (Array.isArray(list) ? list : []).map((r: Row) => ({ name: String(r.name), sizeBytes: Number(r.size_bytes) || 0 })) };
  }

  // ---------------------------------------------------------------- streamed responses

  /** The live frame. 204 when the scan has not produced one yet. */
  async liveFrame(userId: string | null | undefined, projectId: string, nyraId: string, runId: string, res: ExpressResponse) {
    await this.nyra.requireLinked(userId, projectId, nyraId);
    const up = await this.client.fetch("GET", `${this.runPath(nyraId, runId)}/live.jpg`, { headers: { Accept: "image/jpeg" }, maxBytes: 8 * 1024 * 1024 });
    if (up.status === 204) {
      res.status(204).end();
      return;
    }
    res.status(200).set({ "Content-Type": "image/jpeg", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(Buffer.from(await up.arrayBuffer()));
  }

  /** Recordings and screenshots, with Range forwarded so a browser can seek in a video. */
  async file(
    userId: string | null | undefined,
    projectId: string,
    nyraId: string,
    runId: string,
    kind: string,
    name: string,
    req: Request,
    res: ExpressResponse
  ) {
    await this.nyra.requireLinked(userId, projectId, nyraId);
    if (!FILE_KINDS.has(kind) || !FILE_NAME.test(name)) throw new NotFoundException({ error: "File not found" });
    const headers: Record<string, string> = { Accept: "*/*" };
    for (const h of ["range", "if-range"] as const) {
      const v = req.headers[h];
      if (typeof v === "string" && v.length <= 200) headers[h] = v;
    }
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const up = await this.client.fetch("GET", `${this.runPath(nyraId, runId)}/files/${kind}/${name}`, {
      headers,
      signal: abort.signal,
      timeoutMs: STREAM_TIMEOUT_MS,
      maxBytes: FILE_MAX_BYTES
    });
    const type = SAFE_FILE_TYPES[(up.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()] ?? "application/octet-stream";
    res.status(up.status).set({
      "Content-Type": type,
      "Cache-Control": "private, max-age=3600",
      // Scanned content is untrusted: never let a browser sniff or run it.
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      ...(type === "application/octet-stream" && { "Content-Disposition": "attachment" })
    });
    for (const h of ["content-length", "content-range", "accept-ranges"]) {
      const v = up.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!up.body) return void res.end();
    Readable.fromWeb(up.body as never).on("error", () => res.destroy()).pipe(res);
  }

  /** Test cases CSV, knowledge file and business rules, as NYRA built them. Business rules is 204 when empty. */
  async export(userId: string | null | undefined, projectId: string, nyraId: string, runId: string, file: string, res: ExpressResponse) {
    await this.nyra.requireLinked(userId, projectId, nyraId);
    const spec = EXPORTS[file];
    if (!spec) throw new NotFoundException({ error: "Export not found" });
    const up = await this.client.fetch("GET", `${this.runPath(nyraId, runId)}/export/${file}`, { headers: { Accept: "*/*" }, maxBytes: 64 * 1024 * 1024 });
    if (up.status === 204) {
      res.status(204).end();
      return;
    }
    let text = await up.text();
    // The cells are text a scanned page and a model wrote; opened in Excel, a leading = would run.
    if (file.endsWith(".csv")) text = neutralizeCsv(text);
    res.status(200).set({
      "Content-Type": spec.type,
      "Content-Disposition": `attachment; filename="nyra-${runId.slice(0, 8)}-${file}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store"
    });
    res.end(text);
  }

  /**
   * Live events as NYRA sends them (status, log, digest, item), passed through unchanged.
   * The stream never ends on its own, so it ends when the browser leaves. NYRA sends its terminal
   * `status` event BEFORE the results are saved, so the page treats GET .../runs/:id as the end signal.
   * ponytail: no per-user cap on open streams; add one if many viewers watch many scans.
   */
  async events(userId: string | null | undefined, projectId: string, nyraId: string, runId: string, req: Request, res: ExpressResponse) {
    await this.nyra.requireLinked(userId, projectId, nyraId);
    const path = `${this.runPath(nyraId, runId)}/events`;
    const last = req.headers["last-event-id"];
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const up = await this.client.fetch("GET", path, {
      headers: { Accept: "text/event-stream", ...(typeof last === "string" && STREAM_ID.test(last) ? { "Last-Event-ID": last } : {}) },
      signal: abort.signal,
      timeoutMs: STREAM_TIMEOUT_MS,
      maxBytes: FILE_MAX_BYTES
    });
    if (!up.body) throw new BadGatewayException({ error: "NYRA returned an unexpected response." });
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Without this a proxy in front buffers the stream and the page sees nothing until it ends.
      "X-Accel-Buffering": "no"
    });
    res.flushHeaders();
    Readable.fromWeb(up.body as never).on("error", () => res.end()).pipe(res);
  }

  private runDto(r: Row) {
    if (!r?.id) throw new BadGatewayException({ error: "NYRA returned an unexpected response." });
    return {
      id: String(r.id),
      environmentId: r.environment_id ?? null,
      status: r.status,
      budget: { maxPages: r.budget?.max_pages ?? null, maxMinutes: r.budget?.max_minutes ?? null, maxDepth: r.budget?.max_depth ?? null },
      summary: {
        reason: r.summary?.reason ?? null,
        pagesVisited: r.summary?.pages_visited ?? null,
        counts: r.summary?.counts ?? {},
        recordings: r.summary?.recordings ?? null
      },
      createdAt: r.created_at ?? null,
      startedAt: r.started_at ?? null,
      finishedAt: r.finished_at ?? null
    };
  }
}

const LABEL: Record<string, string> = { maxPages: "Max pages", maxMinutes: "Max minutes", maxDepth: "Max depth" };

