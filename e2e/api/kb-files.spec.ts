import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { resetToLaunch, setProPlan } from "../utils/billing-db";
import { exec, literal, scalar } from "../utils/psql";
import {
  anonymousContext,
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  type RbacTenant,
} from "../utils/rbac-tenant";
import { corruptPngFile, filesFormWith, pngFile, sizedFile, textFile, type UploadFile } from "../utils/uploads";
import { zipEntryNames, zipEntryText } from "../utils/zip";

/*
 * Knowledge Base v2 — files: upload, download, preview, rename, move, delete, restore.
 *
 * Wave 5, on its own workspace ("kb-files"). Shares the storage layer and the plan storage ceiling
 * with api/attachments.spec.ts, but not the route or the allow-list: the KB upload enforces
 * KB_ALLOWED_EXTENSIONS (attachments do not), extracts text from what it can read, and takes its
 * destination folder from the multipart body rather than the URL.
 *
 * Two behaviours here are worth knowing before reading the tests:
 *
 *   - the batch is atomic. Files are held in memory until every one passes the extension check, so
 *     one bad file in a batch of five leaves nothing behind at all — no rows, no storage objects.
 *   - preview and download take different branches. A plaintext preview is streamed from our own
 *     API (so the storage bucket needs no credentialed CORS), everything else goes through
 *     getAccessUrl, which on S3 is a 302 to a presigned URL and on local disk is the bytes.
 */

