# Tesbo - AI-Powered Test Case Management

Tesbo is exclusively developed by [QAble Testlab](https://qable.io).

## License

Tesbo is open source under the Apache License 2.0.

You may use, modify, distribute, self-host, and commercially use this software, subject to the terms of the Apache-2.0 license. See `LICENSE`.

## Stack

- **Frontend:** Next.js (App Router) + TypeScript + Tailwind
- **Backend:** NestJS + TypeScript
- **Database:** PostgreSQL
- **Email:** Postmark (OTP and notifications)

## Quick Start

### One-Command Docker Deployment

Use this path when you want the frontend, backend, and database to start together automatically.

```bash
docker compose up --build -d
```

Then open:

- Frontend: http://localhost:3000
- Backend health: http://localhost:7000/health

On Windows PowerShell you can also run:

```powershell
.\scripts\docker-up.ps1
```

On macOS/Linux you can run:

```bash
sh ./scripts/docker-up.sh
```

The stack uses a one-shot Liquibase migrator container before starting the backend, so PostgreSQL is initialized automatically.

The Docker stack includes:

- **frontend** - Next.js production server
- **backend** - NestJS API
- **migrator** - one-shot Liquibase schema migrator
- **postgres** - PostgreSQL database with persistent Docker volume
- **redis** - Redis service for future/background runtime needs

Defaults are ready for local use. To customize ports, database credentials, public URLs, or optional integrations, copy `docker.env.example` to `.env` and edit the values before running Compose.

Useful commands:

```bash
docker compose logs -f
docker compose down
docker compose down -v
```

Use `docker compose down -v` only when you want to delete the local database volume and start fresh.

### Database

Use your existing PostgreSQL. In `Tesbo-Backend-Nest/.env` set:

- **DATABASE_URL** - PostgreSQL URL, e.g. `postgresql://localhost:5432/tesbo`
- **DATABASE_USER** - a PostgreSQL role that exists (e.g. your OS user on Homebrew, not necessarily `postgres`)
- **DATABASE_PASSWORD** - that role's password (empty if you use trust auth)

Create a database that user can access (e.g. `createdb tesbo`), or use an existing one and set `DATABASE_URL` to that database name. Then start the backend; Liquibase will create the schema.

### Backend

```bash
cd Tesbo-Backend-Nest
npm install
npm run start:dev
```

Runs on http://localhost:7000. Health: http://localhost:7000/health

### Frontend

```bash
cd Tesbo-Frontend
npm install
npm run dev
```

Runs on http://localhost:3000. Set `NEXT_PUBLIC_API_URL=http://localhost:7000` if needed.

### Auth

1. Open http://localhost:3000 - redirects to login.
2. Enter email - OTP is sent (or logged if Postmark is not configured).
3. Enter code on verify page - signed in.
4. Onboarding: create organization and first project - project dashboard.

## Project Layout

- `Tesbo-Backend-Nest/` - NestJS API, auth, audit, RBAC, test cases/suites/plans/cycles/executions, bulk update, export, reporting, AI stub, notifications
- `infra/liquibase/` - database schema migrations
- `Tesbo-Frontend/` - Next.js app, login/verify/onboarding, projects, test cases, suites, plans, cycles, execution workflow, bulk actions, export
- `deploy/` - deployment examples
- `infra/` - infrastructure examples
- `docs/` - project documentation

## Contributing

Contributions are welcome. See `CONTRIBUTING.md`.

For repository maintainers preparing a public release, see `docs/OPEN_SOURCE_CHECKLIST.md`.

## Security

Please report vulnerabilities privately. See `SECURITY.md`.

## Non-Functional Notes

- **Rate limiting:** OTP requests are rate-limited by email (configurable max attempts and lockout window). API rate limiting can be added via middleware.
- **Audit:** All auth actions and mutations should log to `audit_logs`; session and OTP flows are audited.
- **Performance:** Test case list uses server-side pagination and full-text search (Postgres `tsvector`). Indexes on `project_id`, `suite_id`, and common filters.
- **Security:** Row-level access by project membership; session stored server-side; OTP single-use and hashed.
