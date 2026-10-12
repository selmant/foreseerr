#!/usr/bin/env bash
# End-to-end check of the shadow tool against the real backend:
#   1. start the backend (from source) behind `shadow record`
#   2. drive some traffic: logins, TMDB-backed pages, writes, a scheduled job
#   3. replay against baseline + noise + two candidates (one deliberately altered)
#   4. compare: the faithful candidate must match, the altered one must not
#
# Usage: tools/shadow/e2e/run.sh [config-dir]   (default: ./config, the Cypress test config)
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../../.." && pwd)
SRC_CONFIG=${1:-$REPO/config}
WORK=${SHADOW_E2E_DIR:-/tmp/shadow-e2e}
SHADOW=$REPO/tools/shadow/target/release/shadow
PRIMARY_PORT=5155
RECORD_PORT=5156
UPSTREAM_PORT=8899

cleanup() {
  [[ -n "${REC_PID:-}" ]] && kill "$REC_PID" 2>/dev/null || true
  [[ -n "${PRIMARY_PID:-}" ]] && kill "$PRIMARY_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

(cd "$REPO/tools/shadow" && cargo build --release --quiet)

rm -rf "$WORK/primary" "$WORK/recording" "$WORK/run"
mkdir -p "$WORK/primary"
cp -r "$SRC_CONFIG" "$WORK/primary/config"
rm -rf "$WORK/primary/config/logs"
"$SHADOW" ca --dir "$WORK/ca" >/dev/null

# Route the primary's outgoing calls through the recorder, mark the test
# instance as set up, and run download-sync every 10s so a job gets recorded.
python3 - "$WORK/primary/config/settings.json" "$UPSTREAM_PORT" <<'PY'
import json, sys
path, port = sys.argv[1], int(sys.argv[2])
s = json.load(open(path))
s["network"]["proxy"] = {"enabled": True, "hostname": "127.0.0.1", "port": port, "useSsl": False,
                         "user": "", "password": "", "bypassFilter": "", "bypassLocalAddresses": False}
s["public"]["initialized"] = True
s["jobs"]["download-sync"]["schedule"] = "*/10 * * * * *"
json.dump(s, open(path, "w"), indent=2)
PY

echo "== starting recorder (forward proxy first, so the backend's startup calls are captured)"
"$SHADOW" record --listen 127.0.0.1:$RECORD_PORT --primary http://127.0.0.1:$PRIMARY_PORT \
  --upstream-listen 127.0.0.1:$UPSTREAM_PORT --out "$WORK/recording" \
  --config-dir "$WORK/primary/config" --ca-dir "$WORK/ca" --jobs-poll-secs 2 \
  >"$WORK/recorder.log" 2>&1 &
REC_PID=$!

echo "== starting primary backend on :$PRIMARY_PORT"
(cd "$REPO" && NODE_ENV=development PORT=$PRIMARY_PORT CONFIG_DIRECTORY="$WORK/primary/config" \
  NODE_EXTRA_CA_CERTS="$WORK/ca/ca.pem" exec bun server/launcher.ts) >"$WORK/primary.log" 2>&1 &
PRIMARY_PID=$!
for _ in $(seq 1 120); do
  curl -sf -o /dev/null http://127.0.0.1:$PRIMARY_PORT/api/v1/status && break
  sleep 0.5
done
curl -sf -o /dev/null http://127.0.0.1:$PRIMARY_PORT/api/v1/status || { tail -30 "$WORK/primary.log"; exit 1; }

B=http://127.0.0.1:$RECORD_PORT/api/v1
JAR=$WORK/cookies.txt
rm -f "$JAR"
c() { curl -s -o /dev/null -w "%{http_code} $1 $2\n" -b "$JAR" -c "$JAR" -X "$1" "$B$2" "${@:3}"; }
json=(-H 'content-type: application/json')

echo "== driving traffic through the recorder"
c GET /status
c GET /settings/public
c HEAD /status -I
curl -s -o /dev/null -w "%{http_code} GET / (frontend, passed through unrecorded)\n" http://127.0.0.1:$RECORD_PORT/
c POST /auth/local "${json[@]}" -d '{"email":"admin@seerr.dev","password":"test1234"}'
c GET /auth/me
c GET /discover/movies
c GET /discover/tv
c GET /movie/550
c GET /tv/1399
c GET "/search?query=matrix&page=1"
c GET /request
c POST /request "${json[@]}" -d '{"mediaType":"movie","mediaId":603}'
c GET /request
c POST /user/2/settings/main "${json[@]}" -d '{"username":"friendly","locale":"de"}'
c GET /user/2/settings/main
c POST /watchlist "${json[@]}" -d '{"tmdbId":550,"mediaType":"movie","title":"Fight Club"}'
c GET /user
c POST /auth/logout
c GET /auth/me
c POST /auth/local "${json[@]}" -d '{"email":"friend@seerr.dev","password":"test1234"}'
c GET /auth/me
c GET /request
echo "== waiting for scheduled jobs to run"
sleep 22
c GET /settings/public

kill "$REC_PID"; wait "$REC_PID" 2>/dev/null || true; unset REC_PID
kill "$PRIMARY_PID"; wait "$PRIMARY_PID" 2>/dev/null || true; unset PRIMARY_PID
echo "== recorded: $(grep -c '"kind":"http"' "$WORK/recording/traffic.jsonl") requests, \
$(grep -c '"kind":"job"' "$WORK/recording/traffic.jsonl" || true) job runs, \
$(wc -l <"$WORK/recording/upstream.jsonl") upstream calls"

cat >"$WORK/replay.toml" <<TOML
recording = "$WORK/recording"
out = "$WORK/run"
ca_dir = "$WORK/ca"

[db]
ignore_tables = ["session"]

[[target]]
name = "node"
role = "baseline"
url = "http://127.0.0.1:6101"
proxy_port = 6201
cwd = "$REPO"
command = ["bun", "server/launcher.ts"]
env = { NODE_ENV = "development", PORT = "6101" }

[[target]]
name = "node-noise"
role = "noise"
url = "http://127.0.0.1:6102"
proxy_port = 6202
cwd = "$REPO"
command = ["bun", "server/launcher.ts"]
env = { NODE_ENV = "development", PORT = "6102" }

[[target]]
name = "candidate"
role = "candidate"
url = "http://127.0.0.1:6103"
proxy_port = 6203
cwd = "$REPO"
command = ["bun", "server/launcher.ts"]
env = { NODE_ENV = "development", PORT = "6103" }

# Same code with a changed setting, standing in for a buggy reimplementation.
[[target]]
name = "altered"
role = "candidate"
url = "http://127.0.0.1:6104"
proxy_port = 6204
cwd = "$REPO"
command = ["bun", "server/launcher.ts"]
env = { NODE_ENV = "development", PORT = "6104" }
prepare = [["python3", "-c", "import json,sys; p=sys.argv[1]; s=json.load(open(p)); s['main']['applicationTitle']='Altered'; s['main']['discoverRegion']='DE'; json.dump(s,open(p,'w'))", "{config}/settings.json"]]
TOML

echo "== replaying"
"$SHADOW" replay --config "$WORK/replay.toml"

echo "== comparing"
set +e
"$SHADOW" compare "$WORK/run" --config "$WORK/replay.toml" --candidate candidate
CLEAN=$?
"$SHADOW" compare "$WORK/run" --config "$WORK/replay.toml" --candidate altered --max-examples 5 >/dev/null
ALTERED=$?
"$SHADOW" compare "$WORK/run" --config "$WORK/replay.toml" --candidate candidate --candidate altered --against-recording --no-fail
set -e

echo
ALTERED_REPORT=$(sed -n '/^## `altered`/,/^## `recording`/p' "$WORK/run/report.md")
if [[ $CLEAN -eq 0 && $ALTERED -ne 0 ]] \
  && grep -q 'applicationTitle' <<<"$ALTERED_REPORT" \
  && grep -q 'outgoing call only the candidate made' <<<"$ALTERED_REPORT"; then
  echo "PASS: faithful candidate matches, altered candidate was caught. Report: $WORK/run/report.md"
else
  echo "FAIL: candidate exit=$CLEAN (want 0), altered exit=$ALTERED (want non-zero, with a body and an outgoing-call difference)"
  exit 1
fi
