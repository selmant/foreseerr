#!/usr/bin/env bash
# Differential test of the Rust OpenAPI request validator (src/openapi)
# against the real express-openapi-validator.
#
# 1. scripts/openapi-diff.js mounts express + express-openapi-validator with
#    seerr-api.yml as server/index.ts does, sends it the generated corpus
#    and records Node's answers (run with the backend's runtime, bun, from
#    the repository so mise picks the pinned version).
# 2. `cargo test openapi_ -- --ignored` replays every request through
#    `Validator::decide` and fails on any certain decision that differs.
#
# Usage: backend-rs/scripts/openapi-diff.sh [corpus.jsonl] [port]
#   NODE_MODULES   where express & co. live (default: <repo>/node_modules)
#   OPENAPI_SPEC   the spec (default: <repo>/seerr-api.yml)
#   JS_RUNTIME     default: bun
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
# Default to a fresh private directory, not a fixed path in the shared tmp.
OUT=${1:-$(mktemp -d "${TMPDIR:-/tmp}/openapi-diff.XXXXXX")/corpus.jsonl}
PORT=${2:-6801}
export NODE_MODULES=${NODE_MODULES:-$REPO/node_modules}
export OPENAPI_SPEC=${OPENAPI_SPEC:-$REPO/seerr-api.yml}

mkdir -p "$(dirname "$OUT")"
(cd "$REPO" && "${JS_RUNTIME:-bun}" "$REPO/backend-rs/scripts/openapi-diff.js" "$OUT" "$PORT")
cd "$REPO/backend-rs"
OPENAPI_CORPUS=$OUT cargo test --locked openapi_ -- --ignored --nocapture
