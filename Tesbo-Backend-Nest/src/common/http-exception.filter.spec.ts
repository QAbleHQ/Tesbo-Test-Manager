import type { ArgumentsHost } from "@nestjs/common";
import { HttpExceptionFilter } from "./http-exception.filter";
import { UnsafeOutboundUrlError } from "./safe-fetch";

function run(exception: unknown) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = { switchToHttp: () => ({ getResponse: () => ({ status }) }) } as unknown as ArgumentsHost;
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  new HttpExceptionFilter().catch(exception, host);
  return { status: status.mock.calls[0]?.[0], body: json.mock.calls[0]?.[0] };
}

describe("HttpExceptionFilter: a refused outbound URL is the caller's to fix", () => {
  afterEach(() => jest.restoreAllMocks());

  it("answers 400 with a code, not a 500 'Internal server error'", () => {
    const { status, body } = run(new UnsafeOutboundUrlError("The URL points at a private or internal address, which is not allowed."));
    expect(status).toBe(400);
    expect(body.code).toBe("ai_base_url_blocked");
    expect(body.error).toBe("AI provider base URL not allowed: The URL points at a private or internal address, which is not allowed.");
  });

  it("still answers an unrelated error with 500 and no detail", () => {
    const { status, body } = run(new Error("connect ECONNREFUSED 10.0.0.2:5432"));
    expect(status).toBe(500);
    expect(body).toEqual({ error: "Internal server error" });
  });
});
