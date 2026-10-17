#!/usr/bin/env bash
# Run the Rust backend with the Node server behind it, as one process tree.
#
# Rust listens on $PORT (default 5055). Node is started from the repository
# on $FORESEERR_NODE_PORT (default $PORT + 1000) and only reachable from
# loopback. Every other environment variable is passed to both, so a
# replay target or a container can treat this script as "the backend".
#
# Usage: backend-rs/scripts/with-node.sh [path/to/foreseerr binary]
#   FORESEERR_NODE_COMMAND  how to start Node (default: "bun server/launcher.ts"
#                           in development, "bun dist/launcher.js" otherwise)
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${1:-$REPO/backend-rs/target/release/foreseerr}
PORT=${PORT:-5055}
NODE_PORT=${FORESEERR_NODE_PORT:-$((PORT + 1000))}
if [[ -n "${FORESEERR_NODE_COMMAND:-}" ]]; then
  read -r -a NODE_CMD <<<"$FORESEERR_NODE_COMMAND"
elif [[ "${NODE_ENV:-}" == "development" ]]; then
  NODE_CMD=(bun server/launcher.ts)
else
  NODE_CMD=(bun dist/launcher.js)
fi

cleanup() {
  trap - TERM INT EXIT
  [[ -n "${RUST_PID:-}" ]] && kill "$RUST_PID" 2>/dev/null || true
  [[ -n "${NODE_PID:-}" ]] && kill "$NODE_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup TERM INT EXIT

cd "$REPO"
HOST=127.0.0.1 PORT=$NODE_PORT "${NODE_CMD[@]}" &
NODE_PID=$!
FORESEERR_APP_ROOT=$REPO FORESEERR_NODE_URL="http://127.0.0.1:$NODE_PORT" "$BIN" &
RUST_PID=$!

# Stop when either side stops, so a crash is visible to whoever started us.
wait -n "$NODE_PID" "$RUST_PID"
