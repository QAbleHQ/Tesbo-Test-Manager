import { Injectable } from "@nestjs/common";
import { AppConfigService } from "../config/app-config.service";
import { DEFAULT_ANALYTICS_QUESTION_URL } from "./analytics-report.constants";

const USER_AGENT = "Tesbo Analytics Report (support@tesbo.io)";
const TIMEOUT_MS = 15_000;

/** Why the report cannot post, or null when every Basecamp setting is present. Never includes a value. */
export function missingBasecampConfig(c: AppConfigService): string | null {
  const missing = [
    ["BASECAMP_CLIENT_ID", c.basecampClientId],
    ["BASECAMP_CLIENT_SECRET", c.basecampClientSecret],
    ["BASECAMP_REFRESH_TOKEN", c.basecampRefreshToken],
    ["BASECAMP_ACCOUNT_ID", c.basecampAccountId]
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  return missing.length ? `missing ${missing.join(", ")}` : null;
}

/** ".../buckets/47793887/questions/10370979699" -> ids, or null when the URL is not a check-in question. */
export function parseQuestionUrl(url: string): { bucketId: string; questionId: string } | null {
  const m = /\/buckets\/(\d+)\/questions\/(\d+)/.exec(url);
  return m ? { bucketId: m[1], questionId: m[2] } : null;
}

@Injectable()
export class BasecampClient {
  constructor(private readonly config: AppConfigService) {}

  /**
   * Posts `html` as a check-in answer grouped on `groupOn` (the day the report is about, so a late or
   * retried post still lands under the right date). Returns the Basecamp answer id.
   *
   * The access token is exchanged from the refresh token on every call. Basecamp access tokens last
   * two weeks and the refresh token does not rotate, so a once-a-day job that refreshes each run never
   * holds an expired token and never has to persist a new one.
   */
  async postAnswer(html: string, groupOn: string): Promise<number> {
    const target = parseQuestionUrl(this.config.basecampAnalyticsQuestionUrl || DEFAULT_ANALYTICS_QUESTION_URL);
    if (!target) throw new Error("BASECAMP_ANALYTICS_QUESTION_URL is not a Basecamp check-in question URL");
    const token = await this.accessToken();
    const res = await fetch(
      `https://3.basecampapi.com/${this.config.basecampAccountId}/buckets/${target.bucketId}/questions/${target.questionId}/answers.json`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ content: html, group_on: groupOn }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      }
    );
    if (!res.ok) throw new Error(`Basecamp answer post failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { id?: number };
    if (typeof body.id !== "number") throw new Error("Basecamp answer post returned no id");
    return body.id;
  }

  private async accessToken(): Promise<string> {
    const params = new URLSearchParams({
      type: "refresh",
      client_id: this.config.basecampClientId,
      client_secret: this.config.basecampClientSecret,
      refresh_token: this.config.basecampRefreshToken
    });
    const res = await fetch(`https://launchpad.37signals.com/authorization/token?${params}`, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    // The body of a failed refresh can echo request details, so only the status is surfaced.
    if (!res.ok) throw new Error(`Basecamp token refresh failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) throw new Error("Basecamp token refresh returned no access_token");
    return body.access_token;
  }
}
