import { isIP } from "net";

/*
 * The base URL for a link Tesbo places in ANOTHER system (a Jira or Linear comment) — somewhere
 * people other than the deployment's own user will click it, from their own machines.
 *
 * Returns null when the configured address could only ever work on the machine or network that
 * produced it: a local stack's FRONTEND_URL is http://localhost:1020, and a comment linking there
 * opens each reader's OWN localhost. The caller then writes plain text instead of a broken link.
 *
 * Deliberately a hostname check, not a network probe: "reachable from outside" can't be proven from
 * inside the deployment, but "certainly not reachable from outside" can — loopback, private and
 * link-local ranges, and names that only resolve locally.
 */
export function externallyReachableBaseUrl(raw: string | null | undefined): string | null {
  const value = String(raw || "").trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || isMachineLocalHost(host)) return null;
  // Origin plus any path prefix the app is served under (e.g. https://example.com/tesbo), no trailing slash.
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function isMachineLocalHost(host: string): boolean {
  const ipVersion = isIP(host);
  if (ipVersion === 4) return isPrivateIpv4(host);
  if (ipVersion === 6) return isPrivateIpv6(host);
  // A single-label name ("backend", "frontend") only resolves inside one network, e.g. Docker's.
  if (!host.includes(".")) return true;
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa")
  );
}

function isPrivateIpv4(host: string): boolean {
  const [a, b] = host.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIpv6(host: string): boolean {
  if (host === "::" || host === "::1") return true;
  // IPv4-mapped (::ffff:a.b.c.d) — WHATWG URL parsing normalizes it to hex (::ffff:7f00:1), so both.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (mapped) return isPrivateIpv4(mapped[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16);
    const low = parseInt(mappedHex[2], 16);
    return isPrivateIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  const first = parseInt(host.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; // fc00::/7 unique-local, fe80::/10 link-local
}
