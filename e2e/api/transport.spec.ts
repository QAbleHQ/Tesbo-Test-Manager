import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import * as XLSX from "xlsx";
import { parseCsv } from "../utils/csv";
import { env } from "../utils/env";
import { anonymousContext } from "../utils/rbac-tenant";
import { pngFile } from "../utils/uploads";
import { readZipEntries } from "../utils/zip";

/*
 * How responses reach the client, rather than what is in them.
 *
 * This file owns the transport layer: response compression (main.ts) and the connection pool that
 * every request draws from (database.module.ts). Neither belongs to a feature spec — they sit in
 * front of every route at once, which is exactly why they need coverage of their own: a regression
 * here shows up as "the xlsx export is corrupt" or "the app stops responding under load", miles from
 * the line that caused it.
 *
 * The compression cases split into two halves that fail in different ways. Text responses must be
 * compressed AND survive the round trip; binary downloads must survive it whether or not the filter
 * decides to compress them. The second half is the one worth having — a mangled zip or xlsx is the
 * classic way response compression breaks a product, and it breaks silently, at download time, long
 * after the change that caused it.
 *
 * Playwright's request context decodes Content-Encoding transparently but still reports the header,
 * so both facts are assertable from the same response: `headers()["content-encoding"]` says how it
 * travelled, `body()` says what arrived.
 */

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));

/** compression's default threshold. Anything smaller is sent as-is, by design. */
const COMPRESSION_THRESHOLD_BYTES = 1024;

async function createCase(request: APIRequestContext, title: string, extra: Record<string, unknown> = {}) {
  const res = await request.post(`/api/projects/${ctx.projectId}/testcases`, {
    data: { title, ...extra },
    failOnStatusCode: false,
  });
  // Surface the status and body: a bare `expect(res.ok())` here reports only "false", which says
  // nothing about whether the fixture failed on a plan limit, an auth change, or contention with
  // another spec file sharing this project.
  expect(res.status(), `createCase failed: ${res.status()} ${await res.text()}`).toBe(201);
  return res.json();
}

async function deleteCase(request: APIRequestContext, id: string) {
  await request.delete(`/api/projects/${ctx.projectId}/testcases/${id}`, { failOnStatusCode: false });
}

