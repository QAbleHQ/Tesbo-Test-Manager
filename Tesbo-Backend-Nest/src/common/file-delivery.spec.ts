import type { Response } from "express";
import { PLAIN_TEXT_DELIVERY, applyFileHeaders, resolveFileDelivery, safeContentType, sendStoredFile, withDelivery } from "./file-delivery";

/*
 * Uploaded files are attacker-supplied and served from the API's own origin. These pin the rules that
 * keep a member from running script as the application by uploading the right file with the right
 * claimed type. The e2e specs (api/attachments, api/kb-files) pin the same through real routes.
 */

describe("safeContentType: what gets stored", () => {
  it.each([
    ["text/html", "x.txt"],
    ["TEXT/HTML", "x.txt"],
    ["text/html; charset=utf-8", "x.html"],
    ["  text/html  ", "x.png"],
    ["application/xhtml+xml", "x.xhtml"],
    ["text/xml", "x.xml"],
    ["application/xml", "x.xml"],
    ["text/javascript", "x.js"],
    ["application/javascript", "x.js"],
    ["application/x-javascript", "x.js"],
    ["text/css", "x.css"],
    ["text/xsl", "x.xsl"],
    ["application/xslt+xml", "x.xsl"],
    ["text/cache-manifest", "x.appcache"]
  ])("downgrades %s (%s) to plain text, so a browser shows the source", (claimed, name) => {
    expect(safeContentType(claimed, name)).toBe("text/plain");
  });

  it("keeps image/svg+xml as sent (an <img> needs it) but never lets it be inline", () => {
    expect(safeContentType("image/svg+xml", "logo.svg")).toBe("image/svg+xml");
    expect(resolveFileDelivery("image/svg+xml", "logo.svg", true).inline).toBe(false);
    // And not by a different name either: the type is what matters, not the extension.
    expect(resolveFileDelivery("image/svg+xml", "logo.png", true).inline).toBe(false);
    expect(resolveFileDelivery("image/svg+xml; charset=utf-8", "logo.png", true).inline).toBe(false);
  });

  it("drops parameters the uploader controls", () => {
    expect(safeContentType("image/png; boundary=x; foo=bar", "a.png")).toBe("image/png");
  });

  it.each([
    ["not a type", "a.bin"],
    ["text/html\r\nSet-Cookie: x=1", "a.bin"],
    ["text/html\nX-Injected: 1", "a.bin"],
    ["image/png\u0000", "a.bin"],
    ["a".repeat(500) + "/b", "a.bin"],
    ["/", "a.bin"],
    ["text/", "a.bin"],
    ["/png", "a.bin"],
    ["te xt/html", "a.bin"],
    ['text/ht"ml', "a.bin"],
    ["", "a.bin"]
  ])("never puts a malformed type (%j) in a header", (claimed, name) => {
    const stored = safeContentType(claimed, name);
    expect(stored).toBe("application/octet-stream");
    expect(stored).not.toMatch(/[\r\n"]/);
  });

  it.each([undefined, null, 123, {}, ["text/html"], true] as unknown[])("treats a non-string type (%p) as missing", (claimed) => {
    expect(safeContentType(claimed as string, "x.bin")).toBe("application/octet-stream");
  });

  it("falls back to the extension when the client sent nothing useful", () => {
    expect(safeContentType("application/octet-stream", "shot.PNG")).toBe("image/png");
    expect(safeContentType(undefined, "clip.mp4")).toBe("video/mp4");
    expect(safeContentType("", "notes.TXT")).toBe("text/plain");
    expect(safeContentType("application/octet-stream", "blob")).toBe("application/octet-stream");
    expect(safeContentType("application/octet-stream", "weird.unknownext")).toBe("application/octet-stream");
    expect(safeContentType("application/octet-stream", undefined)).toBe("application/octet-stream");
  });

  it("does not guess an active type from the extension alone: an .html with no claimed type is a download", () => {
    expect(safeContentType("application/octet-stream", "page.html")).toBe("application/octet-stream");
    expect(resolveFileDelivery("application/octet-stream", "page.html", true).inline).toBe(false);
  });

  it("echoes an ordinary claimed type unchanged, even one that contradicts the extension", () => {
    // The e2e suite pins this: a .png sent as text/plain is stored as text/plain, never promoted to image/png.
    expect(safeContentType("text/plain", "mismatch.png")).toBe("text/plain");
    expect(safeContentType("application/zip", "a.zip")).toBe("application/zip");
    expect(safeContentType("image/png", "a.png")).toBe("image/png");
    expect(safeContentType("application/pdf", "a.pdf")).toBe("application/pdf");
  });

  it("is idempotent, so a row stored with a raw type and one stored cleaned serve identically", () => {
    for (const [claimed, name] of [["text/html", "a.txt"], ["image/svg+xml", "a.svg"], ["image/png", "a.png"], ["junk", "a.bin"]] as const) {
      const once = safeContentType(claimed, name);
      expect(safeContentType(once, name)).toBe(once);
    }
  });
});

describe("resolveFileDelivery: inline only for formats that cannot run script", () => {
  it.each([
    ["image/png", "a.png"],
    ["image/jpeg", "a.jpg"],
    ["image/gif", "a.gif"],
    ["image/webp", "a.webp"],
    ["application/pdf", "a.pdf"],
    ["video/mp4", "a.mp4"],
    ["video/webm", "a.webm"],
    ["audio/mpeg", "a.mp3"],
    ["text/plain", "a.txt"],
    ["text/csv", "a.csv"],
    ["text/markdown", "a.md"],
    ["application/json", "a.json"]
  ])("renders %s inline when asked", (type, name) => {
    expect(resolveFileDelivery(type, name, true).inline).toBe(true);
  });

  it("never renders inline when not asked", () => {
    expect(resolveFileDelivery("image/png", "a.png", false).inline).toBe(false);
    expect(resolveFileDelivery("text/plain", "a.txt", false).inline).toBe(false);
  });

  it.each([
    ["image/svg+xml", "a.svg"],
    ["application/zip", "trace.zip"],
    ["application/octet-stream", "a.bin"],
    ["application/x-msdownload", "a.exe"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx"],
    ["application/x-shockwave-flash", "a.swf"],
    ["application/wasm", "a.wasm"],
    ["multipart/related", "a.mhtml"],
    ["message/rfc822", "a.eml"],
    ["video/x-matroska", "a.mkv"],
    ["junk", "a.bin"]
  ])("keeps %s (%s) a download even when inline is requested", (type, name) => {
    expect(resolveFileDelivery(type, name, true).inline).toBe(false);
  });

  it.each([
    ["text/html", "page.html"],
    ["text/html", "notes.txt"],
    ["application/xhtml+xml", "page.xhtml"],
    ["text/xml", "data.xml"],
    ["application/javascript", "app.js"],
    ["text/css", "site.css"]
  ])("serves %s (%s) inline as plain text, never as markup or script", (type, name) => {
    const delivery = resolveFileDelivery(type, name, true);
    expect(delivery.contentType).toBe("text/plain; charset=utf-8");
    expect(delivery.inline).toBe(true);
  });

  it("serves those same files as a plain-text download when inline is not asked for", () => {
    const delivery = resolveFileDelivery("text/html", "page.html", false);
    expect(delivery).toEqual({ contentType: "text/plain; charset=utf-8", inline: false });
  });

  it("adds an explicit charset to text types only", () => {
    expect(resolveFileDelivery("text/csv", "a.csv", true).contentType).toBe("text/csv; charset=utf-8");
    expect(resolveFileDelivery("image/png", "a.png", true).contentType).toBe("image/png");
    expect(resolveFileDelivery("application/json", "a.json", true).contentType).toBe("application/json");
  });

  it("ignores a missing stored type", () => {
    expect(resolveFileDelivery(null, "a.png", true)).toEqual({ contentType: "image/png", inline: true });
    expect(resolveFileDelivery(undefined, undefined, true)).toEqual({ contentType: "application/octet-stream", inline: false });
  });

  it("the preview of a server-known text extension is plain text regardless of the claimed type", () => {
    expect(PLAIN_TEXT_DELIVERY).toEqual({ contentType: "text/plain; charset=utf-8", inline: true });
  });
});

function fakeResponse() {
  const headers: Record<string, string> = {};
  const res = {
    headers,
    setHeader: (name: string, value: string) => void (headers[name.toLowerCase()] = value),
    redirect: jest.fn(),
    send: jest.fn(),
    sendFile: jest.fn()
  };
  return res as typeof res & Response;
}

describe("applyFileHeaders / sendStoredFile: every response carries the full set", () => {
  const png = { contentType: "image/png", inline: true };

  it("sets type, disposition and nosniff", () => {
    const res = fakeResponse();
    applyFileHeaders(res, png, "pic.png");
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-disposition"]).toBe('inline; filename="pic.png"');
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("adds a sandbox CSP to anything a browser could treat as a document", () => {
    for (const [contentType, inline] of [["text/plain; charset=utf-8", true], ["image/svg+xml", false], ["image/png", true], ["application/zip", false]] as const) {
      const res = fakeResponse();
      applyFileHeaders(res, { contentType, inline }, "f");
      expect(res.headers["content-security-policy"]).toMatch(/^sandbox;/);
      expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    }
  });

  it("leaves PDFs and media without the sandbox CSP, which would blank the browser's viewer", () => {
    for (const contentType of ["application/pdf", "video/mp4", "audio/mpeg"]) {
      const res = fakeResponse();
      applyFileHeaders(res, { contentType, inline: true }, "f");
      expect(res.headers["content-security-policy"]).toBeUndefined();
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  it.each([
    'evil".html',
    "a\r\nSet-Cookie: x=1.png",
    "a\nb.png",
    "../../etc/passwd",
    "名前 café 🧪.png",
    "a;b=c.png",
    "x".repeat(300) + ".png"
  ])("cannot be made to split or break the Content-Disposition header with the filename %j", (name) => {
    const res = fakeResponse();
    applyFileHeaders(res, png, name);
    const disposition = res.headers["content-disposition"];
    expect(disposition).not.toMatch(/[\r\n]/);
    // The only quotes left are the two that wrap the value.
    expect(disposition.match(/"/g)).toHaveLength(2);
    expect(disposition.startsWith("inline; filename=")).toBe(true);
  });

  it("an attachment is labelled as one", () => {
    const res = fakeResponse();
    applyFileHeaders(res, { contentType: "application/zip", inline: false }, "a.zip");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="a.zip"');
  });

  it("redirects to a presigned URL untouched, with no headers of ours (the type was pinned into the URL)", () => {
    const res = fakeResponse();
    sendStoredFile(res, { redirectUrl: "https://bucket.example/obj?sig=1" });
    expect(res.redirect).toHaveBeenCalledWith(302, "https://bucket.example/obj?sig=1");
    expect(res.headers["content-type"]).toBeUndefined();
  });

  it("sends buffered bytes and local files with the headers applied first", () => {
    const buffer = Buffer.from("hi");
    const res = fakeResponse();
    sendStoredFile(res, { buffer, ...png, originalFileName: "a.png" });
    expect(res.send).toHaveBeenCalledWith(buffer);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");

    const local = fakeResponse();
    sendStoredFile(local, { localPath: "/data/a.png", ...png, originalFileName: "a.png" });
    expect(local.sendFile).toHaveBeenCalledWith("/data/a.png");
    expect(local.headers["content-type"]).toBe("image/png");
  });

  it("throws rather than answering 200 with nothing when there is neither bytes nor a path", () => {
    expect(() => sendStoredFile(fakeResponse(), { ...png, originalFileName: "a.png" } as never)).toThrow(/unavailable/);
  });
});

describe("withDelivery", () => {
  it("passes a redirect through and decorates a local path", () => {
    expect(withDelivery({ redirectUrl: "https://x" }, { contentType: "image/png", inline: true }, "a.png")).toEqual({ redirectUrl: "https://x" });
    expect(withDelivery({ localPath: "/p" }, { contentType: "image/png", inline: true }, "a.png")).toEqual({
      localPath: "/p",
      contentType: "image/png",
      inline: true,
      originalFileName: "a.png"
    });
  });
});
