# backend-rs

The Foreseerr backend. It replaced the Node server: one binary that listens
where Node did, runs the migrations, the jobs and the settings bootstrap,
serves the built frontend, and has a handler for every route in
`seerr-api.yml`. Where a request has no exact answer the handlers give
the fallback described under "Fallback answers" below.

The production `Dockerfile` (and `Dockerfile.rust`, which builds the same
image) runs this binary. Bun and Vite build the frontend; the final image
contains neither Bun/Node nor `node_modules`. The package scripts in the
repository root build the frontend and run this binary; the Rust commands
use `backend-rs/rust-toolchain.toml`. [AUDIT.md](AUDIT.md) records the
audit of the port.

It reads and writes settings.json (reloaded when the file changes) as
`getSettings().save()` did; each change runs on the latest document under
one lock (`SettingsStore::mutate`), so concurrent writes don't lose each
other. It reads and writes the database as the TypeORM handlers did,
refreshes session expiry as express-session did on every request, and runs
the request lifecycle (notifications, sending to Radarr/Sonarr). The state
Node kept in memory lives in this process: the download tracker, the jobs
and scanners, the response caches and integration health, the mapping
layer, the Simkl sync and resolution, the Trakt token refresh, the TVDB
metadata, the calendar source statuses and the login avatar check.
Outgoing calls honour `network.proxy` and the `SHADOW_CA_FILE` (or
`NODE_EXTRA_CA_CERTS`) CA file, so they can be recorded and replayed.

## Routes

Every path and method `seerr-api.yml` documents has a handler, plus
`POST /api/v1/desktop/browser-cache/redeem` (not in the spec),
`POST /api/v1/settings/cache/{browser,images,all}/flush` (validated as
`/settings/cache/{cacheId}/flush`) and
`/imageproxy`, `/avatarproxy` outside `/api`. Grouped by area:

