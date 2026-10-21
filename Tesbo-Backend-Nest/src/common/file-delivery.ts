import type { Response } from "express";

/*
 * How an uploaded file is allowed to leave the server.
 *
 * Uploads are attacker-supplied content served from the API's own origin, and the Content-Type that
 * came with them is whatever the uploader's client claimed. It used to be stored as sent and echoed
 * back, and a few routes honoured it for `Content-Disposition: inline`, so a member could upload
 * `x.txt` as `text/html`, or `x.png` as `image/svg+xml`, open the preview URL, and run script in the
 * application's origin with the viewer's session behind it.
 *
 * The rules, none of which trusts the uploader:
 *   1. Active types (HTML, XML, JS, CSS ...) are downgraded to `text/plain`, so a browser shows the
 *      source instead of executing it.
 *   2. A file is only ever rendered inline if its type is on a short allowlist of formats that cannot
 *      run script (raster images, PDF, audio, video, plain text). SVG can, so it is always a download:
 *      an <img src> still draws it, but opening the URL directly saves it instead of running it.
 *      Everything else is a download too.
 *   3. Responses carry `X-Content-Type-Options: nosniff`, so a browser cannot decide a `text/plain`
 *      body is HTML after all, and a `Content-Security-Policy: sandbox` that strips script, forms and
 *      same-origin access even from a document that did get rendered.
 *   4. A type that is not a well-formed `type/subtype` token (header injection, junk) is dropped.
 * The same function runs at upload and again at download, so rows stored before this existed, with
 * the uploader's raw type, are made safe without a backfill.
 */

const OCTET_STREAM = "application/octet-stream";
const TEXT_PLAIN = "text/plain";

// A media type is `type "/" subtype` of token characters (RFC 7231). Anything else, including CR/LF,
// quotes and spaces, is not one and is never put in a header.
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** Types a browser can execute or interpret as a document. Shown as source, never rendered. */
const ACTIVE_TO_TEXT = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/xml",
  "application/xml",
  "text/xsl",
  "application/xslt+xml",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "text/ecmascript",
  "application/ecmascript",
  "text/css",
  "text/cache-manifest",
  "text/x-component"
]);

/** Types that may be sent with `Content-Disposition: inline`. SVG is deliberately absent. */
const INLINE_SAFE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "application/pdf",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/webm",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json"
]);

/** Extensions whose type is known when the client sent none or sent something unusable. */
const EXTENSION_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json"
};

function baseType(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  // Parameters (`; charset=...`, `; boundary=...`) are the uploader's, not ours to echo.
  const base = raw.split(";")[0].trim().toLowerCase();
  return MEDIA_TYPE.test(base) ? base : null;
}

function extensionOf(fileName: string | null | undefined): string {
  const name = String(fileName ?? "");
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * The Content-Type to store for an upload: a bare `type/subtype`, never `text/html` or another active
 * type, never malformed, and never wider than what the file's name or the uploader's own claim supports.
 */
export function safeContentType(clientType: string | null | undefined, fileName?: string | null): string {
  const claimed = baseType(clientType);
  // `application/octet-stream` is what clients send when they have no idea; the extension is the
  // better guess then.
  const type = claimed && claimed !== OCTET_STREAM ? claimed : (EXTENSION_TYPES[extensionOf(fileName)] ?? claimed ?? OCTET_STREAM);
  return ACTIVE_TO_TEXT.has(type) ? TEXT_PLAIN : type;
}

/** The header form of a stored type: text gets an explicit charset so it is never guessed. */
function headerType(type: string): string {
  return type.startsWith("text/") ? `${type}; charset=utf-8` : type;
}

export interface FileDelivery {
  /** Value for the Content-Type header (and S3's ResponseContentType). */
  contentType: string;
  /** True only when the browser may render the file in place. */
  inline: boolean;
}

/** What to send for a stored file, given the type recorded at upload and whether inline was asked for. */
export function resolveFileDelivery(storedType: string | null | undefined, fileName: string | null | undefined, wantInline: boolean): FileDelivery {
  const type = safeContentType(storedType, fileName);
  return { contentType: headerType(type), inline: wantInline && INLINE_SAFE.has(type) };
}

/**
 * A file the server itself knows to be text by its extension (a .py, .sql, .yaml ...), shown in the
 * preview pane. The uploader's claimed type for these is unreliable (Chrome says `video/mp2t` for a
 * .ts), so the preview does not consult it: it is plain text, rendered as text.
 */
export const PLAIN_TEXT_DELIVERY: FileDelivery = { contentType: "text/plain; charset=utf-8", inline: true };

/** Attaches the decided delivery to what `StorageService.getAccessUrl` returned, ready for `sendStoredFile`. */
export function withDelivery(access: { redirectUrl: string } | { localPath: string }, delivery: FileDelivery, originalFileName: string): StoredFileAccess {
  return "redirectUrl" in access ? access : { ...access, ...delivery, originalFileName };
}

/** Types a browser draws without a document that script could run in, so a sandbox CSP adds nothing and can break the viewer. */
function exemptFromSandbox(contentType: string): boolean {
  const base = baseType(contentType) ?? "";
  return base === "application/pdf" || base.startsWith("video/") || base.startsWith("audio/");
}

/** Sets every header a file response needs, so no route can forget one. */
export function applyFileHeaders(res: Response, delivery: FileDelivery, fileName: string): void {
  res.setHeader("Content-Type", delivery.contentType);
  // encodeURIComponent leaves no quote, CR or LF in the value, so a hostile filename cannot split the header.
  res.setHeader("Content-Disposition", `${delivery.inline ? "inline" : "attachment"}; filename="${encodeURIComponent(fileName)}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (!exemptFromSandbox(delivery.contentType)) {
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'");
  }
}

export interface ServedFile {
  contentType: string;
  inline: boolean;
  originalFileName: string;
}
export type StoredFileAccess = { redirectUrl: string } | (ServedFile & { buffer: Buffer }) | (ServedFile & { localPath: string });

/**
 * Sends a stored file the way `StorageService.getAccessUrl` / a service's own read described it: a
 * redirect to a presigned URL (the type and disposition were already pinned into that URL), the
 * buffered bytes, or the file on local disk. The one place the headers above are applied, so the
 * route handlers cannot drift apart.
 */
export function sendStoredFile(res: Response, access: StoredFileAccess): void {
  if ("redirectUrl" in access) {
    res.redirect(302, access.redirectUrl);
    return;
  }
  applyFileHeaders(res, { contentType: access.contentType, inline: access.inline }, access.originalFileName);
  if ("buffer" in access && access.buffer) {
    res.send(access.buffer);
    return;
  }
  if ("localPath" in access && access.localPath) {
    res.sendFile(access.localPath);
    return;
  }
  throw new Error("File content unavailable");
}
