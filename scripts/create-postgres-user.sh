#!/usr/bin/env bash
# Create a PostgreSQL user (role) for the app.
# Usage:
#   ./scripts/create-postgres-user.sh                    # creates user "lifetools" with password "lifetools"
#   ./scripts/create-postgres-user.sh myuser mypassword  # custom user/password
#
# Requires: Postgres running (e.g. docker compose up -d postgres)

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

USERNAME="${1:-lifetools}"
PASSWORD="${2:-lifetools}"

if command -v docker &>/dev/null && docker compose exec postgres true 2>/dev/null; then
  echo "Using Docker Postgres..."
  docker compose exec postgres psql -U postgres -v ON_ERROR_STOP=1 -c "
    DO \$\$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${USERNAME}') THEN
        CREATE USER ${USERNAME} WITH PASSWORD '${PASSWORD}';
        GRANT ALL PRIVILEGES ON DATABASE bettercases TO ${USERNAME};
        ALTER DATABASE bettercases OWNER TO ${USERNAME};
        RAISE NOTICE 'Created user ${USERNAME} and granted access to bettercases.';
      ELSE
        RAISE NOTICE 'User ${USERNAME} already exists.';
      END IF;
    END
    \$\$;
  "
else
  echo "Using local psql..."
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "
    DO \$\$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${USERNAME}') THEN
        CREATE USER ${USERNAME} WITH PASSWORD '${PASSWORD}';
        GRANT ALL PRIVILEGES ON DATABASE bettercases TO ${USERNAME};
        ALTER DATABASE bettercases OWNER TO ${USERNAME};
        RAISE NOTICE 'Created user ${USERNAME} and granted access to bettercases.';
      ELSE
        RAISE NOTICE 'User ${USERNAME} already exists.';
      END IF;
    END
    \$\$;
  "
fi
echo "Done. Use in backend/.env: DATABASE_USER=${USERNAME} DATABASE_PASSWORD=${PASSWORD}"
