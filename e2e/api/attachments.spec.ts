import { expect, test, type APIRequestContext } from "@playwright/test";
import { resetToLaunch, setProPlan } from "../utils/billing-db";
import { testAddress } from "../utils/env";
import { exec, literal, scalar } from "../utils/psql";
import {
  anonymousContext,
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  seedFixtureUser,
  type RbacTenant,
} from "../utils/rbac-tenant";
import { filesForm, pngFile, sizedFile, textFile, type UploadFile } from "../utils/uploads";

/*
 * Attachment evidence on executions and bugs: upload, list, download, delete, and the storage
 * allowance that governs all of it.
 *
 * Both uploads share one `attachments` table (entity_type 'execution' | 'bug') and one storage
 * abstraction (local disk by default, S3 when STORAGE_DRIVER=s3), and both count toward the
 * workspace's plan storage limit — so this file covers the accounting as well as the round trip.
 *
 * Runs against its own disposable workspace ("attachments"): the storage-limit cases rewrite the
 * workspace's plan and fake its usage, which no shared account can absorb.
 *
 * On the storage-limit technique: filling 500MB for real would mean pushing half a gigabyte through
 * HTTP per run. assertStorageAvailable sums attachments.file_size, so instead a synthetic row claims
 * the space and the real guard is then exercised with a small upload — the same "write the state the
 * enforcement logic reads" approach the billing suites use.
 */

const LAUNCH_LIMIT_BYTES = 500 * 1024 * 1024;

/*
 * LegacyService.EVIDENCE_MAX_FILE_SIZE — the per-file ceiling for bug and execution evidence,
 * separate from (and well under) the 100MB MAX_UPLOAD_SIZE the knowledge base uses. Hardcoded here
 * the way LAUNCH_LIMIT_BYTES is: if MAX_EVIDENCE_FILE_SIZE is ever set to something else in the
 * environment under test, these two boundary cases are the ones that should fail and say so.
 */
const EVIDENCE_MAX_BYTES = 25 * 1024 * 1024;