test.describe("response compression", () => {
  test("a JSON list over the threshold is gzipped and decodes to the payload it would have sent raw", { tag: '@tesbo.testId("TES-TC-962")' }, async ({
    request,
  }) => {
    // Seeded rather than borrowed from whatever the project already holds: the assertion is about a
    // response crossing the size threshold, and a shared project's row count is not ours to rely on.
    // The padding is in the description so the list response carries the weight without the titles
    // becoming unreadable in a failure message.
    const marker = `E2E transport ${Date.now()}`;
    const created: string[] = [];
    try {
      for (let i = 0; i < 12; i++) {
        const testcase = await createCase(request, `${marker} ${i}`, { description: "x".repeat(200) });
        created.push(testcase.id);
      }

      const res = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { search: marker, limit: 50 },
      });
      expect(res.ok()).toBeTruthy();

      const raw = await res.body();
      expect(raw.byteLength).toBeGreaterThan(COMPRESSION_THRESHOLD_BYTES);
      // Any negotiated encoding, not gzip specifically: compression picks the best algorithm the
      // client offered, so a browser advertising br gets Brotli and an older client gets gzip. Pinning
      // one of them would fail the day the other is correctly chosen, which is not a regression.
      expect(["br", "gzip", "deflate"]).toContain(res.headers()["content-encoding"]);

      // The decoded payload is still the real thing, not a truncated or double-encoded one.
      const body = JSON.parse(raw.toString("utf-8"));
      const rows = Array.isArray(body) ? body : body.rows;
      expect(rows).toHaveLength(created.length);
      for (const row of rows) expect(String(row.title)).toContain(marker);
    } finally {
      for (const id of created) await deleteCase(request, id);
    }
  });

  test("a client that asks for no encoding still gets a correct, readable body", { tag: '@tesbo.testId("TES-TC-963")' }, async ({ request }) => {
    // Some proxies and older clients send `identity`. compression must honour that rather than
    // gzipping anyway — a body that ignores the negotiated encoding is unreadable at the other end.
    const res = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
      params: { limit: 50 },
      headers: { "accept-encoding": "identity" },
    });
    expect(res.ok()).toBeTruthy();
    expect(res.headers()["content-encoding"]).toBeUndefined();
    // Parses without a decoder in the path, which is the whole point of asking for identity.
    const raw = await res.body();
    expect(() => JSON.parse(raw.toString("utf-8"))).not.toThrow();
  });

  test("a response below the threshold is left alone and still parses", { tag: '@tesbo.testId("TES-TC-964")' }, async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  test("error bodies survive compression on every status the UI reads", { tag: '@tesbo.testId("TES-TC-965")' }, async ({ request }) => {
    // The frontend renders `error` out of these. A body mangled by the encoder turns every failure
    // in the product into a blank message, which is worse than the failure itself.
    const notFound = await request.get(`/api/projects/${ctx.projectId}/testcases/${crypto.randomUUID()}`, {
      failOnStatusCode: false,
    });
    expect(notFound.status()).toBe(404);
    expect(await notFound.json()).toHaveProperty("error");

    // A suite with a blank name, because that is a field the product actually validates. The
    // equivalent on testcases does NOT reject — createTestCase substitutes "Untitled test case" for
    // any falsy title and stores a whitespace-only one verbatim — so it would answer 201 here and
    // prove nothing about error bodies. That gap is real but belongs to testcase validation, not to
    // this file.
    const badRequest = await request.post(`/api/projects/${ctx.projectId}/suites`, {
      data: { name: "" },
      failOnStatusCode: false,
    });
    expect(badRequest.status()).toBe(400);
    expect(await badRequest.json()).toHaveProperty("error");
  });

  test("an unauthenticated caller still gets a readable error body rather than an undecodable one", { tag: '@tesbo.testId("TES-TC-966")' }, async () => {
    // anonymousContext(), not playwright.request.newContext(): a bare newContext inherits `use` from
    // playwright.config.ts, storageState included, so it arrives holding account A's session cookie
    // and is not anonymous at all. The helper passes an empty state explicitly.
    //
    // Deliberately not asserting a particular status: requireUser() answers 400 "Authentication
    // required" rather than 401, and which of those is right is an auth question this file has no
    // business settling. What matters here is that the body still decodes and still carries `error`.
    //
    // The route is /api/workspace rather than a project one because GET .../testcases takes no
    // caller at all (tracker §3 bug 11 — an anonymous reader gets 200), and duplicating that
    // assertion here would put a second owner on a bug custom-field-values.spec.ts already covers.
    const anonymous = await anonymousContext();
    try {
      const res = await anonymous.get("/api/workspace", { failOnStatusCode: false });
      expect(res.status()).toBeGreaterThanOrEqual(400);
      expect(await res.json()).toHaveProperty("error");
    } finally {
      await anonymous.dispose();
    }
  });

  test("an empty result set round-trips as an empty collection, not as an empty body", { tag: '@tesbo.testId("TES-TC-967")' }, async ({ request }) => {
    const res = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
      params: { search: `no-such-case-${Date.now()}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const rows = Array.isArray(body) ? body : body.rows;
    expect(rows).toEqual([]);
  });

  test("a delete still completes and returns no misencoded body", { tag: '@tesbo.testId("TES-TC-968")' }, async ({ request }) => {
    const testcase = await createCase(request, `E2E transport delete ${Date.now()}`);
    const res = await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`);
    expect(res.ok()).toBeTruthy();
    // Whether the route answers 200-with-body or 204-empty, what must not happen is a body that
    // claims an encoding it doesn't have — that surfaces as a parse error in the client.
    const raw = await res.body();
    if (raw.byteLength > 0) expect(() => JSON.parse(raw.toString("utf-8"))).not.toThrow();

    const after = await request.get(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, {
      failOnStatusCode: false,
    });
    expect(after.status()).toBe(404);
  });
});

