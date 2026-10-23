# Security hardening: what changed, and how to check it by hand

Status as of 2026-10-21, branch `Yuvraj`. Nothing here is committed or deployed yet. The e2e specs for every item are written but **have not been run**. The backend unit suite passes in full (2,268 tests; the 3 that used to fail were stale tests, fixed: a renamed method, a shifted SQL parameter and a mock missing a method) and the whole of `scripts/ci-check.sh` passes in a clean Node 22 container.

## 0. Before you test anything

- [ ] Rebuild and redeploy backend, frontend and migrator so the running stack has this code: `scripts/deploy-and-test.sh` (it refuses to run e2e against stale images). Check `git status` first: everything in the working tree goes out.
- [ ] Migration `V147_api_token_expiry` applied (adds `api_tokens.expires_at`, gives every existing token 90 days from the migration). Confirm the number is still free if another branch added a migration.
- [ ] `ALLOW_PRIVATE_AI_HOSTS` is **unset or `false`** on hosted/stage/prod. It is `true` in your local root `.env` only, because the e2e fake AI servers sit on private addresses.
- [ ] A throwaway project and a throwaway test account exist for the destructive steps below. The root `.env` database is shared infrastructure: do not run the SQL steps against a real customer workspace.
- [ ] Shell variables used in the commands below:

```bash
API=http://localhost:1021            # backend; the app itself is on :1020
# sign in once and keep the session cookie
curl -s -c jar.txt -H "Content-Type: application/json" \
  -d '{"email":"YOU@example.com","password":"YOUR_PASSWORD"}' $API/api/auth/password/login
PID=<project uuid>                   # from the browser URL or GET $API/api/projects
```

---

## 1. What was implemented