test.describe("attachments", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asQa: APIRequestContext;
  let asGuest: APIRequestContext;
  let anon: APIRequestContext;

  /** Fixtures every test uploads against, created once. */
  let cycleId: string;
  let executionId: string;
  let bugId: string;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("attachments");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asQa = await loginAs(tenant.qa);
    asGuest = await loginAs(tenant.guest);
    anon = await anonymousContext();

    const suffix = Date.now();
    const testcase = await (
      await asOwner.post(`/api/projects/${tenant.mainProjectId}/testcases`, {
        data: { title: `E2E Attachment Case ${suffix}` },
      })
    ).json();
    const cycle = await (
      await asOwner.post(`/api/projects/${tenant.mainProjectId}/cycles`, {
        data: { name: `E2E Attachment Run ${suffix}` },
      })
    ).json();
    cycleId = cycle.id;
    await asOwner.post(`/api/cycles/${cycleId}/testcases`, { data: { testcaseIds: [testcase.id] } });
    const executions = await (await asOwner.get(`/api/cycles/${cycleId}/executions`)).json();
    executionId = executions[0].id;

    const bug = await (
      await asOwner.post(`/api/projects/${tenant.mainProjectId}/bugs`, {
        data: { title: `E2E Attachment Bug ${suffix}`, severity: "Medium" },
      })
    ).json();
    bugId = bug.id;
  });

  test.afterAll(async () => {
    if (tenant) {
      // Leave the workspace on Pro: the limit tests flip it to Launch, and a tenant left on Launch
      // would refuse the second fixture project on the next run's provisioning.
      setProPlan(tenant.organizationId);
      purgeAttachments(tenant);
      if (cycleId) await asOwner.delete(`/api/cycles/${cycleId}`, { failOnStatusCode: false });
      if (bugId) await asOwner.delete(`/api/bugs/${bugId}`, { failOnStatusCode: false });
    }
    await Promise.all([asOwner, asQa, asGuest, anon].filter(Boolean).map((ctx) => ctx.dispose()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  test.afterEach(() => {
    // Teardown goes through Postgres, not the delete endpoint: that endpoint is itself under test
    // here, and a test that proves it's broken must not also depend on it to clean up.
    if (tenant) purgeAttachments(tenant);
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function executionUploadUrl(): string {
    return `/api/cycles/${cycleId}/executions/${executionId}/attachments`;
  }

  function bugUploadUrl(): string {
    return `/api/projects/${tenant!.mainProjectId}/bugs/${bugId}/attachments`;
  }

  async function upload(
    api: APIRequestContext,
    url: string,
    files: UploadFile[],
  ): Promise<import("@playwright/test").APIResponse> {
    return api.post(url, { multipart: filesForm(files), failOnStatusCode: false });
  }

  /** Every attachment row in this workspace, newest last. */
  function attachmentRows(t: RbacTenant): { id: string; fileSize: number; storagePath: string }[] {
    const raw = scalar(
      `SELECT COALESCE(string_agg(a.id || '|' || a.file_size || '|' || COALESCE(a.storage_path, ''), E'\\n' ORDER BY a.created_at), '') ` +
        `FROM attachments a JOIN projects p ON p.id = a.project_id ` +
        `WHERE p.organization_id = ${literal(t.organizationId)};`,
    );
    if (!raw) return [];
    return raw.split("\n").map((line) => {
      const [id, fileSize, storagePath] = line.split("|");
      return { id, fileSize: Number(fileSize), storagePath };
    });
  }

  function purgeAttachments(t: RbacTenant): void {
    exec(
      `DELETE FROM attachments WHERE project_id IN (SELECT id FROM projects WHERE organization_id = ${literal(t.organizationId)});`,
    );
  }

  /** Claims `bytes` of the workspace's allowance without moving any real data. */
  function claimStorage(t: RbacTenant, bytes: number): void {
    exec(
      `INSERT INTO attachments (project_id, entity_type, entity_id, file_name, content_type, file_size, storage_path, uploaded_by) ` +
        `VALUES (${literal(t.mainProjectId)}, 'bug', ${literal(bugId)}, 'e2e-synthetic-usage.bin', ` +
        `'application/octet-stream', ${bytes}, 'e2e/synthetic/usage.bin', ${literal(t.owner.userId)});`,
    );
  }

  async function reportedStorageBytes(): Promise<number> {
    const usage = await (await asOwner.get("/api/billing/usage")).json();
    return Number(usage.storageUsedBytes ?? usage.storage?.usedBytes ?? 0);
  }

  // ─── The round trip ────────────────────────────────────────────────────────

  test("an execution attachment uploads and appears in its list", { tag: '@tesbo.testId("TES-TC-17")' }, async () => {
    const file = pngFile(`evidence-${Date.now()}.png`);
    const res = await upload(asQa, executionUploadUrl(), [file]);
    expect(res.ok(), `upload failed: ${res.status()} ${await res.text()}`).toBeTruthy();

    const listed = await (await asOwner.get(executionUploadUrl())).json();
    expect(listed.total).toBe(1);
    const [attachment] = listed.list;
    expect(attachment.fileName).toBe(file.name);
    expect(attachment.contentType).toBe("image/png");
    expect(Number(attachment.fileSize)).toBe(file.body.length);
    // The row is scoped to this execution, not just to the project.
    expect(attachment.entityType).toBe("execution");
    expect(attachment.entityId).toBe(executionId);
  });

  test("a bug attachment uploads, downloads byte-for-byte, and deletes", { tag: '@tesbo.testId("TES-TC-4")' }, async () => {
    const file = textFile(`report-${Date.now()}.txt`, "the exact bytes that must come back");
    const res = await upload(asQa, bugUploadUrl(), [file]);
    expect(res.ok(), `upload failed: ${res.status()} ${await res.text()}`).toBeTruthy();

    const rows = attachmentRows(tenant!);
    expect(rows).toHaveLength(1);
    const attachmentId = rows[0].id;

    const download = await asOwner.get(
      `/api/projects/${tenant!.mainProjectId}/bugs/attachments/${attachmentId}/download`,
      { failOnStatusCode: false },
    );
    expect(download.ok(), `download failed: ${download.status()}`).toBeTruthy();
    expect(Buffer.from(await download.body()).equals(file.body)).toBeTruthy();
    expect(download.headers()["content-type"]).toContain("text/plain");
    // Evidence must arrive as a download, never rendered in the tab — see the .html case below.
    expect(download.headers()["content-disposition"]).toContain("attachment");

    const deleted = await asOwner.delete(`/api/bugs/attachments/${attachmentId}`, {
      failOnStatusCode: false,
    });
    expect(deleted.ok()).toBeTruthy();
    expect(attachmentRows(tenant!)).toHaveLength(0);

    const gone = await asOwner.get(
      `/api/projects/${tenant!.mainProjectId}/bugs/attachments/${attachmentId}/download`,
      { failOnStatusCode: false },
    );
    expect(gone.status()).toBe(404);
  });

  test("several files upload in one request", { tag: '@tesbo.testId("TES-TC-1")' }, async () => {
    const suffix = Date.now();
    const files = [pngFile(`a-${suffix}.png`), textFile(`b-${suffix}.txt`), pngFile(`c-${suffix}.png`)];
    const res = await upload(asQa, executionUploadUrl(), files);
    expect(res.ok(), `upload failed: ${res.status()} ${await res.text()}`).toBeTruthy();

    const listed = await (await asOwner.get(executionUploadUrl())).json();
    expect(listed.total).toBe(3);
    expect(listed.list.map((a: any) => a.fileName).sort()).toEqual(files.map((f) => f.name).sort());
  });

  test("the ten-file cap is enforced, and ten exactly is allowed", { tag: '@tesbo.testId("TES-TC-16")' }, async () => {
    const suffix = Date.now();
    const ten = Array.from({ length: 10 }, (_, i) => textFile(`ten-${suffix}-${i}.txt`));
    const atCap = await upload(asQa, executionUploadUrl(), ten);
    expect(atCap.ok(), `ten files should be accepted: ${atCap.status()} ${await atCap.text()}`).toBeTruthy();
    expect((await (await asOwner.get(executionUploadUrl())).json()).total).toBe(10);

    purgeAttachments(tenant!);

    const eleven = Array.from({ length: 11 }, (_, i) => textFile(`eleven-${suffix}-${i}.txt`));
    const overCap = await upload(asQa, executionUploadUrl(), eleven);
    expect(overCap.ok(), "eleven files should be refused").toBeFalsy();
    expect(overCap.status(), "the cap should be a clean rejection, not a 500").toBeLessThan(500);
    // Nothing partial: a refused batch must not leave the first ten behind.
    expect(attachmentRows(tenant!)).toHaveLength(0);
  });

  test("a request with no files is refused", { tag: '@tesbo.testId("TES-TC-56")' }, async () => {
    for (const api of [asQa, asOwner]) {
      const res = await api.post(executionUploadUrl(), {
        multipart: filesForm([]),
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toContain("No files");
    }
    expect(attachmentRows(tenant!)).toHaveLength(0);
  });

  /*
   * This used to accept either outcome — refuse it, or store it and report 0 bytes. The product has
   * chosen: assertValidEvidenceFiles refuses it (Basecamp 10226296533). A zero-byte upload is a
   * failed drag-and-drop or a file still being written, and storing it costs an attachment row and a
   * storage key for nothing.
   */
  test("a zero-byte file is refused, with nothing stored", { tag: '@tesbo.testId("TES-TC-1109")' }, async () => {
    const res = await upload(asQa, bugUploadUrl(), [sizedFile(`empty-${Date.now()}.png`, 0, "image/png")]);
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/empty/i);
    expect(attachmentRows(tenant!)).toHaveLength(0);
  });

  test("a megabyte file round-trips with its size recorded exactly", { tag: '@tesbo.testId("TES-TC-2")' }, async () => {
    // A realistically large screenshot, well inside EVIDENCE_MAX_FILE_SIZE (the boundary itself is
    // covered below). The extension has to be one the evidence allowlist accepts — .bin no longer
    // is — and the bytes are still arbitrary, since nothing decodes bug evidence on upload.
    const file = sizedFile(`large-${Date.now()}.png`, 1024 * 1024, "image/png");
    const res = await upload(asQa, bugUploadUrl(), [file]);
    expect(res.ok(), `upload failed: ${res.status()} ${await res.text()}`).toBeTruthy();

    const rows = attachmentRows(tenant!);
    expect(rows[0].fileSize).toBe(1024 * 1024);
    const download = await asOwner.get(
      `/api/projects/${tenant!.mainProjectId}/bugs/attachments/${rows[0].id}/download`,
    );
    expect(Buffer.from(await download.body()).length).toBe(1024 * 1024);
  });

  // ─── Filenames and content types ───────────────────────────────────────────

  test("a filename that tries to escape the upload directory cannot", { tag: '@tesbo.testId("TES-TC-3")' }, async () => {
    // The stored key is built from the project and execution ids plus a fresh uuid, with only the
    // EXTENSION taken from the client — so a traversal attempt must end up inside the tree. A
    // storage path containing ".." would mean an upload could overwrite anything the process can.
    // ".png" is appended so the file survives the evidence type check and actually reaches the
    // storage-key builder — the traversal risk lives in that builder, which takes the extension from
    // the client, so a name refused up front would leave this test asserting nothing.
    const res = await upload(asQa, bugUploadUrl(), [
      { name: "../../../../etc/passwd.png", mimeType: "text/plain", body: Buffer.from("nope") },
    ]);
    expect(res.status(), "a traversal filename should not cause a 500").toBeLessThan(500);

    if (res.ok()) {
      const [row] = attachmentRows(tenant!);
      expect(row.storagePath).not.toContain("..");
      expect(row.storagePath.startsWith(`bugs/${tenant!.mainProjectId}/`)).toBeTruthy();
    }
  });

  test("unicode and very long filenames survive the round trip", { tag: '@tesbo.testId("TES-TC-6")' }, async () => {
    const suffix = Date.now();
    const unicode = `スクリーンショット-${suffix}-café-🧪.png`;
    // 255 is the usual filesystem ceiling; the extension is kept inside the budget.
    const longName = `${"n".repeat(240)}-${suffix}.png`;

    for (const name of [unicode, longName]) {
      purgeAttachments(tenant!);
      const res = await upload(asQa, bugUploadUrl(), [pngFile(name)]);
      expect(res.status(), `"${name.slice(0, 30)}…" should not cause a 500`).toBeLessThan(500);
      if (!res.ok()) continue;

      const [row] = attachmentRows(tenant!);
      const download = await asOwner.get(
        `/api/projects/${tenant!.mainProjectId}/bugs/attachments/${row.id}/download`,
        { failOnStatusCode: false },
      );
      expect(download.ok(), `a stored file named "${name.slice(0, 30)}…" should download`).toBeTruthy();
      // The header has to be encoded, not raw — a raw newline or quote here breaks the response.
      expect(download.headers()["content-disposition"]).toContain("attachment");
    }
  });

  /*
   * Deliberate reversal (Basecamp 10226296533). This file previously asserted that an extensionless
   * upload was accepted and downloadable, which was true and is no longer intended: the extension is
   * the only thing that tells the server, the browser and the person downloading it what the file
   * is, and evidence with no determinable type is exactly what the card asked to be rejected.
   */
  test("an extensionless file is refused, naming what is supported", { tag: '@tesbo.testId("TES-TC-1110")' }, async () => {
    const res = await upload(asQa, bugUploadUrl(), [
      { name: `noextension-${Date.now()}`, mimeType: "application/octet-stream", body: Buffer.from("x") },
    ]);
    expect(res.status()).toBe(400);
    const { error } = await res.json();
    expect(error).toMatch(/extension/i);
    // The message has to be actionable — a bare "invalid file" leaves the reporter guessing.
    expect(error).toMatch(/png/);
    expect(attachmentRows(tenant!)).toHaveLength(0);
  });

  test("an html attachment is served as a download, never rendered", { tag: '@tesbo.testId("TES-TC-8")' }, async () => {
    // The XSS case: bug evidence is attacker-supplied content served from the app's own origin. If
    // the download responded with text/html and no attachment disposition, opening it would run
    // that script as the app.
    const res = await upload(asQa, bugUploadUrl(), [
      {
        name: `payload-${Date.now()}.html`,
        mimeType: "text/html",
        body: Buffer.from("<script>window.__e2e_xss = true</script>"),
      },
    ]);
    expect(res.status()).toBeLessThan(500);
    if (!res.ok()) return;

    const [row] = attachmentRows(tenant!);
    const download = await asOwner.get(
      `/api/projects/${tenant!.mainProjectId}/bugs/attachments/${row.id}/download`,
      { failOnStatusCode: false },
    );
    expect(download.ok()).toBeTruthy();
    expect(download.headers()["content-disposition"]).toContain("attachment");
  });

  test("a content type that contradicts the extension is recorded as sent, not guessed", { tag: '@tesbo.testId("TES-TC-9")' }, async () => {
    const res = await upload(asQa, bugUploadUrl(), [
      { name: `mismatch-${Date.now()}.png`, mimeType: "text/plain", body: Buffer.from("not a png") },
    ]);
    expect(res.status()).toBeLessThan(500);
    if (!res.ok()) return;

    const download = await asOwner.get(
      `/api/projects/${tenant!.mainProjectId}/bugs/attachments/${attachmentRows(tenant!)[0].id}/download`,
    );
    // Whatever it stores, the download must not claim image/png for text — that combination is what
    // makes content sniffing dangerous.
    expect(download.headers()["content-type"]).toContain("text/plain");
  });

  // ─── Type and size validation ──────────────────────────────────────────────

  /*
   * Basecamp 10226296533 — "[Bug Attachments] Missing File Type and Size Validations Cause Upload to
   * Get Stuck on Saving".
   *
   * Nothing validated type or size before this: every extension was accepted, and the only ceiling
   * was the interceptor's 100MB, enforced by multer mid-stream with no field-level reason — so the
   * reporting modal sat on "Saving…" with nothing to show. Both uploads validate the whole batch up
   * front now, and both are covered here because uploadExecutionAttachments had the identical hole.
   */
  test("an unsupported file type is refused, naming the file and what is supported", { tag: '@tesbo.testId("TES-TC-1111")' }, async () => {
    const name = `malware-${Date.now()}.exe`;
    const res = await upload(asQa, bugUploadUrl(), [{ name, mimeType: "application/octet-stream", body: Buffer.from("MZ") }]);

    expect(res.status()).toBe(400);
    const { error } = await res.json();
    // The reporter has to be able to tell WHICH of several picked files was the problem.
    expect(error).toContain(name);
    expect(error).toMatch(/\.exe/);
    expect(error).toMatch(/png/);
    expect(attachmentRows(tenant!)).toHaveLength(0);
  });

  test("a zip is refused even though it is an ordinary document bundle", { tag: '@tesbo.testId("TES-TC-1112")' }, async () => {
    // Deliberate, and inherited from the knowledge base's list: an extension check cannot see what
    // is inside an archive, so accepting .zip would accept everything the allowlist just refused.
    const res = await upload(asQa, bugUploadUrl(), [
      { name: `evidence-${Date.now()}.zip`, mimeType: "application/zip", body: Buffer.from("PK\u0003\u0004") },
    ]);
    expect(res.status()).toBe(400);
    expect(attachmentRows(tenant!)).toHaveLength(0);
  });

  test("a spread of the allowed evidence types is accepted", { tag: '@tesbo.testId("TES-TC-1113")' }, async () => {
    const suffix = Date.now();
    const res = await upload(asQa, bugUploadUrl(), [
      pngFile(`shot-${suffix}.png`),
      { name: `steps-${suffix}.pdf`, mimeType: "application/pdf", body: Buffer.from("%PDF-1.4") },
      { name: `rows-${suffix}.csv`, mimeType: "text/csv", body: Buffer.from("a,b\n1,2") },
      { name: `clip-${suffix}.mp4`, mimeType: "video/mp4", body: Buffer.from("\u0000\u0000\u0000 ftypmp42") },
    ]);
    expect(res.ok(), `upload failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    expect(attachmentRows(tenant!)).toHaveLength(4);
  });

  test("a file over the evidence limit is refused, with the limit in the message", { tag: '@tesbo.testId("TES-TC-1114")' }, async () => {
    const name = `huge-${Date.now()}.png`;
    const res = await upload(asQa, bugUploadUrl(), [sizedFile(name, EVIDENCE_MAX_BYTES + 1024, "image/png")]);

    expect(res.status()).toBe(400);
    const { error } = await res.json();
    expect(error).toContain(name);
    expect(error).toMatch(/25\.0MB/);
    expect(attachmentRows(tenant!)).toHaveLength(0);
  });

  test("a file exactly at the evidence limit is accepted", { tag: '@tesbo.testId("TES-TC-1115")' }, async () => {
    // The boundary in the allowed direction: a cap that also rejects the value it names is a
    // different cap. The 25MB body is the reason this is one test and not a loop.
    const file = sizedFile(`at-limit-${Date.now()}.png`, EVIDENCE_MAX_BYTES, "image/png");
    const res = await upload(asQa, bugUploadUrl(), [file]);

    expect(res.ok(), `upload failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    const rows = attachmentRows(tenant!);
    expect(rows).toHaveLength(1);
    expect(rows[0].fileSize).toBe(EVIDENCE_MAX_BYTES);
  });

  test("one bad file in a batch refuses the whole batch, storing none of it", { tag: '@tesbo.testId("TES-TC-1116")' }, async () => {
    // The upload loops storage.put per file, so validating per file as it goes would leave the
    // accepted ones written and billed while the request answers 400. All-or-nothing is the contract.
    const suffix = Date.now();
    const res = await upload(asQa, bugUploadUrl(), [
      pngFile(`good-a-${suffix}.png`),
      { name: `bad-${suffix}.exe`, mimeType: "application/octet-stream", body: Buffer.from("MZ") },
      pngFile(`good-b-${suffix}.png`),
    ]);

    expect(res.status()).toBe(400);
    expect(attachmentRows(tenant!), "a rejected batch must not leave partial evidence behind").toHaveLength(0);
  });

  test("execution evidence is held to the same rules as bug evidence", { tag: '@tesbo.testId("TES-TC-1117")' }, async () => {
    const suffix = Date.now();
    const unsupported = await upload(asQa, executionUploadUrl(), [
      { name: `run-log-${suffix}.exe`, mimeType: "application/octet-stream", body: Buffer.from("MZ") },
    ]);
    expect(unsupported.status()).toBe(400);

    const oversize = await upload(asQa, executionUploadUrl(), [
      sizedFile(`run-shot-${suffix}.png`, EVIDENCE_MAX_BYTES + 1024, "image/png"),
    ]);
    expect(oversize.status()).toBe(400);
    expect(attachmentRows(tenant!)).toHaveLength(0);

    const accepted = await upload(asQa, executionUploadUrl(), [pngFile(`run-shot-ok-${suffix}.png`)]);
    expect(accepted.ok(), `upload failed: ${accepted.status()} ${await accepted.text()}`).toBeTruthy();
  });

  test("authorization is still decided before the file is judged", { tag: '@tesbo.testId("TES-TC-1118")' }, async () => {
    // Order matters: if validation ran first, an anonymous caller would learn which extensions a
    // workspace accepts, and a member with no project access would get a 400 that reads like their
    // file was the problem rather than their access.
    const bad: UploadFile = { name: `nope-${Date.now()}.exe`, mimeType: "application/octet-stream", body: Buffer.from("MZ") };

    /*
     * Asserted on WHAT the refusal is about, not on its status code.
     *
     * This path answers an unauthenticated caller with 400 {"error":"Authentication required"} —
     * verified by probing it with a perfectly valid .png, which gets the identical response, so the
     * file genuinely is not being judged first. 401 would be the correct code and this endpoint is
     * not the place to change it (the suite's other auth cases already encode the 400), so the test
     * proves the ordering instead of pinning a number: the answer must be about the caller, never
     * about their file.
     */
    const anonRes = await upload(anon, bugUploadUrl(), [bad]);
    expect([400, 401, 403]).toContain(anonRes.status());
    const anonBody = await anonRes.text();
    expect(anonBody).toMatch(/auth|session|sign in/i);
    expect(anonBody, "an anonymous caller must not learn which file types are accepted").not.toMatch(/\.exe|supported types/i);

    const guestRes = await upload(asGuest, bugUploadUrl(), [bad]);
    // 403 or 404 — the same pair the access test above accepts, since hiding the resource entirely
    // is also a defensible answer for a non-member. What matters is that it is not 400.
    expect([403, 404], "a caller with no project access should be refused on access").toContain(guestRes.status());
    expect(attachmentRows(tenant!)).toHaveLength(0);
  });

  // ─── Trace links (the embedded Playwright trace viewer) ────────────────────
  //
  // A trace is shown in place by Playwright's own viewer (trace.playwright.dev) in an iframe. That
  // viewer runs in the visitor's browser and fetches the .zip itself, cross-origin and without
  // credentials, so it cannot use the session-authorized download route above. These cases cover the
  // signed grant that replaces it, and — since the route it unlocks takes no session at all — they
  // are as much about what the grant refuses as what it allows.

  function traceLinkUrl(attachmentId: string, cycle = cycleId, execution = executionId): string {
    return `/api/cycles/${cycle}/executions/${execution}/attachments/${attachmentId}/trace-link`;
  }

  function zipFile(name = `trace-${Date.now()}.zip`): UploadFile {
    // Real zip magic bytes, so nothing downstream can be passing it for a different reason.
    return { name, mimeType: "application/zip", body: Buffer.from("PK\u0003\u0004 e2e trace archive", "utf-8") };
  }

  async function uploadTrace(): Promise<{ attachmentId: string; file: UploadFile }> {
    const file = zipFile();
    const res = await upload(asQa, executionUploadUrl(), [file]);
    expect(res.ok(), `trace upload failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    const rows = attachmentRows(tenant!);
    expect(rows).toHaveLength(1);
    return { attachmentId: rows[0].id, file };
  }

  test("a trace attachment yields a link the viewer can fetch without a session", async () => {
    const { attachmentId, file } = await uploadTrace();

    const minted = await asQa.get(traceLinkUrl(attachmentId), { failOnStatusCode: false });
    expect(minted.ok(), `minting failed: ${minted.status()} ${await minted.text()}`).toBeTruthy();
    const { token, expiresAt } = await minted.json();
    expect(token, "the viewer is given a token, never a storage path").toBeTruthy();
    expect(String(token)).not.toContain("executions/");
    expect(new Date(expiresAt).getTime(), "a trace grant has to expire").toBeGreaterThan(Date.now());

    // Redeemed anonymously: this is the whole point — the fetch comes from trace.playwright.dev,
    // which has no cookie of ours to send.
    const served = await anon.get(`/api/public/trace/${token}`, { failOnStatusCode: false });
    expect(served.ok(), `redeeming failed: ${served.status()} ${await served.text()}`).toBeTruthy();
    expect(Buffer.from(await served.body()).equals(file.body), "the archive must arrive byte-for-byte").toBeTruthy();

    const headers = served.headers();
    expect(headers["content-type"]).toContain("application/zip");
    // Without this exact header the viewer's cross-origin fetch fails and the iframe sits empty.
    expect(headers["access-control-allow-origin"]).toBe("https://trace.playwright.dev");
    // Still a download, never something a browser will render — the rule the rest of this file keeps.
    expect(headers["content-disposition"]).toContain("attachment");
  });

  test("a trace link is refused for evidence that is not a trace", async () => {
    const res = await upload(asQa, executionUploadUrl(), [pngFile(`shot-${Date.now()}.png`)]);
    expect(res.ok()).toBeTruthy();
    const attachmentId = attachmentRows(tenant!)[0].id;

    /*
     * The narrowness of the grant is the security property, not a nicety: the public route takes no
     * session, so if a link could be minted for arbitrary evidence, any attachment in the workspace
     * would be reachable by URL alone. A zip cannot be rendered as markup by a browser; an .html or
     * .svg served from a URL with no session could be.
     */
    const minted = await asQa.get(traceLinkUrl(attachmentId), { failOnStatusCode: false });
    expect(minted.status()).toBe(400);
    expect(await minted.text()).toMatch(/not a playwright trace/i);
  });

  test("a tampered, malformed or unknown trace token is refused", async () => {
    const { attachmentId } = await uploadTrace();
    const { token } = await (await asQa.get(traceLinkUrl(attachmentId))).json();

    const [payload, signature] = String(token).split(".");
    // Same payload, one character of the signature changed — the case a signature check exists for.
    const forgedSignature = `${payload}.${signature.slice(0, -1)}${signature.slice(-1) === "A" ? "B" : "A"}`;
    // A valid signature over a payload naming a different attachment is not obtainable, but an
    // attacker can certainly re-encode the payload and hope it is trusted unverified.
    const swapped = Buffer.from(JSON.stringify({ a: attachmentId, e: executionId, t: Date.now() })).toString("base64url");
    const forgedPayload = `${swapped}.${signature}`;

    for (const bad of [forgedSignature, forgedPayload, "not-a-token", `${payload}.`, payload]) {
      const res = await anon.get(`/api/public/trace/${bad}`, { failOnStatusCode: false });
      expect(res.status(), `token "${bad.slice(0, 24)}…" should be refused`).toBe(404);
    }
  });

  test("minting a trace link needs access to the run", async () => {
    const { attachmentId } = await uploadTrace();

    const anonRes = await anon.get(traceLinkUrl(attachmentId), { failOnStatusCode: false });
    expect([400, 401, 403], "an anonymous caller must not mint a trace link").toContain(anonRes.status());

    const guestRes = await asGuest.get(traceLinkUrl(attachmentId), { failOnStatusCode: false });
    expect([403, 404], "a workspace member with no project access must not mint one").toContain(guestRes.status());
  });

  test("a trace link cannot be minted for another execution's evidence", async () => {
    const { attachmentId } = await uploadTrace();

    // A second run in the same project, so the only thing separating the two is the scoping check.
    const suffix = Date.now();
    const testcase = await (
      await asOwner.post(`/api/projects/${tenant!.mainProjectId}/testcases`, {
        data: { title: `E2E Trace Scope Case ${suffix}` },
      })
    ).json();
    const otherCycle = await (
      await asOwner.post(`/api/projects/${tenant!.mainProjectId}/cycles`, { data: { name: `E2E Trace Scope Run ${suffix}` } })
    ).json();
    try {
      await asOwner.post(`/api/cycles/${otherCycle.id}/testcases`, { data: { testcaseIds: [testcase.id] } });
      const otherExecutions = await (await asOwner.get(`/api/cycles/${otherCycle.id}/executions`)).json();

      const res = await asOwner.get(traceLinkUrl(attachmentId, otherCycle.id, otherExecutions[0].id), {
        failOnStatusCode: false,
      });
      expect(res.status(), "an attachment id must not cross to another execution").toBe(404);
    } finally {
      await asOwner.delete(`/api/cycles/${otherCycle.id}`, { failOnStatusCode: false });
      await asOwner.delete(`/api/projects/${tenant!.mainProjectId}/testcases/${testcase.id}`, {
        failOnStatusCode: false,
      });
    }
  });

  test("a trace link stops working once the evidence is gone", async () => {
    const { attachmentId } = await uploadTrace();
    const { token } = await (await asQa.get(traceLinkUrl(attachmentId))).json();
    expect((await anon.get(`/api/public/trace/${token}`, { failOnStatusCode: false })).ok()).toBeTruthy();

    // The grant outlives the row it names, so redemption has to re-check rather than trust the
    // signature alone.
    purgeAttachments(tenant!);

    const afterDelete = await anon.get(`/api/public/trace/${token}`, { failOnStatusCode: false });
    expect(afterDelete.status(), "a link to deleted evidence must stop resolving").toBe(404);
  });

  // ─── Authorization ─────────────────────────────────────────────────────────

  test("uploading needs a session", { tag: '@tesbo.testId("TES-TC-10")' }, async () => {
    for (const url of [executionUploadUrl(), bugUploadUrl()]) {
      const res = await upload(anon, url, [pngFile()]);
      expect([400, 401], `${url} should refuse an anonymous upload`).toContain(res.status());
    }
    expect(attachmentRows(tenant!)).toHaveLength(0);
  });

  test("a workspace member with no project access cannot upload evidence", { tag: '@tesbo.testId("TES-TC-11")' }, async () => {
    for (const url of [executionUploadUrl(), bugUploadUrl()]) {
      const res = await upload(asGuest, url, [pngFile()]);
      expect([403, 404], `${url} should refuse a non-member of the project`).toContain(res.status());
    }
    expect(attachmentRows(tenant!)).toHaveLength(0);
  });

  test("listing execution attachments is refused without access to the run", { tag: '@tesbo.testId("TES-TC-12")' }, async () => {
    // listExecutionAttachments takes only the execution id — its controller method never receives
    // the caller, and the query joins nothing — so today the list (including internal storage paths)
    // is readable by anyone who can name an execution id.
    await upload(asQa, executionUploadUrl(), [pngFile(`listing-${Date.now()}.png`)]);

    const byGuest = await asGuest.get(executionUploadUrl(), { failOnStatusCode: false });
    expect([403, 404], "a non-member should not be able to list a run's evidence").toContain(
      byGuest.status(),
    );

    const byAnon = await anon.get(executionUploadUrl(), { failOnStatusCode: false });
    expect([400, 401, 403, 404], "an anonymous caller should not be able to list evidence").toContain(
      byAnon.status(),
    );
  });

  test("an attachment cannot be downloaded by someone with no access to it", { tag: '@tesbo.testId("TES-TC-13")' }, async () => {
    // downloadBugAttachment resolves the file by id alone — no session, no project join. The upload
    // path is properly scoped, so the file is only reachable by id; that id appearing in a link,
    // a log or a report shouldn't be enough to hand the file to the world.
    await upload(asQa, bugUploadUrl(), [textFile(`private-${Date.now()}.txt`, "confidential evidence")]);
    const [row] = attachmentRows(tenant!);
    const url = `/api/projects/${tenant!.mainProjectId}/bugs/attachments/${row.id}/download`;

    const byGuest = await asGuest.get(url, { failOnStatusCode: false });
    expect([403, 404], "a non-member should not be able to download the file").toContain(byGuest.status());

    const byAnon = await anon.get(url, { failOnStatusCode: false });
    expect([400, 401, 403, 404], "an anonymous caller should not be able to download the file").toContain(
      byAnon.status(),
    );
  });

  test("an attachment cannot be deleted by someone with no access to it", { tag: '@tesbo.testId("TES-TC-14")' }, async () => {
    // deleteBugAttachment also takes only an id, and it deletes the stored object as well as the
    // row — so an unauthorized caller doesn't just read someone's evidence, they destroy it.
    await upload(asQa, bugUploadUrl(), [textFile(`deletable-${Date.now()}.txt`)]);
    const [row] = attachmentRows(tenant!);

    const byAnon = await anon.delete(`/api/bugs/attachments/${row.id}`, { failOnStatusCode: false });
    expect([400, 401, 403, 404], "an anonymous caller should not be able to delete evidence").toContain(
      byAnon.status(),
    );
    expect(attachmentRows(tenant!), "the file should still be there").toHaveLength(1);

    const byGuest = await asGuest.delete(`/api/bugs/attachments/${row.id}`, { failOnStatusCode: false });
    expect([403, 404], "a non-member should not be able to delete evidence").toContain(byGuest.status());
    expect(attachmentRows(tenant!)).toHaveLength(1);
  });

  // ─── Missing and malformed targets ─────────────────────────────────────────

  test("uploading to something that doesn't exist is a clean 404", { tag: '@tesbo.testId("TES-TC-15")' }, async () => {
    const missing = "00000000-0000-0000-0000-000000000000";
    const cases = [
      `/api/cycles/${cycleId}/executions/${missing}/attachments`,
      `/api/cycles/${missing}/executions/${executionId}/attachments`,
      `/api/projects/${tenant!.mainProjectId}/bugs/${missing}/attachments`,
    ];
    for (const url of cases) {
      const res = await upload(asOwner, url, [pngFile()]);
      expect(res.status(), `${url} should be a clean 404`).toBe(404);
    }
  });

  test("a malformed id fails cleanly, never with a 500", { tag: '@tesbo.testId("TES-TC-26")' }, async () => {
    const cases = [
      `/api/cycles/${cycleId}/executions/not-a-uuid/attachments`,
      `/api/projects/${tenant!.mainProjectId}/bugs/not-a-uuid/attachments`,
    ];
    for (const url of cases) {
      const res = await upload(asOwner, url, [pngFile()]);
      expect(res.status(), `${url} should fail cleanly`).toBeLessThan(500);
      expect(res.ok()).toBeFalsy();
    }

    for (const url of [
      `/api/projects/${tenant!.mainProjectId}/bugs/attachments/not-a-uuid/download`,
      `/api/bugs/attachments/not-a-uuid`,
    ]) {
      const res = url.endsWith("download")
        ? await asOwner.get(url, { failOnStatusCode: false })
        : await asOwner.delete(url, { failOnStatusCode: false });
      expect(res.status(), `${url} should fail cleanly`).toBeLessThan(500);
    }
  });

  // ─── Storage accounting and the plan ceiling ───────────────────────────────

  test("uploaded bytes are reported as storage used, and freed again on delete", { tag: '@tesbo.testId("TES-TC-18")' }, async () => {
    const before = await reportedStorageBytes();
    const file = sizedFile(`accounted-${Date.now()}.png`, 64 * 1024, "image/png");

    expect((await upload(asQa, bugUploadUrl(), [file])).ok()).toBeTruthy();
    expect(await reportedStorageBytes()).toBe(before + file.body.length);

    const [row] = attachmentRows(tenant!);
    expect((await asOwner.delete(`/api/bugs/attachments/${row.id}`)).ok()).toBeTruthy();
    expect(
      await reportedStorageBytes(),
      "deleting evidence has to give the space back, or a workspace fills up permanently",
    ).toBe(before);
  });

  test("an upload that would exceed the Launch ceiling is refused with a route out", { tag: '@tesbo.testId("TES-TC-19")' }, async () => {
    try {
      resetToLaunch(tenant!.organizationId);
      // One byte short of the ceiling, so any real upload has to be refused.
      claimStorage(tenant!, LAUNCH_LIMIT_BYTES - 1);

      const res = await upload(asQa, bugUploadUrl(), [sizedFile(`over-${Date.now()}.png`, 4096, "image/png")]);
      expect(res.status()).toBe(403);
      const { error } = await res.json();
      expect(error).toContain("storage limit");
      expect(error, "a Launch workspace has somewhere to go — say so").toContain("Upgrade to Pro");
    } finally {
      setProPlan(tenant!.organizationId);
      purgeAttachments(tenant!);
    }
  });

  test("a Pro workspace at its ceiling is pointed at support, not at an upgrade", { tag: '@tesbo.testId("TES-TC-20")' }, async () => {
    try {
      setProPlan(tenant!.organizationId);
      claimStorage(tenant!, 5 * 1024 * 1024 * 1024 - 1);

      const res = await upload(asQa, bugUploadUrl(), [sizedFile(`over-pro-${Date.now()}.png`, 4096, "image/png")]);
      expect(res.status()).toBe(403);
      const { error } = await res.json();
      expect(error).toContain("storage limit");
      expect(error, "Pro is the largest plan, so 'upgrade' is a dead end").not.toContain("Upgrade to Pro");
      expect(error).toContain("contact");
    } finally {
      purgeAttachments(tenant!);
    }
  });

  test("freeing space makes a refused upload possible again", { tag: '@tesbo.testId("TES-TC-21")' }, async () => {
    try {
      resetToLaunch(tenant!.organizationId);
      claimStorage(tenant!, LAUNCH_LIMIT_BYTES - 1);

      const file = sizedFile(`retry-${Date.now()}.png`, 4096, "image/png");
      expect((await upload(asQa, bugUploadUrl(), [file])).status()).toBe(403);

      // Release the claimed space the way a user would: delete the thing taking it up.
      const claimed = attachmentRows(tenant!).find((r) => r.fileSize === LAUNCH_LIMIT_BYTES - 1)!;
      exec(`DELETE FROM attachments WHERE id = ${literal(claimed.id)};`);

      const retry = await upload(asQa, bugUploadUrl(), [file]);
      expect(retry.ok(), `the upload should succeed once space is free: ${await retry.text()}`).toBeTruthy();
    } finally {
      setProPlan(tenant!.organizationId);
      purgeAttachments(tenant!);
    }
  });

  // ─── What happens to evidence when its parent goes ─────────────────────────

  test("deleting a bug does not leave its evidence billing the workspace", { tag: '@tesbo.testId("TES-TC-22")' }, async () => {
    // Whichever way the product goes — cascade the rows or keep them — the workspace must not be
    // charged for storage it can no longer see or delete through the UI.
    const suffix = Date.now();
    const throwaway = await (
      await asOwner.post(`/api/projects/${tenant!.mainProjectId}/bugs`, {
        data: { title: `E2E Attachment Orphan Bug ${suffix}`, severity: "Low" },
      })
    ).json();

    const file = sizedFile(`orphan-${suffix}.png`, 32 * 1024, "image/png");
    const uploaded = await upload(asQa, `/api/projects/${tenant!.mainProjectId}/bugs/${throwaway.id}/attachments`, [
      file,
    ]);
    expect(uploaded.ok()).toBeTruthy();
    const before = await reportedStorageBytes();
    expect(before).toBeGreaterThanOrEqual(file.body.length);

    expect((await asOwner.delete(`/api/bugs/${throwaway.id}`)).ok()).toBeTruthy();

    const stillBilled = (await reportedStorageBytes()) >= file.body.length;
    const stillReachable = attachmentRows(tenant!).length > 0;
    if (stillBilled) {
      // If the bytes are still counted, the attachment must still be reachable and deletable —
      // otherwise the space can never be reclaimed by any means the product offers.
      expect(
        stillReachable,
        "storage is still counted for a deleted bug's evidence with no way left to remove it",
      ).toBeTruthy();
      const [row] = attachmentRows(tenant!);
      const download = await asOwner.get(
        `/api/projects/${tenant!.mainProjectId}/bugs/attachments/${row.id}/download`,
        { failOnStatusCode: false },
      );
      expect(download.status(), "orphaned evidence should not 500").toBeLessThan(500);
    }
  });

  test("an outsider with no workspace at all is refused everywhere", { tag: '@tesbo.testId("TES-TC-23")' }, async () => {
    const email = testAddress("attach-outsider");
    const outsider = seedFixtureUser(email, "E2E Attachment Outsider");
    const asOutsider = await loginAs(outsider);
    try {
      await upload(asQa, bugUploadUrl(), [textFile(`outsider-${Date.now()}.txt`)]);
      const [row] = attachmentRows(tenant!);

      const uploadRes = await upload(asOutsider, bugUploadUrl(), [pngFile()]);
      expect(uploadRes.ok()).toBeFalsy();

      const downloadRes = await asOutsider.get(
        `/api/projects/${tenant!.mainProjectId}/bugs/attachments/${row.id}/download`,
        { failOnStatusCode: false },
      );
      expect([400, 401, 403, 404]).toContain(downloadRes.status());
    } finally {
      await asOutsider.dispose();
    }
  });
});
