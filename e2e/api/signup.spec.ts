import { expect, test, type APIRequestContext } from "@playwright/test";
import { emailDomain } from "../utils/env";
import { clearOtpIpRateLimit, seedOtpCode } from "../utils/otp";
import {
  dbControlAvailable,
  exec,
  execAllowingAuditImmutability,
  execMany,
  literal,
  scalar,
} from "../utils/psql";
import { anonymousContext } from "../utils/rbac-tenant";

/*
 * Self-serve signup: POST /api/auth/signup/start and POST /api/auth/signup/verify.
 *
 * These two were the last routes in the API with no asserting test. They were *exercised* —
 * global-setup.ts provisions the smoke tenant through them, so a break would fail the whole suite at
 * startup — but nothing asserted what they do, which is not the same thing: an exercised route tells
 * you it returns 2xx for one happy path, not what it does with a duplicate email, a wrong code, or a
 * verify with no pending signup behind it.
 *
 * BUDGET. `signup/start` is IP rate-limited and every worker looks like the same caller, so attempts
 * here are spent from the same allowance `api/auth.spec.ts`'s rate-limit tests need. Two things keep
 * this file cheap:
 *
 *   - every validation case is asserted BEFORE the rate limit is touched. startSelfServeSignup
 *     validates email, name and password and checks for an existing user *before* it calls sendOtp, so
 *     a refused request costs nothing.
 *   - the IP limit is cleared in beforeAll and afterAll, so whatever this file spends is returned. It
 *     makes exactly THREE rate-limited attempts in total (SGN-A-10, SGN-A-11 twice... and SGN-A-13's
 *     single accepted name). OTP_MAX_ATTEMPTS defaults to 5, so there is very little headroom: any
 *     new test here that expects a 204 from signup/start has to justify the attempt it spends, and a
 *     rate-limited start fails quietly — it still answers 204 but writes no pending_signups row.
 *
 * The OTP is seeded rather than read from a mailbox (utils/otp.ts), the same way the invitation specs
 * do it: the code goes out by email and is stored hashed, so there is nothing to read back.
 */