| # | Area | Problem | What it does now | Where |
|---|---|---|---|---|
| 1 | Signup / invite code brute force | A 6-digit code could be guessed without limit on signup and invite verify | 5 guesses per code, then the code is dead even if the next guess is right. A new request retires older codes. Max 20 codes per email per hour (429 `otp_rate_limited`). Guess budget is atomic, so parallel guesses can't exceed it. A code can be used once even under two simultaneous submissions. A non-string `code`/`email` is a 400, not a 500. | `auth/otp.service.ts`, `auth/auth.service.ts`, `legacy/signup.service.ts` |
| 2 | API tokens: reach | A token was the whole of its user on every route | Default-deny in the middleware. A token reaches only `/api/mcp`, its own project's `mcp` and `automation` routes, and its own project's `testcases`, `suites`, `cycles` routes. Everything else is 403 (workspace, auth, billing, admin, member and token management, AI keys, other projects, routes keyed only by a cycle/bug/suite id). Scope comes from the method on the REST routes (GET needs `read`, the rest `write`). | `auth/api-token-policy.ts`, `auth/auth.middleware.ts` |
| 3 | API tokens: lifetime | Tokens never expired | 90 days by default, 1 to 365 on request (`expiresInDays`). Expired, archived-project and removed-member tokens stop authenticating. Max 25 active tokens per project. Unknown scope is now a 400 (it used to be widened to read+write). Names over 128 characters are a 400, not a 500. | `auth/api-token.service.ts`, `V147_api_token_expiry.sql` |
| 4 | API tokens: who can mint | The UI hid token management from QA engineers but the API did not | Only owner and manager can create or revoke. | `legacy/legacy.service.ts` |
| 5 | API tokens: UI | Nothing told users a token would expire | Status column (Active / Expired), Expires column with "in N days" (amber at 14 days or less), "Expired N days ago" in red, Remove instead of Revoke for expired ones, expiry choice (30/90/180/365) in the create form, expiry date in the copy-your-token step, help text. | `settings/api-tokens/page.tsx` |
| 6 | Password reset | Tokens survived a reset | Completing a **reset** deletes all the user's API tokens (on every project). Notice on `/forgot-password` and `/reset-password/:token`, and on the success screen. A password **change** keeps tokens by decision. | `auth/password-reset.service.ts`, `components/auth/ResetImpactNotice.tsx` |
| 7 | Stored XSS on uploads | The uploader's claimed Content-Type was stored and echoed back, some routes inline | One decision point (`file-delivery.ts`): active types (HTML, XML, JS, CSS) become `text/plain`; only raster images, PDF, audio, video and plain text may render inline; SVG is always a download; malformed types become `application/octet-stream`. Every file response carries `nosniff` and a sandbox CSP (PDF and media exempt). Applied to KB files, bug attachments, bug comment files, execution evidence and automation evidence, at upload and again at download (old rows are covered without a backfill). | `common/file-delivery.ts`, `legacy/legacy.service.ts`, `legacy/legacy.controller.ts` |
| 8 | Global headers | Only HSTS was set | `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Permitted-Cross-Domain-Policies: none` on every response; `x-powered-by` removed. Helmet was deliberately not added (new dependency; its default frame/CSP/CORP headers break the cross-origin PDF and image embeds). | `main.ts` |
| 9 | CSV formula injection | A title like `=HYPERLINK(...)` was a live formula in a CSV | CSV cells starting with `=`, `+`, `-`, `@`, tab or CR get a leading `'` (data and headers). Real numbers like `-5` are left alone. The import wizard removes exactly one quote on **CSV** uploads, so export then import is exact. XLSX is unchanged: it writes text cells that no spreadsheet evaluates. Headers with a comma or quote no longer break the CSV. | `common/spreadsheet-safe.ts`, `lib/spreadsheet.ts`, `ImportTestCasesModal.tsx` |
| 10 | SSRF through the AI provider URL | A base URL of `http://169.254.169.254/` made the server read its own cloud metadata | `safeFetch` at all AI call sites: https only, no credentials in the URL, DNS resolved by us with **every** address checked, connection pinned to the address checked (no rebinding), no redirects followed, private/loopback/link-local/CGNAT/metadata/multicast ranges refused (incl. IPv4-mapped IPv6, NAT64, 6to4, `2130706433`-style spellings), 50 MB response cap, 10 minute ceiling. Checked at save time and on every call, so old saved keys are covered. `ALLOW_PRIVATE_AI_HOSTS=true` lets private ranges and http through for self-hosted runtimes; metadata, link-local, `0.0.0.0` and multicast stay blocked either way. | `common/safe-fetch.ts`, `legacy/legacy.service.ts` |
| 11 | Stored key exfiltration | `POST /ai-keys/models` with a saved `keyId` plus a new `baseUrl` sent the real key there | Changing the base URL of a saved key requires typing the key again (400 `ai_key_reentry_required`). | `legacy/legacy.service.ts` |
| 12 | Brute force across accounts and codes | Per-account lockouts could not see one source trying many accounts, many codes, many reset links or many emails; the current-password form had no limit at all | **Failure-only** counters per source address, in Redis (in-process fallback if Redis is down). Only wrong guesses count: a wrong password or unknown email on login (100 per 15 min), a wrong code on email-code login or on signup/invite (100 per 15 min each), a bad or used reset link (100 per 15 min), a forgot-password for an unregistered email (50 per hour), a bearer token that does not exist (600 per 10 min). Mail-bombing is capped by request count: reset emails 10 per hour per email **and** per source (60 per hour per email overall), login code emails 600 per hour per source. A signed-in user guessing the current password is stopped after 10 wrong tries in 15 minutes. **Nothing counts a successful login, a signed-in user's traffic, a valid token or a valid link**, so no regular user can be held up; a 429 carries `code: "rate_limited"` and a `Retry-After` header. IPv6 sources are counted as a /64. Caps are the base values and scale with `RATE_LIMIT_IP_MULTIPLIER`; `RATE_LIMIT_ENABLED=false` turns it all off. | `rate-limit/rate-limit.service.ts`, `auth/auth.service.ts`, `legacy/signup.service.ts`, `auth/auth.middleware.ts` |
| 13 | Login flood freezing the app | Password hashing was synchronous, so each wrong-password login blocked the whole process for about 100 ms and a flood stalled every other user | Hashing and verifying run on the thread pool (`pbkdf2` async). Same hash format; existing passwords still verify. | `auth/password.service.ts` |
| 14 | Input shape on auth and AI keys | A number, object or oversized value in `email`, `password`, `token`, `name`, `provider`, `apiKey` and similar reached `.trim()` or a fixed-width column and became a 500 | Login, forgot, reset, change password and email-code endpoints answer 400 for non-text or over-long values (email 255, password 1024). AI keys: field types and widths are checked, control characters and line breaks are refused in key, name, model, scheme and URL, the auth header name must be a valid header token and may not be `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Upgrade`, `Cookie`, `Proxy-*` and similar. | `auth/auth.service.ts`, `legacy/legacy.service.ts` |
| 15 | Nothing checked before a deploy | A push to `main` or `dev` deployed with no typecheck, lint, tests or secret scan | `scripts/ci-check.sh` runs before anything deploys, in a throwaway Node 22 container: **repo hygiene** (no NUL bytes in source, no committed `.only`, migration numbers unique and well formed), **backend** (`npm ci`, typecheck including specs, lint ratchet, all unit tests), **frontend** (`npm ci`, typecheck, lint ratchet), **critical-dependency audit** (blocks), **high** (warns). A separate **gitleaks** stage scans the tree and history. Same checks on every pull request through `.github/workflows/ci.yml`. A failing gate stops the build with nothing deployed. Emergency bypass: the `SKIP_GATES` build parameter, which a push can never set and which labels the build. Lint is a ratchet: the error count may not rise above `scripts/lint-baseline.json` (backend 12, frontend 14 today), so the gate is on without a clean-up first. | `scripts/ci-check.sh`, `scripts/lint-ratchet.js`, `Jenkinsfile`, `Jenkinsfile.stage`, `.github/workflows/ci.yml`, `.gitleaks.toml` |
| 16 | Dependencies with known critical flaws | `proxy-addr` (IP spoofing behind a proxy, which the login limits and lockouts rely on) and Next.js 16.3.3 (remote code execution in `next/og`, among others) were in production | `proxy-addr` 2.0.8 in the backend lockfile; Next.js and `eslint-config-next` 16.3.7 in the frontend. Both audits now show zero critical. A production `next build` passes. | `package-lock.json`, `Tesbo-Frontend/package.json` |
| 17 | Dependency updates were switched off | `open-pull-requests-limit: 0` on every ecosystem | On, weekly on Monday, minor and patch grouped into one PR per ecosystem, at most five open, and extended to `e2e`, the reporter SDK, the Dockerfiles and the Actions used. | `.github/dependabot.yml` |

