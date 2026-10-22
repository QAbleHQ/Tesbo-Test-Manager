import * as dns from "dns";
import * as http from "http";
import * as https from "https";
import { BlockList, isIP } from "net";
import { Readable, Transform } from "stream";

/*
 * Outbound requests to an address a user typed in.
 *
 * A workspace owner can point an AI provider at any base URL, and the server then calls it with the
 * stored API key. Anyone can sign up and own a workspace, so "the owner chose it" is not a trust
 * boundary: a base URL of http://169.254.169.254/ makes this server read its own cloud metadata, and
 * http://redis:6379 or http://backend:1021 reaches whatever sits on the private network. The reply
 * comes back to the caller as the provider's "error", so it is not even blind.
 *
 * What this enforces, on every request and not only when the URL is saved (a name can be pointed
 * somewhere else after it was checked):
 *   - https only, no `user:pass@`. Plain http sends the API key in the clear.
 *   - The name is resolved HERE, every address it resolves to is checked (a name that answers with one
 *     public and one private address is the rebinding trick), and the connection is then made to the
 *     address that was checked, not to the name again, so DNS cannot change its answer in between.
 *   - Loopback, private, link-local, CGNAT, documentation, multicast and reserved ranges are refused,
 *     including IPv4-mapped IPv6, NAT64 and 6to4 forms that wrap a private IPv4 address.
 *   - A redirect is never followed, so a public URL cannot bounce the request inward.
 *   - The response is capped in size, so an endpoint that never stops cannot fill memory.
 *
 * Self-hosted runtimes (Ollama, LM Studio, vLLM) legitimately live on private addresses, so
 * ALLOW_PRIVATE_AI_HOSTS=true lets private ranges and plain http through. It never lets through the
 * cloud metadata and link-local ranges, or "this host" and multicast, which no runtime lives on.
 */

export class UnsafeOutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeOutboundUrlError";
  }
}

/** Off unless explicitly turned on: a hosted deployment must not reach its own network. */
export function allowPrivateAiHosts(): boolean {
  return String(process.env.ALLOW_PRIVATE_AI_HOSTS ?? "").trim().toLowerCase() === "true";
}

function blockList(v4: string[], v6: string[]): BlockList {
  const list = new BlockList();
  for (const cidr of v4) {
    const [address, prefix] = cidr.split("/");
    list.addSubnet(address, Number(prefix), "ipv4");
  }
  for (const cidr of v6) {
    const [address, prefix] = cidr.split("/");
    list.addSubnet(address, Number(prefix), "ipv6");
  }
  return list;
}

/** Never reachable, whatever the deployment: nothing legitimate is here, and some of it is the metadata service. */
const ALWAYS_BLOCKED = blockList(
  [
    "0.0.0.0/8", // "this host": 0.0.0.0 connects to the local machine on Linux
    "169.254.0.0/16", // link-local, which is where AWS, GCP, Azure and OpenStack serve instance metadata
    "100.100.100.200/32", // Alibaba Cloud metadata
    "224.0.0.0/4", // multicast
    "240.0.0.0/4" // reserved, and 255.255.255.255 broadcast
  ],
  [
    "::/96", // unspecified and the deprecated IPv4-compatible form
    "fe80::/10", // link-local
    "fd00:ec2::/32", // AWS IMDS over IPv6
    "ff00::/8" // multicast
  ]
);

/** Private networks: refused on a hosted deployment, allowed for a self-hosted one. */
const PRIVATE = blockList(
  [
    "10.0.0.0/8",
    "100.64.0.0/10", // carrier-grade NAT
    "127.0.0.0/8", // loopback
    "172.16.0.0/12",
    "192.0.0.0/24", // IETF protocol assignments
    "192.0.2.0/24", // documentation
    "192.168.0.0/16",
    "198.18.0.0/15", // benchmarking
    "198.51.100.0/24", // documentation
    "203.0.113.0/24" // documentation
  ],
  [
    "::1/128", // loopback
    "fc00::/7", // unique local
    "fec0::/10", // deprecated site-local
    "2001:db8::/32", // documentation
    "2001::/32", // Teredo
    "2002::/16", // 6to4: wraps an IPv4 address, so a private one hides in it
    "64:ff9b::/96", // NAT64: the same
    "64:ff9b:1::/48",
    "100::/64" // discard
  ]
);

