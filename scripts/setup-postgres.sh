#!/usr/bin/env bash
# Idempotent local PostgreSQL setup for BetterCases.
# - Prefers Docker Compose postgres service (project default)
# - Falls back to local psql if Docker is unavailable
#
# Usage:
#   ./scripts/setup-postgres.sh
#   ./scripts/setup-postgres.sh --user lifetools --password lifetools --db bettercases

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

DB_USER="postgres"
DB_PASSWORD="postgres"
DB_NAME="bettercases"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)
      DB_USER="$2"
      shift 2
      ;;
    --password)
      DB_PASSWORD="$2"
      shift 2
      ;;
    --db)
      DB_NAME="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

echo "Setting up PostgreSQL for BetterCases..."

if command -v docker >/dev/null 2>&1; then
  echo "Docker detected. Starting postgres service..."
  docker compose up -d postgres >/dev/null

  echo "Waiting for postgres to become ready..."
  for _ in {1..30}; do
    if docker compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  if ! docker compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1; then
    echo "Postgres did not become ready in time."
    exit 1
  fi

  docker compose exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}';
  END IF;
END
\$\$;
"

  docker compose exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}') THEN
    CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};
  END IF;
END
\$\$;
"

  docker compose exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "
GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
"

  docker compose exec -T postgres psql -U postgres -d "${DB_NAME}" -v ON_ERROR_STOP=1 -c "
ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER};
ALTER SCHEMA public OWNER TO ${DB_USER};
GRANT USAGE, CREATE ON SCHEMA public TO ${DB_USER};
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${DB_USER};
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${DB_USER};
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO ${DB_USER};
"

  echo "Postgres setup completed with Docker."
else
  if ! command -v psql >/dev/null 2>&1; then
    echo "Neither Docker nor psql found."
    echo "Install Docker Desktop and run this script again."
    exit 1
  fi

  echo "Using local psql."
  ADMIN_USER="${PGADMIN_USER:-$(whoami)}"
  PSQL_CONN=(psql -v ON_ERROR_STOP=1 -U "$ADMIN_USER" -d postgres)

  if ! "${PSQL_CONN[@]}" -c "SELECT 1" >/dev/null 2>&1; then
    PSQL_CONN=(psql -v ON_ERROR_STOP=1 -U "$ADMIN_USER" -d template1)
  fi
  if ! "${PSQL_CONN[@]}" -c "SELECT 1" >/dev/null 2>&1; then
    PSQL_CONN=(psql -v ON_ERROR_STOP=1 -d postgres)
  fi
  if ! "${PSQL_CONN[@]}" -c "SELECT 1" >/dev/null 2>&1; then
    PSQL_CONN=(psql -v ON_ERROR_STOP=1 -d template1)
  fi
  if ! "${PSQL_CONN[@]}" -c "SELECT 1" >/dev/null 2>&1; then
    echo "Could not connect to local Postgres."
    echo "Try setting PGADMIN_USER, for example:"
    echo "  PGADMIN_USER=$(whoami) ./scripts/setup-postgres.sh"
    exit 1
  fi

  "${PSQL_CONN[@]}" -c "
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}';
  END IF;
END
\$\$;
"

  "${PSQL_CONN[@]}" -c "
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}') THEN
    CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};
  END IF;
END
\$\$;
"

  "${PSQL_CONN[@]}" -c "
GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
"

  "${PSQL_CONN[@]}" -d "${DB_NAME}" -c "
ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER};
ALTER SCHEMA public OWNER TO ${DB_USER};
GRANT USAGE, CREATE ON SCHEMA public TO ${DB_USER};
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${DB_USER};
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${DB_USER};
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO ${DB_USER};
"

  echo "Postgres setup completed with local psql."
fi

echo
echo "Use these values in backend/.env:"
echo "DATABASE_URL=jdbc:postgresql://localhost:5432/${DB_NAME}"
echo "DATABASE_USER=${DB_USER}"
echo "DATABASE_PASSWORD=${DB_PASSWORD}"
