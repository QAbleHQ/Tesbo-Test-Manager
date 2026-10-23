/*
 * Normalises API-call evidence into one shape the viewer can render.
 *
 * Two inputs are accepted, because both are what a CI job can produce without custom tooling:
 *   - a HAR (`{ log: { entries: [...] } }`), which browsers and proxies export;
 *   - Tesbo's own envelope — one call `{ method, url, status, durationMs, request, response }`,
 *     `{ calls: [...] }`, or a bare array of calls — where `request`/`response` carry `headers`
 *     (an object, or HAR-style `[{name, value}]`) and `body` (a string or any JSON value).
 *
 * Anything else yields no calls, which the viewer reports as "not recognised" instead of showing
 * an empty panel.
 */

export interface ApiCall {
  method: string;
  url: string;
  status: number | null;
  statusText: string | null;
  durationMs: number | null;
  request: ApiMessage;
  response: ApiMessage;
}

export interface ApiMessage {
  headers: Array<[string, string]>;
  body: string | null;
}

/** Headers whose values are credentials; shown as a marker, never rendered. Display-only redaction. */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
]);

export const REDACTED = "[redacted]";

export function redactHeaderValue(name: string, value: string): string {
  return SENSITIVE_HEADERS.has(name.toLowerCase()) ? REDACTED : value;
}

/** Bodies larger than this are cut for display; the full file is still one download away. */
export const MAX_BODY_DISPLAY_CHARS = 20_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toHeaders(raw: unknown): Array<[string, string]> {
  if (Array.isArray(raw)) {
    const out: Array<[string, string]> = [];
    for (const item of raw) {
      const rec = asRecord(item);
      if (rec && typeof rec.name === "string") out.push([rec.name, String(rec.value ?? "")]);
    }
    return out;
  }
  const rec = asRecord(raw);
  if (!rec) return [];
  return Object.entries(rec).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")]);
}

function toBody(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") {
    // A JSON string body is pretty-printed; anything else (HTML, form data, plain text) is shown as-is.
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }
  return JSON.stringify(raw, null, 2);
}

function toNumber(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

function fromHarEntry(entry: Record<string, unknown>): ApiCall | null {
  const req = asRecord(entry.request);
  const res = asRecord(entry.response);
  if (!req || typeof req.url !== "string") return null;
  const postData = asRecord(req.postData);
  const content = asRecord(res?.content);
  const time = toNumber(entry.time);
  return {
    method: typeof req.method === "string" ? req.method.toUpperCase() : "GET",
    url: req.url,
    status: toNumber(res?.status),
    statusText: typeof res?.statusText === "string" && res.statusText ? res.statusText : null,
    durationMs: time !== null && time >= 0 ? Math.round(time) : null,
    request: { headers: toHeaders(req.headers), body: toBody(postData?.text) },
    response: { headers: toHeaders(res?.headers), body: toBody(content?.text) },
  };
}

function fromEnvelopeCall(call: Record<string, unknown>): ApiCall | null {
  if (typeof call.url !== "string") return null;
  const req = asRecord(call.request);
  const res = asRecord(call.response);
  return {
    method: typeof call.method === "string" ? call.method.toUpperCase() : "GET",
    url: call.url,
    status: toNumber(call.status ?? res?.status),
    statusText: typeof call.statusText === "string" && call.statusText ? call.statusText : null,
    durationMs: toNumber(call.durationMs),
    request: { headers: toHeaders(req?.headers), body: toBody(req?.body) },
    response: { headers: toHeaders(res?.headers), body: toBody(res?.body) },
  };
}

export function parseApiEvidence(data: unknown): ApiCall[] {
  const root = asRecord(data);
  const har = asRecord(root?.log);
  if (har && Array.isArray(har.entries)) {
    return har.entries
      .map((e) => asRecord(e))
      .filter((e): e is Record<string, unknown> => e !== null)
      .map(fromHarEntry)
      .filter((c): c is ApiCall => c !== null);
  }
  const list: unknown[] = Array.isArray(data) ? data : Array.isArray(root?.calls) ? (root!.calls as unknown[]) : root ? [root] : [];
  return list
    .map((e) => asRecord(e))
    .filter((e): e is Record<string, unknown> => e !== null)
    .map(fromEnvelopeCall)
    .filter((c): c is ApiCall => c !== null);
}

export function truncateBody(body: string): { text: string; truncated: boolean } {
  return body.length > MAX_BODY_DISPLAY_CHARS
    ? { text: body.slice(0, MAX_BODY_DISPLAY_CHARS), truncated: true }
    : { text: body, truncated: false };
}
