# Tesbo Test Manager — AI-Powered Test Case Management

Tesbo Test Manager is developed by [QAble Testlab](https://qable.io).

Open-source test case management for QA teams: self-host, organize cases and suites, run test cycles, track results, and optionally connect email, storage, and integrations.

**Public repository:** https://github.com/QAbleHQ/Tesbo-Test-Manager

## License

Apache License 2.0. See `LICENSE`.

## Stack

| Layer | Technology |
| --- | --- |
| Frontend | Next.js (App Router) + TypeScript + Tailwind |
| Backend | NestJS + TypeScript |
| Database | PostgreSQL with **pgvector** (`vector` extension) |
| Cache | Redis |
| Email (optional) | Postmark |

---

## Choose your setup (read this first)

You always need:

1. This Git repo  
2. A **`.env`** file  
3. A **PostgreSQL + pgvector** database  
4. Docker Compose for the app (frontend + backend + redis + migrator)

**Database — pick ONE path:**

| Path | When to use | What you set |
| --- | --- | --- |
| **A — Database URL** | You already have Postgres (Neon, RDS, Cloud SQL, company DB, …) | Put the connection string in `DATABASE_URL` |
| **B — Docker Postgres** | You want everything local; no hosted DB | Run a `pgvector` Postgres container, then point `DATABASE_URL` at it |

Both paths are valid. The app only cares that `DATABASE_URL` works and the DB has the **`vector`** extension.

Compose does **not** ship a Postgres service today. You supply the DB via Path A or Path B, then start the app.

---

## Step 1 — Install prerequisites

- Git  
- Docker  
- Docker Compose (`docker compose` **or** `docker-compose`)

Check:

```bash
git --version
docker --version
docker compose version || docker-compose version
```

---

## Step 2 — Clone

```bash
git clone https://github.com/QAbleHQ/Tesbo-Test-Manager.git
cd Tesbo-Test-Manager
git checkout main
```

---

## Step 3 — Create `.env`

```bash
cp docker.env.example .env
```

Edit `.env`. Start with these keys (safe local defaults):

```bash
FRONTEND_PORT=1010
BACKEND_PORT=1011
REDIS_PORT=6379

FRONTEND_URL=http://localhost:1010
NEXT_PUBLIC_API_URL=http://localhost:1011
CORS_ALLOWED_ORIGINS=http://localhost:1010,http://127.0.0.1:1010

REDIS_URL=redis://redis:6379
STORAGE_DRIVER=local
```

You will set **`DATABASE_URL` / `DATABASE_USER` / `DATABASE_PASSWORD`** in Step 4 (Path A or B).

**Do not commit `.env`.** Secrets stay on your machine. The full list of optional variables is in `docker.env.example`.

### If you open the UI from another host/IP

Example: browser uses `http://192.168.1.50:1010` or a public IP.

Then set **all three** to that same host (not only `localhost`):

```bash
FRONTEND_URL=http://YOUR_HOST:1010
NEXT_PUBLIC_API_URL=http://YOUR_HOST:1011
CORS_ALLOWED_ORIGINS=http://YOUR_HOST:1010
```

Then **rebuild** the frontend (see Step 5).  
If you skip this, login shows **Failed to fetch**.

---

## Step 4 — Database (Path A or Path B)

### Path A — Use a Postgres URL (Neon / cloud / existing server)

1. Create a Postgres database (Postgres 15+ recommended).  
2. Ensure **pgvector** is available, then run:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

3. Put credentials in `.env`:

```bash
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DBNAME?sslmode=require
DATABASE_USER=USER
DATABASE_PASSWORD=PASSWORD
```

Examples:

- Neon: copy the connection string from the Neon console  
- Local Postgres on your laptop (not in Docker):  
  `DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:5432/tesbo`  
  (Linux may need the host gateway IP instead of `host.docker.internal`)

4. Skip Path B. Go to **Step 5**.

> Tip: If the DB is on the internet (Neon), the Docker backend can reach it directly. No extra Docker network steps.

---

### Path B — Run Postgres in Docker (local, no cloud DB)

Use the official pgvector image (plain `postgres` image will fail migrations).

**B1. Start Postgres**

```bash
docker network create tesbo-net 2>/dev/null || true

docker rm -f tesbo-db 2>/dev/null || true

docker run -d --name tesbo-db \
  --network tesbo-net \
  -e POSTGRES_DB=tesbo \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  pgvector/pgvector:pg16
```

Wait until healthy:

```bash
docker exec tesbo-db pg_isready -U postgres
docker exec tesbo-db psql -U postgres -d tesbo -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

**B2. Put this in `.env`**

```bash
DATABASE_URL=postgresql://postgres:postgres@tesbo-db:5432/tesbo
DATABASE_USER=postgres
DATABASE_PASSWORD=postgres
```

Here `tesbo-db` is the **container name** (DNS name on the Docker network).  
Do **not** use `localhost` inside `DATABASE_URL` for this setup — inside Compose, `localhost` means the app container itself, not your laptop.

**B3. Put Postgres on the same Docker network as the app** (important)

Docker Compose creates a project network (often named `tesbo-test-manager_default`).
The database container must be on that network so the hostname `tesbo-db` works.

Do this **after** Step 5 starts Compose the first time (or if migrator fails with connection errors):

```bash
# See the exact network name
docker network ls | grep tesbo

# Attach the DB container to the Compose network (use the name you saw above)
docker network connect tesbo-test-manager_default tesbo-db

# Recreate migrator + backend so they connect cleanly
docker compose up -d --force-recreate migrator backend
```

If the network name is different (for example `tesbotestmanager_default`), use that name instead.

Then continue with the health checks in Step 5.

---

## Step 5 — Start the application

From the repo root:

```bash
docker compose up --build -d
# or:
docker-compose up --build -d
```

Helpers:

```bash
sh ./scripts/docker-up.sh          # macOS / Linux
.\scripts\docker-up.ps1            # Windows PowerShell
```

First build can take several minutes.

### Verify everything

```bash
docker compose ps

curl -sS http://localhost:1011/health
# → {"status":"ok"}

curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:1010/login
# → 200
```

Open: **http://localhost:1010**

Useful:

```bash
docker compose logs -f backend
docker compose logs migrator
docker compose down
```

After changing any `NEXT_PUBLIC_*` value:

```bash
docker compose up --build -d frontend
```

---

## Step 6 — Sign in

1. Go to http://localhost:1010/login  
2. Enter email → send code  
3. Get OTP:

**If Postmark is not configured** (`POSTMARK_API_TOKEN` empty):

```bash
docker compose logs backend 2>&1 | grep "OTP for"
# OTP for you@example.com: 123456
```

**If Postmark is configured:** check email inbox.

4. Verify code → finish onboarding (workspace + project) if asked  

A demo project with sample test cases may appear so you can explore immediately.

Optional email settings in `.env`:

```bash
POSTMARK_API_TOKEN=
POSTMARK_FROM_EMAIL=noreply@example.com
```

---

## Step 7 — Create and run test cases (no confusion)

### Concepts (simple)

| Word | Meaning |
| --- | --- |
| **Test case** | One test you write (steps, expected result, suite, …) |
| **Suite** | Group/folder of cases |
| **Plan** | Which cases belong to a release / theme (optional) |
| **Cycle / Run** | One execution session of selected cases |
| **Execution** | Result of one case inside a run: Untested / Passed / Failed / … |

You do **not** “run” a case from the case list alone.  
You put cases into a **Cycle (Run)**, then mark each result.

### Write test cases

1. Open a **Project**  
2. Open **Test cases**  
3. Create cases (title, suite, priority, steps, …)  
4. Organize with **Suites** if you want  

### Run / execute test cases

1. Project → **Cycles** (Test Runs)  
2. **Create** a new cycle (or create from selected cases / from a plan)  
3. **Add** the test cases into that cycle  
4. Set cycle status to **In Progress**  
5. For each case, set **Passed**, **Failed**, **Blocked**, **Skipped**, or **Retest**  
6. Save — dashboard / run stats update  

That is the full manual execution flow.

---

## Step 8 — Optional features (only if you need them)

All keys are listed empty in `docker.env.example`. Fill only what you use:

| Area | Examples |
| --- | --- |
| Billing | `STRIPE_*` |
| Jira / Linear | `JIRA_*`, `LINEAR_*` |
| S3 / files | `STORAGE_DRIVER=s3`, `S3_*` |
| BetterBugs | `NEXT_PUBLIC_BETTERBUGS_*` |
| Encryption | `SECRETS_ENCRYPTION_KEY` (`openssl rand -base64 32`) |

For a first successful local setup you can leave all of these empty.

---

## Step 9 — Automate: report results from your test framework (optional)

Everything in Step 7 is the **manual** flow. If your tests are automated, they can report their own
results into Tesbo instead — creating a Test Run and filling in each case's pass/fail automatically.

**[→ Playwright integration guide](docs/playwright-integration.md)** — install the reporter, tag your
tests with the case they validate, and every `npx playwright test` posts its results back into Tesbo,
with failure screenshots, video and traces attached.

The short version:

```bash
npm install --save-dev @tesbox/playwright-reporter   # in your Playwright project
npx @tesbox/playwright-reporter init                 # asks for the 3 values and verifies them
```

```ts
test('user can reset password', { tag: '@tesbo.testId("TES-1042")' }, async ({ page }) => { … });
```

The reporter is in [`sdk/playwright-reporter/`](sdk/playwright-reporter/). It never creates test
cases — it only reports results against cases you already own — and it cannot fail your suite: if
Tesbo is unreachable the failure is logged and counted, never thrown.

---

## Local development (npm, without building app images)

Still need Postgres (Path A or B) + Redis.

```bash
# Backend
cd Tesbo-Backend-Nest
npm install
npm run build
npm run migrate
npm run start:dev
# → http://localhost:7000

# Frontend (other terminal)
cd Tesbo-Frontend
npm install
NEXT_PUBLIC_API_URL=http://localhost:7000 npm run dev
# → http://localhost:3000
```

Match CORS / URLs to these ports in `.env`.

---

## Troubleshooting (quick answers)

| Symptom | Fix |
| --- | --- |
| **Failed to fetch** on login | Browser host must match `FRONTEND_URL`, `NEXT_PUBLIC_API_URL`, `CORS_ALLOWED_ORIGINS`. Rebuild frontend. |
| `extension "vector" is not available` | Use `pgvector/pgvector:pg16` (Path B) or enable pgvector on your cloud DB (Path A). |
| Migrator cannot connect / DB errors | Path B: `DATABASE_URL` host = `tesbo-db`, and DB + app on the **same Docker network**. Path A: check URL, SSL, firewall. |
| No OTP email | Normal without Postmark — read `docker compose logs backend` for `OTP for ...`. |
| Port busy | Change `FRONTEND_PORT` / `BACKEND_PORT` / `REDIS_PORT` in `.env`. |
| Old API URL after `.env` edit | `docker compose up --build -d frontend` |

---

## Project layout

- `Tesbo-Backend-Nest/` — API + migrations  
- `Tesbo-Frontend/` — UI  
- `docker-compose.yml` — app stack (frontend, backend, migrator, redis)  
- `docker.env.example` — full env template (Path A/B + optional integrations)  
- `scripts/` — `docker-up.sh`, `docker-up.ps1`  
- `sdk/playwright-reporter/` — Playwright reporter that posts automated results into Tesbo  
- `docs/` — more documentation (see **Documentation** below)  

## Documentation

| Guide | What it covers |
| --- | --- |
| [Playwright integration](docs/playwright-integration.md) | Step-by-step: report automated Playwright results into Tesbo |
| [Feature documentation](docs/FEATURE_DOCUMENTATION.md) | What each module does, endpoint by endpoint |
| [Deploy guide](docs/deploy-guide.md) | Deploying the stack beyond a local setup |

## Contributing / Security

- Contributing: `CONTRIBUTING.md`  
- Security: `SECURITY.md`  

---

## One-page checklist

- [ ] Cloned repo, on `main`  
- [ ] `cp docker.env.example .env`  
- [ ] Chose **Path A (URL)** or **Path B (Docker Postgres + pgvector)**  
- [ ] Set `DATABASE_*` correctly for that path  
- [ ] Set URLs for how you open the browser (`localhost` or your IP)  
- [ ] `docker compose up --build -d`  
- [ ] `/health` returns ok; UI loads on `:1010`  
- [ ] Logged in with OTP (email or logs)  
- [ ] Created or opened a project → added cases → created a **Cycle** → marked **Passed/Failed**  

If you follow this checklist top to bottom, setup should complete without guesswork.
