# backend-rs

The Rust backend for Foreseerr, replacing the Node server. It listens where
Node used to and has a handler for every route in `seerr-api.yml`. It runs
in one of two modes:

- hybrid: Node keeps running behind it (`FORESEERR_NODE_URL`), and gets
  every request no Rust handler takes plus every request a handler hands
  back because it can't answer exactly as Node would;
- standalone (below): no Node; this binary is the whole backend.

```text
clients ──► foreseerr (Rust) :5055 ──► Node :5056   (FORESEERR_NODE_URL)
                 │
                 └── native routes answered here, reading and writing the
                     same settings.json and database Node uses
```

In hybrid mode Node still owns the schema and migrations and, unless
`FORESEERR_RUST_JOBS` says otherwise, the jobs and the state that lives in
its memory. The Rust side reads settings.json (reloaded when the file
changes) and writes it as `getSettings().save()` does, then tells Node to
read it again (`POST /internal/settings/reload`). It reads and writes the
database as the TypeORM handlers do, refreshes session expiry as
express-session does on every request, and runs the request lifecycle
(notifications, sending to Radarr/Sonarr). State that lives only in Node's
memory is read and changed over the `/internal` routes Node serves for this
purpose (`server/routes/internal.ts`), authenticated with the API key: the
download tracker (`/internal/downloads`, which `downloadStatus` needs), the
jobs and scanners, the response caches and integration health, the mapping
layer, the Simkl sync and resolution, the Trakt token refresh, the TVDB
metadata, the calendar source statuses and the login avatar check (see
"Hybrid forwarding" below for what `FORESEERR_RUST_JOBS` moves here).
Outgoing calls honour
`network.proxy` and the `NODE_EXTRA_CA_CERTS` / `SHADOW_CA_FILE` file like
Node, so they can be recorded and replayed too.

## Ported routes

Every path and method `seerr-api.yml` documents has a native handler, plus
`POST /api/v1/desktop/browser-cache/redeem` (not in the spec) and
`/imageproxy`, `/avatarproxy` outside `/api`. Grouped by area:

| Route                              | Answered here when                                               |
| ---------------------------------- | ---------------------------------------------------------------- |
| `GET /api/v1/status`, `/status/appdata`, `/settings/public`, `/auth/me` | unless a general case below applies; `/status` includes the update check against GitHub |
| `/api/v1/auth/`: `local`, `logout`, `plex`, `jellyfin`, `jellyfin/quickconnect/{initiate,check,authenticate}`, `reset-password`, `reset-password/{guid}` | unless a general case below applies |
| `POST /api/v1/auth/jellyfin/plugin`, `/api/v1/desktop/{auth-tickets,auth-tickets/redeem,browser-cache/redeem}` | the binary runs standalone as the Jellyfin plugin sidecar or the desktop child respectively; with Node behind, both runtimes go to Node whole |
| `/api/v1/user`: list, create, bulk `PUT`, `{id}` (`GET`, `PUT`, `DELETE`), `{id}/requests`, `{id}/watchlist`, `{id}/watch_data`, `{id}/pushSubscriptions`, `{id}/pushSubscription/{endpoint}`, `registerPushSubscription`, `import-from-plex`, `import-from-jellyfin`, `jellyfin/{id}` | unless a general case below applies |
| `GET`/`POST /api/v1/user/{id}/settings/{main,password,notifications,permissions,discover}` | unless a general case below applies |
| `GET /api/v1/user/{id}/quota`      | the user themselves or a `MANAGE_USERS` + `MANAGE_REQUESTS` holder; the window boundary is `now - days` in UTC where Node uses the server's local calendar, so a DST change inside the window shifts Node's boundary by an hour |
| `/api/v1/user/{id}/settings/linked-accounts/`: Plex and Jellyfin (link, Quick Connect, unlink), Trakt and Simkl (`GET`, `PATCH`, `DELETE`), AniList (`GET`, `POST`, `PATCH`, `DELETE`) | unless a general case below applies |
| `POST .../linked-accounts/trakt/device/{code,token}`, `.../simkl/pin/{code,token}`, `.../simkl/sync` | standalone only: the device and PIN sessions, their throttles and the Simkl sync's per-user lock live in Node's memory, so with Node behind these always go to Node |
| `/api/v1/settings/` (admin): `main` (+`regenerate`), `initialize`, `network`, `plex` (+libraries, library sync, users, `devices/servers`), `jellyfin` (+libraries, library sync, users), `tautulli`, `radarr`/`sonarr` (+`test`, `{id}`, `{id}/profiles`), `metadatas` (+`test`), `servarr-interventions`, `trakt`/`simkl`/`anilist` (+`actions`), `mdblist`, every notification agent (+`test`, Pushover `sounds`), `discover` (+`add`, `{id}`, `reset`), `jobs`, `plex/sync`, `jellyfin/sync`, `cache`, `integrations/status`, `mapping/*`, `logs`, `about` | unless a general case below applies. Sections Node returns as stored are read from settings.json as they are. `POST /settings/plex` and `/settings/tautulli` go to Node when the body changed the settings and the connection test fails (or Tautulli has no hostname): Node keeps the assigned body unsaved in its memory, which only Node can reproduce |
| `/api/v1/request`: list, `count`, `{id}` (`GET`, `PUT`, `DELETE`), create, `{id}/{approve,decline,retry}` | unless a general case below applies; quality profile names come from every Radarr and Sonarr server through `getRolling`'s cache, failures land in `serviceErrors` as in Node; writes run the request lifecycle (`src/lifecycle.rs`): notifications, sending to Radarr/Sonarr in the background, parent media and season statuses |
| `/api/v1/issue`: list, `count`, `{id}` (`GET`, `DELETE`), create, `{id}/comment`, `{id}/{open,resolved}`; `/api/v1/issueComment/{id}` | unless a general case below applies |
| `/api/v1/media`: list, `{id}` `DELETE`, `{id}/{status}`, `{id}/file`, `{id}/watch_data`, `{id}/servarr/*` (context, release search and grab, manual imports, commands) | unless a general case below applies; the download tracker comes from Node unless this process runs the jobs |
| `/api/v1/media-actions/*`: `capabilities`, `status-batch`, movie, show and episode status, watched, unwatched and rating | while Node owns the mapping layer's sync caches (no `FORESEERR_RUST_JOBS`), a request that would reach one of the user's linked providers (Trakt, Jellyfin, AniList, Simkl) goes to Node; only the no-provider answers are given here |
| `/api/v1/movie/{id}`, `/tv/{id}` (+`recommendations`, `similar`, `ratings`; TV also `season/{n}` and `episodes`), `/person/{id}` (+`combined_credits`), `/collection/{id}`, `/search` (+`keyword`, `company`), `/genres/*`, `/certifications/*`, `/keyword/{id}`, `/network/{id}`, `/studio/{id}`, `/backdrops`, `/regions`, `/languages`, `/watchproviders/{regions,movies,tv}` | unless a general case below applies; TMDB, TVDB, Rotten Tomatoes, the IMDb proxy and MDBList are called as Node calls them, with the same caches |
| `/api/v1/discover/`: the TMDB lists (`movies`, `tv`, `trending`, upcoming, by language, genre, studio, network and keyword, `genreslider`), `trakt/*`, `anilist/*`, `simkl/*`, `mdblist/*`, `watchlist` | unless a general case below applies; the mapping layer (TMDB resolution of provider items, the Simkl library sync) is Node's over `/internal` unless this process runs the jobs |
| `/api/v1/library/*`, `/api/v1/calendar`, `/api/v1/service/{radarr,sonarr}` (+`{id}`, `sonarr/lookup/{tmdbId}`), `/api/v1/servarr/interventions` (+`count`, `seen`, `{id}/reject`) | unless a general case below applies |
| `/api/v1/blocklist` (+`{id}`, `collection/{id}`), `/api/v1/blacklist` (the deprecated alias), `/api/v1/watchlist`, `/api/v1/overrideRule` | unless a general case below applies |
| `GET /imageproxy/*`, `GET /avatarproxy/*` (`HEAD` runs the `GET` route, as in Express) | the path is one Express wouldn't decode or normalise (no `%`, dot or empty segments, trailing slash); other methods go to Node |

Routes are registered in `src/routes/mod.rs` from three tables: `ROUTES`
maps a path to the `GET` handler that answers it, `SETTINGS_SECTIONS` maps
a path to the settings.json section it returns as it is, and `TABLES` lists
each module's own `ROUTES` table of path, method and handler (a module adds
itself there); `imageproxy::routes` adds the two image mounts. Paths are
matched as Express matches them (case-insensitively, with an optional
trailing slash and decoded parameters, `src/routes/expressroute.rs`); a
request that goes to Node is sent with the URI it arrived with. A
registered path's other methods, and `HEAD`, go to Node, whose validator
answers 405; so does every path no handler is registered for.

The TMDB-backed routes use `src/tmdb.rs`, which carries `ExternalAPI.get`'s
response cache (a day for these lookups) and axios's query encoding, so the
outgoing calls match Node's byte for byte in a shadow replay.

`GET /media` reproduces `TypeORM`'s paging order (sort column descending,
then id ascending) and leaves `seasons` out of the `mediaAdded` sort, whose
query builder doesn't load the eager relation. The `Media` entity is printed
as Node does in `src/media.rs`: the computed links and download progress
first, in declaration order, then the columns; a Plex `machineId` missing
from settings.json prints as `undefined`, as the template literal does.