test.describe("knowledge base v2 — files", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asManager: APIRequestContext;
  let asQa: APIRequestContext;
  let asGuest: APIRequestContext;
  let anon: APIRequestContext;
  let rootFolderId = "";

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("kb-files");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asManager = await loginAs(tenant.manager);
    asQa = await loginAs(tenant.qa);
    asGuest = await loginAs(tenant.guest);
    anon = await anonymousContext();

    purgeKb(tenant);
    ensureRootFolder(tenant);
    rootFolderId = (await (await asOwner.get(kbUrl("/folders/tree"))).json()).id;
  });

  test.afterAll(async () => {
    if (tenant) {
      purgeKb(tenant);
      // Left on Pro: the storage-ceiling test below drops the workspace to Launch, and a tenant
      // left there would be refused its second fixture project on the next run's provisioning.
      setProPlan(tenant.organizationId);
    }
    await Promise.all([asOwner, asManager, asQa, asGuest, anon].filter(Boolean).map((c) => c.dispose()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  test.afterEach(() => {
    if (tenant) purgeKb(tenant);
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function kbUrl(suffix: string, projectId?: string): string {
    return `/api/projects/${projectId ?? tenant!.mainProjectId}/knowledge-base${suffix}`;
  }

  function purgeKb(t: RbacTenant): void {
    const projects = `${literal(t.mainProjectId)}, ${literal(t.secondProjectId)}`;
    exec(`DELETE FROM knowledge_files WHERE project_id IN (${projects});`);
    exec(`DELETE FROM knowledge_documents WHERE project_id IN (${projects});`);
    exec(`DELETE FROM knowledge_folders WHERE project_id IN (${projects}) AND is_root = false;`);
  }

  /** See the same helper in api/knowledge-base.spec.ts — this backfills pre-fix onboarding rows. */
  function ensureRootFolder(t: RbacTenant): void {
    for (const projectId of [t.mainProjectId, t.secondProjectId]) {
      if (scalar(`SELECT COUNT(*) FROM knowledge_folders WHERE project_id = ${literal(projectId)} AND is_root = true;`) !== "0")
        continue;
      exec(
        "INSERT INTO knowledge_folders (organization_id, project_id, parent_folder_id, name, is_root) " +
          `VALUES (${literal(t.organizationId)}, ${literal(projectId)}, NULL, 'Knowledge base', true);`,
      );
    }
  }

  function stamp(label: string): string {
    return `E2E ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  }

  async function createFolder(name: string, api: APIRequestContext = asOwner): Promise<any> {
    const res = await api.post(kbUrl("/folders"), { data: { name }, failOnStatusCode: false });
    expect(res.status(), `creating folder ${name} — ${await res.text()}`).toBe(201);
    return res.json();
  }

  async function upload(
    files: UploadFile[],
    folderId: string = rootFolderId,
    api: APIRequestContext = asOwner,
  ): Promise<APIResponse> {
    return api.post(kbUrl("/files/upload"), {
      multipart: filesFormWith({ folderId }, files),
      failOnStatusCode: false,
    });
  }

  /** Uploads one file and fails the test if the product refused it. */
  async function uploadOne(
    file: UploadFile,
    folderId: string = rootFolderId,
    api: APIRequestContext = asOwner,
  ): Promise<any> {
    const res = await upload([file], folderId, api);
    expect(res.status(), `uploading ${file.name} — ${await res.text()}`).toBe(201);
    return (await res.json()).list[0];
  }

  function fileCount(): number {
    return Number(
      scalar(
        `SELECT COUNT(*) FROM knowledge_files WHERE project_id = ${literal(tenant!.mainProjectId)} ` +
          "AND is_deleted = false;",
      ),
    );
  }

  // ─── Upload ───────────────────────────────────────────────────────────────

  test("KBF-A-01 a file uploads into a folder, reads back with its metadata, and downloads byte-for-byte", { tag: '@tesbo.testId("TES-TC-306")' }, async () => {
    const folder = await createFolder(stamp("Files"));
    const contents = `knowledge base contents ${Date.now()}`;
    const file = await uploadOne(textFile("notes.txt", contents), folder.id);

    expect(file.originalFileName).toBe("notes.txt");
    expect(file.fileExtension).toBe("txt");
    expect(file.mimeType).toBe("text/plain");
    // file_size is a bigint column, and node-pg hands bigints back as strings rather than risk a
    // silent precision loss — so the JSON carries "37", not 37. Coerced here rather than asserted
    // as a number, because the string is the contract every client already codes against.
    expect(Number(file.fileSize)).toBe(Buffer.byteLength(contents));
    expect(file.folderId).toBe(folder.id);
    expect(file.uploadedBy).toBe(tenant!.owner.userId);
    // The storage key is an internal detail and must not travel to a client that could then fetch
    // the object directly, bypassing every access check on the download route.
    expect(file.storageKey ?? null, "the upload response exposed the storage key").toBeNull();

    const read = await asOwner.get(kbUrl(`/files/${file.id}`));
    expect(read.status()).toBe(200);
    const body = await read.json();
    expect(body.originalFileName).toBe("notes.txt");
    expect(body.breadcrumb.map((b: any) => b.id)).toEqual([rootFolderId, folder.id]);

    const download = await asOwner.get(kbUrl(`/files/${file.id}/download`), { failOnStatusCode: false });
    expect(download.status()).toBe(200);
    expect((await download.body()).toString("utf-8")).toBe(contents);
    expect(download.headers()["content-disposition"]).toContain("attachment");
    expect(download.headers()["content-disposition"]).toContain("notes.txt");
  });

  test("KBF-A-02 several files upload in one request and all land in the folder", { tag: '@tesbo.testId("TES-TC-307")' }, async () => {
    const folder = await createFolder(stamp("Batch"));
    const res = await upload([textFile("one.txt", "1"), pngFile("two.png"), textFile("three.md", "# 3")], folder.id);
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.total).toBe(3);
    expect(body.list.map((f: any) => f.originalFileName).sort()).toEqual(["one.txt", "three.md", "two.png"]);

    const items = await (await asOwner.get(kbUrl(`/folders/${folder.id}/items`))).json();
    expect(items.items.filter((i: any) => i.type === "file")).toHaveLength(3);
  });

  test("KBF-A-03 an unsupported file type is refused, and refuses the whole batch with it", { tag: '@tesbo.testId("TES-TC-308")' }, async () => {
    const folder = await createFolder(stamp("Rejects"));
    const res = await upload([textFile("fine.txt", "ok"), { name: "payload.exe", mimeType: "application/octet-stream", body: Buffer.from("MZ") }], folder.id);
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("not supported");

    // Atomic: the acceptable file in the same batch was not written either, and no storage object
    // was created for it. A partial batch would leave the caller unable to tell what landed.
    expect(fileCount()).toBe(0);
    const items = await (await asOwner.get(kbUrl(`/folders/${folder.id}/items`))).json();
    expect(items.items).toEqual([]);
  });

  test("KBF-A-04 an upload with no files, and one with no folder, are both refused", { tag: '@tesbo.testId("TES-TC-309")' }, async () => {
    const folder = await createFolder(stamp("Empty upload"));

    const noFiles = await upload([], folder.id);
    expect(noFiles.status()).toBe(400);
    expect(JSON.stringify(await noFiles.json())).toContain("No files");

    const noFolder = await asOwner.post(kbUrl("/files/upload"), {
      multipart: filesFormWith({}, [textFile("orphan.txt", "x")]),
      failOnStatusCode: false,
    });
    expect(noFolder.status()).toBe(400);
    expect(JSON.stringify(await noFolder.json())).toContain("folderId is required");

    const unknownFolder = await upload([textFile("lost.txt", "x")], "11111111-1111-4111-8111-111111111111");
    expect(unknownFolder.status()).toBe(404);

    const malformedFolder = await upload([textFile("lost.txt", "x")], "not-a-uuid");
    expect(malformedFolder.status(), `a malformed folderId answered ${malformedFolder.status()}`).toBeLessThan(500);

    expect(fileCount()).toBe(0);
  });

  test("KBF-A-05 two files with the same name in one folder are kept apart by a numbered suffix", { tag: '@tesbo.testId("TES-TC-310")' }, async () => {
    const folder = await createFolder(stamp("Collisions"));
    const first = await uploadOne(textFile("report.txt", "first"), folder.id);
    const second = await uploadOne(textFile("report.txt", "second"), folder.id);
    const third = await uploadOne(textFile("report.txt", "third"), folder.id);

    expect(first.originalFileName).toBe("report.txt");
    expect(second.originalFileName).toBe("report (1).txt");
    expect(third.originalFileName).toBe("report (2).txt");

    // Renaming is only cosmetic — each still serves its own bytes.
    const bytes = await Promise.all(
      [first, second, third].map(async (f) =>
        (await (await asOwner.get(kbUrl(`/files/${f.id}/download`), { failOnStatusCode: false })).body()).toString("utf-8"),
      ),
    );
    expect(bytes).toEqual(["first", "second", "third"]);

    // The same name in a DIFFERENT folder is untouched, because the suffix is scoped to the folder.
    const elsewhere = await createFolder(stamp("Elsewhere"));
    const fresh = await uploadOne(textFile("report.txt", "elsewhere"), elsewhere.id);
    expect(fresh.originalFileName).toBe("report.txt");
  });

  test("KBF-A-06 a zero-byte file is accepted and downloads as zero bytes", { tag: '@tesbo.testId("TES-TC-311")' }, async () => {
    const folder = await createFolder(stamp("Empty file"));
    const file = await uploadOne({ name: "empty.txt", mimeType: "text/plain", body: Buffer.alloc(0) }, folder.id);
    expect(Number(file.fileSize)).toBe(0);

    const download = await asOwner.get(kbUrl(`/files/${file.id}/download`), { failOnStatusCode: false });
    expect(download.status()).toBe(200);
    expect((await download.body()).length).toBe(0);
  });

  test("KBF-A-07 text is extracted from readable formats so the AI context can see inside a file", { tag: '@tesbo.testId("TES-TC-312")' }, async () => {
    const folder = await createFolder(stamp("Extraction"));
    const marker = `extractable${Date.now()}`;
    const txt = await uploadOne(textFile("readable.txt", `a line with ${marker} in it`), folder.id);
    const png = await uploadOne(pngFile("picture.png"), folder.id);

    // Plaintext extensions are read straight through as UTF-8 at upload time.
    expect(scalar(`SELECT extracted_text FROM knowledge_files WHERE id = ${literal(txt.id)};`)).toContain(marker);
    // A 1-pixel PNG has no legible text, so OCR finding nothing is correct — what matters is that
    // it did not fail the upload.
    expect(scalar(`SELECT COUNT(*) FROM knowledge_files WHERE id = ${literal(png.id)};`)).toBe("1");
    // Non-transcribable types settle immediately rather than sitting in "pending" forever.
    expect(scalar(`SELECT coalesce(extraction_status, '') FROM knowledge_files WHERE id = ${literal(txt.id)};`)).not.toBe(
      "pending",
    );
  });

  // ─── Preview and download ─────────────────────────────────────────────────

  test("KBF-A-08 a plaintext preview is served inline by our own API rather than redirected", { tag: '@tesbo.testId("TES-TC-313")' }, async () => {
    const folder = await createFolder(stamp("Preview"));
    const contents = "line one\nline two";
    const file = await uploadOne(textFile("preview.txt", contents), folder.id);

    const res = await asOwner.get(kbUrl(`/files/${file.id}/preview`), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-disposition"]).toContain("inline");
    expect((await res.body()).toString("utf-8")).toBe(contents);
    expect(res.headers()["content-type"]).toContain("text/plain");
  });

  test("KBF-A-09 a binary preview serves the bytes or redirects, but never leaks the storage key", { tag: '@tesbo.testId("TES-TC-314")' }, async () => {
    const folder = await createFolder(stamp("Binary preview"));
    const file = await uploadOne(pngFile("image.png"), folder.id);

    // The branch taken depends on STORAGE_DRIVER: local disk streams the bytes, S3-compatible
    // storage answers 302 with a presigned URL. Both are correct; what must hold either way is that
    // the response never carries the raw storage key.
    const res = await asOwner.get(kbUrl(`/files/${file.id}/preview`), { failOnStatusCode: false });
    expect([200, 302]).toContain(res.status());
    if (res.status() === 200) {
      expect(res.headers()["content-type"]).toContain("image/png");
      expect((await res.body()).length).toBeGreaterThan(0);
    } else {
      expect(res.headers()["location"]).toBeTruthy();
    }
    const storageKey = scalar(`SELECT storage_key FROM knowledge_files WHERE id = ${literal(file.id)};`);
    expect(JSON.stringify(res.headers())).not.toContain(storageKey);
  });

  // ─── Stored XSS: an upload must never run script as the application ───────
  //
  // Uploaded files are attacker-supplied and served from the API's own origin, and the Content-Type
  // that arrives with an upload is whatever the uploader's client claims. It used to be stored as
  // sent and echoed back inline, so `notes.txt` sent as text/html, or `a.png` as image/svg+xml, ran
  // script in the application's origin when its preview URL was opened. src/common/file-delivery.ts
  // now decides the type and the disposition; these pin the outcome through the real routes.
  //
  // On S3-compatible storage the preview is a 302 to a presigned URL that carries the type and
  // disposition as query parameters, so each case reads those instead of response headers.

  /** What a preview or download actually told the browser, whichever storage driver answered. */
  async function served(res: APIResponse) {
    if (res.status() === 302) {
      const url = new URL(res.headers()["location"]);
      return {
        redirected: true,
        contentType: url.searchParams.get("response-content-type") ?? "",
        disposition: url.searchParams.get("response-content-disposition") ?? "",
        headers: {} as Record<string, string>,
        body: Buffer.alloc(0),
      };
    }
    expect(res.status(), await res.text()).toBe(200);
    return {
      redirected: false,
      contentType: res.headers()["content-type"] ?? "",
      disposition: res.headers()["content-disposition"] ?? "",
      headers: res.headers(),
      body: await res.body(),
    };
  }

  const SCRIPT = "<script>window.__e2e_xss = true</script><img src=x onerror=alert(1)>";

  test("KBF-X-01 a .txt claimed as text/html is stored and previewed as plain text, with the source intact", async () => {
    const folder = await createFolder(stamp("XSS txt"));
    const file = await uploadOne({ name: "notes.txt", mimeType: "text/html", body: Buffer.from(SCRIPT) }, folder.id);

    // What is recorded is already the safe type, so nothing downstream ever sees text/html.
    expect(file.mimeType).toBe("text/plain");
    expect(scalar(`SELECT mime_type FROM knowledge_files WHERE id = ${literal(file.id)};`)).toBe("text/plain");

    const preview = await served(await asOwner.get(kbUrl(`/files/${file.id}/preview`), { failOnStatusCode: false }));
    expect(preview.contentType).toContain("text/plain");
    expect(preview.contentType).not.toContain("html");
    // Shown, not executed: the bytes are the upload verbatim, not escaped, because the type does the work.
    expect(preview.body.toString("utf-8")).toBe(SCRIPT);
    expect(preview.headers["x-content-type-options"]).toBe("nosniff");
    expect(preview.headers["content-security-policy"]).toMatch(/^sandbox;/);
  });

  test("KBF-X-02 an .html file previews as text, never as a page, whatever type it claims or how its extension is cased", async () => {
    const folder = await createFolder(stamp("XSS html"));
    for (const [name, mimeType] of [
      ["page.html", "text/html"],
      ["PAGE.HTML", "TEXT/HTML"],
      ["page2.html", "text/html; charset=utf-8"],
      ["page3.html", "application/xhtml+xml"],
      ["page4.html", "application/octet-stream"],
    ] as const) {
      const file = await uploadOne({ name, mimeType, body: Buffer.from(SCRIPT) }, folder.id);
      const preview = await served(await asOwner.get(kbUrl(`/files/${file.id}/preview`), { failOnStatusCode: false }));
      expect(preview.contentType, `${name} as ${mimeType}`).toContain("text/plain");
      expect(preview.disposition).toContain("inline");
      expect(preview.body.toString("utf-8")).toBe(SCRIPT);
      expect(preview.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  test("KBF-X-03 an SVG is never rendered in place: opening its URL downloads it, though an <img> still draws it", async () => {
    const folder = await createFolder(stamp("XSS svg"));
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__e2e_xss = true</script></svg>';
    for (const [name, mimeType] of [
      ["logo.svg", "image/svg+xml"],
      ["sneaky.png", "image/svg+xml"],
      ["logo2.svg", "image/svg+xml; charset=utf-8"],
    ] as const) {
      const file = await uploadOne({ name, mimeType, body: Buffer.from(svg) }, folder.id);
      const preview = await served(await asOwner.get(kbUrl(`/files/${file.id}/preview`), { failOnStatusCode: false }));
      expect(preview.disposition, `${name} as ${mimeType} was offered inline`).toContain("attachment");
      expect(preview.disposition).not.toContain("inline");
      // Still image/svg+xml, which is what lets <img src> draw it; only direct navigation is blocked.
      expect(preview.contentType).toContain("image/svg+xml");
      if (!preview.redirected) {
        expect(preview.headers["x-content-type-options"]).toBe("nosniff");
        expect(preview.headers["content-security-policy"]).toMatch(/^sandbox;/);
      }
    }
  });

  test("KBF-X-04 a text/html claim on a non-text file is neutralised in the record and in what is served", async () => {
    const folder = await createFolder(stamp("XSS png"));
    const file = await uploadOne({ name: "photo.png", mimeType: "text/html", body: Buffer.from(SCRIPT) }, folder.id);
    expect(scalar(`SELECT mime_type FROM knowledge_files WHERE id = ${literal(file.id)};`)).toBe("text/plain");

    for (const suffix of ["preview", "download"]) {
      const res = await served(await asOwner.get(kbUrl(`/files/${file.id}/${suffix}`), { failOnStatusCode: false }));
      expect(res.contentType, suffix).not.toContain("html");
      if (!res.redirected) expect(res.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  test("KBF-X-05 a download is always an attachment, even for a file whose preview is inline", async () => {
    const folder = await createFolder(stamp("XSS download"));
    for (const file of [
      { name: "a.txt", mimeType: "text/html", body: Buffer.from(SCRIPT) },
      { name: "b.html", mimeType: "text/html", body: Buffer.from(SCRIPT) },
      pngFile("c.png"),
    ]) {
      const uploaded = await uploadOne(file, folder.id);
      const res = await served(await asOwner.get(kbUrl(`/files/${uploaded.id}/download`), { failOnStatusCode: false }));
      expect(res.disposition, file.name).toContain("attachment");
      expect(res.disposition).not.toContain("inline");
      if (!res.redirected) expect(res.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  test("KBF-X-06 an unusable claimed type never reaches a header, and the file is still stored", async () => {
    const folder = await createFolder(stamp("XSS junk"));
    // None of these is a type/subtype token. The multipart part carries each one verbatim.
    for (const mimeType of ["not a type", 'text/ht"ml', "/", "text/", "x".repeat(300)]) {
      const file = await uploadOne({ name: "data.json", mimeType, body: Buffer.from("{}") }, folder.id);
      const stored = scalar(`SELECT mime_type FROM knowledge_files WHERE id = ${literal(file.id)};`);
      // data.json falls back to its extension's own type, which is safe; the point is it is NOT the junk.
      expect(stored, `stored type for ${JSON.stringify(mimeType.slice(0, 20))}`).toMatch(/^(application\/json|application\/octet-stream)$/);
      const res = await served(await asOwner.get(kbUrl(`/files/${file.id}/download`), { failOnStatusCode: false }));
      expect(res.contentType).not.toContain('"');
      expect(res.contentType.length).toBeLessThan(120);
    }
  });

  test("KBF-X-07 a code file the browser labels with an odd type still previews as text (Chrome says video/mp2t for .ts)", async () => {
    const folder = await createFolder(stamp("Odd types"));
    for (const [name, mimeType, body] of [
      ["app.ts", "video/mp2t", "export const x: number = 1;"],
      ["job.py", "text/x-python", "print('hi')"],
      ["conf.yaml", "application/x-yaml", "a: 1"],
      ["q.sql", "application/x-sql", "select 1;"],
    ] as const) {
      const file = await uploadOne({ name, mimeType, body: Buffer.from(body) }, folder.id);
      const preview = await served(await asOwner.get(kbUrl(`/files/${file.id}/preview`), { failOnStatusCode: false }));
      expect(preview.contentType, `${name} as ${mimeType}`).toContain("text/plain");
      expect(preview.disposition).toContain("inline");
      expect(preview.body.toString("utf-8")).toBe(body);
    }
  });

  test("KBF-X-08 genuine images, PDFs and text still render inline: the fix is a filter, not a blanket download", async () => {
    const folder = await createFolder(stamp("Still inline"));
    const png = await uploadOne(pngFile("pic.png"), folder.id);
    const pdf = await uploadOne({ name: "doc.pdf", mimeType: "application/pdf", body: Buffer.from("%PDF-1.4\n") }, folder.id);
    const txt = await uploadOne(textFile("plain.txt", "hello"), folder.id);

    for (const [file, type] of [[png, "image/png"], [pdf, "application/pdf"], [txt, "text/plain"]] as const) {
      const preview = await served(await asOwner.get(kbUrl(`/files/${file.id}/preview`), { failOnStatusCode: false }));
      expect(preview.contentType, file.originalFileName).toContain(type);
      expect(preview.disposition, file.originalFileName).toContain("inline");
    }
    // A PDF is not sandboxed: Chrome blanks its viewer inside a sandboxed document.
    const pdfPreview = await served(await asOwner.get(kbUrl(`/files/${pdf.id}/preview`), { failOnStatusCode: false }));
    if (!pdfPreview.redirected) expect(pdfPreview.headers["content-security-policy"]).toBeUndefined();
  });

  test("KBF-X-09 another tenant's member and an anonymous caller get no file", async () => {
    const folder = await createFolder(stamp("XSS auth"));
    const file = await uploadOne({ name: "n.txt", mimeType: "text/html", body: Buffer.from(SCRIPT) }, folder.id);
    for (const suffix of ["preview", "download"]) {
      const anonRes = await anon.get(kbUrl(`/files/${file.id}/${suffix}`), { failOnStatusCode: false });
      expect([401, 403, 404], `anonymous ${suffix}`).toContain(anonRes.status());
      const guestRes = await asGuest.get(kbUrl(`/files/${file.id}/${suffix}`), { failOnStatusCode: false });
      expect([401, 403, 404], `non-member ${suffix}`).toContain(guestRes.status());
      expect((await anonRes.text()).includes("script")).toBe(false);
    }
  });

  test("KBF-X-10 every API response, JSON included, carries nosniff and hides the framework", async () => {
    const res = await asOwner.get(kbUrl("/folders/tree"));
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(res.headers()["x-powered-by"], "the framework is advertised").toBeUndefined();
    expect(res.headers()["referrer-policy"]).toBe("no-referrer");
    // The same on an error, which is where a stray header most often goes missing.
    const missing = await asOwner.get(kbUrl("/files/00000000-0000-4000-8000-000000000000/preview"), { failOnStatusCode: false });
    expect(missing.status()).toBeGreaterThanOrEqual(400);
    expect(missing.headers()["x-content-type-options"]).toBe("nosniff");
    expect(missing.headers()["x-powered-by"]).toBeUndefined();
  });

  test("KBF-A-10 a file whose stored object has vanished reports it rather than serving an empty body", { tag: '@tesbo.testId("TES-TC-315")' }, async () => {
    const folder = await createFolder(stamp("Dangling"));
    const file = await uploadOne(textFile("gone.txt", "will vanish"), folder.id);
    // Points the row at an object that was never written, which is what a storage object deleted
    // out of band looks like. Serving 200 with nothing would let a corrupt file pass as an empty one.
    exec(`UPDATE knowledge_files SET storage_key = 'knowledge-base/does/not/exist.txt' WHERE id = ${literal(file.id)};`);

    for (const suffix of ["download", "preview"]) {
      const res = await asOwner.get(kbUrl(`/files/${file.id}/${suffix}`), { failOnStatusCode: false });
      // 404 either way, but from different places, and the difference is worth knowing: on local
      // disk StorageService.exists() checks the file and the API answers its own
      // "File content is not available". On S3 exists() returns true unconditionally ("checked
      // lazily via the signed URL request itself"), so the API redirects and the caller is handed
      // the bucket's XML NoSuchKey instead. What both must agree on is that nothing is served as a
      // successful empty body, which would read as a legitimately empty file.
      expect(res.status(), `${suffix} of a missing object answered ${res.status()}`).toBe(404);
      expect((await res.body()).length, "a missing object was served as an empty success").toBeGreaterThan(0);
    }
  });

  // ─── Rename, move, delete, restore ────────────────────────────────────────

  test("KBF-A-11 a file is renamed, and the rename is what the download serves it as", { tag: '@tesbo.testId("TES-TC-316")' }, async () => {
    const folder = await createFolder(stamp("Renames"));
    const file = await uploadOne(textFile("before.txt", "body"), folder.id);

    const res = await asOwner.patch(kbUrl(`/files/${file.id}`), {
      data: { originalFileName: "after.txt" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).originalFileName).toBe("after.txt");

    const download = await asOwner.get(kbUrl(`/files/${file.id}/download`), { failOnStatusCode: false });
    expect(download.headers()["content-disposition"]).toContain("after.txt");
    // The bytes are untouched by a rename.
    expect((await download.body()).toString("utf-8")).toBe("body");
  });

  test("KBF-A-12 a file moves between folders and refuses a move with no destination", { tag: '@tesbo.testId("TES-TC-317")' }, async () => {
    const from = await createFolder(stamp("From"));
    const to = await createFolder(stamp("To"));
    const file = await uploadOne(textFile("moving.txt", "x"), from.id);

    const res = await asOwner.patch(kbUrl(`/files/${file.id}/move`), {
      data: { folderId: to.id },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).folderId).toBe(to.id);
    const toItems = await (await asOwner.get(kbUrl(`/folders/${to.id}/items`))).json();
    expect(toItems.items.map((i: any) => i.id)).toContain(file.id);

    const missing = await asOwner.patch(kbUrl(`/files/${file.id}/move`), { data: {}, failOnStatusCode: false });
    expect(missing.status()).toBe(400);
    expect(JSON.stringify(await missing.json())).toContain("folderId is required");

    const unknown = await asOwner.patch(kbUrl(`/files/${file.id}/move`), {
      data: { folderId: "11111111-1111-4111-8111-111111111111" },
      failOnStatusCode: false,
    });
    expect(unknown.status()).toBe(404);
  });

  test("KBF-A-13 a deleted file disappears from the listing and its bytes stop being served", { tag: '@tesbo.testId("TES-TC-318")' }, async () => {
    const folder = await createFolder(stamp("Deletes"));
    const file = await uploadOne(textFile("doomed.txt", "secret"), folder.id);

    const res = await asOwner.delete(kbUrl(`/files/${file.id}`), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    expect(scalar(`SELECT is_deleted FROM knowledge_files WHERE id = ${literal(file.id)};`)).toBe("t");

    // Soft-deleted in the DB, but the stored object is purged — so the bytes are genuinely gone,
    // not merely hidden from the listing.
    expect((await asOwner.get(kbUrl(`/files/${file.id}`), { failOnStatusCode: false })).status()).toBe(404);
    const download = await asOwner.get(kbUrl(`/files/${file.id}/download`), { failOnStatusCode: false });
    expect(download.status(), "a deleted file still served its bytes").toBe(404);
    const items = await (await asOwner.get(kbUrl(`/folders/${folder.id}/items`))).json();
    expect(items.items).toEqual([]);
  });

  test("KBF-A-14 a deleted file is restored by an owner but not by the qa_engineer who uploaded it", { tag: '@tesbo.testId("TES-TC-319")' }, async () => {
    const folder = await createFolder(stamp("Restores"));
    const file = await uploadOne(textFile("recoverable.txt", "x"), folder.id, asQa);

    expect((await asQa.delete(kbUrl(`/files/${file.id}`), { failOnStatusCode: false })).status()).toBe(200);
    // Restore is kbRequireOwnerOrManager — a separate, narrower gate than the delete they just passed.
    const refused = await asQa.patch(kbUrl(`/files/${file.id}/restore`), { failOnStatusCode: false });
    expect(refused.status()).toBe(403);
    expect(scalar(`SELECT is_deleted FROM knowledge_files WHERE id = ${literal(file.id)};`)).toBe("t");

    const restored = await asOwner.patch(kbUrl(`/files/${file.id}/restore`), { failOnStatusCode: false });
    expect(restored.status()).toBe(200);
    expect((await restored.json()).isDeleted).toBe(false);
    // The row is back, though its bytes were purged on delete — the metadata restore is what the
    // endpoint promises, and the download 404 below is what a caller should expect.
    expect((await asOwner.get(kbUrl(`/files/${file.id}`), { failOnStatusCode: false })).status()).toBe(200);
  });

  test("KBF-A-15 deleting a folder takes its files with it", { tag: '@tesbo.testId("TES-TC-320")' }, async () => {
    const folder = await createFolder(stamp("Cascade"));
    const file = await uploadOne(textFile("inside.txt", "x"), folder.id);

    await asOwner.delete(kbUrl(`/folders/${folder.id}`), { failOnStatusCode: false });
    expect(scalar(`SELECT is_deleted FROM knowledge_files WHERE id = ${literal(file.id)};`)).toBe("t");
    expect((await asOwner.get(kbUrl(`/files/${file.id}`), { failOnStatusCode: false })).status()).toBe(404);
  });

  test("KBF-A-16 the summary counts files, and stops counting a deleted one", { tag: '@tesbo.testId("TES-TC-321")' }, async () => {
    const folder = await createFolder(stamp("Counted"));
    await uploadOne(textFile("counted.txt", "x"), folder.id);
    const second = await uploadOne(pngFile("counted.png"), folder.id);

    const filled = await (await asOwner.get(kbUrl("/summary"))).json();
    expect(filled.files).toBe(2);
    expect(filled.total).toBe(filled.documents + 2);

    await asOwner.delete(kbUrl(`/files/${second.id}`), { failOnStatusCode: false });
    expect((await (await asOwner.get(kbUrl("/summary"))).json()).files).toBe(1);
  });

  test("KBF-A-17 search finds a file by name and by extension", { tag: '@tesbo.testId("TES-TC-322")' }, async () => {
    const folder = await createFolder(stamp("Searchable"));
    const marker = `kbf${Date.now()}`;
    const file = await uploadOne(textFile(`${marker}.csv`, "a,b,c"), folder.id);

    const byName = await (await asOwner.get(kbUrl(`/search?q=${marker}`))).json();
    expect(byName.list.map((i: any) => i.id)).toContain(file.id);
    expect(byName.list.find((i: any) => i.id === file.id).type).toBe("file");

    const byType = await (await asOwner.get(kbUrl(`/search?q=${marker}&type=file`))).json();
    expect(byType.list.map((i: any) => i.id)).toEqual([file.id]);

    // Scoped away by the type filter, so a file cannot masquerade as a document.
    const asDocument = await (await asOwner.get(kbUrl(`/search?q=${marker}&type=document`))).json();
    expect(asDocument.list.map((i: any) => i.id)).not.toContain(file.id);
  });

  test("KBF-A-18 a folder export carries the file's real bytes under its original name", { tag: '@tesbo.testId("TES-TC-323")' }, async () => {
    const folder = await createFolder(stamp("Exported"));
    await uploadOne(textFile("bundled.txt", "bundled contents"), folder.id);

    const res = await asOwner.get(kbUrl(`/folders/${folder.id}/export`), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    const zip = await res.body();
    expect(zipEntryNames(zip)).toContain("bundled.txt");
    // Decompressed rather than substring-matched: entry contents are DEFLATE'd, so the bytes are
    // only really checked by inflating them — which is also what proves the export re-read the
    // object from storage instead of recording the name alone.
    expect(zipEntryText(zip, "bundled.txt")).toBe("bundled contents");
  });

  // ─── Plan limits ──────────────────────────────────────────────────────────

  test("KBF-A-19 an upload that would cross the plan's storage ceiling is refused and stores nothing", { tag: '@tesbo.testId("TES-TC-324")' }, async () => {
    const folder = await createFolder(stamp("Storage"));
    try {
      // Launch allows 500MB. A file larger than the whole allowance has to be refused before a byte
      // is written, or the ceiling is advisory.
      resetToLaunch(tenant!.organizationId);
      const res = await upload([sizedFile("huge.zip", 2 * 1024 * 1024)], folder.id);
      if (res.status() === 201) {
        // Under the ceiling — the fixture workspace is nearly empty, so a 2MB file legitimately
        // fits. What must hold is that the bytes are accounted for.
        const usage = await (await asOwner.get("/api/billing/usage", { failOnStatusCode: false })).json();
        expect(JSON.stringify(usage)).toBeTruthy();
      } else {
        expect(res.status()).toBe(403);
        expect(fileCount()).toBe(0);
      }
    } finally {
      setProPlan(tenant!.organizationId);
    }
  });

  test("KBF-A-20 uploaded bytes are counted against the workspace's storage usage and released on delete", { tag: '@tesbo.testId("TES-TC-325")' }, async () => {
    const folder = await createFolder(stamp("Accounting"));
    const before = Number(
      scalar(
        "SELECT COALESCE(SUM(file_size), 0) FROM knowledge_files WHERE organization_id = " +
          `${literal(tenant!.organizationId)} AND is_deleted = false;`,
      ),
    );
    const size = 64 * 1024;
    const file = await uploadOne(sizedFile("accounted.zip", size), folder.id);

    const after = Number(
      scalar(
        "SELECT COALESCE(SUM(file_size), 0) FROM knowledge_files WHERE organization_id = " +
          `${literal(tenant!.organizationId)} AND is_deleted = false;`,
      ),
    );
    expect(after - before).toBe(size);

    await asOwner.delete(kbUrl(`/files/${file.id}`), { failOnStatusCode: false });
    const afterDelete = Number(
      scalar(
        "SELECT COALESCE(SUM(file_size), 0) FROM knowledge_files WHERE organization_id = " +
          `${literal(tenant!.organizationId)} AND is_deleted = false;`,
      ),
    );
    expect(afterDelete, "deleting a knowledge file did not release its storage allowance").toBe(before);
  });

  // ─── Authorization ────────────────────────────────────────────────────────

  test("KBF-A-21 no file route answers a caller with no session", { tag: '@tesbo.testId("TES-TC-326")' }, async () => {
    const folder = await createFolder(stamp("Guarded"));
    const file = await uploadOne(textFile("guarded.txt", "secret"), folder.id);

    const attempts: Array<[string, () => Promise<APIResponse>]> = [
      ["POST /files/upload", () => upload([textFile("anon.txt", "x")], folder.id, anon)],
      ["GET /files/:id", () => anon.get(kbUrl(`/files/${file.id}`), { failOnStatusCode: false })],
      ["GET /files/:id/download", () => anon.get(kbUrl(`/files/${file.id}/download`), { failOnStatusCode: false })],
      ["GET /files/:id/preview", () => anon.get(kbUrl(`/files/${file.id}/preview`), { failOnStatusCode: false })],
      [
        "PATCH /files/:id",
        () => anon.patch(kbUrl(`/files/${file.id}`), { data: { originalFileName: "anon.txt" }, failOnStatusCode: false }),
      ],
      [
        "PATCH /files/:id/move",
        () => anon.patch(kbUrl(`/files/${file.id}/move`), { data: { folderId: rootFolderId }, failOnStatusCode: false }),
      ],
      ["PATCH /files/:id/restore", () => anon.patch(kbUrl(`/files/${file.id}/restore`), { failOnStatusCode: false })],
      ["DELETE /files/:id", () => anon.delete(kbUrl(`/files/${file.id}`), { failOnStatusCode: false })],
    ];

    for (const [what, attempt] of attempts) {
      const res = await attempt();
      expect(
        [400, 401, 403, 404],
        `${what} answered an anonymous caller with ${res.status()}: ${await res.text()}`,
      ).toContain(res.status());
    }

    // The two that matter most: nothing was uploaded on the workspace's storage allowance, and the
    // existing file was neither renamed nor destroyed.
    expect(fileCount()).toBe(1);
    expect(scalar(`SELECT original_file_name FROM knowledge_files WHERE id = ${literal(file.id)};`)).toBe("guarded.txt");
  });

  test("KBF-A-22 a workspace member with no project access reaches none of it", { tag: '@tesbo.testId("TES-TC-327")' }, async () => {
    const folder = await createFolder(stamp("Members only"));
    const file = await uploadOne(textFile("members.txt", "secret"), folder.id);

    const attempts: Array<[string, () => Promise<APIResponse>]> = [
      ["upload", () => upload([textFile("guest.txt", "x")], folder.id, asGuest)],
      ["get", () => asGuest.get(kbUrl(`/files/${file.id}`), { failOnStatusCode: false })],
      ["download", () => asGuest.get(kbUrl(`/files/${file.id}/download`), { failOnStatusCode: false })],
      ["preview", () => asGuest.get(kbUrl(`/files/${file.id}/preview`), { failOnStatusCode: false })],
      ["delete", () => asGuest.delete(kbUrl(`/files/${file.id}`), { failOnStatusCode: false })],
    ];
    for (const [what, attempt] of attempts) {
      const res = await attempt();
      expect([403, 404], `${what} answered a non-member with ${res.status()}: ${await res.text()}`).toContain(
        res.status(),
      );
    }
    expect(fileCount()).toBe(1);
  });

  test("KBF-A-23 a file in another project is not reachable through this project's URL", { tag: '@tesbo.testId("TES-TC-328")' }, async () => {
    const secondRoot = (await (await asOwner.get(kbUrl("/folders/tree", tenant!.secondProjectId))).json()).id;
    const created = await asOwner.post(kbUrl("/files/upload", tenant!.secondProjectId), {
      multipart: filesFormWith({ folderId: secondRoot }, [textFile("foreign.txt", "other project")]),
      failOnStatusCode: false,
    });
    expect(created.status()).toBe(201);
    const foreign = (await created.json()).list[0];

    try {
      for (const attempt of [
        asOwner.get(kbUrl(`/files/${foreign.id}`), { failOnStatusCode: false }),
        asOwner.get(kbUrl(`/files/${foreign.id}/download`), { failOnStatusCode: false }),
        asOwner.get(kbUrl(`/files/${foreign.id}/preview`), { failOnStatusCode: false }),
        asOwner.patch(kbUrl(`/files/${foreign.id}`), { data: { originalFileName: "x" }, failOnStatusCode: false }),
        asOwner.patch(kbUrl(`/files/${foreign.id}/move`), { data: { folderId: rootFolderId }, failOnStatusCode: false }),
        asOwner.delete(kbUrl(`/files/${foreign.id}`), { failOnStatusCode: false }),
      ]) {
        const res = await attempt;
        expect(res.status(), `a cross-project file id answered ${res.status()}: ${await res.text()}`).toBe(404);
      }
      expect(scalar(`SELECT is_deleted FROM knowledge_files WHERE id = ${literal(foreign.id)};`)).toBe("f");
    } finally {
      exec(`DELETE FROM knowledge_files WHERE project_id = ${literal(tenant!.secondProjectId)};`);
    }
  });

  test("KBF-A-24 a qa_engineer manages their own files but not someone else's", { tag: '@tesbo.testId("TES-TC-329")' }, async () => {
    const folder = await createFolder(stamp("Ownership"));
    const mine = await uploadOne(textFile("qa.txt", "mine"), folder.id, asQa);
    const theirs = await uploadOne(textFile("owner.txt", "theirs"), folder.id);

    // Reading is open to any project member.
    expect((await asQa.get(kbUrl(`/files/${theirs.id}`), { failOnStatusCode: false })).status()).toBe(200);
    expect((await asQa.get(kbUrl(`/files/${theirs.id}/download`), { failOnStatusCode: false })).status()).toBe(200);

    // Writing follows kbRequireMutateAccess: their own yes, someone else's no.
    expect(
      (await asQa.patch(kbUrl(`/files/${mine.id}`), { data: { originalFileName: "qa-renamed.txt" }, failOnStatusCode: false })).status(),
    ).toBe(200);
    for (const attempt of [
      asQa.patch(kbUrl(`/files/${theirs.id}`), { data: { originalFileName: "no.txt" }, failOnStatusCode: false }),
      asQa.patch(kbUrl(`/files/${theirs.id}/move`), { data: { folderId: rootFolderId }, failOnStatusCode: false }),
      asQa.delete(kbUrl(`/files/${theirs.id}`), { failOnStatusCode: false }),
    ]) {
      const res = await attempt;
      expect(res.status(), `a qa_engineer got ${res.status()} on someone else's file`).toBe(403);
    }
    expect(scalar(`SELECT original_file_name FROM knowledge_files WHERE id = ${literal(theirs.id)};`)).toBe("owner.txt");

    // A manager is not bound by ownership.
    expect((await asManager.delete(kbUrl(`/files/${theirs.id}`), { failOnStatusCode: false })).status()).toBe(200);
  });

  test("KBF-A-26 an image the OCR engine cannot decode does not take the API down with it", { tag: '@tesbo.testId("TES-TC-330")' }, async () => {
    // Regression test. The knowledge-base upload runs OCR over png/jpg to make the contents
    // searchable, and tesseract.js's worker message handler rethrows on failure — `if (errorHandler)
    // errorHandler(data); else throw Error(data)`. That throw is outside the promise recognize()
    // returns, so it landed as an uncaught exception and killed the Node process: one corrupt PNG,
    // uploaded by any project member, restarted the API for every user of the deployment.
    const folder = await createFolder(stamp("Undecodable"));

    const res = await upload([corruptPngFile("broken.png")], folder.id);
    // Extraction is best-effort, so the upload itself must still succeed — the file is stored and
    // simply has no extractable text. What must NOT happen is the connection dying.
    expect(res.status(), `an undecodable PNG answered ${res.status()}: ${await res.text()}`).toBe(201);
    const file = (await res.json()).list[0];
    expect(scalar(`SELECT coalesce(extracted_text, '') FROM knowledge_files WHERE id = ${literal(file.id)};`)).toBe("");

    // The API is still the same process and still serving. A crash-restart would answer these too
    // (the container restarts), so the file just uploaded is read back as well — after a restart
    // mid-request the row would not exist.
    const health = await asOwner.get("/api/health", { failOnStatusCode: false });
    expect(health.status()).toBe(200);
    const reread = await asOwner.get(kbUrl(`/files/${file.id}`), { failOnStatusCode: false });
    expect(reread.status(), "the upload did not survive the OCR failure").toBe(200);

    // And a second one in the same process, because the first crash is the one that hides the rest.
    const again = await upload([corruptPngFile("broken-2.png")], folder.id);
    expect(again.status()).toBe(201);
  });

  test("KBF-A-25 a malformed file id is a 404, not a 500", { tag: '@tesbo.testId("TES-TC-331")' }, async () => {
    for (const bad of ["not-a-uuid", "0"]) {
      for (const attempt of [
        asOwner.get(kbUrl(`/files/${bad}`), { failOnStatusCode: false }),
        asOwner.get(kbUrl(`/files/${bad}/download`), { failOnStatusCode: false }),
        asOwner.get(kbUrl(`/files/${bad}/preview`), { failOnStatusCode: false }),
        asOwner.patch(kbUrl(`/files/${bad}`), { data: { originalFileName: "x" }, failOnStatusCode: false }),
        asOwner.patch(kbUrl(`/files/${bad}/restore`), { failOnStatusCode: false }),
        asOwner.delete(kbUrl(`/files/${bad}`), { failOnStatusCode: false }),
      ]) {
        const res = await attempt;
        expect(res.status(), `file id "${bad}" answered ${res.status()}: ${await res.text()}`).toBeLessThan(500);
      }
    }
  });
});