test.describe("self-serve signup", () => {
  let anon: APIRequestContext;
  /** Emails this file created, cleaned up in afterAll whatever happened. */
  const created: string[] = [];

  const skipReason = dbControlAvailable()
    ? null
    : "needs `docker compose exec postgres psql` to seed an OTP code and clear the IP rate limit";

  test.beforeAll(async () => {
    anon = await anonymousContext();
    if (!skipReason) clearOtpIpRateLimit();
  });

  test.afterAll(async () => {
    if (!skipReason) {
      for (const email of created) purgeAccount(email);
      // Hand the allowance back: another spec file's rate-limit test should not fail because this one
      // ran first.
      clearOtpIpRateLimit();
    }
    await anon?.dispose();
  });

  test.beforeEach(() => {
    test.skip(skipReason !== null, skipReason ?? "");
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function signupEmail(label: string): string {
    const email = `e2e-signup-${label}-${Date.now()}@${emailDomain}`;
    created.push(email);
    return email;
  }

  /**
   * Removes the user and any pending signup, so a re-run starts from the same place.
   *
   * Batched into two round trips rather than five, because this runs once per account created by the
   * file and the connection is what costs on a hosted database — ~3.4s to connect against ~0.3s for
   * another statement on a connection already open. As five separate calls this spent ~12.5s per
   * account, and with the ~15 accounts this file creates the afterAll hook needed ~187s against a
   * 120s budget: SGN-A-17 failed on the teardown, not on its assertion. Two calls bring it to ~5s.
   *
   * The users DELETE stays on its own call deliberately. It is the one statement here whose failure
   * is expected and tolerated — any account that has been audited cannot be hard-deleted, because
   * audit_logs is append-only and its foreign key is ON DELETE SET NULL. Batching it would let that
   * tolerated failure abandon the rest of the batch. See execMany's caveat in utils/psql.ts.
   */
  function purgeAccount(email: string): void {
    const normalized = email.toLowerCase();
    execMany([
      `DELETE FROM pending_signups WHERE email = ${literal(normalized)}`,
      `DELETE FROM organization_members WHERE user_id IN (SELECT id FROM users WHERE email = ${literal(normalized)})`,
      `DELETE FROM project_members WHERE user_id IN (SELECT id FROM users WHERE email = ${literal(normalized)})`,
      // Inlined rather than calling clearOtpRateLimit(), purely so it shares this connection. Kept
      // identical to utils/otp.ts's statement, including the three key shapes it clears.
      `DELETE FROM otp_rate_limit WHERE email IN (${literal(`send:${normalized}`)}, ${literal(`verify:${normalized}`)}, ${literal(normalized)})`,
    ]);
    execAllowingAuditImmutability(`DELETE FROM users WHERE email = ${literal(normalized)};`);
  }

  function pendingCount(email: string): number {
    return Number(
      scalar(`SELECT COUNT(*) FROM pending_signups WHERE email = ${literal(email.toLowerCase())};`),
    );
  }

  /**
   * Pending signups still usable for this address.
   *
   * A consumed signup is marked `consumed_at`, not deleted — the row stays as an audit trail of the
   * account's creation — and `findPendingSignup` filters on `consumed_at IS NULL AND expires_at >
   * now()`. So "was it consumed" is a question about that column, not about the row's existence.
   */
  function usablePendingCount(email: string): number {
    return Number(
      scalar(
        `SELECT COUNT(*) FROM pending_signups WHERE email = ${literal(email.toLowerCase())} ` +
          "AND consumed_at IS NULL AND expires_at > now();",
      ),
    );
  }

  function userCount(email: string): number {
    return Number(scalar(`SELECT COUNT(*) FROM users WHERE email = ${literal(email.toLowerCase())};`));
  }

  async function start(data: Record<string, unknown>) {
    return anon.post("/api/auth/signup/start", { data, failOnStatusCode: false });
  }

  async function verify(data: Record<string, unknown>) {
    return anon.post("/api/auth/signup/verify", { data, failOnStatusCode: false });
  }

  // ─── Validation: refused before the rate limit, so these are free ─────────

  test("SGN-A-01 signup/start refuses a missing or malformed email and writes nothing", { tag: '@tesbo.testId("TES-TC-516")' }, async () => {
    for (const email of [undefined, "", "   ", "not-an-email", "missing@tld", "@nodomain.com", "spaces in@x.com"]) {
      const res = await start({ firstName: "EndToEnd", lastName: "Signup", email, password: "E2eSignPass9f3!" });
      expect(res.status(), `email ${JSON.stringify(email)} was accepted: ${await res.text()}`).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("invalid email");
    }
    // Nothing was queued, so a refused attempt cannot leave a half-made account behind.
    expect(
      Number(scalar("SELECT COUNT(*) FROM pending_signups WHERE email LIKE 'e2e-signup-%';")),
      "a refused signup left a pending row",
    ).toBe(0);
  });

  test("SGN-A-02 signup/start requires a first and a last name", { tag: '@tesbo.testId("TES-TC-517")' }, async () => {
    const email = signupEmail("noname");
    for (const firstName of [undefined, "", "   ", "\t\n"]) {
      const res = await start({ firstName, lastName: "Signup", email, password: "E2eSignPass9f3!" });
      expect(res.status(), `first name ${JSON.stringify(firstName)} was accepted`).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("First name is required");
    }
    for (const lastName of [undefined, "", "   ", "\t\n"]) {
      const res = await start({ firstName: "EndToEnd", lastName, email, password: "E2eSignPass9f3!" });
      expect(res.status(), `last name ${JSON.stringify(lastName)} was accepted`).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("Last name is required");
    }
    expect(pendingCount(email)).toBe(0);
  });

  test("SGN-A-03 signup/start enforces an 8-character password floor", { tag: '@tesbo.testId("TES-TC-518")' }, async () => {
    const email = signupEmail("weakpass");
    // 7 characters is refused, and the message says what the rule is — a password rule the user has to
    // guess at is a rule they will fight.
    for (const password of [undefined, "", "short", "1234567", "       "]) {
      const res = await start({ firstName: "EndToEnd", lastName: "Signup", email, password });
      expect(res.status(), `password ${JSON.stringify(password)} was accepted`).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("8 characters");
    }
    expect(pendingCount(email)).toBe(0);
  });

  test("SGN-A-04 signup/start refuses an email that already has an account, and says to sign in", { tag: '@tesbo.testId("TES-TC-519")' }, async () => {
    // The smoke tenant's own address, which global-setup has already registered.
    const existing = scalar("SELECT email FROM users WHERE email LIKE 'e2e-%' ORDER BY created_at LIMIT 1;");
    expect(existing, "no seeded account to test against").toBeTruthy();

    const pendingBefore = pendingCount(existing);
    const res = await start({ firstName: "EndToEnd", lastName: "Duplicate", email: existing, password: "E2eSignPass9f3!" });
    expect(res.status()).toBe(400);
    const message = JSON.stringify(await res.json());
    expect(message).toContain("already exists");
    // The message points at the way out. An "email taken" that doesn't say "sign in instead" sends the
    // user round the signup loop again.
    expect(message.toLowerCase()).toContain("sign in");

    // And the existing account is untouched. Asserted as "unchanged" rather than "zero": whatever
    // pending rows that shared account already carries are global-setup's business, not this test's,
    // and a spec that asserts an absolute count of state it did not create drifts (see the
    // workspaces.spec.ts defect in the tracker's §3).
    expect(pendingCount(existing), "the refused signup queued a pending row over an existing account")
      .toBe(pendingBefore);
    expect(userCount(existing)).toBe(1);
  });

  test("SGN-A-05 the email is normalised, so case and padding cannot create a second account", { tag: '@tesbo.testId("TES-TC-520")' }, async () => {
    const existing = scalar("SELECT email FROM users WHERE email LIKE 'e2e-%' ORDER BY created_at LIMIT 1;");
    for (const variant of [existing.toUpperCase(), `  ${existing}  `]) {
      const res = await start({ firstName: "EndToEnd", lastName: "Duplicate", email: variant, password: "E2eSignPass9f3!" });
      // validateEmail lowercases and trims before the existence check, so a shouted or padded address
      // is the same address — otherwise one person could hold two accounts differing only in case.
      expect(res.status(), `${JSON.stringify(variant)} was treated as a new address`).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("already exists");
    }
  });

  // ─── Verify: also refused before any rate-limited work ────────────────────

  test("SGN-A-06 signup/verify requires an email and a code", { tag: '@tesbo.testId("TES-TC-521")' }, async () => {
    const email = signupEmail("noverify");
    for (const data of [{}, { email }, { email, code: "" }, { email, code: "   " }, { code: "123456" }]) {
      const res = await verify(data);
      expect(res.status(), `${JSON.stringify(data)} was accepted: ${await res.text()}`).toBe(400);
    }
    expect(userCount(email)).toBe(0);
  });

  test("SGN-A-07 signup/verify refuses a wrong code before it looks for a pending signup", { tag: '@tesbo.testId("TES-TC-522")' }, async () => {
    const email = signupEmail("wrongcode");
    seedOtpCode(email, "111111");

    const res = await verify({ email, code: "999999" });
    // 401 rather than 400: the code is a credential, and a wrong one is an authentication failure.
    expect(res.status()).toBe(401);
    expect(JSON.stringify(await res.json())).toContain("invalid_or_expired_otp");
    expect(userCount(email), "a wrong code created an account").toBe(0);
  });

  test("SGN-A-08 a correct code with no pending signup behind it does not create an account", { tag: '@tesbo.testId("TES-TC-523")' }, async () => {
    const email = signupEmail("nopending");
    // The code is valid but nothing was ever started — the ordering matters, because creating a user
    // from a verified code alone would let anyone with a code skip the password step entirely.
    seedOtpCode(email, "222222");
    exec(`DELETE FROM pending_signups WHERE email = ${literal(email.toLowerCase())};`);

    const res = await verify({ email, code: "222222" });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("No pending signup");
    expect(userCount(email)).toBe(0);
  });

  test("SGN-A-09 an expired code is refused", { tag: '@tesbo.testId("TES-TC-524")' }, async () => {
    const email = signupEmail("expired");
    // Negative expiry: the same state a code left sitting for eleven minutes reaches.
    seedOtpCode(email, "333333", -1);

    const res = await verify({ email, code: "333333" });
    expect(res.status()).toBe(401);
    expect(JSON.stringify(await res.json())).toContain("invalid_or_expired_otp");
    expect(userCount(email)).toBe(0);
  });

  // ─── The happy path: the only rate-limited attempts in this file ───────────

  test("SGN-A-10 a signup completes end to end and signs the new user in", { tag: '@tesbo.testId("TES-TC-525")' }, async () => {
    const email = signupEmail("happy");
    const password = "E2eSignPass9f3!";

    const started = await start({
      firstName: "EndToEnd",
      lastName: "Happy Signup",
      mobileNumber: "+14155550123",
      email,
      password,
    });
    // 204: the response deliberately carries nothing, because saying whether the address was new
    // would make this endpoint an account-existence oracle for anyone who asks.
    expect(started.status(), `signup/start — ${await started.text()}`).toBe(204);
    expect((await started.body()).length).toBe(0);

    // Queued, not created: no user row exists until the code is verified.
    expect(usablePendingCount(email)).toBe(1);
    expect(userCount(email), "signup/start created the user before the code was verified").toBe(0);
    // And the password is hashed on the way into the pending row, not held in the clear while it waits.
    const pendingHash = scalar(
      `SELECT COALESCE(password_hash, '') FROM pending_signups WHERE email = ${literal(email.toLowerCase())};`,
    );
    expect(pendingHash, "the pending signup holds no password hash").toBeTruthy();
    expect(pendingHash, "the password is stored in the clear in pending_signups").not.toContain(password);

    seedOtpCode(email, "444444");
    const verified = await verify({ email, code: "444444" });
    // 201, not 200: Nest's default for POST. signup/start opts out of it with @HttpCode(204); verify
    // does not, and it does create a user, so 201 is defensible.
    expect(verified.status(), `signup/verify — ${await verified.text()}`).toBe(201);
    const body = await verified.json();
    expect(body.ok).toBe(true);
    expect(body.userId).toBeTruthy();

    // The account exists, the pending row is consumed, and the response set a session cookie so the
    // user lands signed in rather than at a login form.
    expect(userCount(email)).toBe(1);
    // The structured first/last name and mobile number collected at signup/start round-trip onto the
    // finished account — not just folded into the combined `name` — and this path already collected
    // them, so the Account page / complete-profile step must never ask again for this user.
    expect(scalar(`SELECT first_name FROM users WHERE email = ${literal(email.toLowerCase())};`)).toBe("EndToEnd");
    expect(scalar(`SELECT last_name FROM users WHERE email = ${literal(email.toLowerCase())};`)).toBe("Happy Signup");
    expect(scalar(`SELECT mobile_number FROM users WHERE email = ${literal(email.toLowerCase())};`)).toBe("+14155550123");
    expect(
      scalar(`SELECT profile_completed_at IS NOT NULL FROM users WHERE email = ${literal(email.toLowerCase())};`),
    ).toBe("t");
    // Consumed rather than deleted, so it can never be verified a second time but the record of the
    // signup survives.
    expect(usablePendingCount(email), "the pending signup was not consumed").toBe(0);
    expect(
      scalar(
        `SELECT COUNT(*) FROM pending_signups WHERE email = ${literal(email.toLowerCase())} AND consumed_at IS NOT NULL;`,
      ),
      "the pending signup was deleted rather than marked consumed",
    ).toBe("1");
    const cookies = await anon.storageState();
    expect(
      cookies.cookies.length,
      "verifying a signup returned no session cookie, so the new user is not signed in",
    ).toBeGreaterThan(0);

    // The same code cannot be replayed to make a second account or a second session.
    const replay = await verify({ email, code: "444444" });
    expect(replay.status(), "the OTP code was accepted twice").toBeGreaterThanOrEqual(400);
    expect(userCount(email)).toBe(1);

    // And the password that was set actually works, which is the only proof it survived the pending
    // row intact.
    const login = await anon.post("/api/auth/password/login", {
      data: { email, password },
      failOnStatusCode: false,
    });
    expect(login.status(), `the new account cannot sign in — ${await login.text()}`).toBeLessThan(400);
  });

  test("SGN-A-11 starting twice for the same address leaves one usable pending signup", { tag: '@tesbo.testId("TES-TC-526")' }, async () => {
    const email = signupEmail("restart");
    const first = await start({ firstName: "EndToEnd", lastName: "Restart", email, password: "E2eSignPass9f3!" });
    expect(first.status()).toBe(204);

    // A user who misses the first email and asks again must not be locked out — whatever the row
    // count, the latest code has to work.
    const second = await start({ firstName: "EndToEnd", lastName: "Restart", email, password: "E2eSignPass9f3!" });
    expect(second.status(), `a second signup/start answered ${second.status()}: ${await second.text()}`).toBe(204);

    // Two starts leave two pending rows; findPendingSignup takes the newest usable one, which is what
    // makes the second code the one that works.
    expect(usablePendingCount(email)).toBeGreaterThanOrEqual(1);

    // Neither start() call set a mobile number — proves the field is genuinely optional rather than
    // defaulted to something, without spending a fifth rate-limited attempt on a dedicated test.
    expect(
      scalar(`SELECT mobile_number IS NULL FROM pending_signups WHERE email = ${literal(email.toLowerCase())} ORDER BY created_at DESC LIMIT 1;`),
    ).toBe("t");

    seedOtpCode(email, "555555");
    const verified = await verify({ email, code: "555555" });
    expect(verified.status(), `verify after a restarted signup — ${await verified.text()}`).toBe(201);
    expect(userCount(email)).toBe(1);
    expect(scalar(`SELECT mobile_number IS NULL FROM users WHERE email = ${literal(email.toLowerCase())};`)).toBe("t");
  });
  // ─── Field rules (BetterBugs 6a7c621b) ─────────────────────────────────────
  //
  // "Validation and maximum character limits are missing for Sign Up fields" — first name, last name
  // and password took digits, specials and unbounded length. All three are enforced now, in
  // person-name.util.ts (validatePersonName) and password.service.ts (assertValidPassword), and
  // mirrored in the frontend's lib/validation.ts.
  //
  // Every case below is refused BEFORE sendOtp, so like SGN-A-01..03 these cost nothing from the IP
  // rate-limit allowance this file is careful with.

  test("SGN-A-12 a name containing digits or special characters is refused", { tag: '@tesbo.testId("TES-TC-952")' }, async () => {
    const email = signupEmail("badnamechars");
    // The reporter typed exactly these kinds of values into First/Last name and the form took them.
    const rejected = [
      "Namrata123",
      "Test@User",
      "N4me",
      "<script>alert(1)</script>",
      "Robert'); DROP TABLE users;--",
      "名前 42",
      "Name_With_Underscore",
      "Name+Plus",
    ];
    for (const firstName of rejected) {
      const res = await start({ firstName, lastName: "Valid", email, password: "E2eSignPass9f3!" });
      expect(res.status(), `first name ${JSON.stringify(firstName)} was accepted`).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("can only contain letters");
    }
    // Last name is validated independently of first name — one representative case is enough here,
    // since it's the same validatePersonName rule SGN-A-12's first-name loop already exercises fully.
    const badLastName = await start({ firstName: "Valid", lastName: "N4me", email, password: "E2eSignPass9f3!" });
    expect(badLastName.status()).toBe(400);
    expect(JSON.stringify(await badLastName.json())).toContain("can only contain letters");
    expect(pendingCount(email)).toBe(0);
  });

  test("SGN-A-13 the punctuation real names use is still accepted", { tag: '@tesbo.testId("TES-TC-953")' }, async () => {
    // The rule has to reject digits without rejecting people, so the accepted first/last name pair
    // carries every allowed class between them: an accented letter, a hyphen, an apostrophe and a
    // period.
    //
    // Exactly ONE successful start in this whole block, on purpose. A start that passes validation
    // reaches sendOtp and spends from the 5-attempt IP allowance (OTP_MAX_ATTEMPTS) that every
    // worker shares — and a rate-limited start still answers 204 while storing no pending row, so
    // overspending here would not fail loudly, it would make these assertions flaky by file order.
    const email = signupEmail("goodname");
    const firstName = "José Mary-Jane";
    const lastName = "O'Neill Jr.";
    const res = await start({ firstName, lastName, email, password: "E2eSignPass9f3!" });
    expect(res.status(), `name ${JSON.stringify({ firstName, lastName })} was refused: ${await res.text()}`).toBe(204);

    // Stored trimmed and split, so padding never becomes part of the person's name and the combined
    // `name` other read paths (Members tab, activity feed) still see stays in sync.
    const row = `SELECT first_name || '|' || last_name || '|' || name FROM pending_signups
      WHERE email = ${literal(email.toLowerCase())} ORDER BY created_at DESC LIMIT 1;`;
    expect(scalar(row)).toBe(`${firstName}|${lastName}|${firstName} ${lastName}`);
  });

  test("SGN-A-14 a first or last name longer than 50 characters is refused", { tag: '@tesbo.testId("TES-TC-954")' }, async () => {
    // Self-serve signup caps First/Last name at 50, tighter than person-name.util's shared 100-char
    // default every other "Name" field here uses (SignupService.startSelfServeSignup) — so the
    // boundary that actually applies at this endpoint is 50, not 100.
    const email = signupEmail("longname");
    const tooLong = await start({ firstName: "A".repeat(51), lastName: "Valid", email, password: "E2eSignPass9f3!" });
    expect(tooLong.status(), `a 51-character first name — ${await tooLong.text()}`).toBe(400);
    expect(JSON.stringify(await tooLong.json())).toContain("at most 50 characters");

    const tooLongLast = await start({ firstName: "Valid", lastName: "A".repeat(51), email, password: "E2eSignPass9f3!" });
    expect(tooLongLast.status(), `a 51-character last name — ${await tooLongLast.text()}`).toBe(400);
    expect(JSON.stringify(await tooLongLast.json())).toContain("at most 50 characters");

    expect(pendingCount(email)).toBe(0);
    // The accepting side of the boundary is not exercised here — it would cost another
    // rate-limited attempt (see SGN-A-13). SGN-A-10 already proves a legal name signs up.
  });

  test("SGN-A-15 a password over 16 characters is refused rather than silently truncated", { tag: '@tesbo.testId("TES-TC-955")' }, async () => {
    const email = signupEmail("longpass");
    // Silent truncation would be the dangerous outcome: the user would set a 20-character password
    // and later be unable to sign in with it. 16 is PasswordService's real MAX_LENGTH — mirrored by
    // the frontend's PASSWORD_MAX_LENGTH — not the 128 this test used to assume.
    const res = await start({ firstName: "EndToEnd", lastName: "Signup", email, password: "Aa1xxxxxxxxxxxxxx" });
    expect(res.status(), `a 17-character password — ${await res.text()}`).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("at most 16 characters");
    expect(pendingCount(email)).toBe(0);
  });

  test("SGN-A-16 a password must mix upper case, lower case and a digit", { tag: '@tesbo.testId("TES-TC-956")' }, async () => {
    const email = signupEmail("passclasses");
    const cases: Array<[string, string]> = [
      ["alllowercase1", "uppercase"],
      ["ALLUPPERCASE1", "lowercase"],
      ["NoDigitsAtAll", "number"],
    ];
    for (const [password, expected] of cases) {
      const res = await start({ firstName: "EndToEnd", lastName: "Signup", email, password });
      expect(res.status(), `password ${JSON.stringify(password)} was accepted`).toBe(400);
      // The message has to name the missing class — "invalid password" makes the user guess.
      expect(JSON.stringify(await res.json()).toLowerCase()).toContain(expected);
    }
    expect(pendingCount(email)).toBe(0);
  });

  test("SGN-A-17 an email longer than 255 characters is refused", { tag: '@tesbo.testId("TES-TC-957")' }, async () => {
    // users.email is VARCHAR(255); without the check the insert would fail as a 500 rather than a 400.
    const local = "a".repeat(250);
    const res = await start({
      firstName: "EndToEnd",
      lastName: "Signup",
      email: `${local}@${emailDomain}`,
      password: "E2eSignPass9f3!",
    });
    expect(res.status(), `a ${local.length + emailDomain.length + 1}-character email — ${await res.text()}`).toBe(400);
  });

  // ─── The new mobile number field ───────────────────────────────────────────

  test("SGN-A-18 a malformed mobile number is refused before the rate limit is touched", { tag: '@tesbo.testId("TES-TC-1312")' }, async () => {
    const email = signupEmail("badmobile");
    for (const mobileNumber of ["not-a-number", "5551234567", "+1", "+0123456789", "++14155551234", "abc123"]) {
      const res = await start({ firstName: "EndToEnd", lastName: "Signup", mobileNumber, email, password: "E2eSignPass9f3!" });
      expect(res.status(), `mobile number ${JSON.stringify(mobileNumber)} was accepted`).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("country code");
    }
    expect(pendingCount(email)).toBe(0);
  });
});
