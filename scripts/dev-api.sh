#!/usr/bin/env bash
# scripts/dev-api.sh - run the API locally against a persistent Postgres.
#
# Starts postgres:16-alpine in a named container backed by a named volume,
# applies pending migrations, then runs the API with DATABASE_URL pointing at
# it. Data survives restarts, so a normal start only checks for pending
# migrations instead of replaying the three baseline files; RESET_DB=1 throws
# the volume away for a clean run. Nothing outside Docker is touched, and the
# API refuses any non-loopback host anyway. Not used by CI or the image.
#
# Environment:
#   CLOUD_BIND    listen address (default 127.0.0.1:8080)
#   API_PORT      container port on the host (default 55432)
#   SKIP_MIGRATE  set to 1 to reuse an already-migrated database
#   RESET_DB      set to 1 to drop the container and its volume first
#   DEV_OZON_WRITES  set to 1 to enable real Seller writes (default off)
#   DEV_MEDIA_GC_WORKER  set to 0 to keep the automatic cleanup worker stopped
# Local settings in .env.local override .env for this API process.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

# Server credentials stay in the API child, separate from the Vite process.
set -a
for dev_env_file in .env .env.local; do
  if [ -f "$dev_env_file" ]; then
    source "$dev_env_file"
  fi
done
set +a

port="${API_PORT:-55432}"
bind="${CLOUD_BIND:-127.0.0.1:8080}"
name="podhub-dev-pg"
volume="podhub-dev-pgdata"
admin_dsn="postgres://postgres:postgres@127.0.0.1:${port}/podhub?sslmode=disable"
# The API refuses a superuser or BYPASSRLS login. 00001_roles.sql creates this
# one for exactly that purpose; it is not superuser and does not bypass RLS.
dsn="postgres://podhub_login_api:podhub@127.0.0.1:${port}/podhub?sslmode=disable"
worker_dsn="postgres://podhub_login_ai_media_worker:podhub@127.0.0.1:${port}/podhub?sslmode=disable"
# The listing worker claims listing.submit.batch. Without it a send stays
# queued forever locally; only the Cloud deployment used to run one.
listing_dsn="${dsn/podhub_login_api/podhub_login_listing_worker}"
# The reconciler claims accepted imports and reads back Ozon's receipt. Without
# it a successful send stays accepted with no product id or import outcome.
reconciler_dsn="${dsn/podhub_login_api/podhub_login_reconciler}"
media_delete="${CLOUD_MEDIA_GC_DELETE:-0}"
# A real send creates a live Ozon listing. Keep the kill switch on unless the
# operator opts in for this process; .env's own value is not an opt-in.
ozon_kill_switch=1
case "$(printf '%s' "${DEV_OZON_WRITES:-}" | tr '[:upper:]' '[:lower:]')" in
  1 | true | on | yes) ozon_kill_switch=0 ;;
esac

if [ "${RESET_DB:-0}" = "1" ]; then
  echo "resetting ${name}"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm -f "$volume" >/dev/null 2>&1 || true
fi

# An older dev.sh ran this container without a volume, so its data dies with
# it. Recreate it now rather than migrate into storage that the next start
# would drop.
if docker inspect "$name" >/dev/null 2>&1 &&
  [ "$(docker inspect -f '{{range .Mounts}}{{.Name}}{{end}}' "$name")" != "$volume" ]; then
  docker rm -f "$name" >/dev/null 2>&1 || true
fi

if ! docker inspect "$name" >/dev/null 2>&1; then
  docker run -d --name "$name" \
    -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_DB=podhub \
    -p "127.0.0.1:${port}:5432" \
    -v "${volume}:/var/lib/postgresql/data" \
    postgres:16-alpine >/dev/null
elif [ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]; then
  docker start "$name" >/dev/null
fi

# Probe TCP on purpose. During initdb the entrypoint runs a temporary server
# on the Unix socket only (listen_addresses=''), so a socket probe succeeds
# and then dies mid-migration with an unexpected EOF. The final server is the
# only one listening on loopback.
ready() {
  docker exec "$name" pg_isready -q -h 127.0.0.1 -U postgres -d podhub >/dev/null 2>&1
}
for _ in $(seq 1 1200); do
  ready && break
  sleep 0.05
done
if ! ready; then
  echo "postgres did not become ready on 127.0.0.1:${port}" >&2
  docker logs --tail 20 "$name" >&2 || true
  exit 1
