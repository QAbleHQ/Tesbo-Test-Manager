import { expect, test, type APIRequestContext } from "@playwright/test";
import { emailDomain, env } from "../utils/env";
import { expectWelcomeJobScheduled, readWelcomeJob, removeWelcomeJob } from "../utils/welcome-email-queue";
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
  /** Users whose welcome-email job must be removed, so a run doesn't send mail two minutes later. */
  const welcomed: string[] = [];

  const skipReason = dbControlAvailable()
    ? null
    : "needs `docker compose exec postgres psql` to seed an OTP code and clear the IP rate limit";

  test.beforeAll(async () => {
    anon = await anonymousContext();
    if (!skipReason) clearOtpIpRateLimit();
  });

  test.afterAll(async () => {
    for (const userId of welcomed) removeWelcomeJob(userId);
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

  // ─── Brute force: a 6-digit code must not be guessable ─────────────────────
  //
  // signup/verify (and the invite verify routes) call OtpService.verifyOtpCode directly, and unlike
  // login's /otp/verify they had no lockout at all, so a 6-digit code could be guessed at wire speed.
  // The budget is per code: five guesses, then the code is dead even if the next guess is right. A
  // fresh code retires the older ones, and no more than ten are issued per email per hour.
  //
  // None of these needs a signup/start, so they spend nothing from the rate-limited allowance above.

  /** The most guesses spent on any live code for this address. */
  function guessesSpent(email: string): number {
    return Number(scalar(`SELECT COALESCE(MAX(attempts), 0) FROM otp_codes WHERE email = ${literal(email.toLowerCase())};`));
  }

  function purgeCodes(email: string): void {
    execMany([
      `DELETE FROM otp_codes WHERE email = ${literal(email.toLowerCase())}`,
      `DELETE FROM otp_rate_limit WHERE email = ${literal(`login:${email.toLowerCase()}`)}`,
    ]);
  }

  test("SGN-OTP-01 five wrong guesses kill the code, so the right code is refused afterwards", async () => {
    const email = signupEmail("otp-dead");
    seedOtpCode(email, "111111");
    try {
      for (let guess = 1; guess <= 5; guess++) {
        const res = await verify({ email, code: `99999${guess}` });
        expect(res.status(), `guess ${guess} was not a plain 401`).toBe(401);
      }
      expect(guessesSpent(email)).toBe(5);

      // 401, not 400 "No pending signup": a 400 would mean the OTP check passed and only the
      // pending lookup stopped it, i.e. the dead code was still accepted.
      const right = await verify({ email, code: "111111" });
      expect(right.status(), "the correct code was accepted after five wrong guesses").toBe(401);
      expect(JSON.stringify(await right.json())).toContain("invalid_or_expired_otp");
      expect(userCount(email)).toBe(0);
    } finally {
      purgeCodes(email);
    }
  });

  test("SGN-OTP-02 the right code still works on the fifth guess (the budget is five, not four)", async () => {
    const email = signupEmail("otp-fifth");
    seedOtpCode(email, "222222");
    try {
      for (let guess = 1; guess <= 4; guess++) {
        expect((await verify({ email, code: `88888${guess}` })).status()).toBe(401);
      }
      // The OTP passes here; it is the missing pending signup that answers 400. That is the proof.
      const fifth = await verify({ email, code: "222222" });
      expect(fifth.status(), `fifth guess — ${await fifth.text()}`).toBe(400);
    } finally {
      purgeCodes(email);
    }
  });

  test("SGN-OTP-03 a parallel burst cannot spend more than five guesses", async () => {
    // The race that a read-then-increment limiter loses: twenty guesses in flight at once all read
    // attempts < 5 before any of them writes. Here the burst is wrong guesses, then the right code.
    const email = signupEmail("otp-burst");
    seedOtpCode(email, "333333");
    try {
      const burst = await Promise.all(
        Array.from({ length: 20 }, (_, i) => verify({ email, code: `7777${String(i).padStart(2, "0")}` })),
      );
      for (const res of burst) expect(res.status()).toBe(401);
      expect(guessesSpent(email), "the burst overshot the attempt budget").toBe(5);
      expect((await verify({ email, code: "333333" })).status()).toBe(401);
    } finally {
      purgeCodes(email);
    }
  });

  test("SGN-OTP-04 requesting a new code retires the older ones", async () => {
    // Left live, ten requests would leave ten codes to guess against and multiply the odds tenfold.
    const email = signupEmail("otp-retire");
    seedOtpCode(email, "444444");
    try {
      const requested = await anon.post("/api/auth/otp/request", { data: { email }, failOnStatusCode: false });
      expect(requested.status(), `otp/request — ${await requested.text()}`).toBeLessThan(300);

      const old = await verify({ email, code: "444444" });
      expect(old.status(), "an older code still worked after a newer one was issued").toBe(401);
      expect(
        Number(scalar(`SELECT COUNT(*) FROM otp_codes WHERE email = ${literal(email.toLowerCase())} AND used_at IS NULL;`)),
        "more than one code is live",
      ).toBe(1);
      // Retired, not deleted: the row count still says how many were sent.
      expect(Number(scalar(`SELECT COUNT(*) FROM otp_codes WHERE email = ${literal(email.toLowerCase())};`))).toBe(2);
    } finally {
      purgeCodes(email);
    }
  });

  test("SGN-OTP-05 the twenty-first code in an hour is refused with 429, on both entry points", async () => {
    const email = signupEmail("otp-cap");
    const normalized = email.toLowerCase();
    exec(
      `INSERT INTO otp_codes (email, code_hash, expires_at, used_at) ` +
        `SELECT ${literal(normalized)}, 'e2e-cap-' || g, now() + interval '10 minutes', now() FROM generate_series(1, 20) g;`,
    );
    try {
      const login = await anon.post("/api/auth/otp/request", { data: { email }, failOnStatusCode: false });
      // 429 with its own code, not the 503 "otp_delivery_failed" a swallowed error would have become.
      expect(login.status()).toBe(429);
      expect(JSON.stringify(await login.json())).toContain("otp_rate_limited");

      const signup = await start({ firstName: "EndToEnd", lastName: "Capped", email, password: "E2eSignPass9f3!" });
      expect(signup.status()).toBe(429);
      expect(JSON.stringify(await signup.json())).toContain("otp_rate_limited");

      expect(Number(scalar(`SELECT COUNT(*) FROM otp_codes WHERE email = ${literal(normalized)};`)), "a refused request still issued a code").toBe(20);
      // A refused request is not a failed login: it must not feed the 24-hour password lockout.
      expect(Number(scalar(`SELECT COUNT(*) FROM otp_rate_limit WHERE email = ${literal(`login:${normalized}`)};`))).toBe(0);
    } finally {
      purgeCodes(email);
    }
  });

  test("SGN-OTP-06 a non-string code or email is a 400, never a 500, and spends no guess", async () => {
    const email = signupEmail("otp-types");
    seedOtpCode(email, "555555");
    try {
      for (const code of [123456, { $ne: "" }, ["555555"], true, null]) {
        const res = await verify({ email, code });
        expect(res.status(), `${JSON.stringify(code)} was not refused as a bad request`).toBe(400);
        const login = await anon.post("/api/auth/otp/verify", { data: { email, code }, failOnStatusCode: false });
        expect(login.status(), `login /otp/verify with ${JSON.stringify(code)}`).toBe(400);
      }
      const loginEmail = await anon.post("/api/auth/otp/verify", { data: { email: 12345, code: "555555" }, failOnStatusCode: false });
      expect(loginEmail.status()).toBe(400);
      const requestEmail = await anon.post("/api/auth/otp/request", { data: { email: { a: 1 } }, failOnStatusCode: false });
      expect(requestEmail.status()).toBe(400);
      expect(guessesSpent(email), "a malformed request spent a guess").toBe(0);
    } finally {
      purgeCodes(email);
    }
  });

  test("SGN-OTP-07 a code for one address cannot be guessed against another's", async () => {
    // Guesses are spent per address. Burning one victim's budget must not touch a second address.
    const victim = signupEmail("otp-victim");
    const bystander = signupEmail("otp-bystander");
    seedOtpCode(victim, "666666");
    seedOtpCode(bystander, "777777");
    try {
      for (let guess = 1; guess <= 5; guess++) await verify({ email: victim, code: `00000${guess}` });
      expect(guessesSpent(victim)).toBe(5);
      expect(guessesSpent(bystander), "guesses against one address were charged to another").toBe(0);
      expect((await verify({ email: bystander, code: "777777" })).status()).toBe(400);
    } finally {
      purgeCodes(victim);
      purgeCodes(bystander);
    }
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
    welcomed.push(body.userId);

    // Completing signup schedules the welcome email: one delayed BullMQ job, due 120 seconds after the
    // account's created_at. Asserted here rather than in a test of its own because a separate test
    // would spend another rate-limited signup/start (see BUDGET above). Only the local stack has a
    // Redis container to read; against a deployed target the check is recorded as not run.
    const welcomeJob = env.targetIsLocal ? expectWelcomeJobScheduled(body.userId) : null;
    if (!welcomeJob) {
      test.info().annotations.push({ type: "not-checked", description: "welcome-email job: no local Redis to inspect" });
    }

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
    // ...nor a second welcome email: the one job is untouched, not re-added with a fresh timestamp.
    if (welcomeJob) {
      const after = readWelcomeJob(body.userId);
      expect(after?.timestamp, "the replayed verify re-scheduled the welcome email").toBe(welcomeJob.timestamp);
      expect(after?.firesAt).toBe(welcomeJob.firesAt);
    }

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

  test("SGN-A-19 a resend after the first code and pending signup expired still completes the signup", async () => {
    // The /signup code step's "Resend code" re-calls signup/start rather than /otp/request, because
    // the pending signup expires on the same timer as the code: a fresh code alone would pass the OTP
    // check and then fail on "No pending signup found". This pins the backend half of that choice.
    // Spends two signup/start attempts; see BUDGET at the top of the file.
    const email = signupEmail("resend-expired");
    const normalized = email.toLowerCase();
    const details = { firstName: "EndToEnd", lastName: "Resent", email, password: "E2eSignPass9f3!" };
    expect((await start(details)).status()).toBe(204);

    execMany([
      `UPDATE pending_signups SET expires_at = now() - interval '1 minute' WHERE email = ${literal(normalized)}`,
      `UPDATE otp_codes SET expires_at = now() - interval '1 minute' WHERE email = ${literal(normalized)}`,
    ]);
    expect(usablePendingCount(email)).toBe(0);

    const resent = await start(details);
    expect(resent.status(), `the resend's signup/start answered ${resent.status()}: ${await resent.text()}`).toBe(204);
    expect(usablePendingCount(email), "the resend did not write a fresh pending signup").toBe(1);

    seedOtpCode(email, "777777");
    const verified = await verify({ email, code: "777777" });
    expect(verified.status(), `verify after a resend — ${await verified.text()}`).toBe(201);
    welcomed.push((await verified.json()).userId);
    expect(userCount(email)).toBe(1);
    expect(scalar(`SELECT last_name FROM users WHERE email = ${literal(normalized)};`)).toBe("Resent");
    expect(usablePendingCount(email), "the resent pending signup was not consumed").toBe(0);
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