### Deliberately not changed
- First-admin setup (`/api/setup/first-admin`) stays as it was, by decision.
- "No account found" on login and forgot-password stays (documented product choice).
- Login lockout is still 24 h per email and OTP requests still count toward it, so someone can lock a victim out of password login by requesting 5 codes for their email.
- XLSX gets no quote prefix (verified safe).

### Not done yet
- [ ] **Branch protection on `main` and `dev`** (a GitHub setting, so it needs an admin; not applied by this change). Require the `Quality gates` and `Secret scan` checks and at least one review: `gh api -X PUT repos/QAbleHQ/Tesbo-Test-Manager-Private/branches/main/protection --input protection.json` with a body that sets `required_status_checks.contexts` to `["Quality gates","Secret scan"]` and `required_pull_request_reviews.required_approving_review_count` to 1. Until then the CI workflow reports but cannot stop a merge; Jenkins still stops the deploy.
- [ ] Turn on **Dependabot security updates** (Settings, Advanced Security). `dependabot.yml` only covers version updates.
- [ ] **Next.js 16.4.x.** Version 16.3.7 clears the critical advisory, but an image-optimisation SSRF (GHSA-cjq9-62q9-8jv4) is only fixed in 16.4.x, which is a larger upgrade. The app sets no `images` config, which narrows the exposure, but the upgrade is still owed.
- [ ] **`xlsx` (SheetJS) has no fixed version** (prototype pollution and a ReDoS). It parses the user's own file in the browser during import, so the damage is limited to that user's tab, but it stays in the audit's warning list until a replacement is chosen.
- [ ] Frontend CSP and frame headers.
- [ ] A general request limit on signed-in traffic: deliberately **not** added, so no regular user is ever slowed. Abuse of an authenticated account is handled at the account (lockouts, the change-password limit), not by throttling requests.
- [ ] No global `ValidationPipe` or DTO classes: it needs `class-validator`, and the endpoints that take untrusted input (auth, signup, tokens, AI keys) are checked in code instead. Other endpoints still validate in their own services.
- [ ] Limits on public share links and on first-admin setup attempts.
- [ ] If a load balancer or CDN sits in front of nginx, `trust proxy` must be raised: the limiter keys on the address nginx reports, and behind one more hop that would be the balancer's address for everybody.
- [ ] Report-only mode for the token allowlist (`API_TOKEN_POLICY=report`), recommended before enforcing in production.