test.describe("binary downloads survive the encoder", () => {
  test("the CSV export still parses as CSV", { tag: '@tesbo.testId("TES-TC-969")' }, async ({ request }) => {
    const marker = `E2E transport csv ${Date.now()}`;
    const testcase = await createCase(request, marker);
    try {
      const res = await request.get(`/api/projects/${ctx.projectId}/testcases/export/csv`);
      expect(res.ok()).toBeTruthy();
      const rows = parseCsv((await res.body()).toString("utf-8"));
      expect(rows.length).toBeGreaterThan(1);
      expect(rows[0]).toContain("title");
      expect(rows.some((row) => row.includes(marker))).toBeTruthy();
    } finally {
      await deleteCase(request, testcase.id);
    }
  });

  test("the XLSX export still opens as a workbook", { tag: '@tesbo.testId("TES-TC-970")' }, async ({ request }) => {
    // The real regression this guards: xlsx is a zip container, so a byte mangled in transit does not
    // produce a wrong cell — it produces a file Excel refuses to open. Parsing it here is the only
    // assertion that can tell the difference.
    const marker = `E2E transport xlsx ${Date.now()}`;
    const testcase = await createCase(request, marker);
    try {
      const res = await request.get(`/api/projects/${ctx.projectId}/testcases/export/xlsx`);
      expect(res.ok()).toBeTruthy();
      const workbook = XLSX.read(await res.body(), { type: "buffer" });
      expect(workbook.SheetNames.length).toBeGreaterThan(0);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const records = XLSX.utils.sheet_to_json<Record<string, string>>(sheet);
      expect(records.some((record) => String(record.title) === marker)).toBeTruthy();
    } finally {
      await deleteCase(request, testcase.id);
    }
  });

  test("an uploaded attachment downloads back byte-for-byte", { tag: '@tesbo.testId("TES-TC-971")' }, async ({ request }) => {
    // A PNG is the strictest check available here: it carries a CRC per chunk, so a single altered
    // byte is detectable, and image/* is a content type the filter must decline to compress.
    const file = pngFile(`transport-${Date.now()}.png`);
    const bugRes = await request.post(`/api/projects/${ctx.projectId}/bugs`, {
      data: { title: `E2E transport bug ${Date.now()}`, severity: "Low" },
    });
    expect(bugRes.ok()).toBeTruthy();
    const bug = await bugRes.json();

    try {
      const upload = await request.post(`/api/projects/${ctx.projectId}/bugs/${bug.id}/attachments`, {
        multipart: { files: { name: file.name, mimeType: file.mimeType, buffer: file.body } },
      });
      expect(upload.ok()).toBeTruthy();
      // uploadBugAttachments answers { list, total } — not a bare array and not { attachments }.
      const { list } = await upload.json();
      const attachment = list[0];
      expect(attachment.id).toBeTruthy();

      const download = await request.get(
        `/api/projects/${ctx.projectId}/bugs/attachments/${attachment.id}/download`
      );
      expect(download.ok()).toBeTruthy();
      expect(Buffer.compare(await download.body(), file.body)).toBe(0);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("the knowledge-base folder export still unzips", { tag: '@tesbo.testId("TES-TC-972")' }, async ({ request }) => {
    const folderRes = await request.post(`/api/projects/${ctx.projectId}/knowledge-base/folders`, {
      data: { name: `E2E transport folder ${Date.now()}` },
    });
    expect(folderRes.ok()).toBeTruthy();
    const folder = await folderRes.json();

    try {
      // contentHtml, not content — the export archives the `content_html` column, and a document
      // created with the wrong field name stores null and exports an empty entry, which looks like a
      // zip corruption but isn't one.
      const docRes = await request.post(`/api/projects/${ctx.projectId}/knowledge-base/documents`, {
        data: { title: "Transport doc", folderId: folder.id, contentHtml: "<p>zip integrity</p>" },
      });
      expect(docRes.ok()).toBeTruthy();

      const res = await request.get(
        `/api/projects/${ctx.projectId}/knowledge-base/folders/${folder.id}/export`
      );
      expect(res.ok()).toBeTruthy();
      // application/zip is already compressed; re-encoding it is both wasteful and the fastest way
      // to hand someone an archive their OS refuses to open.
      const entries = readZipEntries(await res.body());
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some((entry) => entry.contents.toString("utf-8").includes("zip integrity"))).toBeTruthy();
    } finally {
      await request.delete(`/api/projects/${ctx.projectId}/knowledge-base/folders/${folder.id}`, {
        failOnStatusCode: false,
      });
    }
  });
});

test.describe("connection pool under load", () => {
  test("more concurrent requests than the pool holds all complete", { tag: '@tesbo.testId("TES-TC-973")' }, async ({ request }) => {
    // 40 against a pool of 20: the excess must queue and drain rather than error on
    // connectionTimeoutMillis. This is the case that would have failed under the old `max: 10` with
    // no connection timeout at all — it would not error, it would simply never settle.
    const responses = await Promise.all(
      Array.from({ length: 40 }, () => request.get(`/api/projects/${ctx.projectId}/testcases`, { params: { limit: 5 } }))
    );
    for (const res of responses) expect(res.status()).toBe(200);
  });


  test("a burst of dashboard, activity and report loads still leaves a light request answering promptly", async ({ request }) => {
    /*
     * Analytical reads are capped at a quarter of the pool (DatabaseService.heavyQuery), so a few page
     * loads cannot take every connection and leave the ones behind them waiting for a free one. 24 heavy
     * requests are well past that cap; a light read fired in the middle of them must not queue behind all
     * of them, and every one of them must still complete.
     */
    test.setTimeout(120_000);
    const p = `/api/projects/${ctx.projectId}`;
    const heavy = Array.from({ length: 24 }, (_, i) =>
      request.get([`${p}/dashboard`, `${p}/activity`, `${p}/activity/summary`, `${p}/reports/overview`][i % 4], {
        params: i % 4 === 1 ? { limit: 30 } : undefined,
        failOnStatusCode: false,
      }),
    );

    // Fired while the burst is in flight.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const t0 = Date.now();
    const light = await request.get(`${p}/testcases`, { params: { limit: 1 }, failOnStatusCode: false });
    const lightMs = Date.now() - t0;

    const responses = await Promise.all(heavy);
    expect(light.status(), await light.text()).toBe(200);
    expect(lightMs, `a light request took ${lightMs}ms while heavy reads were running`).toBeLessThan(5000);
    for (const [i, res] of responses.entries()) expect(res.status(), `heavy request #${i}: ${await res.text()}`).toBe(200);
  });

  test("a rejected request returns its connection instead of leaking it", { tag: '@tesbo.testId("TES-TC-974")' }, async ({ request }) => {
    // The leak this catches: a failing path that takes a client from the pool and never releases it
    // drains the pool one bad request at a time, and the symptom arrives much later as a hang. 25
    // rejections exceed the pool of 20, so a leak of even one connection per failure exhausts it.
    //
    // The failure has to happen AFTER a query, or it proves nothing about connection release — a
    // handler that validates and throws before touching the database never takes a client at all.
    // A lookup by unknown uuid queries first and 404s on the empty result, which is the shape needed.
    for (let i = 0; i < 25; i++) {
      const res = await request.get(`/api/projects/${ctx.projectId}/testcases/${crypto.randomUUID()}`, {
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(404);
    }

    // If any of those held a connection, this never answers.
    const after = await request.get(`/api/projects/${ctx.projectId}/testcases`, { params: { limit: 5 } });
    expect(after.status()).toBe(200);
  });

  test("concurrent creates in one project all succeed instead of colliding on the generated id", { tag: '@tesbo.testId("TES-TC-975")' }, async ({
    request,
  }) => {
    // Regression for a 500 this file surfaced: nextExternalId reads MAX(n)+1 in a statement separate
    // from the INSERT, so simultaneous creates in the same project allocated the same external id and
    // idx_testcases_project_external rejected all but one. Two testers adding cases at the same
    // moment, a double-clicked Save, or an import overlapping manual entry all hit it.
    //
    // Ten at once against one project, which reliably reproduced it before the retry was added.
    const marker = `E2E transport race ${Date.now()}`;
    const created: string[] = [];
    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          request.post(`/api/projects/${ctx.projectId}/testcases`, {
            data: { title: `${marker} ${i}` },
            failOnStatusCode: false,
          })
        )
      );
      for (const res of results) {
        expect(res.status(), `concurrent create failed: ${res.status()} ${await res.text()}`).toBe(201);
        created.push((await res.json()).id);
      }

      // Every one got a distinct external id — a retry that reused an id would corrupt the sequence
      // just as surely as the original 500 rejected the write.
      const list = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { search: marker, limit: 50 },
      });
      const body = await list.json();
      const rows = Array.isArray(body) ? body : body.rows;
      const externalIds = rows.map((row: { externalId: string }) => row.externalId);
      expect(new Set(externalIds).size).toBe(externalIds.length);
      expect(externalIds).toHaveLength(10);
    } finally {
      for (const id of created) await deleteCase(request, id);
    }
  });

  test("a transactional write still commits and is readable afterwards", { tag: '@tesbo.testId("TES-TC-976")' }, async ({ request }) => {
    // createTestCase runs inside db.transaction(); the pool changes touch how that client is acquired
    // and released, so the commit path needs a witness.
    const title = `E2E transport txn ${Date.now()}`;
    const testcase = await createCase(request, title);
    try {
      const res = await request.get(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`);
      expect(res.ok()).toBeTruthy();
      expect((await res.json()).title).toBe(title);
    } finally {
      await deleteCase(request, testcase.id);
    }
  });
});

/*
 * How long the server holds a connection open between requests.
 *
 * Node defaults `server.keepAliveTimeout` to 5 seconds. Every keep-alive client above this API
 * holds a pooled socket for far longer than that — nginx reuses upstream connections for 60s by
 * default, and so does Playwright's own request context — so the server would send FIN on a socket
 * the client still believed was good. A request written into that socket in the race comes back as
 * ECONNRESET, which surfaces as "socket hang up": no status, no body, nothing to diagnose from,
 * and indistinguishable from a network fault. It lands on whichever request happens to follow a
 * pause, which is why it reads as random.
 *
 * These are transport-level facts about the server, so they are asserted with a raw socket rather
 * than through the request context — the point is what the server does with an idle connection, not
 * what any particular client makes of it.
 */
test.describe("connection keep-alive", () => {
  /** The longest idle any upstream keep-alive client here holds a pooled socket. */
  const UPSTREAM_IDLE_SECONDS = 60;

  test("the server advertises a keep-alive window longer than its clients hold sockets for", { tag: '@tesbo.testId("TES-TC-1212")' }, async ({
    request,
  }) => {
    const res = await request.get(`/api/projects/${ctx.projectId}/testcases`, { params: { limit: 1 } });
    expect(res.status()).toBe(200);
    const keepAlive = res.headers()["keep-alive"] ?? "";
    const timeout = Number(/timeout=(\d+)/.exec(keepAlive)?.[1] ?? 0);
    // Node's 5s default is the value this assertion exists to catch.
    expect(timeout, `the server advertised "${keepAlive}" — Node's 5s default is not survivable`).toBeGreaterThan(
      UPSTREAM_IDLE_SECONDS,
    );
  });

  test("an idle connection is still usable after longer than the old 5s default", { tag: '@tesbo.testId("TES-TC-1213")' }, async () => {
    const net = await import("node:net");
    const url = new URL(env.apiBaseUrl);
    const socket = net.createConnection({
      host: url.hostname,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("error", reject);
      });

      const readResponse = () =>
        new Promise<string>((resolve, reject) => {
          let buffer = "";
          const onData = (chunk: Buffer) => {
            buffer += chunk.toString("utf-8");
            // Headers are all this test reads; the status line is what it asserts on.
            if (buffer.includes("\r\n\r\n")) {
              socket.off("data", onData);
              resolve(buffer);
            }
          };
          socket.on("data", onData);
          socket.once("error", reject);
          socket.once("close", () => reject(new Error("the server closed the idle connection")));
        });

      const send = () =>
        socket.write(`GET /api/health HTTP/1.1\r\nHost: ${url.host}\r\nConnection: keep-alive\r\n\r\n`);

      send();
      expect(await readResponse(), "the first request on a fresh connection failed").toContain("200");

      // Idle past Node's 5s default, then reuse the same socket. Before keepAliveTimeout was raised
      // the server had already sent FIN by now and this write produced the "socket hang up" the
      // suite kept reporting as a network problem.
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      expect(socket.destroyed, "the server dropped the connection while it was idle").toBe(false);

      send();
      expect(await readResponse(), "reusing an idle keep-alive connection failed").toContain("200");
    } finally {
      socket.destroy();
    }
  });
});
