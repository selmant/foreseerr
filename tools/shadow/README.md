# shadow

Record real traffic against the Foreseerr backend, replay it against several
backends at once, and compare what they did. It exists to check a
reimplementation of the backend (for example in Rust) against the current
TypeScript one, without needing hand-written tests for every endpoint.

```text
record:   clients ──► shadow :5056 ──► backend :5055 ──► shadow :8899 ──► TMDB, Sonarr, Plex, ...
                          │                                  │
                     traffic.jsonl                      upstream.jsonl     + snapshot of config/ and DB

replay:   recording ──► shadow ──► baseline   (Node)        each target has its own copy of the
                              ├──► noise      (Node again)  snapshot and its own forward proxy that
                              └──► candidate  (Rust)        answers outgoing calls from the recording

compare:  responses, outgoing calls and databases, baseline vs candidate,
          minus whatever also differed between baseline and noise
```

Build it with `cargo build --release` in this directory. The binary is
`target/release/shadow`.

## 1. Record

Put the recorder in front of the running backend and point the backend's
outgoing calls at it.

1. Create the certificate authority the backend must trust, so HTTPS calls
   can be read:

   ```sh
   shadow ca --dir shadow-ca        # prints the path of ca.pem
   ```

2. Restart the backend with `NODE_EXTRA_CA_CERTS=/path/to/shadow-ca/ca.pem`.
3. In **Settings → Network → HTTP(S) proxy**, set host `127.0.0.1` (or
   wherever the recorder runs), port `8899`, and turn **off** "bypass local
   addresses" so LAN services like Sonarr and Plex are recorded too. The
   proxy listens on loopback; when the backend can't reach that (another
   host or container), pass `--upstream-listen 0.0.0.0:8899` and keep the
   port away from untrusted networks, since it forwards anything.
4. Start recording:

   ```sh
   shadow record \
     --primary http://127.0.0.1:5055 \
     --listen 0.0.0.0:5056 \
     --config-dir /path/to/foreseerr/config \
     --out recordings/2026-10-10
   ```

5. Send clients to port 5056 instead of 5055, for example by pointing your
   reverse proxy at it. Stop with Ctrl-C.

What ends up in the recording:

| File              | Contents                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshot/config` | Copy of the config directory at the start, including the SQLite DB (taken with SQLite's online backup, so the backend keeps running). `logs/` and `cache/` are left out.                 |
| `traffic.jsonl`   | Every request under `/api/`, `/imageproxy/` and `/avatarproxy/` with its response. Static frontend files pass through unrecorded.                                                        |
| (same file)       | Scheduled job starts, found by polling `/api/v1/settings/jobs` with the API key from `settings.json`. Replay runs the same job at the same point.                                         |
| `upstream.jsonl`  | Every outgoing call the backend made, with the full response.                                                                                                                            |

For Postgres, add `--pg-url postgres://...` and the snapshot includes a
`pg_dump` (`snapshot/postgres.dump`).

> **Recordings contain secrets**: session cookies, API keys, Plex tokens and
> passwords from login requests. Files are created readable by the owner only.
> Don't commit them or share them.

## 2. Replay

Replay is driven by a TOML file. Each target starts from its own copy of the
snapshot. `shadow` patches the copied `settings.json` so outgoing calls go to
that target's replay proxy and cron schedules are parked (jobs only run where
the recording says they ran). It then starts the process and waits until
startup work settles, meaning no outgoing calls and no DB writes for 3s.
After that, events go to all targets at once, one event at a time.

```toml
recording = "recordings/2026-10-10"
out = "runs/2026-10-10"
ca_dir = "shadow-ca"

[db]
ignore_tables = ["session"]          # `mapping_*` style prefixes work too
ignore_columns = []                  # "column" or "table.column"

[compare]
ignore_paths = []                    # e.g. "updatedAt", "$.results[*].media.lastSeasonChange"
timestamp_tolerance_ms = 5000

[[target]]
name = "node"
role = "baseline"                    # exactly one
url = "http://127.0.0.1:6101"
proxy_port = 6201
cwd = "/path/to/SeerrSuggestArr"
command = ["bun", "dist/launcher.js"]
env = { NODE_ENV = "production", PORT = "6101" }

[[target]]
name = "node-noise"
role = "noise"                       # optional, strongly recommended
url = "http://127.0.0.1:6102"
proxy_port = 6202
cwd = "/path/to/SeerrSuggestArr"
command = ["bun", "dist/launcher.js"]
env = { NODE_ENV = "production", PORT = "6102" }

[[target]]
name = "rust"
role = "candidate"
url = "http://127.0.0.1:6103"
proxy_port = 6203
command = ["/path/to/foreseerr-rs"]
env = { PORT = "6103" }
```

```sh
shadow replay --config replay.toml
```

Details:

- **Environment.** The config directory is passed in `CONFIG_DIRECTORY`
  (change it with `config_env`). The CA is passed in both
  `NODE_EXTRA_CA_CERTS` and `SHADOW_CA_FILE`. A non-Node candidate has to
  trust that CA and honour `settings.json` `network.proxy`.
- **Placeholders.** `{workdir}`, `{config}`, `{snapshot}`, `{recording}` and
  `{proxy_port}` are replaced in `command`, `env`, `prepare` and `db`.
- **Postgres targets.** Use `prepare` to restore the dump into a per-target
  database and `db = { kind = "postgres", url = "..." }` so it can be
  digested, for example:
  `prepare = [["sh", "-c", "dropdb --if-exists t1 && createdb t1 && pg_restore -d t1 {snapshot}/../postgres.dump"]]`.
- **Unmanaged targets.** Leave out `command` to replay against a target you
  started yourself. You then have to point its proxy at `proxy_port` yourself.
- **Sessions.** Logins that happen during the recording are mapped per
  target: the recorded cookie value is swapped for the one each target
  issued. Sessions from before the recording keep working because the
  session table and secret come from the snapshot.
- **Settling after writes.** After every write, the runner waits until the
  target has made no outgoing call for `settle_ms`. This catches work done
  after the response, such as sending a request to Radarr. It then takes
  per-table DB digests (`db_checkpoints = true`). Digests leave timestamp
  values out, because "now" differs by milliseconds between targets; the
  final row-by-row diff still compares them, within the tolerance.
- **Outgoing calls are never sent anywhere.** They're answered from the
  recording, matched by method + URL (query order ignored) + body, falling
  back to URL only, then to a match that ignores date-like values. When the
  same call was recorded several times, the answer that was current at that
  point in the recording is used. Calls with no match get a 502 and are
  counted as "unmatched".

Per target, the run directory contains `results.jsonl` (one line per event:
the response, the outgoing calls and the DB digest), `db.json` (the final
state), `startup.jsonl` (calls made while booting) and `target.log`.

## 3. Compare

```sh
shadow compare runs/2026-10-10 --config replay.toml
shadow compare runs/2026-10-10 --config replay.toml --against-recording
```

This writes `report.md` and `report.json` to the run directory and exits
non-zero when a candidate differs, so it can gate CI. The report covers:

- **Responses.** Status, `content-type` and `location`, Set-Cookie names,
  and the body as a structural JSON diff with paths like
  `$.results[3].mediaInfo.status`.
- **Outgoing calls.** Calls only the baseline made and calls only the
  candidate made. Secret query values like `api_key` are shown as a short
  hash.
- **Database.** The first event after which each table's digest diverged,
  and a row-by-row diff of the final state.

How noise is handled:

- **Noise target.** Anything that differs between baseline and noise is
  noise for that route (or column). It's learned strictly and then ignored
  for candidates. Events where baseline and noise disagree on the status are
  counted as flaky.
- **Timestamps.** Values within `timestamp_tolerance_ms` of each other count
  as equal, since targets run in lockstep.
- **Jobs.** Job starts are detected from the job's `history.lastStartedAt`
  when the backend reports it, otherwise from `nextExecutionTime` moving
  forward after a scheduled run.
- **Configured ignores.** `[compare] ignore_paths`, `ignore_routes`,
  `mask_timestamps`, and `[db] ignore_tables` / `ignore_columns`.

`--against-recording` compares the baseline's replayed responses with what
the real backend answered while recording. It measures how faithful the
replay is; if this isn't clean, fix the setup before trusting candidate
results.

## Testing the tool

The crate is linted strictly: rustc's `future_incompatible`,
`rust_2018_idioms`, `unused` and more, plus Clippy's `all`, `pedantic` and
`nursery` groups and a set of restriction lints (no `unwrap`/`expect`, no
panicking indexing, no `as` casts, no `println!`), all set to deny in
`Cargo.toml`. `allow_attributes` is denied too, so lints can't be silenced
with `#[allow]`. The toolchain is pinned in `rust-toolchain.toml`, and
`.github/workflows/shadow.yml` runs the same checks in CI:

```sh
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

`cargo test` runs the unit tests. `e2e/run.sh` runs the whole loop against
the real backend from source:

1. Record a session: logins, TMDB-backed pages, writes, and a scheduled job.
2. Replay it against baseline, noise, a faithful candidate and a
   deliberately altered one.
3. Check that the faithful candidate matches and the altered one is caught
   on both the response body and the outgoing TMDB calls.

## Limits

- Replay is sequential. Bugs that only show up under concurrency won't
  appear.
- Server-sent events and requests whose client disconnected are recorded but
  skipped on replay. WebSockets aren't proxied.
- Outgoing calls made after `settle_max_ms`, or by timers unrelated to any
  request, are attributed to whichever event is running at the time.
- Wall-clock dependent output that isn't a timestamp (for example "airs in 3
  days") can differ between a recording and a replay made on another day.
  Calls whose URLs contain dates still match through the date-insensitive
  fallback.