Numbers in upstream JSON are re-printed as JavaScript would (`8.0` becomes
`8`), since Node parses and re-serialises every answer.

TMDB-backed routes compare equal to Node only against the same upstream
answers: TMDB orders some arrays (release dates, crew, a cast member's
roles) differently from one call to the next and vote counts move, so side
by side against live TMDB the bodies differ in order while an
order-insensitive comparison is clean.
The shadow replay, which serves both sides the recorded answers, is the
reference check.

While Node answers part of the traffic, each process keeps its own
response cache, so a request Node answers may re-fetch from TMDB what this
server already holds (the shadow report lists it as an extra outgoing
call).

Two Node quirks are reproduced on purpose in `GET /user`: the OpenAPI
validator fills in `sort=created`, so the handler's own default never
applies, and TypeORM leaves the search `OR` chain unparenthesised, so
`includeIds` only narrows the last branch of it.

One is deliberately not: `GET /tv/{id}/season/{n}` prefixes the image host
onto episode stills once per answer. Node writes the prefix onto its cached
object, so it stacks once more per call within the cache's five minutes;
cached answers here are shared and never changed in place.

A handler that can't be sure of answering as Node would hands the request
on instead (`Outcome::Forward` in `src/routes/mod.rs`, logged at `debug`
with the reason, `RUST_LOG=foreseerr=debug`). In hybrid mode it goes to
Node with the request intact; standalone, the handler's own fallback
answer is given instead (see "Standalone" below). Forwarding is meant to
be decided before a handler changes anything, so that Node runs the request
from the start: once a write handler has written to the database or
settings.json, or called an upstream that acts, a failure is answered
here (`try_written!` in `src/routes/writes.rs`), never handed to Node to
run again. The general cases, on top of the per-route ones in the table:

- plugin mode (`FORESEERR_PLUGIN`) and the desktop runtime with Node
  behind: nothing is answered here and the OpenAPI gate is skipped, so
  every request goes to Node unchanged (standalone mode runs both, see
  "Managed runtimes" below);
- `HEAD` on an `/api` route, and a method no handler is registered for
  on a path (Node's validator answers 405);
- Node hasn't answered a request yet after startup, so this server is as
  unavailable as Node while Node boots;
- settings.json can't be read, or the database fails in a way the handler
  doesn't answer itself;
- `X-API-User` that isn't a whole number, or a `SQLite` datetime not in the
  shape TypeORM writes, which Node would read in the server's local
  timezone;
- the OpenAPI validator is unsure. With Node behind it runs in `proxy`
  mode (`FORESEERR_OPENAPI_VALIDATOR`, `src/openapi/gate.rs`): rejections
  that are certainly Node's (400 for a bad query or body, 401 without a
  credential, 405) are answered here, anything it isn't sure of goes to
  Node, and requests that pass reach the handlers with the query and body
  as the validator left them. A handler still forwards an input the
  validator didn't vouch for (a query string, a body field, an enum
  value) rather than judge it itself;
- `isAuthenticated`'s 403 is answered here once the validator has judged
  the request; without that the request goes to Node;
- a body `express.json()` would refuse or skip (not JSON, over 100 kB,
  neither an object nor an array), or fields the handler would store
  differently from Node;
- stored data or upstream answers of a shape Node would trip over or print
  differently (a stored `notificationTypes` or GitHub payload that would
  make Node throw, a path segment Express would decode, an odd Arr or
  Plex answer…), and upstream failures whose message Node words itself;
  the reason strings in the handlers say which.