---

## 2. Manual test checklist

Tick as you go. "Expect" is what a pass looks like. Steps marked **(DB)** change data in the shared database: use a throwaway token or project only.

### A. Signup and invite codes (item 1)

- [ ] Get a code for a throwaway email: `curl -s -X POST $API/api/auth/signup/start -H "Content-Type: application/json" -d '{"firstName":"Test","lastName":"User","email":"brute1@example.com","password":"Passw0rdX9"}'`. In log mode the code is printed in `docker compose logs backend --tail 50`.
- [ ] Send 5 wrong codes: `curl -s -o /dev/null -w "%{http_code}\n" -X POST $API/api/auth/signup/verify -H "Content-Type: application/json" -d '{"email":"brute1@example.com","code":"000001"}'` (change the code each time). Expect `401` each time.
- [ ] Now send the **correct** code. Expect `401` (the code is dead). Before the fix this created the account.
- [ ] Fresh email, 4 wrong then the correct code on the 5th. Expect it accepted (a 400 "No pending signup" is also a pass if you skipped `signup/start`: it proves the code was accepted).
- [ ] Request a code twice for one email, then use the **first** code. Expect `401`; the second works.
- [ ] Call `signup/start` 21 times for the same email within an hour. Expect `429` with `{"error":"otp_rate_limited"}` on the 21st and no email sent.
- [ ] Send `{"email":"a@b.co","code":123456}` (a number) and `{"email":{"a":1},"code":"1"}` to `/api/auth/otp/verify` and `/api/auth/signup/verify`. Expect `400`, never `500`.
- [ ] Repeat the wrong-code run through an **invite** link (`/api/invitations/:token/register/verify`). Same result.
- [ ] Normal path still works: sign up in the browser with a correct code. Expect account created and signed in.

### B. API tokens (items 2 to 6)

Create a token in the app: Project, Settings, API & MCP, Create token. Copy it once.

```bash
T=tsbo_...your token...
```

Reach:
- [ ] `curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $T" $API/api/projects/$PID/testcases` Expect `200`.
- [ ] Same for `.../suites` and `.../cycles`. Expect `200`.
- [ ] MCP: `curl -s -X POST $API/api/mcp -H "Authorization: Bearer $T" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`. Expect the tool list.
- [ ] Each of these must be `403`: `$API/api/workspace`, `$API/api/auth/me`, `$API/api/projects`, `$API/api/projects/$PID` (bare project), `$API/api/projects/$PID/apikeys`, `$API/api/projects/$PID/members`, `$API/api/plans/current`.
- [ ] `POST $API/api/projects/$PID/apikeys` with the token. Expect `403`, and no new token appears in the list (a token must not mint a successor).
- [ ] The token against **another** project's id (`.../api/projects/<other uuid>/testcases`). Expect `403 This API token is not scoped to this project`.
- [ ] A read-only token: `POST .../testcases` with `{}`. Expect `403 ... requires the "write" scope`. A write-only token doing `GET .../testcases`: `403 ... "read" scope`.
- [ ] Real clients still work: connect Claude Code / an MCP client with the token and run a tool; run the Playwright reporter with the token and confirm a run appears in the project.

Expiry and status (UI):
- [ ] The tokens table shows Name, Token, Scopes, **Status**, Last used, Created, **Expires**.
- [ ] A new token shows a green Active chip and "Expires in 90 days".
- [ ] Create one with "30 days": the copy step says "This token expires on <date>" and the table says "Expires in 30 days".
- [ ] A token with 14 days or fewer left shows the relative line in amber. **(DB)** On a throwaway token: `UPDATE api_tokens SET expires_at = now() + interval '5 days' WHERE id = '<id>';` then reload: "Expires in 5 days", amber.
- [ ] **(DB)** `UPDATE api_tokens SET expires_at = now() - interval '3 days' WHERE id = '<id>';` Reload: red Expired chip, "Expired 3 days ago", button reads **Remove**. The token returns `401` on `.../testcases`. Click Remove: the row disappears.
- [ ] Create form: invalid input is refused. `curl -s -X POST $API/api/projects/$PID/apikeys -b jar.txt -H "Content-Type: application/json" -d '{"name":"x","scopes":["admin"]}'` Expect `400 Unknown scope`. Also try `"expiresInDays":0`, `366`, `"soon"`, and a 129-character name. All `400`.

