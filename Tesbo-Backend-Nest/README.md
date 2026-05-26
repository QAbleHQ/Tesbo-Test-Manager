# Tesbo Nest Backend

Primary NestJS backend for Tesbo.

## API coverage

The service exposes the Tesbo product API surface used by the frontend, including auth, setup, workspace, projects, suites, test cases, plans, cycles, reports, AI stubs, admin views, and health checks.

The service uses the PostgreSQL schema in `../infra/liquibase/changelog` and the `tesbo_session` cookie contract.

## Run locally

```bash
npm install
npm run build
PORT=7700 npm start
```

Set `DATABASE_URL`, `DATABASE_USER`, and `DATABASE_PASSWORD` for your PostgreSQL database. Liquibase migrations remain the source of truth for schema creation.