/** ::1 sits inside ::/96, which is blocked as a whole, so loopback is picked out first and treated as private. */
const LOOPBACK_V6 = blockList([], ["::1/128"]);

export type AddressClass = "public" | "private" | "blocked";

/** Turns `::ffff:a.b.c.d` (and its hex form `::ffff:7f00:1`) back into the IPv4 address it wraps. */
function unwrapMapped(address: string): string {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return address;
}

export function classifyAddress(raw: string): AddressClass {
  const address = unwrapMapped(String(raw).replace(/^\[|\]$/g, "").split("%")[0]);
  const family = isIP(address);
  if (family === 0) return "blocked"; // not an address at all: never treat as public
  const type = family === 4 ? "ipv4" : "ipv6";
  if (family === 6 && LOOPBACK_V6.check(address, "ipv6")) return "private";
  if (ALWAYS_BLOCKED.check(address, type)) return "blocked";
  if (PRIVATE.check(address, type)) return "private";
  return "public";
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet", ".corp", ".localdomain"];

/** Names that only ever resolve inside one machine or network: refused before any lookup. */
function isLocalName(host: string): boolean {
  if (host === "localhost") return true;
  // A single label ("backend", "redis", "postgres") only resolves inside one Docker network.
  if (!host.includes(".")) return true;
  return LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

// Deliberately says nothing about which address it resolved to: that would turn the error into a map of the network.
const INTERNAL_MESSAGE = "The URL points at a private or internal address, which is not allowed.";

const MAX_URL_LENGTH = 2048;

/** Everything that can be decided without the network. Returns the parsed URL. */
export function assertSafeUrlSyntax(raw: string, allowPrivate = allowPrivateAiHosts()): URL {
  const text = String(raw ?? "").trim();
  if (!text) throw new UnsafeOutboundUrlError("The URL is empty.");
  if (text.length > MAX_URL_LENGTH) throw new UnsafeOutboundUrlError("The URL is too long.");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new UnsafeOutboundUrlError("The URL is not valid. Use the full address, for example https://api.example.com/v1.");
  }
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) {
    throw new UnsafeOutboundUrlError(
      allowPrivate ? "The URL must start with https:// or http://." : "The URL must start with https://. Plain http is not accepted because it sends the API key unencrypted."
    );
  }
  if (url.username || url.password) throw new UnsafeOutboundUrlError("The URL must not contain a username or password.");

  // The WHATWG parser has already folded 2130706433, 0x7f.1 and 017700000001 into 127.0.0.1.
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) throw new UnsafeOutboundUrlError("The URL has no host.");
  if (isIP(host)) {
    const kind = classifyAddress(host);
    if (kind === "blocked" || (kind === "private" && !allowPrivate)) throw new UnsafeOutboundUrlError(INTERNAL_MESSAGE);
  } else if (!allowPrivate && isLocalName(host)) {
    throw new UnsafeOutboundUrlError(INTERNAL_MESSAGE);
  }
  return url;
}

export interface ResolvedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