Lifetime:
- [ ] **(DB)** Archive a throwaway project that has a token. Expect that token to return `401` straight away.
- [ ] Remove a member from a project (throwaway). Expect their token for that project to return `401`.

Who can mint:
- [ ] Sign in as a QA engineer: Settings shows "Only project managers and owners can create or revoke API tokens". `POST .../apikeys` as that user returns `403`. As a manager: `201`.

Password reset (item 6):
- [ ] Create a token, then go to `/forgot-password`. The page shows "What happens when you complete this" with both bullets.
- [ ] Request the link (in log mode it prints `PASSWORD RESET for <email>: <url>` in the backend log) and open it. The form shows the same notice above the fields.
- [ ] Complete the reset. The success screen says you were signed out everywhere and that API tokens were revoked.
- [ ] The token from before now returns `401`, and the tokens table is empty.
- [ ] A different user's tokens are untouched.
- [ ] A wrong or reused reset link revokes nothing.
- [ ] Password **change** (Account screen) while signed in: the token still works.

Housekeeping:
- [ ] **Rotate the committed stage token** in `e2e/tesbo.config.json` (revoke it in the app, mint a new one, update the file). It expires 90 days after V146 was applied; after that every CI run using it fails with 401 at collection.

### C. Uploads and previews (items 7 and 8)

Get a folder id: `curl -s -b jar.txt $API/api/projects/$PID/knowledge-base/folders/tree` (the `id` field is the root folder).

```bash
printf '<script>alert("XSS")</script>' > evil.txt
curl -s -b jar.txt -X POST $API/api/projects/$PID/knowledge-base/files/upload \
  -F "folderId=$FOLDER" -F "files=@evil.txt;type=text/html"
FID=<id from the response>
curl -si -b jar.txt $API/api/projects/$PID/knowledge-base/files/$FID/preview | head -20
```

- [ ] The response `mimeType` is `text/plain`, not `text/html`.
- [ ] Preview headers: `Content-Type: text/plain; charset=utf-8`, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'; ...`.
- [ ] Open the preview URL in the browser address bar while signed in. Expect the source text on screen and **no alert**.
- [ ] Upload `page.html` (type `text/html`): preview is text, no alert. Try `PAGE.HTML` and `application/xhtml+xml` too.
- [ ] Upload `logo.svg` containing `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`: opening its URL **downloads** it (no alert, no render). Rename it `sneaky.png` with type `image/svg+xml`: same.
- [ ] Download route (`.../download`) is always `Content-Disposition: attachment`.
- [ ] Bug attachment: upload an `.html` with type `text/html` to a bug (`POST .../bugs/$BUG/attachments`), then fetch `.../bugs/attachments/<id>/download`. Expect attachment, type `text/plain`.
- [ ] Execution evidence: upload a `.png` claiming `image/svg+xml`, then request `...attachments/<id>/download?inline=1`. Expect `attachment`, not inline.
- [ ] Nothing broke: in the KB, a PNG, a PDF and a `.txt` still preview in the viewer; a `.ts`, `.py`, `.yaml` still preview as text; a screenshot from a run still renders inline in the run view.
- [ ] A signed-out request (or a member of another workspace) for the preview URL gets `401`/`404` and no file.
- [ ] Headers on any API response: `curl -si $API/api/auth/me | head -20` shows `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`, and **no** `X-Powered-By`.

### D. CSV and XLSX exports (item 9)

- [ ] Create test cases with these titles: `=HYPERLINK("http://example.com","click")`, `+1 (415) 555-0100 callback`, `-2+3 totals`, `@smoke login works`, `'=already quoted`. Give one a description starting with `=`.
- [ ] Export CSV (Test cases, Export). Open the raw file in a text editor: each of those cells starts with one extra `'`, and `'=already quoted` starts with two.
- [ ] Open the CSV in Excel or Google Sheets: the cells show as text. Nothing is evaluated and no link is created.
- [ ] Export XLSX: open it. The titles appear exactly as typed (no extra quote), as text.
- [ ] Add a number custom field with `-5`. In the CSV it is `-5` with no quote.
- [ ] Re-import the **CSV** into a different project (Import, upload, Next, Import N rows). Titles come back exactly as typed: no stray quote, `'=already quoted` intact.
- [ ] Re-import the **XLSX**: also exact.
- [ ] Import a CSV with plain titles that start with a quote (`'quoted word`, `'5 apples`): they stay as typed.
- [ ] A custom field named `Steps, "notes"` no longer breaks the import template's header row.
- [ ] Report CSV (Reports, Export): a suite named `=HYPERLINK(...)` is quoted in the file.

