# TesboX — AI-Powered Test Case Management

## Stack

- **Frontend:** Next.js (App Router) + TypeScript + Tailwind
- **Backend:** Java 17 + Javalin + Maven
- **Database:** PostgreSQL
- **Email:** Postmark (OTP and notifications)

## Quick start

### Database

Use your existing PostgreSQL. In `backend/.env` set:

- **DATABASE_URL** — JDBC URL, e.g. `jdbc:postgresql://localhost:5432/bettercases`
- **DATABASE_USER** — a PostgreSQL role that exists (e.g. your OS user on Homebrew, not necessarily `postgres`)
- **DATABASE_PASSWORD** — that role’s password (empty if you use trust auth)

Create a database that user can access (e.g. `createdb bettercases`), or use an existing one and set `DATABASE_URL` to that database name. Then start the backend; Liquibase will create the schema.

### Backend

```bash
cd backend
mvn compile exec:java -q -Dexec.mainClass="com.bettercases.Main"
```

Runs on http://localhost:7000. Health: http://localhost:7000/health

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Runs on http://localhost:3000. Set `NEXT_PUBLIC_API_URL=http://localhost:7000` if needed.

### Auth (Phase 1)

1. Open http://localhost:3000 → redirects to login.
2. Enter email → OTP is sent (or logged if Postmark is not configured).
3. Enter code on verify page → signed in.
4. Onboarding: create organization and first project → project dashboard.

## Project layout

- `backend/` — Javalin API, Liquibase migrations, auth, audit, RBAC, test cases/suites/plans/cycles/executions, bulk update, export, reporting, AI stub, notifications
- `frontend/` — Next.js app, login/verify/onboarding, projects, test cases, suites, plans, cycles, execution workflow, bulk actions, export

## Non-functional notes

- **Rate limiting:** OTP requests are rate-limited by email (configurable max attempts and lockout window). API rate limiting can be added via middleware.
- **Audit:** All auth actions and mutations should log to `audit_logs`; session and OTP flows are audited.
- **Performance:** Test case list uses server-side pagination and full-text search (Postgres `tsvector`). Indexes on `project_id`, `suite_id`, and common filters.
- **Security:** Row-level access by project membership; session stored server-side; OTP single-use and hashed.
