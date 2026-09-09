/**
 * Parses a buffered Server-Sent Events response body (the W3C event-stream format Nest's built-in
 * SSE writer emits — see @nestjs/core/router/sse-stream.js) into the JSON payload of each `data:`
 * field, in arrival order. Ignores `id:`/`event:`/`retry:` lines and blank keep-alive frames.
 *
 * Works against a body captured AFTER the stream has fully closed (Playwright's `response.text()`
 * only resolves once the connection ends) — fine for this suite's use, since every stream under
 * test is designed to terminate on its own (see zyra-progress.service.ts's file header: a turn
 * always eventually completes or errors, and an unknown/foreign turnId closes immediately).
 */
export function parseSseEvents(body: string): unknown[] {
  const blocks = body.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  const events: unknown[] = [];
  for (const block of blocks) {
    const dataLines = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""));
    if (!dataLines.length) continue;
    try {
      events.push(JSON.parse(dataLines.join("\n")));
    } catch {
      events.push(dataLines.join("\n"));
    }
  }
  return events;
}
