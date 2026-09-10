import { BadRequestException } from "@nestjs/common";

// E.164-ish: "+", then 2-15 digits (country code + subscriber number). Matches the CHECK constraint
// on users.mobile_number / pending_signups.mobile_number (see V105_user_profile_fields.sql).
const MOBILE_NUMBER_RE = /^\+[1-9]\d{6,14}$/;

/**
 * Mobile number is optional everywhere it's collected: `undefined`/empty returns null rather than
 * throwing. When a value is given, it must already look like a normalized "+<country code><digits>"
 * string — the frontend strips spaces/dashes/parens before sending it, so a malformed value here
 * means the input truly doesn't parse as a phone number, not just loose formatting.
 */
export function validateMobileNumber(raw: string | undefined | null): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  if (!MOBILE_NUMBER_RE.test(trimmed)) {
    throw new BadRequestException({ error: "Mobile number must include a country code, e.g. +14155551234" });
  }
  return trimmed;
}
