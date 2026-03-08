#!/usr/bin/env bash
# Creates PostgreSQL role "postgres" and database "bettercases" (when you have a superuser).
# If you get "permission denied", use Docker instead: from project root run: docker compose up -d
set -e
echo "Setting up PostgreSQL for TesboX..."
if ! psql -d postgres -v ON_ERROR_STOP=1 -c "
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres WITH LOGIN PASSWORD 'postgres' SUPERUSER CREATEDB;
    RAISE NOTICE 'Created role postgres.';
  ELSE
    RAISE NOTICE 'Role postgres already exists.';
  END IF;
END
\$\$;
" 2>/dev/null; then
  echo "Could not create role (permission denied or Postgres not running)."
  echo "→ Easiest fix: start Postgres via Docker (from project root):"
  echo "    docker compose up -d"
  echo "  Then run the backend again. Your backend/.env already matches Docker's postgres/postgres/bettercases."
  exit 1
fi
createdb -O postgres bettercases 2>/dev/null && echo "Created database bettercases." || echo "Database bettercases already exists."
echo "Done. You can run: mvn compile exec:java -q -Dexec.mainClass=\"com.bettercases.Main\""