type Lookup = (host: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;

/**
 * Syntax check, then DNS, then a check of EVERY address the name resolves to. Returns the address to
 * connect to: the caller must use it rather than the name.
 */
export async function resolveSafeTarget(
  raw: string,
  options: { allowPrivate?: boolean; lookup?: Lookup } = {}
): Promise<ResolvedTarget> {
  const allowPrivate = options.allowPrivate ?? allowPrivateAiHosts();
  const url = assertSafeUrlSyntax(raw, allowPrivate);
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  let addresses: Array<{ address: string; family: number }>;
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    const lookup: Lookup = options.lookup ?? ((name, opts) => dns.promises.lookup(name, opts));
    try {
      addresses = await lookup(host, { all: true, verbatim: true });
    } catch {
      throw new UnsafeOutboundUrlError("The host name could not be resolved.");
    }
  }
  if (!addresses.length) throw new UnsafeOutboundUrlError("The host name could not be resolved.");
  for (const { address } of addresses) {
    const kind = classifyAddress(address);
    if (kind === "blocked" || (kind === "private" && !allowPrivate)) throw new UnsafeOutboundUrlError(INTERNAL_MESSAGE);
  }
  const chosen = addresses[0];
  return { url, address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}

/** For saving a URL: the same rules, so a bad one is refused when typed instead of when first used. */
export async function assertSafeBaseUrl(raw: string, options: { allowPrivate?: boolean; lookup?: Lookup } = {}): Promise<void> {
  await resolveSafeTarget(raw, options);
}

export interface SafeFetchOptions {
  allowPrivate?: boolean;
  /** Largest response body accepted, in bytes. */
  maxBytes?: number;
  /** Ceiling for the whole request, in ms, in addition to any signal the caller passes. */
  timeoutMs?: number;
  lookup?: Lookup;
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const NO_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * A drop-in for `fetch` that refuses internal addresses, pins the connection to the address it
 * checked, never follows a redirect and caps the response. Returns an ordinary `Response`.
 */
export async function safeFetch(input: string | URL, init: RequestInit = {}, options: SafeFetchOptions = {}): Promise<Response> {
  const target = await resolveSafeTarget(String(input), options);
  const { url } = target;

  // Letting `Request` normalise the body and headers means a string, a URLSearchParams and a FormData
  // (the audio upload) all work, with the right content-type and multipart boundary.
  const normalised = new Request(url.toString(), {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body ?? undefined
  });
  const body = normalised.body ? Buffer.from(await normalised.arrayBuffer()) : null;
  const headers: Record<string, string> = {};
  normalised.headers.forEach((value, key) => (headers[key] = value));
  // No automatic decompression here, and no need for it: ask for the bytes as they are.
  if (!headers["accept-encoding"]) headers["accept-encoding"] = "identity";
  if (body) headers["content-length"] = String(body.length);

  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const callerSignal = init.signal ?? undefined;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => controller.abort(new DOMException("The request timed out.", "TimeoutError")), timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    };
    const fail = (error: unknown) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    if (callerSignal?.aborted) return fail(callerSignal.reason ?? new DOMException("Aborted", "AbortError"));
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

    const request = lib.request(
      {
        protocol: url.protocol,
        hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: normalised.method,
        headers,
        // One connection per request: a pooled socket would be keyed by name, not by the address checked.
        agent: false,
        // The connection goes to the address that was just checked. The name is kept for the Host
        // header and for TLS (SNI and certificate validation), which still verify the real host.
        lookup: ((_host: string, opts: { all?: boolean }, callback: (...args: unknown[]) => void) => {
          if (opts && opts.all) callback(null, [{ address: target.address, family: target.family }]);
          else callback(null, target.address, target.family);
        }) as never,
        signal: controller.signal
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && status !== 304) {
          res.resume();
          return fail(
            new UnsafeOutboundUrlError(
              `The server answered with a redirect (HTTP ${status}). Redirects are not followed; use the final address as the base URL.`
            )
          );
        }
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) value.forEach((v) => responseHeaders.append(name, v));
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        let payload: ReadableStream | null = null;
        if (!NO_BODY_STATUSES.has(status) && normalised.method !== "HEAD") {
          let seen = 0;
          const limiter = new Transform({
            transform(chunk: Buffer, _encoding, done) {
              seen += chunk.length;
              if (seen > maxBytes) done(new UnsafeOutboundUrlError("The response is larger than the allowed size."));
              else done(null, chunk);
            }
          });
          // Errors on either side must reach the reader, not crash the process as an unhandled 'error'.
          res.on("error", (error) => limiter.destroy(controller.signal.aborted && controller.signal.reason ? controller.signal.reason : error));
          payload = Readable.toWeb(res.pipe(limiter)) as unknown as ReadableStream;
        } else {
          res.resume();
        }
        res.on("close", cleanup);
        if (settled) return;
        settled = true;
        resolve(new Response(payload, { status, statusText: res.statusMessage ?? "", headers: responseHeaders }));
      }
    );
    request.on("error", (error) => {
      // fetch rejects with the signal's own reason (a TimeoutError or AbortError), which callers test for by name.
      if (controller.signal.aborted && controller.signal.reason) return fail(controller.signal.reason);
      fail(error);
    });
    if (body) request.write(body);
    request.end();
  });
}