### E. AI provider base URL (items 10 and 11)

In Settings, Workspace AI keys, add a **custom provider** key. Each of these must be refused with "Base URL not allowed: ..." and nothing saved:
- [ ] `https://169.254.169.254/latest/meta-data/` and `http://169.254.169.254/`
- [ ] `http://2852039166/` and `http://0xa9.0xfe.0xa9.0xfe/` (the same address, spelled differently)
- [ ] `https://[fd00:ec2::254]/`, `https://[::ffff:169.254.169.254]/`, `https://0.0.0.0/`, `https://224.0.0.1/`
- [ ] `file:///etc/passwd`, `ftp://8.8.8.8/`, `https://user:pass@8.8.8.8/v1`, `not a url`
- [ ] `https://169.254.169.254.nip.io/` (a public name that points at the metadata address)
- [ ] The message never names the address it resolved to.

On a **hosted** stack (`ALLOW_PRIVATE_AI_HOSTS` unset), also refused:
- [ ] `http://localhost:11434/v1`, `https://127.0.0.1/`, `https://10.0.0.1/`, `https://192.168.1.1/`, `https://backend:1021/`, `https://redis:6379/`, `https://host.docker.internal/`, `http://8.8.8.8/v1` (plain http), and choosing the **Ollama** provider.

On your **local** stack (flag `true`): `http://localhost:11434/v1` and `http://192.168.x.x:8000/v1` are accepted, `169.254.169.254` is still refused.

Real providers still work:
- [ ] A key with a normal provider (OpenAI, Anthropic, Azure `https://<resource>.openai.azure.com/`, Groq, ...) saves, lists models, and Zyra generates test cases.
- [ ] Model list for a key whose URL is refused: the picker falls back to the built-in list and shows the reason, with no crash.