| Route                              | Answered here when                                               |
| ---------------------------------- | ---------------------------------------------------------------- |
| `GET /api/v1/status`, `/status/appdata`, `/settings/public`, `/auth/me` | unless a general case below applies; `/status` includes the update check against GitHub |
| `/api/v1/auth/`: `local`, `logout`, `plex`, `jellyfin`, `jellyfin/quickconnect/{initiate,check,authenticate}`, `reset-password`, `reset-password/{guid}` | unless a general case below applies |
| `POST /api/v1/auth/jellyfin/plugin`, `/api/v1/desktop/{auth-tickets,auth-tickets/redeem,browser-cache/redeem}` | the binary runs as the Jellyfin plugin sidecar or the desktop child respectively |
| `/api/v1/user`: list, create, bulk `PUT`, `{id}` (`GET`, `PUT`, `DELETE`), `{id}/requests`, `{id}/watchlist`, `{id}/watch_data`, `{id}/pushSubscriptions`, `{id}/pushSubscription/{endpoint}`, `registerPushSubscription`, `import-from-plex`, `import-from-jellyfin`, `jellyfin/{id}` | unless a general case below applies |
| `GET`/`POST /api/v1/user/{id}/settings/{main,password,notifications,permissions,discover}` | unless a general case below applies |
| `GET /api/v1/user/{id}/quota`      | the user themselves or a `MANAGE_USERS` + `MANAGE_REQUESTS` holder |
| `/api/v1/user/{id}/settings/linked-accounts/`: Plex and Jellyfin (link, Quick Connect, unlink), Trakt and Simkl (`GET`, `PATCH`, `DELETE`), AniList (`GET`, `POST`, `PATCH`, `DELETE`) | unless a general case below applies |
| `POST .../linked-accounts/trakt/device/{code,token}`, `.../simkl/pin/{code,token}`, `.../simkl/sync` | unless a general case below applies; the device and PIN sessions, their throttles and the Simkl sync's per-user lock live in this process |
| `/api/v1/settings/` (admin): `main` (+`regenerate`), `initialize`, `network`, `plex` (+libraries, library sync, users, `devices/servers`), `jellyfin` (+libraries, library sync, users), `tautulli`, `radarr`/`sonarr` (+`test`, `{id}`, `{id}/profiles`), `metadatas` (+`test`), `servarr-interventions`, `trakt`/`simkl`/`anilist` (+`actions`), `mdblist`, every notification agent (+`test`, Pushover `sounds`), `discover` (+`add`, `{id}`, `reset`), `jobs`, `plex/sync`, `jellyfin/sync`, `cache`, `integrations/status`, `mapping/*`, `logs`, `about` | unless a general case below applies. Sections Node returned as stored are read from settings.json as they are. When `POST /settings/plex` or `/settings/tautulli` changed the settings and the connection test fails (or Tautulli has no hostname), the assigned body stays in the current settings unsaved, as it did in Node's memory |
| `/api/v1/request`: list, `count`, `{id}` (`GET`, `PUT`, `DELETE`), create, `{id}/{approve,decline,retry}` | unless a general case below applies; quality profile names come from every Radarr and Sonarr server through `getRolling`'s cache, failures land in `serviceErrors` as in Node; writes run the request lifecycle (`src/lifecycle.rs`): notifications, sending to Radarr/Sonarr in the background, parent media and season statuses |
| `/api/v1/issue`: list, `count`, `{id}` (`GET`, `DELETE`), create, `{id}/comment`, `{id}/{open,resolved}`; `/api/v1/issueComment/{id}` | unless a general case below applies |
| `/api/v1/media`: list, `{id}` `DELETE`, `{id}/{status}`, `{id}/file`, `{id}/watch_data`, `{id}/servarr/*` (context, release search and grab, manual imports, commands) | unless a general case below applies |
| `/api/v1/media-actions/*`: `capabilities`, `status-batch`, movie, show and episode status, watched, unwatched and rating | unless a general case below applies; the linked providers (Trakt, Jellyfin, AniList, Simkl) are called with the mapping layer's sync caches |
| `/api/v1/movie/{id}`, `/tv/{id}` (+`recommendations`, `similar`, `ratings`; TV also `season/{n}` and `episodes`), `/person/{id}` (+`combined_credits`), `/collection/{id}`, `/search` (+`keyword`, `company`), `/genres/*`, `/certifications/*`, `/keyword/{id}`, `/network/{id}`, `/studio/{id}`, `/backdrops`, `/regions`, `/languages`, `/watchproviders/{regions,movies,tv}` | unless a general case below applies; TMDB, TVDB, Rotten Tomatoes, the IMDb proxy and MDBList are called as Node called them, with the same caches |
| `/api/v1/discover/`: the TMDB lists (`movies`, `tv`, `trending`, upcoming, by language, genre, studio, network and keyword, `genreslider`), `trakt/*`, `anilist/*`, `simkl/*`, `mdblist/*`, `watchlist` | unless a general case below applies; provider items are resolved to TMDB by the mapping layer (`src/mappinglayer/`) |
| `/api/v1/library/*`, `/api/v1/calendar`, `/api/v1/service/{radarr,sonarr}` (+`{id}`, `sonarr/lookup/{tmdbId}`), `/api/v1/servarr/interventions` (+`count`, `seen`, `{id}/reject`) | unless a general case below applies |
| `/api/v1/blocklist` (+`{id}`, `collection/{id}`), `/api/v1/blacklist` (the deprecated alias), `/api/v1/watchlist`, `/api/v1/overrideRule` | unless a general case below applies |
| `GET /imageproxy/*`, `GET /avatarproxy/*` (`HEAD` runs the `GET` route, as in Express) | the path is one Express wouldn't decode or normalise (no `%` or dot segments, no empty segment first or last; an empty one inside, as in the `...//x.jpg` backdrop URLs the frontend builds, is kept as Express keeps it); other methods and paths get the fallback answer |

Routes are registered in `src/routes/mod.rs` from three tables: `ROUTES`
maps a path to the `GET` handler that answers it, `SETTINGS_SECTIONS` maps
a path to the settings.json section it returns as it is, and `TABLES` lists
each module's own `ROUTES` table of path, method and handler (a module adds
itself there); `imageproxy::routes` adds the two image mounts. Paths are
matched as Express matches them (case-insensitively, with an optional
trailing slash and decoded parameters, `src/routes/expressroute.rs`). A
registered path's other methods, and `HEAD`, get the fallback answer (the
validator's 405 under `/api`); so does every path no handler is
registered for.

