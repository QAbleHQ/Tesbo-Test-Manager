# Tesbo Test Manager - AI-Powered Test Case Management

Tesbo Test Manager is exclusively developed by [QAble Testlab](https://qable.io).

We have been working with QA teams for years. One repeated problem we saw: test case management is either too expensive, too heavy, too disconnected from real QA workflows, or locked inside enterprise tools. So we built Tesbo Test Manager as an open-source foundation for modern quality engineering teams.

## License

Tesbo Test Manager is open source under the Apache License 2.0.

You may use, modify, distribute, self-host, and commercially use this software, subject to the terms of the Apache-2.0 license. See `LICENSE`.

## Stack

- **Frontend:** Next.js (App Router) + TypeScript + Tailwind
- **Backend:** NestJS + TypeScript
- **Database:** PostgreSQL
- **Email:** Postmark (OTP and notifications)

## Quick Start

### Prerequisites

Before starting Tesbo Test Manager with Docker, install:

- **Docker** - container runtime for PostgreSQL, Redis, backend, frontend, and the database migrator.
- **Docker Compose** - multi-container runner used by `docker-compose.yml`.

Recommended install paths:

- **Windows/macOS:** Install Docker Desktop from the official Docker docs: https://docs.docker.com/desktop/
- **Linux desktop:** Install Docker Desktop for Linux, or install Docker Engine from the official Docker Engine docs: https://docs.docker.com/engine/install/
- **Compose plugin/standalone Compose:** Follow Docker's Compose install guide: https://docs.docker.com/compose/install/

Verify your installation:

```bash
docker --version
docker-compose version
```

Some newer Docker installations use the Compose plugin command instead:

```bash
docker compose version
```

### One-Command Docker Deployment

Use this path when you want the frontend, backend, and database to start together automatically.

```bash
docker-compose up --build -d
```

Run the command exactly in that order: `--build` belongs after `up`. If your Docker installation supports the newer Compose plugin syntax, you can also use:

```bash
docker compose up --build -d
```

Then open:

- Frontend: http://localhost:1010
- Backend health: http://localhost:1011/health

On Windows PowerShell you can also run:

```powershell
.\scripts\docker-up.ps1
```

On macOS/Linux you can run:

```bash
sh ./scripts/docker-up.sh
```

The stack uses a one-shot Node/TypeScript migrator container before starting the backend, so PostgreSQL is initialized automatically.

The Docker stack includes:

- **frontend** - Next.js production server
- **backend** - NestJS API
- **migrator** - one-shot Node/TypeScript schema migrator
- **postgres** - PostgreSQL database with persistent Docker volume
- **redis** - Redis service for future/background runtime needs

Defaults are ready for local use. To customize ports, database credentials, public URLs, or optional integrations, copy `docker.env.example` to `.env` and edit the values before running Compose.

Useful commands:

```bash
docker-compose logs -f
docker-compose down
docker-compose down -v
```

For Docker installations that support the newer Compose plugin syntax, you can replace `docker-compose` with `docker compose`.

Use `docker-compose down -v` only when you want to delete the local database volume and start fresh.

### Database

Use your existing PostgreSQL. In `Tesbo-Backend-Nest/.env` set:

- **DATABASE_URL** - PostgreSQL URL, e.g. `postgresql://localhost:5432/tesbo`
- **DATABASE_USER** - a PostgreSQL role that exists (e.g. your OS user on Homebrew, not necessarily `postgres`)
- **DATABASE_PASSWORD** - that role's password (empty if you use trust auth)

Create a database that user can access (e.g. `createdb tesbo`), or use an existing one and set `DATABASE_URL` to that database name. Then run the backend migrations before starting the API:

```bash
cd Tesbo-Backend-Nest
npm run build
npm run migrate
```

### Backend

```bash
cd Tesbo-Backend-Nest
npm install
npm run start:dev
```

Runs on http://localhost:7000 in local dev, or http://localhost:1011 with the default Docker Compose stack. Health: http://localhost:1011/health

### Frontend

```bash
cd Tesbo-Frontend
npm install
npm run dev
```

Runs on http://localhost:3000 in local dev, or http://localhost:1010 with the default Docker Compose stack. Set `NEXT_PUBLIC_API_URL=http://localhost:1011` if needed.

### Auth

1. Open http://localhost:1010 - redirects to login.
2. Enter email - OTP is sent (or logged if Postmark is not configured).
3. Enter code on verify page - signed in.
4. Onboarding: create organization and first project - project dashboard.

## Project Layout

- `Tesbo-Backend-Nest/` - NestJS API, auth, audit, RBAC, test cases/suites/plans/cycles/executions, bulk update, export, reporting, AI stub, notifications
- `Tesbo-Backend-Nest/migrations/` - database schema migrations
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