Stored key guard:
- [ ] Save a key (OpenAI, no custom URL). Then: `curl -s -X POST $API/api/workspace/ai-keys/models -b jar.txt -H "Content-Type: application/json" -d '{"provider":"openai","keyId":"<id>","baseUrl":"https://attacker.example/v1"}'` Expect `400 ai_key_reentry_required`, and nothing reaches `attacker.example`.
- [ ] Same call without `baseUrl`, and with `"baseUrl":"https://api.openai.com/v1"`: both `200`.
- [ ] With `"apiKey":"sk-typed"` added to the first call: allowed (the key is the owner's to send).
- [ ] **(DB)** Insert a key row whose `base_url` is `https://169.254.169.254/latest/` (as an older build could have). Use it for a model list or a Zyra run: a 400/`ai_base_url_blocked` message, not a hang or a 500. Delete the row after.
- [ ] A custom URL that redirects (HTTP 301/302) now fails with "Redirects are not followed"; confirm that is acceptable for your providers.
- [ ] Only the workspace owner can do any of this (manager, QA, guest and signed-out get `403`/`401`).

### G. Brute-force limits and input checks (items 12 to 14)

The caps below are the base values. On the local stack `RATE_LIMIT_IP_MULTIPLIER=20` widens the per-IP ones to 20x (so 100 becomes 2000); the per-email and per-user caps are not scaled. Against the backend directly you can pretend to be different addresses with `-H "X-Forwarded-For: 10.9.9.9"`; behind nginx the real address overwrites it, so test those from different machines or use the base caps on a hosted stack.

Nothing here may ever slow a normal user. Check that first:
- [ ] Sign in with a correct password 20 times in a row from one machine. Every one succeeds, none is `429`. (Successes are never counted.)
- [ ] Browse, create and edit test cases, switch projects and run a Zyra chat while signed in. No `429` anywhere: signed-in traffic is not limited at all.
- [ ] Make a typo in your password 3 times, then sign in correctly. It works, from the same address.
- [ ] A valid API token and an MCP session keep working while another address spams wrong tokens.

Login from one address (`API=...`; base cap 100 failures per 15 minutes):
- [ ] Send wrong logins for made-up emails until the cap: `for i in $(seq 1 120); do curl -s -o /dev/null -w "%{http_code} " -X POST $API/api/auth/password/login -H "Content-Type: application/json" -H "X-Forwarded-For: 10.9.9.9" -d "{\"email\":\"nobody$i@example.com\",\"password\":\"Wrong9Horse\"}"; done`. Expect `401` up to the cap, then `429` (on the local stack that is 2000, so lower `RATE_LIMIT_IP_MULTIPLIER` to 1 for this check).
- [ ] The `429` body is `{"error":"Too many attempts. Try again in N minutes.","code":"rate_limited","retryAfterSeconds":...}` and the response has a `Retry-After` header.
- [ ] The same account logs in normally from a different address.
- [ ] After the window passes (or you delete the `rl:login-fail:*` key in Redis) the first address works again.

Other counters:
- [ ] Wrong email codes (`POST /api/auth/otp/verify`) and wrong signup/invite codes: `429` after the cap, and a correct code from another address still works.
- [ ] `GET /api/auth/password/reset/<random>` returns `{"valid":false}` and counts; a real reset link does not count.
- [ ] `POST /api/auth/password/forgot` for the same made-up email 11 times from one address: 10 answers, then `429`. A different address asking about the **same** email is still answered (a stranger cannot use up the owner's allowance).
- [ ] While signed in, `POST /api/auth/password/change` with a wrong `currentPassword` 11 times: `401` ten times, then `429`, and even the right password waits.
- [ ] Bad bearer tokens (`Authorization: Bearer tsbo_nope`) from one address: `401`, and `429` only far past the cap (600 per 10 minutes).
- [ ] Turn it off: set `RATE_LIMIT_ENABLED=false`, restart, repeat any of the above. No `429` at all. Turn it back on.
- [ ] Redis down (stop the redis container): sign-in and the app still work; the in-process counter keeps counting, and the backend log shows "rate limit ... using the in-process count".

Login flood does not freeze the app:
- [ ] Fire 40 wrong-password logins at once (`xargs -P 40`). While they run, load another page of the app or `curl $API/api/auth/password/reset/x`. It answers within a second or two (before the change it stalled for seconds).
- [ ] Existing users still sign in (the hash format is unchanged), and a password set after this change works too.

Malformed input is a 400, never a 500:
- [ ] `POST /api/auth/password/login` with `{"email":123,"password":"x"}`, `{"email":{"$ne":""},"password":"x"}`, `{"email":"a@b.co","password":["x"]}`: all `400` with an error message.
- [ ] A 256-character email, or a 1025-character password: `400`.
- [ ] `POST /api/auth/password/forgot` with `{"email":123}` and `{"email":{}}`: `400`.
- [ ] `POST /api/auth/password/reset` with `{"token":123,"password":"Newpass9x"}`: `400`.
- [ ] `POST /api/workspace/ai-keys` as the owner with: a 129-character name, a 33-character provider, a provider `a/b`, a key containing a newline, an `authHeaderName` of `Host` or `Cookie` or `x api key`, and a numeric `name`. Each is `400` naming the field, and nothing is saved.
- [ ] A normal custom gateway still saves: `authHeaderName` `x-api-key` with a public https base URL.

### H. CI gates (items 15 to 17)

Locally, with Node 22 (or the same command in the container Jenkins uses):
- [ ] `bash scripts/ci-check.sh` finishes with "All blocking gates passed" (about 5 minutes the first time). It prints a summary naming the warnings.
- [ ] Plant a problem and confirm it is caught, then remove it: a `test.only(` in any `e2e` spec (blocks); a second migration with an existing `V<number>_` (blocks, names both files); a file named `migrations/oops.sql` (blocks); a new unused variable in backend code (the lint ratchet reports "went UP" and blocks); a TypeScript error (typecheck blocks).
- [ ] `CI_SKIP="audit-high" bash scripts/ci-check.sh` names the skipped gate in the summary and never prints a plain green "all passed".
- [ ] Secret scan: `docker run --rm --entrypoint sh -v "$PWD:/repo:ro" zricethezav/gitleaks:v8.28.0 -c 'git config --global --add safe.directory /repo && gitleaks detect --source /repo --config /repo/.gitleaks.toml --redact --no-banner'` exits 0. Commit a file containing `AKIAIOSFODNN7REALKEY` in a scratch branch and it exits 1.

In Jenkins (stage first, then prod):
- [ ] The next push builds with the new stages in this order: Checkout, Quality gates, Secret scan, SonarQube, Deploy, Smoke check. The first run after this change has no `SKIP_GATES` value yet and runs the gates, as it should.
- [ ] A build whose gates fail stops there and the log says nothing was deployed; nginx still points at the previous colour.
- [ ] The workspace has no root-owned files afterwards (`ls -la` shows the Jenkins user), and the second build is faster because `.npm-cache` is reused.
- [ ] "Build with Parameters" shows `SKIP_GATES`. Ticking it deploys, marks the build UNSTABLE, and sets the build description to "QUALITY GATES SKIPPED". Use it only for an emergency, and re-run without it afterwards.
- [ ] A stuck gate cannot hold deploys forever: Quality gates times out at 30 minutes and Secret scan at 10.

On GitHub:
- [ ] Open a pull request against `main`: the `CI` workflow runs two jobs, `Quality gates` and `Secret scan`. Make a change that fails a gate and confirm the PR shows a red check.
- [ ] Dependabot opens grouped "minor-and-patch" PRs on Monday, one per ecosystem, at most five open per ecosystem, with the `deps(...)` commit prefix.

### F. Whole-product smoke after deploy

- [ ] Sign in with password, OTP and via an invite.
- [ ] Browser KB file upload, preview and download of normal files.
- [ ] Test case import and export (CSV and XLSX) on a normal project.
- [ ] Project dashboard, runs, bugs with attachments.
- [ ] Playwright reporter run and an MCP session on one token.
- [ ] Zyra chat and generation on a real provider.

---

## 3. Running the automated suites

Unit (fast, no stack needed):
```bash
cd Tesbo-Backend-Nest && npx jest --runInBand
```
Expect 3 known failures only: `signup-invite.spec.ts` (1), `notion-integration.spec.ts` (2).

End to end (rebuilds and deploys, then runs; per `CLAUDE.md` it opens its own terminal and uses 10 workers):
```bash
scripts/deploy-and-test.sh api/signup.spec.ts api/invitations.spec.ts api/auth.spec.ts \
  api/automation.spec.ts api/mcp.spec.ts api/rbac.spec.ts ui/api-tokens.spec.ts ui/account.spec.ts \
  api/kb-files.spec.ts api/attachments.spec.ts api/import-export.spec.ts ui/testcase-import.spec.ts \
  api/zyra.spec.ts
```
- On a hosted target also set `E2E_AI_PRIVATE_HOSTS_BLOCKED=true` to enable `ZYR-SSRF-05`.
- New specs to look for: `SGN-OTP-01..07`, `AUT-55..59` and `AUT-62`, `RESET-TOK-01..02`, `KBF-X-01..10`, `ZYR-SSRF-01..08`, `ZYR-IN-01..04`, `BF-01..06` (in `api/auth.spec.ts`), and the formula tests in `import-export` and `testcase-import`.
- `BF-01` and `BF-02` send `100 x RATE_LIMIT_IP_MULTIPLIER` failed logins (2000 on the local stack, about a minute). They read the multiplier from the root `.env`; for a remote target set `E2E_RATE_LIMIT_IP_MULTIPLIER`. They spoof the client address, so they only run against a local stack (backend reached directly).
- `scripts/deploy-and-test.sh` opens a Terminal.app window; on Windows run the equivalent through Git Bash or WSL.

## 4. Things to know when something looks wrong

| Symptom | Likely cause |
|---|---|
| CI starts failing with 401 from the Playwright reporter | The committed token in `e2e/tesbo.config.json` expired (90 days after V146). Mint a new one. |
| A script that used a token on `/api/cycles/:id/...`, `/api/bugs/...` or `GET /api/projects/:id` now gets 403 | Outside the token allowlist. The `load/` k6 harness is the known case. Widen `auth/api-token-policy.ts` or have it use a session. |
| Users report a pipeline broke after they reset their password | Reset now revokes their tokens. They create new ones. |
| Zyra or model listing fails with "private or internal address" | The key's base URL is a private address on a stack where `ALLOW_PRIVATE_AI_HOSTS` is off. Self-hosters set it to `true`. |
| AI e2e specs fail on stage | Stage runs with the flag off and the specs' fake AI servers are on private addresses. |
| A CSV shows `'@name` in Excel | Intended. The quote keeps it from being a formula and is removed on CSV import. |
| An SVG downloads instead of showing in a new tab | Intended. It still draws inside an `<img>`. |