The TMDB-backed routes use `src/tmdb.rs`, which carries `ExternalAPI.get`'s
response cache (a day for these lookups) and axios's query encoding, so the
outgoing calls are the ones Node made, byte for byte.

`GET /media` reproduces `TypeORM`'s paging order (sort column descending,
then id ascending) and leaves `seasons` out of the `mediaAdded` sort, whose
query builder doesn't load the eager relation. The `Media` entity is printed
as Node printed it in `src/media.rs`: the computed links and download
progress first, in declaration order, then the columns; a Plex `machineId`
missing from settings.json prints as `undefined`, as the template literal
did.

Numbers in upstream JSON are re-printed as JavaScript would (`8.0` becomes
`8`), since Node parsed and re-serialised every answer.

TMDB orders some arrays (release dates, crew, a cast member's roles)
differently from one call to the next and vote counts move, so two runs
side by side against live TMDB differ in order while an order-insensitive
comparison is clean. The shadow replay, which serves every target the
recorded answers, is the reference check.

Two Node quirks are reproduced on purpose in `GET /user`: the OpenAPI
validator fills in `sort=created`, so the handler's own default never
applies, and TypeORM leaves the search `OR` chain unparenthesised, so
`includeIds` only narrows the last branch of it.

One is deliberately not: `GET /tv/{id}/season/{n}` prefixes the image host
onto episode stills once per answer. Node wrote the prefix onto its cached
object, so it stacked once more per call within the cache's five minutes;
cached answers here are shared and never changed in place.

## Fallback answers

A handler that can't answer as Node would returns `Outcome::Forward` with
the reason (`src/routes/mod.rs`; the name dates from when such requests
were forwarded to a Node server behind this one, and comments in the
handlers still say a request "goes to Node" for this). The request then
gets the handler's fallback answer: the status it names
(`isAuthenticated`'s 403, a 400 for an input it refuses, 413 for a body
over 100 kB…), else 400 when the validator didn't vouch for the request
and 500 when it did, with `{"message": <the reason>}`; 5xx answers are
logged at `warn`. The fallback is meant to be decided before a handler
changes anything: once a write handler has written to the database or
settings.json, or called an upstream that acts, a failure is answered as
the handler's own error (`try_written!` in `src/routes/writes.rs`). The
general cases, on top of the per-route ones in the table:

- `HEAD` on an `/api` route, and a method no handler is registered for
  on a path (the validator's 405);
- settings.json can't be read, or the database fails in a way the handler
  doesn't answer itself;
- `X-API-User` that isn't a whole number, or a `SQLite` datetime not in the
  shape TypeORM writes, which Node would read in the server's local
  timezone;
- the OpenAPI validator is unsure (`src/openapi/gate.rs`): requests that
  pass reach the handlers with the query and body as the validator left
  them, and a handler gives its fallback for an input the validator didn't
  vouch for (a query string, a body field, an enum value) rather than
  judge it itself;
- a body `express.json()` would refuse or skip (not JSON, over 100 kB,
  neither an object nor an array), or fields the handler would store
  differently from Node;
- stored data or upstream answers of a shape Node would trip over or print
  differently (a stored `notificationTypes` or GitHub payload that would
  make Node throw, a path segment Express would decode, an odd Arr or
  Plex answer…), and upstream failures whose message Node worded itself;
  the reason strings in the handlers say which.

`network.csrfProtection` (read at startup, as Node mounted csurf once) is
reproduced in `src/csrf.rs` in front of everything: answers get the
`_csrf` and `XSRF-TOKEN` cookies as Node set them, and a request with a
missing or wrong token gets csurf's 403 `{"message":"invalid csrf token"}`.

Writes receive the body as `express.json()` parses it (or as the validator
left it, once it passed the request); a body it would refuse, or one whose
fields the handler would store oddly, gets the fallback answer. They run
the statements `TypeORM` would and print the entity as Node left it:
fields the body omitted are `undefined` and drop out, and a removed entity
loses its id.

Responses match Express's `res.json`: compact JSON with a weak `ETag`, and a
`304` when `If-None-Match` matches.

## Running

```sh
bun run build:web                 # once: the frontend in dist/public
cargo build --release
NODE_ENV=production CONFIG_DIRECTORY=/path/to/config \
  FORESEERR_APP_ROOT=/path/to/repo backend-rs/target/release/foreseerr
```

The binary is `target/release/foreseerr`. It reads the environment Node
read (`NODE_ENV`, `PORT`, `HOST`, `CONFIG_DIRECTORY`, `DB_TYPE` and the
`DB_*` Postgres variables, `API_KEY`, `LOG_LEVEL`, `LOG_DIRECTORY`,
`CACHE_DIRECTORY`, `FORESEERR_PLUGIN`, `FORESEERR_RUNTIME`) plus:

| Variable             | Meaning                                                    | Default                 |
| -------------------- | ---------------------------------------------------------- | ----------------------- |
| `FORESEERR_APP_ROOT` | Directory with `seerr-api.yml`, `committag.json`, `dist/public/` and `config/` | current directory |
| `FORESEERR_PUBLIC_PATH` | The built frontend                                      | `$FORESEERR_APP_ROOT/dist/public` |
| `SHADOW_CA_FILE`     | Extra CA certificates (PEM) to trust for outgoing calls, e.g. a shadow recorder's | `NODE_EXTRA_CA_CERTS` |
| `RUST_LOG`           | Console log filter, e.g. `info,foreseerr=debug`            | `info`                  |

What it does (`src/standalone/`):

- Startup does what `server/index.ts` did before listening: the Overseerr
  merge, the TypeORM migrations (in production, and on Postgres in
  development too, as in Node; development on `SQLite` builds the entity
  schema on an empty database as `synchronize` did, and otherwise expects
  that schema) with `PRAGMA foreign_keys` around them on SQLite, the
  newer-schema guard,
  `Settings.load()` (settings.json created, migrated with a
  `settings.old.json` backup, keys and VAPID pair generated, `API_KEY`
  honoured), the Plex library type migration, the discover slider
  bootstrap and the image cache maintenance. The scheduler runs every job.
- `network.forceIpv4First` and `network.dnsCache` apply to every outgoing
  client (`src/dnsresolve.rs`; the system resolver has no TTLs, so cached
  answers live 300 s within `forceMinTtl`/`forceMaxTtl`).
- The OpenAPI validator (`seerr-api.yml` from the app root; the start
  fails without it) decides every `/api` request itself, uncertain ones
  included. For a request no handler takes (`src/standalone/fallback.rs`),
  Node's answers under `/api` are reproduced from `seerr-api.yml`
  (`src/standalone/apiroutes.rs`, regenerate with
  `cd <repo> && bun backend-rs/scripts/gen-api-routes.ts . backend-rs`):
  405 for an undocumented method (`HEAD` included), 401 without a
  credential, the `/api/v1` banner, `isAuthenticated`'s 403 for an
  undocumented path below a guarded mount, Express's HTML 404 for any
  other undocumented path. A documented route no handler answers would be
  a plain 500 `{"message":"Internal Server Error"}`, logged at `error`
  (every documented route has a handler today).
- In production the frontend is served like `express.static` +
  the SPA fallback: `index.html` with `Cache-Control: no-store`,
  `/assets/*` with `public, max-age=31536000, immutable`, everything else
  `public, max-age=0`, with `ETag`/`Last-Modified`, 304s and byte ranges.
  `/api-docs` is Swagger UI from the browser assets packaged into
  `dist/public/api-docs` by the frontend build
  (`src/standalone/apidocs.rs`).
- The `/internal` routes Node served are answered in-process
  (`src/standalone/internal.rs`): the mapping layer (`src/mappinglayer/`)
  and the process state Node kept in memory (`src/routes/procstate/`) run
  here, the settings reload is a no-op, and the jobs' state is read from
  the Rust scheduler at the call site. A path no port covers answers its
  caller 501. `/internal` requests from outside get the same answers
  behind Node's API-key check (403 `{"message":"Forbidden"}` without the
  key).
- `network.csrfProtection` works as csurf did in Node (`src/csrf.rs`).
- Logs go to the console (`RUST_LOG`) and, as `server/logger.ts` wrote
  them, to `seerr-YYYY-MM-DD.log` and `.machinelogs-YYYY-MM-DD.json` under
  `LOG_DIRECTORY` (default `<config>/logs`) at `LOG_LEVEL` (default
  `debug`), which the log viewer reads (`src/logfile.rs`).
- The Jellyfin plugin sidecar and the desktop child are two runtimes of
  the same binary (below).

### Managed runtimes: the desktop app and the Jellyfin plugin

The desktop app and the Jellyfin plugin can launch this binary where they
launched Node (`node launcher.js` in the desktop bundle, the compiled
`foreseerr-<os>-<arch>` sidecar in the plugin). The code is in
`src/runtime/`.

Files the binary reads besides the config directory, from
`FORESEERR_APP_ROOT` (default: the working directory, which both
launchers set to the directory of what they start):

| File               | Needed for                                                           |
| ------------------ | -------------------------------------------------------------------- |
| `seerr-api.yml`    | the `OpenAPI` validator (the binary refuses to start without it)     |
| `dist/public/`     | the frontend in production (`FORESEERR_PUBLIC_PATH` overrides); the plugin refuses to start in production without its `index.html` |
| `committag.json`   | the commit tag in `/status` (optional, `local` without it)           |

`package.json`, the locales (`locale/`) and the email templates are
compiled in.

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

## Shadow replays

`tools/shadow` records real traffic and replays it against several builds
side by side, comparing responses, outgoing calls and the database: a
candidate build against the release that served the recording. A replay
target for this crate looks like:

```toml
[[target]]
name = "candidate"
role = "candidate"
url = "http://127.0.0.1:6113"
proxy_port = 6213
cwd = "/path/to/SeerrSuggestArr"
command = ["backend-rs/target/release/foreseerr"]
env = { NODE_ENV = "production", PORT = "6113" }
```

Two smaller checks need no recording and run in CI (standard-library
Python, from the repository):

- `scripts/ci-smoke.py [--bin path] [--mapping-db OUT]` starts this binary
  in production mode on a fresh config directory, on SQLite or, with
  `DB_TYPE=postgres` and the `DB_*` variables, on an empty Postgres
  database (`psql` on `PATH`). It checks that exactly the migrations in
  `src/dbmigrate/` were applied, in order, that a set of authenticated
  reads answers 200, and that a restart applies nothing. With
  `--mapping-db` it also downloads both mapping datasets and copies the
  database to `OUT`, the scratch database `FORESEERR_MAPPING_TEST_DB`
  names for `src/mappinglayer/dbtests.rs`.
- `scripts/ci-standalone.py [--bin path] [--require-web]` starts it from
  an app root holding only `seerr-api.yml` and the built frontend (no
  `node_modules`), on SQLite or the same dedicated Postgres database, and
  exercises the auth failure cases, concurrent password resets, the
  packaged frontend and Swagger bytes, a restart and the future-schema
  refusal. It rewrites migration records for a while: never run it
  against a real installation.

## Lints and tests

The crate uses the same strict lint set as `tools/shadow`: rustc's
`future_incompatible`, `rust_2018_idioms`, `unused` and more, Clippy's
`all`, `pedantic` and `nursery` groups and a list of restriction lints (no
`unwrap`/`expect`, no panicking indexing, no `as` casts, no `println!`), all
denied in `Cargo.toml`. `allow_attributes` is denied too, so lints can't be
silenced inline. The one exception is `multiple_crate_versions`, which sqlx
makes unavoidable. The toolchain is pinned in `rust-toolchain.toml`.

`.github/workflows/backend-rs.yml` runs on changes to the crate and to
what it compiles in or reads from outside it (`package.json`,
`seerr-api.yml`, the Dockerfiles, the frontend build). It has four jobs:

- format, lint and test: `cargo fmt --check`, `cargo clippy --all-targets
  --locked -- -D warnings`, the SQLite startup smoke that also builds the
  scratch mapping database (`scripts/ci-smoke.py --mapping-db`), then
  `cargo test --locked` with `FORESEERR_MAPPING_TEST_DB` set;
- the API route table: `scripts/gen-api-routes.ts` runs again (Bun only,
  no `node_modules`), and the job fails if `src/standalone/apiroutes.rs`
  changed;
- startup and migrations on a Postgres 18 service container
  (`scripts/ci-smoke.py` and `scripts/ci-standalone.py` with
  `DB_TYPE=postgres`);
- the standalone regressions with the built frontend on SQLite
  (`bun run build:web`, then `scripts/ci-standalone.py --require-web`).

The mapping database test (`FORESEERR_MAPPING_TEST_DB`) skips without its
database locally, but fails when `CI` is set, so a CI job can't pass it
vacuously.

### Hand-maintained mirrors

These were generated from or mirrored the Node sources; with the Node
server gone they are maintained here:

- `src/dbmigrate/sqlite.rs` and `postgres.rs`: the TypeORM migrations, one
  entry per migration with its class name, timestamp and statements. A
  schema change is a new entry with a later timestamp; released entries
  never change. `src/dbmigrate/sqlite_reference.json` is the schema the
  `SQLite` migrations leave, which `src/dbmigrate/tests.rs` compares
  against.
- `src/dbmigrate/synchronize.rs` and `synchronize_reference.json`: the
  development schema (`synchronize`) for an empty `SQLite` database.
- `src/settings/defaults.json`: the settings defaults (Node's
  `server/lib/settings/index.ts`).
- `src/standalone/apiroutes.rs` is still generated, from `seerr-api.yml`
  (`scripts/gen-api-routes.ts`, checked in CI).

## Layout

| File               | Contents                                                              |
| ------------------ | --------------------------------------------------------------------- |
| `src/main.rs`      | Runtime, listener, graceful shutdown                                  |
| `src/env.rs`       | Environment variables                                                 |
| `src/state.rs`     | Shared state and the restart flag                                     |
| `src/settings/`    | settings.json over the embedded defaults; `fullPublicSettings`        |
| `locale/`          | The notification strings in every locale (`src/i18n.rs` compiles them in) |
| `src/db.rs`        | SQLite or Postgres pool; session and user lookups                     |
| `src/auth.rs`      | `checkUser`: API key or signed session cookie                         |
| `src/user.rs`      | `User.toPublicJSON` with its column transformers                      |
| `src/discover.rs`  | Discover slider responses with their computed endpoints               |
| `src/media.rs`     | `Media` as Node printed it: servarr, Plex, Jellyfin and Tautulli links, download progress |
| `src/downloads.rs` | The download tracker as `downloadStatus` reads it (`src/jobs/downloadtracker.rs`) |
| `src/standalone/`  | Startup (migrations, settings bootstrap, Overseerr merge), fallback answers, static frontend, in-process `/internal` |
| `src/runtime/`     | The desktop child and the Jellyfin plugin sidecar: readiness records, control channel, lock, request guards, sessions, host bootstrap |
| `src/dbmigrate/`   | The TypeORM migrations, the dev-mode `synchronize` DDL and the schema guard |
| `src/dnsresolve.rs` | `forceIpv4First` and the DNS cache for outgoing clients              |
| `src/servarr.rs`   | Radarr and Sonarr calls: `buildUrl`, `apikey`, the rolling response cache |
| `src/ratings.rs`   | `fetchCombinedRatings`: MDBList, or Rotten Tomatoes (with its Jaro title scoring) and the IMDb proxy |
| `src/outbound.rs`  | Outgoing HTTP client: proxy settings, CA file, user agent             |
| `src/github.rs`    | The GitHub update check with its response cache                       |
| `src/tmdb.rs`      | The TMDB client: regions, languages, watch providers                  |
| `src/openapi/`     | The `OpenAPI` validator and its gate in front of the routes           |
| `src/csrf.rs`      | csurf and the `XSRF-TOKEN` cookie                                     |
| `src/jobs/`        | The scheduler and the jobs                                            |
| `src/respond.rs`   | Express-shaped JSON responses                                         |
| `src/clock.rs`     | UTC calendar fields in the formats `TypeORM` and `Date.toJSON` write |
| `src/routes/`      | The router and the hand-off to the fallback (`mod.rs`), Express-style path matching (`expressroute.rs`) and one module per area (`user*.rs`, `settings*.rs`, `request*.rs`, `issue*.rs`, `media*.rs`, `discover.rs` and the provider discover modules, `movie.rs`, `tv.rs`, `library.rs`, `calendar.rs`, `auth*.rs`, `login.rs`, `linkedaccounts.rs`, `writes.rs`, `imageproxy.rs`…); `related.rs` loads the media, users and tracker a page points at, `procstate/` is the process state Node kept in memory |
