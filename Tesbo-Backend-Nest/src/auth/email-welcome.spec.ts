import { EmailService } from "./email.service";
import { AppConfigService } from "../config/app-config.service";
import { EmailDeliveryPolicy } from "../config/email-delivery.policy";

/**
 * EmailService.sendWelcome — the approved welcome email, asserted on the exact payload posted to
 * Postmark. Live mode, fetch mocked, for the same reason as email-invite.spec.ts: the send is then the
 * only fetch in play.
 */
function makeService(configOverrides: Partial<Record<string, unknown>> = {}) {
  const config = {
    postmarkApiToken: "pm-token",
    postmarkFromEmail: "noreply@tesbo.io",
    emailDeliveryMode: "live",
    frontendUrl: "https://app.tesbo.io",
    ...configOverrides
  } as unknown as AppConfigService;
  return new EmailService(config, new EmailDeliveryPolicy(config));
}

type Posted = { From: string; To: string; Cc?: string; Subject: string; TextBody: string; HtmlBody: string };

describe("EmailService.sendWelcome", () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true, text: jest.fn() });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // Options object rather than defaulted positional params: passing `undefined` to a defaulted
  // parameter silently substitutes the default, which would make "no CC" untestable.
  async function send(opts: { to?: string; cc?: string | null; firstName?: string } = {}) {
    const cc = opts.cc === null ? undefined : (opts.cc ?? "cc-inbox@example.test");
    await makeService().sendWelcome(opts.to ?? "qa-inbox@example.test", cc, opts.firstName ?? "Ada");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.postmarkapp.com/email");
    return JSON.parse(init.body) as Posted;
  }

  it("posts to exactly the recipient and CC it was given, with the approved subject", async () => {
    const body = await send({ to: "qa-inbox@example.test", cc: "cc-inbox@example.test" });
    expect(body.To).toBe("qa-inbox@example.test");
    expect(body.Cc).toBe("cc-inbox@example.test");
    expect(body.From).toBe("noreply@tesbo.io");
    expect(body.Subject).toBe("Welcome to Tesbo Test Manager");
  });

  it("sends no Cc field at all when no CC is configured", async () => {
    const body = await send({ cc: null });
    expect("Cc" in body).toBe(false);
  });

  it("renders the first name in bold and every 'Tesbo Test Manager' in bold", async () => {
    const { HtmlBody } = await send({ firstName: "Ada" });
    expect(HtmlBody).toContain("Hi <strong>Ada</strong>,");
    const all = HtmlBody.match(/Tesbo Test Manager/g) ?? [];
    const bold = HtmlBody.match(/<strong>Tesbo Test Manager<\/strong>/g) ?? [];
    // Header, "Thank you for Choosing", "explore", signature, footer.
    expect(all.length).toBe(5);
    expect(bold.length).toBe(all.length);
  });

  it("carries the approved copy, in order", async () => {
    const { HtmlBody } = await send();
    const text = HtmlBody.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
    const lines = [
      "Hi Ada,",
      "Thank you for Choosing Tesbo Test Manager!",
      "We noticed that you recently created your account, and we wanted to make sure you have everything you need to get started.",
      "You can now log in to your account and explore Tesbo Test Manager. If you have any questions or need assistance, our team is happy to help.",
      "Get started",
      "We look forward to having you with us!",
      "Best regards,",
      "Tesbo Test Manager"
    ];
    let from = 0;
    for (const line of lines) {
      const at = text.indexOf(line, from);
      expect(at).toBeGreaterThanOrEqual(from);
      from = at + line.length;
    }
  });

  it("makes 'Get started' a real green button linking to FRONTEND_URL/login", async () => {
    const { HtmlBody } = await send();
    const anchor = HtmlBody.match(/<a href="([^"]+)"[^>]*>Get started<\/a>/);
    expect(anchor).not.toBeNull();
    expect(anchor![1]).toBe("https://app.tesbo.io/login");
    expect(anchor![0]).toContain("display:inline-block");
    // The green fill sits on the button's cell (the bulletproof-button pattern) — the <a> is inside it.
    expect(HtmlBody).toMatch(/<td style="background:#16A34A[^"]*"><a href="https:\/\/app\.tesbo\.io\/login"/);
    // And the existing orange helper colour is not what this email uses.
    expect(HtmlBody).not.toContain("#E8600A");
  });

  it("leaves no template brackets in either body", async () => {
    const { HtmlBody, TextBody } = await send();
    for (const body of [HtmlBody, TextBody]) {
      expect(body).not.toMatch(/\{\{|\}\}/);
      expect(body).not.toContain("First Name");
    }
  });

  it("includes the same content as plain text, with the login URL", async () => {
    const { TextBody } = await send();
    expect(TextBody).toBe(
      "Hi Ada,\n\nThank you for Choosing Tesbo Test Manager!\n\n" +
        "We noticed that you recently created your account, and we wanted to make sure you have everything you need to get started.\n\n" +
        "You can now log in to your account and explore Tesbo Test Manager. If you have any questions or need assistance, our team is happy to help.\n\n" +
        "Get started: https://app.tesbo.io/login\n\n" +
        "We look forward to having you with us!\n\nBest regards,\nTesbo Test Manager"
    );
  });

  it("HTML-escapes the first name, so a name cannot inject markup", async () => {
    const { HtmlBody } = await send({ firstName: `<img src=x onerror="a">` });
    expect(HtmlBody).toContain("<strong>&lt;img src=x onerror=&quot;a&quot;&gt;</strong>");
    expect(HtmlBody).not.toContain("<img");
  });

  it("throws on a Postmark error, so the BullMQ job can retry", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: jest.fn().mockResolvedValue("boom") });
    await expect(makeService().sendWelcome("qa-inbox@example.test", undefined, "Ada")).rejects.toThrow("Postmark returned 500");
  });
});
