#!/usr/bin/env bash
# scripts/dev-api.sh - run the API locally against a throwaway Postgres.
#
# Starts postgres:16-alpine with Docker, migrates it once, then runs the API
# with DATABASE_URL pointing at it. The database lives in the container, so
# nothing outside it is touched, and the process refuses any non-loopback
# host anyway. Not used by CI or the image.
#
# Environment:
#   CLOUD_BIND    listen address (default 127.0.0.1:8080)
#   API_PORT      container port on the host (default 55432)
#   SKIP_MIGRATE  set to 1 to reuse an already-migrated database
#   KEEP_DB       set to 1 to leave the container running after exit
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

port="${API_PORT:-55432}"
bind="${CLOUD_BIND:-127.0.0.1:8080}"
name="podhub-dev-pg"
admin_dsn="postgres://postgres:postgres@127.0.0.1:${port}/podhub?sslmode=disable"
# The API refuses a superuser or BYPASSRLS login. 00083 creates this one for
# exactly that purpose; it is not superuser and does not bypass RLS.
dsn="postgres://podhub_login_api:podhub@127.0.0.1:${port}/podhub?sslmode=disable"

cleanup() {
  if [ "${KEEP_DB:-0}" != "1" ]; then
    docker rm -f "$name" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if ! docker inspect "$name" >/dev/null 2>&1; then
  docker run -d --name "$name" \
    -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_DB=podhub \
    -p "127.0.0.1:${port}:5432" \
    postgres:16-alpine >/dev/null
fi

echo "waiting for postgres on 127.0.0.1:${port}"
for _ in $(seq 1 60); do
  docker exec "$name" pg_isready -U postgres -d podhub >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$name" pg_isready -U postgres -d podhub >/dev/null

if [ "${SKIP_MIGRATE:-0}" != "1" ]; then
  echo "applying migrations"
  # The pool refuses a superuser login; the migration needs the postgres
  # role. The escape hatch is read at connect time, so it stays local to
  # this one process.
  PODHUB_ALLOW_SUPERUSER_DB=1 DATABASE_URL="$admin_dsn" go run ./scripts/devmigrate

  # The migration creates the role without a password. Set one so the API can
  # log in as it.
  docker exec "$name" psql -U postgres -d podhub -qc \
    "ALTER ROLE podhub_login_api PASSWORD 'podhub'"
fi

echo "starting api on ${bind}"
# Writes stay disabled: this process must not reach Ozon or delete objects.
DATABASE_URL="$dsn" CLOUD_BIND="$bind" \
  OZON_WRITE_KILL_SWITCH=1 CLOUD_MEDIA_GC_DELETE=0 \
  exec go run ./cmd/api
