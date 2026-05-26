#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "Starting Tesbo frontend, Nest backend, and database with Docker Compose..."
docker compose up --build -d

echo
echo "Tesbo is starting."
echo "Frontend: http://localhost:3000"
echo "Backend health: http://localhost:7000/health"
echo
echo "Useful commands:"
echo "  docker compose logs -f"
echo "  docker compose down"
