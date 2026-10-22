// IANA timezones for the workspace timezone picker. The browser knows the full list; the fallback is a
// short list of common zones for an engine without Intl.supportedValuesOf. A zone the workspace already
// uses is always included, so a saved value never disappears from its own dropdown.

const FALLBACK = [
  "UTC",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Moscow",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Africa/Johannesburg",
  "Pacific/Auckland",
];

export function timezoneOptions(current?: string | null): string[] {
  let zones: string[] = FALLBACK;
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone");
    if (supported?.length) zones = supported.includes("UTC") ? supported : ["UTC", ...supported];
  } catch {
    // keep the fallback list
  }
  return current && !zones.includes(current) ? [current, ...zones] : zones;
}