`network.csrfProtection` (read at startup, as Node mounts csurf once) is
reproduced in `src/csrf.rs` in front of everything: answers made here get
the `_csrf` and `XSRF-TOKEN` cookies as Node would set them, a request with
a missing or wrong token (or a body only Node's parsers can judge) goes to
Node, which refuses it in its own words, and Node's answers pass through
untouched.

Writes receive the body as `express.json()` parses it (or as the validator
left it, once it passed the request); a body it would refuse, or one whose
fields the handler would store oddly, goes to Node with the request intact.
They run the statements `TypeORM` would and print the entity as Node
leaves it: fields the body omitted are `undefined` and drop out, and a
removed entity loses its id.

Responses match Express's `res.json`: compact JSON with a weak `ETag`, and a
`304` when `If-None-Match` matches.

## Hybrid forwarding

`scripts/with-node.sh` starts both processes as one tree: Node on
`$FORESEERR_NODE_PORT` (default `$PORT + 1000`) bound to `127.0.0.1`
(`FORESEERR_NODE_COMMAND` overrides how; `bun server/launcher.ts` in
development, `bun dist/launcher.js` otherwise), and Rust on `$PORT` with
`FORESEERR_NODE_URL=http://127.0.0.1:<node port>` and
`FORESEERR_APP_ROOT` set to the repository. Every other variable is passed
to both. When either process exits the other is stopped.

Forwarding (`src/proxy.rs`) sends Node the request as it arrived: the
method, the original path and query (before the Express-style rewrite),
the headers (`Host`, cookies and the rest unchanged) with the client's
address appended to `X-Forwarded-For`, over HTTP/1.1. The request body is
streamed through, or sent as the bytes the validator, the CSRF layer or
the handler already buffered. Node's status, headers and body are streamed
back as they come. Hop-by-hop headers (`Connection`, `Keep-Alive`,
`Proxy-*`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`) are dropped
both ways, so a WebSocket upgrade isn't proxied (Node serves none). If
Node doesn't answer, the client gets 502
`{"message":"The backend is not available"}`. The first answer from Node
marks it ready, and from then on the native handlers answer.

Besides the `/api` cases above, everything outside the native routes goes
to Node: the frontend and its SPA fallback, `/api-docs`, and `/internal`
requests that arrive from outside. Rust doesn't look at what Node
answered: no cache is invalidated and nothing runs after a forwarded
request. Coherence goes the other way. After its own writes Rust tells Node
what changed, over `/internal` with the API key:
`POST /internal/settings/reload` after every settings.json save,
`/internal/settings/effects` for side effects that live in Node's memory
(its MDBList client, the sync caches),
`/internal/user/{id}/sync-cache/{provider}/invalidate`,
`/internal/mapping/datasets/changed`, and `/internal/jobs/start` when the
first sign-in created the admin. A Node that can't be told is only logged.

`FORESEERR_RUST_JOBS=1` moves the jobs to this process. It has to reach
both processes (`with-node.sh` passes it on): Node then skips `startJobs()`
(`server/job/schedule.ts`) and Rust schedules and runs every job. The
state that comes with them is then read in-process instead of over
`/internal`: the download tracker, job and scanner state, the calendar
source statuses, the mapping layer (and with it the media-action provider
calls and the discover lists' TMDB resolution), and Node's process-state
routes (response caches, integration health, settings effects, TVDB
metadata, the Trakt token refresh, the Simkl sync, the login avatar
check). The per-user sync caches (`/internal/user/{id}/sync-cache/*`) stay
Node's while Node runs, and Rust keeps telling Node about settings
reloads, memory effects, dataset changes and sync-cache invalidations so
the copies behind the requests Node still answers stay current.

## Running

Build with `cargo build --release`; the binary is `target/release/foreseerr`.
It reads the same environment as Node (`PORT`, `HOST`, `CONFIG_DIRECTORY`,
`DB_TYPE` and the `DB_*` Postgres variables, `API_KEY`, `FORESEERR_PLUGIN`,
`FORESEERR_RUNTIME`) plus:

| Variable             | Meaning                                                    | Default                 |
| -------------------- | ---------------------------------------------------------- | ----------------------- |
| `FORESEERR_NODE_URL` | Where Node listens; unset means standalone (below)         | standalone              |
| `FORESEERR_STANDALONE` | `1` forces standalone, `0` forces forwarding to `http://127.0.0.1:5056` | follows `FORESEERR_NODE_URL` |
| `FORESEERR_RUST_JOBS` | `1`: this process runs the scheduled jobs (implied by standalone; Node reads it too) | unset |
| `FORESEERR_OPENAPI_VALIDATOR` | `proxy`: answer the validator's certain rejections, send the uncertain ones to Node; `standalone`: answer all; `off`: don't validate (refused in standalone mode) | `proxy`, `standalone` without Node |
| `FORESEERR_APP_ROOT` | Directory with package.json, committag.json and `config/`  | current directory       |
| `FORESEERR_PUBLIC_PATH` | The built frontend served in standalone mode            | `$FORESEERR_APP_ROOT/dist/public` |
| `RUST_LOG`           | Log filter, e.g. `info,foreseerr=debug` to see what is forwarded and why | `info`    |

`scripts/with-node.sh` starts both processes as one tree (see "Hybrid
forwarding" above). It is what a shadow replay target or a container can
run as "the backend".

### Standalone (no Node)

```sh
bun run build:web                 # once: the frontend in dist/public
cargo build --release
NODE_ENV=production CONFIG_DIRECTORY=/path/to/config \
  FORESEERR_APP_ROOT=/path/to/repo backend-rs/target/release/foreseerr
```

With `FORESEERR_NODE_URL` unset (or `FORESEERR_STANDALONE=1`) the binary is
the whole backend (`src/standalone/`):

- Startup does what `server/index.ts` does before listening: the Overseerr
  merge, the TypeORM migrations (`NODE_ENV=production` only, as in Node;
  development expects an existing schema) with `PRAGMA foreign_keys` around
  them on SQLite, the newer-schema guard, `Settings.load()` (settings.json
  created, migrated with a `settings.old.json` backup, keys and VAPID pair
  generated, `API_KEY` honoured), the Plex library type migration, the
  discover slider bootstrap and the image cache maintenance. The scheduler
  runs every job (standalone implies `FORESEERR_RUST_JOBS`).
- `network.forceIpv4First` and `network.dnsCache` apply to every outgoing
  client (`src/dnsresolve.rs`; the system resolver has no TTLs, so cached
  answers live 300 s within `forceMinTtl`/`forceMaxTtl`).
- Nothing is forwarded, and the OpenAPI validator decides every request
  itself, uncertain ones included. For a request no handler takes
  (`src/standalone/fallback.rs`), Node's answers under `/api` are
  reproduced from `seerr-api.yml` (`src/standalone/apiroutes.rs`,
  regenerate with
  `cd <repo> && bun backend-rs/scripts/gen-api-routes.ts . backend-rs && cargo fmt`):
  405 for an undocumented method (`HEAD` included), 401 without a
  credential, the `/api/v1` banner, `isAuthenticated`'s 403 for an
  undocumented path below a guarded mount, Express's HTML 404 for any
  other undocumented path. A documented route no handler answers would be
  a plain 500 `{"message":"Internal Server Error"}`, logged at `error`
  (every documented route has a handler today).
- Where a handler would have handed the request to Node, it answers its
  fallback instead: the status it names (`isAuthenticated`'s 403, a 400 for
  an input it refuses, 413 for a body over 100 kB…), else 400 when the validator
  didn't vouch for the request and 500 when it did, with
  `{"message": <the reason>}`; 5xx answers are logged at `warn`. The
  routes that are standalone-only behind Node (the Trakt device and Simkl
  PIN flows, the Simkl sync) keep their state in this process.
- In production the frontend is served like `express.static` +
  the SPA fallback: `index.html` with `Cache-Control: no-store`,
  `/assets/*` with `public, max-age=31536000, immutable`, everything else
  `public, max-age=0`, with `ETag`/`Last-Modified`, 304s and byte ranges.
  `/api-docs` is Swagger UI from `node_modules/swagger-ui-dist`
  (`src/standalone/apidocs.rs`).
- Node's `/internal` calls are answered in-process
  (`src/standalone/internal.rs`): the mapping layer (`src/mappinglayer/`)
  and the Node process state (`src/routes/procstate/`) run here, the
  settings reload is a no-op, and the jobs' state is read from the Rust
  scheduler at the call site. A path no port covers answers its caller 501.
  `/internal` requests from outside get the same answers behind Node's
  API-key check (403 `{"message":"Forbidden"}` without the key).
- `network.csrfProtection` works as csurf does in Node (`src/csrf.rs`).
- Logs go to the console (`RUST_LOG`) and, as `server/logger.ts` writes
  them, to `seerr-YYYY-MM-DD.log` and `.machinelogs-YYYY-MM-DD.json` under
  `LOG_DIRECTORY` (default `<config>/logs`) at `LOG_LEVEL` (default
  `debug`), which the log viewer reads (`src/logfile.rs`).
- `Dockerfile.rust` builds an image that runs this binary standalone.
- The Jellyfin plugin sidecar and the desktop child run standalone too
  (below).

### Managed runtimes: the desktop app and the Jellyfin plugin

The desktop app and the Jellyfin plugin can launch this binary where they
launch Node today (`node launcher.js` in the desktop bundle, the compiled
`foreseerr-<os>-<arch>` sidecar in the plugin). It has to run standalone:
leave `FORESEERR_NODE_URL` unset (or set `FORESEERR_STANDALONE=1`). With
Node behind it, both modes are forwarded to Node unchanged. The code is in
`src/runtime/`.

Files the binary reads besides the config directory, from
`FORESEERR_APP_ROOT` (default: the working directory, which both
launchers set to the directory of what they start):

| File               | Needed for                                                           |
| ------------------ | -------------------------------------------------------------------- |
| `seerr-api.yml`    | the `OpenAPI` validator (without it requests aren't validated)        |
| `dist/public/`     | the frontend in production (`FORESEERR_PUBLIC_PATH` overrides); the plugin refuses to start in production without its `index.html` |
| `committag.json`   | the commit tag in `/status` (optional, `local` without it)           |

`package.json`, the locales and the email templates are compiled in.

#### Desktop child (`FORESEERR_RUNTIME=desktop`)

Environment, as `foreseer-desktop/src/supervisor.rs` sets it for Node:

| Variable              | Value / meaning                                                    |
| --------------------- | ------------------------------------------------------------------ |
| `FORESEERR_RUNTIME`   | `desktop`                                                          |
| `NODE_ENV`            | `production` (migrations run, the frontend is served)              |
| `CONFIG_DIRECTORY`    | required: settings.json, `db/`, `state/` (exit 73 without it)      |
| `CACHE_DIRECTORY`     | image cache (`<dir>/images`)                                       |
| `LOG_DIRECTORY`       | log files                                                          |
| `PORT`                | `0` lets the system pick; read as `Number(PORT)` (unset or not a whole number: 5055) |
| `HOST`                | ignored: the child always binds `127.0.0.1`                        |
| `FORESEERR_COMMIT`    | echoed as `commit` in the readiness record (`unknown` when unset)   |
| `FORESEER_CACHE_LIMIT_BYTES` | image cache size limit                                      |

Process contract:

- stdout carries exactly one line, once listening:
  `FORESEERR_DESKTOP_READY {"protocolVersion":1,"pid":<pid>,"origin":"http://127.0.0.1:<port>","foreseerrVersion":"<version>","commit":"<FORESEERR_COMMIT>","schemaVersion":<latest migration timestamp, 0 without one>}`.
  Every log line goes to stderr, in winston's console format
  (`<ISO time> [<coloured level>][<label>]: <message> <metadata>`), at
  `LOG_LEVEL` (default `debug`; `RUST_LOG` overrides).
- `<CONFIG_DIRECTORY>/state/instance.lock` holds the pid while running
  (created 0600, removed on a clean stop). A lock whose process is alive
  ends the start with exit code 73 (`Another Foreseer Desktop instance owns
  this data directory`); a stale one is taken over. A database migrated by
  a newer, unknown version ends it with exit code 74 (`Desktop database
  schema is incompatible: …`). Any other failed start exits with 1. The
  error is logged on stderr first.
- stdin is the control channel, one JSON object per line:
  `{"type":"shutdown","deadlineMs":2000}` stops (open requests get up to
  `deadlineMs`, default 10 s), `{"type":"runtime-state","playbackActive":true|false}`
  pauses heavy jobs during playback and queues the catch-up when it ends.
  Anything else is logged (`Ignoring unknown/malformed desktop control
  message`) and ignored. End of stdin, `SIGTERM` and `SIGINT` stop like
  `shutdown` with the default deadline; a second stop request while one
  is running exits at once (as Node does, the lock is then left for the
  next start to take over).
- Stopping: `/api/v1/status` reports `"stopping":true` and every other
  request gets 503 `{"message":"Foreseerr is shutting down"}`, the jobs
  stop (`Scheduled jobs stopped`), the listener closes, `SQLite` is
  checkpointed (`wal_checkpoint(TRUNCATE)`) and closed, the lock removed,
  exit code 0.
- Requests: `Host` must be `127.0.0.1:<port>`, no `X-Forwarded-Host` or
  `Forwarded`, no absolute-URL target, and `POST`/`PUT`/`PATCH`/`DELETE`
  need `Origin: http://127.0.0.1:<port>` (except the native
  `/api/v1/desktop/auth-tickets/redeem` and `/browser-cache/redeem`);
  otherwise 403 `{"message":"Invalid local desktop request"}`. CSRF
  protection is always on (cookies `SameSite=Strict`, never `Secure`); the
  session cookie is `SameSite=Strict`.
- `/api/v1/status` adds `"runtime":"desktop","managed":true,"jobsStarted":…,"stopping":…`.
- `settings.main.applicationUrl` reads as the loopback origin while
  running and is never saved as such.
- The signed-in user id is kept in `<CONFIG_DIRECTORY>/state/desktop-login.json`
  (0600; removed on sign-out); an `/api` request without a session gets a
  new session cookie for that user (the port, and so the cookie origin,
  changes between launches).
- No jobs start at boot. They start 3 s after a successful sign-in (5 s
  after `GET /auth/me`); 30 s later one catch-up pass runs: a download
  tracker reset and poll, the heavy jobs deferred by playback, then each
  job whose cron fired while the app was closed (`Running desktop
  catch-up: <job>`), with the failure back-off of `server/job/catchup.ts`.
- Every `/api` request is logged on stderr: `API <method> <path>` and
  `API <method> <path> <status> <ms>ms` (label `Desktop`).
- Jellyfin sign-in calls time out after 15 s and skip the avatar refresh;
  library links go to the internal Jellyfin address.

#### Jellyfin plugin sidecar (`FORESEERR_PLUGIN=1`)

Environment, as `jellyfin-plugin-foreseerr/Foreseerr.Jellyfin/SidecarSupervisor.cs`
sets it:

| Variable                     | Value / meaning                                             |
| ---------------------------- | ----------------------------------------------------------- |
| `FORESEERR_PLUGIN`           | `1` (or `true`)                                             |
| `FORESEERR_PLUGIN_SECRET`    | required shared secret (the start fails without it)        |
| `FORESEERR_PLUGIN_INSTANCE`  | echoed as `instance` in the readiness record               |
| `FORESEERR_BASE_PATH`        | the mount, default `/Foreseerr`                             |
| `FORESEERR_PUBLIC_BASE_PATH` | the browser-visible base for `index.html`'s `<base>` (Jellyfin's base URL + mount) |
| `CONFIG_DIRECTORY`           | config directory, holding `jellyfin-host.json`             |
| `PORT`                       | `0` lets the system pick                                    |
| `HOST`                       | ignored: always `127.0.0.1`                                 |
| `NODE_ENV`                   | `production`                                                |
| `FORESEERR_RUNTIME`          | must be unset                                               |

Process contract:

- Once listening it writes `FORESEERR_PLUGIN_READY {"port":<port>,"instance":"<FORESEERR_PLUGIN_INSTANCE>"}`
  on stdout (no `instance` key when the variable is unset), then logs
  `Server ready on 127.0.0.1 port <port>/Foreseerr`. Console logs follow
  winston: errors and warnings on stderr, the rest on stdout, so the
  readiness line shares stdout with log lines. `SIGTERM`/`SIGINT` stop
  gracefully with exit code 0 (Node dies by the signal; the plugin kills
  the process tree anyway).
- At startup `jellyfin-host.json` is merged into settings.json (media
  server, login switches, application URL and locale, Jellyfin
  connection and libraries, the Trakt provider, `initialized`) and saved,
  and the `adminUser` it names is created or made an administrator.
- Everything lives under the base path (matched case-insensitively);
  other paths are Express's 404. Every request must come from loopback with
  `X-Foreseerr-Plugin-Secret`, else 403
  `{"error":"Plugin proxy authentication required."}`. `trust proxy` is
  on, so `X-Forwarded-Proto: https` makes the session cookie `Secure`; its
  path is the base path. CSRF protection is off.
- `POST /api/v1/auth/jellyfin/plugin` with `X-Foreseerr-Mint: 1` mints a
  session for a Jellyfin user (creating the account when allowed); Jellyfin
  administrators get ADMIN, which the plugin removes again only where it
  granted it (`settings.plugin.jellyfinAdmins`).
- The validator's `servers` entry is `<base>/api/v1` (its 401 errors name
  `/Foreseerr/api/v1/...`); `/api/v1/settings/public` reports
  `"pluginMode":true`; sign-out leaves the Jellyfin device alone; Jellyfin
  links without an external hostname use the configured `urlBase` (same
  origin as the plugin page).
- In production page routes (no file extension, or `.html`) get
  `index.html` with `<base href="<public base>/">` and a
  `foreseerr-base-path` meta tag, without the manifest link,
  `Cache-Control: no-store`.

## Checking against Node

`tools/shadow` records real traffic and replays it against Node and this
binary side by side, comparing responses, outgoing calls and the database.
A replay target for this crate looks like:

```toml
[[target]]
name = "rust"
role = "candidate"
url = "http://127.0.0.1:6113"
proxy_port = 6213
cwd = "/path/to/SeerrSuggestArr"
command = ["backend-rs/scripts/with-node.sh", "backend-rs/target/release/foreseerr"]
env = { NODE_ENV = "development", PORT = "6113" }
```

Two smaller checks need no recording and run in CI (standard-library
Python, from the repository):

- `scripts/ci-smoke.py [--bin path] [--mapping-db OUT]` starts this binary
  standalone in production mode on a fresh config directory, on SQLite or,
  with `DB_TYPE=postgres` and the `DB_*` variables, on an empty Postgres
  database (`psql` on `PATH`). It checks that exactly the migrations in
  `src/dbmigrate/` were applied, in order, that a set of authenticated
  reads answers 200, and that a restart applies nothing. With
  `--mapping-db` it also downloads both mapping datasets and copies the
  database to `OUT`, the scratch database `FORESEERR_MAPPING_TEST_DB`
  names for `src/mappinglayer/dbtests.rs`.
- `scripts/ci-compare.py [--bin path]` runs Node (`bun server/launcher.ts`,
  development) and this binary (standalone) one after the other, each on
  its own fresh SQLite database with the same seed rows. It sends both the
  same scripted requests and compares the status, the 2xx JSON bodies
  (volatile fields blanked, timestamps compared by format only) and the
  outcome of the review's failure and concurrency scenarios. Error bodies
  are not compared. Scenarios listed in its `KNOWN_GAPS` are reported
  without failing the run, and the run says when one starts to agree.

## Lints and tests

The crate uses the same strict lint set as `tools/shadow`: rustc's
`future_incompatible`, `rust_2018_idioms`, `unused` and more, Clippy's
`all`, `pedantic` and `nursery` groups and a list of restriction lints (no
`unwrap`/`expect`, no panicking indexing, no `as` casts, no `println!`), all
denied in `Cargo.toml`. `allow_attributes` is denied too, so lints can't be
silenced inline. The one exception is `multiple_crate_versions`, which sqlx
makes unavoidable. The toolchain is pinned in `rust-toolchain.toml`.

`.github/workflows/backend-rs.yml` runs on changes to the crate and to
`server/**`, since entities, migrations, settings defaults and routes are
mirrored by hand. It has five jobs:

- format, lint and test: `cargo fmt --check`, `cargo clippy --all-targets
  --locked -- -D warnings`, the SQLite startup smoke that also builds the
  scratch mapping database (`scripts/ci-smoke.py --mapping-db`), then
  `cargo test --locked` with `FORESEERR_MAPPING_TEST_DB` set;
- generated code: `scripts/gen-api-routes.ts`, `gen-migrations.ts` and
  `gen-synchronize.ts` run again (`bun <script> <repo> <repo>/backend-rs`
  from the repository), and the job fails if anything under `backend-rs/`
  changed;
- the validator differential test, `scripts/openapi-diff.sh`, which runs
  the ignored `openapi_` tests against express-openapi-validator's answers;
- startup and migrations on a Postgres 18 service container
  (`scripts/ci-smoke.py` with `DB_TYPE=postgres`);
- the Node and Rust comparison, `scripts/ci-compare.py`.

The tests that need an environment (`FORESEERR_MAPPING_TEST_DB` for the
mapping database test, `OPENAPI_CORPUS` for the ignored validator tests)
skip without it locally, but fail when `CI` is set, so a CI job can't pass
them vacuously.

## Layout

| File               | Contents                                                              |
| ------------------ | --------------------------------------------------------------------- |
| `src/main.rs`      | Runtime, listener, graceful shutdown                                  |
| `src/env.rs`       | Environment variables                                                 |
| `src/state.rs`     | Shared state and the restart flag                                     |
| `src/settings/`    | settings.json over the embedded defaults; `fullPublicSettings`        |
| `src/db.rs`        | SQLite or Postgres pool; session and user lookups                     |
| `src/auth.rs`      | `checkUser`: API key or signed session cookie                         |
| `src/user.rs`      | `User.toPublicJSON` with its column transformers                      |
| `src/discover.rs`  | Discover slider responses with their computed endpoints               |
| `src/media.rs`     | `Media` as Node prints it: servarr, Plex, Jellyfin and Tautulli links, download progress |
| `src/downloads.rs` | The download tracker: Node's over `/internal/downloads`, or the Rust jobs' (`src/jobs/downloadtracker.rs`) |
| `src/standalone/`  | Running without Node: startup (migrations, settings bootstrap, Overseerr merge), fallback answers, static frontend, in-process `/internal` |
| `src/runtime/`     | The desktop child and the Jellyfin plugin sidecar: readiness records, control channel, lock, request guards, sessions, host bootstrap |
| `src/dbmigrate/`   | The TypeORM migrations (generated by `scripts/gen-migrations.ts`), the dev-mode `synchronize` DDL (`scripts/gen-synchronize.ts`) and the schema guard |
| `src/dnsresolve.rs` | `forceIpv4First` and the DNS cache for outgoing clients              |
| `src/servarr.rs`   | Radarr and Sonarr calls: `buildUrl`, `apikey`, the rolling response cache |
| `src/ratings.rs`   | `fetchCombinedRatings`: MDBList, or Rotten Tomatoes (with its Jaro title scoring) and the IMDb proxy |
| `src/outbound.rs`  | Outgoing HTTP client: proxy settings, CA file, user agent             |
| `src/github.rs`    | The GitHub update check with its response cache                       |
| `src/tmdb.rs`      | The TMDB client: regions, languages, watch providers                  |
| `src/proxy.rs`     | Forwarding to Node                                                    |
| `src/openapi/`     | The `OpenAPI` validator and its gate in front of the routes           |
| `src/csrf.rs`      | csurf and the `XSRF-TOKEN` cookie                                     |
| `src/jobs/`        | The scheduler and the jobs (`FORESEERR_RUST_JOBS`, standalone)         |
| `src/respond.rs`   | Express-shaped JSON responses                                         |
| `src/clock.rs`     | UTC calendar fields in the formats `TypeORM` and `Date.toJSON` write |
| `src/routes/`      | The router and its forwarding (`mod.rs`), Express-style path matching (`expressroute.rs`) and one module per area (`user*.rs`, `settings*.rs`, `request*.rs`, `issue*.rs`, `media*.rs`, `discover.rs` and the provider discover modules, `movie.rs`, `tv.rs`, `library.rs`, `calendar.rs`, `auth*.rs`, `login.rs`, `linkedaccounts.rs`, `writes.rs`, `imageproxy.rs`…); `related.rs` loads the media, users and tracker a page points at, `procstate/` is Node's process state run here |

`src/settings/defaults.json` mirrors the defaults in
`server/lib/settings/index.ts` and has to be updated when they change.