fi
echo "postgres ready on 127.0.0.1:${port}"

if [ "${SKIP_MIGRATE:-0}" != "1" ]; then
  echo "applying migrations"
  # The pool refuses a superuser login; the migration needs the postgres
  # role. The escape hatch is read at connect time, so it stays local to
  # this one process.
  PODHUB_ALLOW_SUPERUSER_DB=1 DATABASE_URL="$admin_dsn" go run ./scripts/devmigrate
fi

# The migration creates the roles without a password. Set one so the API and
# the worker can log in as them. Idempotent, and it also repairs a database
# started with SKIP_MIGRATE before the role had a password.
docker exec "$name" psql -U postgres -d podhub -qc \
  "ALTER ROLE podhub_login_api PASSWORD 'podhub'"
docker exec "$name" psql -U postgres -d podhub -qc \
  "ALTER ROLE podhub_login_listing_worker PASSWORD 'podhub'"
docker exec "$name" psql -U postgres -d podhub -qc \
  "ALTER ROLE podhub_login_reconciler PASSWORD 'podhub'"

# Leases are per CLOUD_INSTANCE_ID and expire after 60s without a write. Pin the
# id (the default axum-<pid> changes every start) and keep every domain leased
# for it, otherwise roster, auth and billing writes answer "写入未启用". The
# keeper is built first so the trap kills the process itself, not a go run shim.
export CLOUD_INSTANCE_ID="${CLOUD_INSTANCE_ID:-dev-local}"
tools=$(mktemp -d)
go build -o "$tools/devlease" ./scripts/devlease
DATABASE_URL="$dsn" "$tools/devlease" -once
DATABASE_URL="$dsn" "$tools/devlease" &
keeper=$!
media_worker=""
listing_worker=""
reconcile_worker=""
cleanup() {
  kill "$keeper" 2>/dev/null || true
  if [ -n "$media_worker" ]; then
    kill "$media_worker" 2>/dev/null || true
    wait "$media_worker" 2>/dev/null || true
  fi
  if [ -n "$listing_worker" ]; then
    kill "$listing_worker" 2>/dev/null || true
    wait "$listing_worker" 2>/dev/null || true
  fi
  if [ -n "$reconcile_worker" ]; then
    kill "$reconcile_worker" 2>/dev/null || true
    wait "$reconcile_worker" 2>/dev/null || true
  fi
  wait "$keeper" 2>/dev/null || true
  rm -rf "$tools"
}
trap cleanup EXIT

if [ "${DEV_MEDIA_GC_WORKER:-1}" != "0" ]; then
  case "$(printf '%s' "$media_delete" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')" in
    1|true|on|yes)
      docker exec "$name" psql -U postgres -d podhub -qc \
        "ALTER ROLE podhub_login_ai_media_worker PASSWORD 'podhub'"
      go build -o "$tools/media-gc" ./cmd/worker-media-gc
      echo "starting user slice cleanup worker"
      DATABASE_URL="$worker_dsn" CLOUD_MEDIA_GC_DELETE="$media_delete" "$tools/media-gc" &
      media_worker=$!
      ;;
  esac
fi

# The listing worker drains submission intents. With the default kill switch a
# send settles as a visible refusal instead of staying queued; DEV_OZON_WRITES=1
# lets it reach the real Seller API.
go build -o "$tools/worker-listing" ./cmd/worker-listing
echo "starting listing worker"
DATABASE_URL="$listing_dsn" OZON_WRITE_KILL_SWITCH="$ozon_kill_switch" "$tools/worker-listing" &
listing_worker=$!

# Receipts only. Keep product sync out of the local reconcile process so it
# cannot enqueue store.product_sync jobs that no local sync worker drains.
go build -o "$tools/worker-reconcile" ./cmd/worker-reconcile
echo "starting reconcile worker"
DATABASE_URL="$reconciler_dsn" OZON_PRODUCT_SYNC_DISABLED=1 \
  DELEGATE_SYNC_INTERVAL_MS=86400000 "$tools/worker-reconcile" &
reconcile_worker=$!

echo "starting api on ${bind}"
# R2 deletion is opt-in for local development.
DATABASE_URL="$dsn" CLOUD_BIND="$bind" \
  OZON_WRITE_KILL_SWITCH="$ozon_kill_switch" CLOUD_MEDIA_GC_DELETE="$media_delete" \
  go run ./cmd/api
