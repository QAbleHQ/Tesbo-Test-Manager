# TesboX - AI-Powered Test Case Management

TesboX is exclusively developed by [QAble Testlab](https://qable.io).

## License

TesboX is open source under the Apache License 2.0.

You may use, modify, distribute, self-host, and commercially use this software, subject to the terms of the Apache-2.0 license. See `LICENSE`.

## Stack

- **Frontend:** Next.js (App Router) + TypeScript + Tailwind
- **Backend:** Java 17 + Javalin + Maven
- **Database:** PostgreSQL
- **Email:** Postmark (OTP and notifications)

## Quick Start

### Database

Use your existing PostgreSQL. In `Tesbo-Backend/.env` set:

- **DATABASE_URL** - JDBC URL, e.g. `jdbc:postgresql://localhost:5432/bettercases`
- **DATABASE_USER** - a PostgreSQL role that exists (e.g. your OS user on Homebrew, not necessarily `postgres`)
- **DATABASE_PASSWORD** - that role's password (empty if you use trust auth)

Create a database that user can access (e.g. `createdb bettercases`), or use an existing one and set `DATABASE_URL` to that database name. Then start the backend; Liquibase will create the schema.

### Backend

```bash
cd Tesbo-Backend
mvn compile exec:java -q -Dexec.mainClass="com.bettercases.Main"
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

- `Tesbo-Backend/` - Javalin API, Liquibase migrations, auth, audit, RBAC, test cases/suites/plans/cycles/executions, bulk update, export, reporting, AI stub, notifications
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
