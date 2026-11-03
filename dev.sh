#!/usr/bin/env bash
# dev.sh — start the local API and the Vite frontend together.
#
# The API comes up first (scripts/dev-api.sh) against a persistent Postgres
# container with a named volume, so a restart only applies new migrations
# instead of replaying the whole history. Vite proxies /api and /mcp to that
# process, so the browser only talks to the frontend origin. Ctrl-C stops
# both; the Postgres container is stopped but kept, and RESET_DB=1 wipes it.
#
# Environment (same names as the pieces this wraps):
#   CLOUD_BIND    API listen address (default 127.0.0.1:8080)
#   API_PORT      Postgres container port on the host (default 55432)
#   SKIP_MIGRATE  set to 1 to reuse an already-migrated database
#   RESET_DB      set to 1 to drop the dev database and migrate from scratch
#   KEEP_DB       set to 1 to leave Postgres running after exit
#   WEB_PORT      Vite port (default 1420; web/vite.config.ts uses the same default)
set -euo pipefail

root=$(cd "$(dirname "$0")" && pwd)
cd "$root"

bind="${CLOUD_BIND:-127.0.0.1:8080}"
web_port="${WEB_PORT:-1420}"
pg_name="podhub-dev-pg"

if ! command -v docker >/dev/null || ! command -v go >/dev/null || ! command -v bun >/dev/null; then
  echo "dev.sh needs docker, go, and bun on PATH" >&2
  exit 1
fi

if [ ! -d web/node_modules ]; then
  echo "installing web dependencies"
  (cd web && bun install)
fi

# Both children use strictPort / a fixed bind, so a leftover process from a
# previous run would only surface after Postgres and migrations have already
# run. Reclaim the ports before that work: an earlier dev.sh from this checkout
# is stopped through its own trap, and anything this repo left listening is
# killed. A process owned by another app or checkout is reported, never killed.
if ! command -v lsof >/dev/null; then
  echo "dev.sh needs lsof to inspect the dev ports" >&2
  exit 1
fi

proc_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

listener_pids() {
  lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u || true
}

under_root() {
  case "$1" in
    "$root"|"$root"/*) return 0 ;;
  esac
  return 1
}

# Nearest ancestor that is this checkout's dev.sh, if the listener came from it.
dev_sh_ancestor() {
  local pid=$1 cmd
  while [ "${pid:-0}" -gt 1 ]; do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
    case "${cmd%% *}" in
      */bash|*/sh|*/zsh|bash|sh|zsh)
        case " $cmd " in
          *[[:space:]]*dev.sh[[:space:]]*)
            if [ "$(proc_cwd "$pid")" = "$root" ]; then
              echo "$pid"
              return 0
            fi
            ;;
        esac
        ;;
    esac
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  done
  return 1
}

reclaim_port() {
  local name=$1 port=$2 var=$3 pid wrapper
  [ -n "$(listener_pids "$port")" ] || return 0

  # Let the old wrapper run its trap so it stops Vite, the API and Postgres
  # itself; otherwise its cleanup could stop the container under our feet.
  for pid in $(listener_pids "$port"); do
    wrapper=$(dev_sh_ancestor "$pid") || continue
    echo "stopping earlier dev.sh (pid ${wrapper}) holding ${name} port ${port}"
    kill "$wrapper" >/dev/null 2>&1 || true
    for _ in $(seq 1 50); do
      kill -0 "$wrapper" >/dev/null 2>&1 || break
      sleep 0.1
    done
    if kill -0 "$wrapper" >/dev/null 2>&1; then
      kill -9 "$wrapper" >/dev/null 2>&1 || true
    fi
    break
  done

  for pid in $(listener_pids "$port"); do
    if ! under_root "$(proc_cwd "$pid")"; then
      echo "${name} port ${port} is held by pid ${pid} ($(ps -o command= -p "$pid")); stop it or set ${var}" >&2
      exit 1
    fi
  done

  for pid in $(listener_pids "$port"); do
    echo "killing ${name} port ${port} listener (pid ${pid})"
    kill "$pid" >/dev/null 2>&1 || true
  done
  for _ in $(seq 1 30); do
    [ -z "$(listener_pids "$port")" ] && return 0
    sleep 0.1
  done
  for pid in $(listener_pids "$port"); do
    kill -9 "$pid" >/dev/null 2>&1 || true
  done
  sleep 0.2
  if [ -n "$(listener_pids "$port")" ]; then
    echo "${name} port ${port} is still in use; stop that process or set ${var}" >&2
    exit 1
  fi
}

for spec in "web:${web_port}:WEB_PORT" "api:${bind##*:}:CLOUD_BIND"; do
  name=${spec%%:*}
  rest=${spec#*:}
  reclaim_port "$name" "${rest%%:*}" "${rest##*:}"
done

pids=()
stopping=0

kill_tree() {
  local pid=$1 child
  local children
  children=$(pgrep -P "$pid" 2>/dev/null || true)
  for child in $children; do
    kill_tree "$child"
  done
  kill "$pid" >/dev/null 2>&1 || true
}

cleanup() {
  if [ "$stopping" -eq 1 ]; then
    return
  fi
  stopping=1
  local pid
  for pid in "${pids[@]+"${pids[@]}"}"; do
    kill_tree "$pid"
  done
  wait >/dev/null 2>&1 || true
  if [ "${KEEP_DB:-0}" != "1" ]; then
    docker stop -t 1 "$pg_name" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM HUP

echo "starting api on ${bind}"
CLOUD_BIND="$bind" bash scripts/dev-api.sh &
pids+=("$!")

echo "starting web on http://127.0.0.1:${web_port}"
# Invoke the local Vite binary directly so WEB_PORT is the only --port and a
# version mismatch never sends bun to the registry. `bun run dev` already
# appends `--port 1420` from package.json.
(cd web && exec ./node_modules/.bin/vite --host 127.0.0.1 --port "$web_port" --strictPort) &
pids+=("$!")

# bash 3.2 has no `wait -n`. Stop everything when either child exits.
while true; do
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      echo "a dev process exited; stopping the rest" >&2
      exit 1
    fi
  done
  sleep 1
done
