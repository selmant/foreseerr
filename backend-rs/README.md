# backend-rs

The Rust backend for Foreseerr, replacing the Node server one route at a
time. It listens where Node used to, answers the routes ported so far
itself and forwards everything else to Node, which keeps running behind it.

```text
clients ──► foreseerr (Rust) :5055 ──► Node :5056   (FORESEERR_NODE_URL)
                 │
                 └── ported routes answered here, reading the same
                     settings.json and database Node writes
```

Nothing changes for Node: it still owns settings.json, the schema and
migrations, jobs, notifications and every route not listed below. The Rust
side only reads settings.json (reloaded when the file changes) and the
database, with one exception: it refreshes session expiry on the routes it
answers, as express-session does on every request. State that lives only in
Node's memory is read over `/internal` routes Node serves for this purpose
(`server/routes/internal.ts`), authenticated with the API key: so far the
download tracker at `/internal/downloads`, which `downloadStatus` needs. Outgoing calls honour
`network.proxy` and the `NODE_EXTRA_CA_CERTS` / `SHADOW_CA_FILE` file like
Node, so they can be recorded and replayed too.

## Ported routes

| Route                              | Answered here when                                               |
| ---------------------------------- | ---------------------------------------------------------------- |
| `GET /api/v1/status`               | always, including the update check against GitHub                |
| `GET /api/v1/status/appdata`       | always                                                           |
| `GET /api/v1/settings/public`      | always                                                           |
| `GET /api/v1/auth/me`              | a user is signed in and `userEmailRequired` is off (the email check uses a library that isn't ported) |
| `GET /api/v1/settings/discover`    | a user is signed in                                              |
| `GET /api/v1/user`                 | a user is signed in and the query is one the validator accepts   |
| `GET /api/v1/user/{id}`            | a user is signed in and the id is a plain integer                |
| `GET /api/v1/regions`              | a user is signed in                                              |
| `GET /api/v1/languages`            | a user is signed in                                              |
| `GET /api/v1/watchproviders/regions` | a credential is present (the route has no `isAuthenticated`)   |
| `GET /api/v1/watchproviders/movies`, `.../tv` | a credential is present and `watchRegion` is the only parameter |
| `GET /api/v1/user/{id}/settings/{main,password,notifications,discover}` | the user themselves or a `MANAGE_USERS` holder; `discover` only when the settings row exists (Node creates it otherwise) |
| `GET /api/v1/user/{id}/settings/permissions` | a `MANAGE_USERS` holder                                  |
| `GET /api/v1/user/{id}/quota`      | the user themselves or a `MANAGE_USERS` + `MANAGE_REQUESTS` holder |
| `GET /api/v1/settings/{main,network,plex,jellyfin,tautulli,radarr,sonarr,metadatas,servarr-interventions,trakt,simkl,anilist,mdblist}` | an admin is signed in |
| `GET /api/v1/settings/notifications/{discord,slack,telegram,pushbullet,pushover,email,webpush,webhook,gotify,ntfy}` | an admin is signed in |
| `GET /api/v1/overrideRule`         | an admin is signed in and there is no query string               |
| `GET /api/v1/blocklist`            | a `MANAGE_BLOCKLIST` or `VIEW_BLOCKLIST` holder, with a query the validator and zod both accept |
| `GET /api/v1/request`              | a user is signed in and the query is one the validator accepts; quality profile names come from every Radarr and Sonarr server through `getRolling`'s cache, failures land in `serviceErrors` as in Node |
| `GET /api/v1/request/count`        | a user is signed in                                              |
| `GET /api/v1/request/{id}`         | a user is signed in and the id is a plain integer                |
| `GET /api/v1/issue`                | a `MANAGE_ISSUES`, `VIEW_ISSUES` or `CREATE_ISSUES` holder with a query the validator accepts (`requestedBy` is accepted and, as in Node, ignored) |
| `GET /api/v1/issue/count`          | a user is signed in                                              |
| `GET /api/v1/issue/{id}`           | an issue permission holder and the id is a plain integer; an unknown id is Node's 500 |
| `GET /api/v1/user/{id}/requests`   | a user is signed in, the id is a plain integer and `take`/`skip` are plain non-negative integers |
| `GET /api/v1/service/radarr`, `/service/sonarr` | a user is signed in                                 |
| `GET /api/v1/service/radarr/{id}`, `/service/sonarr/{id}` | a user is signed in, the id is a plain integer and every call to the server succeeds (a failure is Node's 500 with axios's words) |
| `GET /api/v1/settings/about`       | an admin is signed in and `CONFIG_DIRECTORY` is set (Node's default path is relative to its own sources) |
| `GET /api/v1/movie/{id}`           | a user is signed in, the id is a plain integer and the query is at most a non-empty `language`; TMDB, Rotten Tomatoes, the IMDb proxy and MDBList are called as Node calls them, with the same caches |
| `GET /api/v1/movie/{id}/recommendations`, `/similar` | a user is signed in, the id and `page` are plain integers, `language` is non-empty and no MDBList key is configured (the list enrichment isn't ported yet) |
| `GET /api/v1/movie/{id}/ratings`   | a user is signed in and the id is a plain integer                |
| `GET /api/v1/tv/{id}`              | like the movie route, and the metadata provider for the show (TV or anime, detected as `isAnimeMedia` does) is TMDB; a TVDB provider stays with Node |
| `GET /api/v1/tv/{id}/recommendations`, `/similar`, `/ratings` | like the movie routes                                |
| `GET /api/v1/tv/{id}/season/{n}`   | like the show route; Node prefixes the image host onto episode stills on the cached object, once more per call within the cache's five minutes, and so does this server |
| `GET /api/v1/person/{id}`          | a user is signed in, the id is a plain integer and the query is at most a non-empty `language` |
| `GET /api/v1/person/{id}/combined_credits`, `GET /api/v1/collection/{id}` | the same, and no MDBList key is configured |
| `GET /api/v1/search`               | a user is signed in, `query` is a plain text search (the `tmdb:`, `imdb:`, `tvdb:` and `year:` forms stay with Node), `page` is a plain integer and no MDBList key is configured |
| `GET /api/v1/search/keyword`, `/search/company` | a user is signed in and the query is one the validator accepts |
| `POST /api/v1/overrideRule`, `PUT`/`DELETE /api/v1/overrideRule/{id}` | an admin is signed in and the body's fields have the types the handler stores |
| `GET`/`PUT`/`DELETE /api/v1/issueComment/{id}` | an issue permission holder; `PUT` needs a text `message` |
| `POST /api/v1/settings/discover/add`, `PUT`/`DELETE /api/v1/settings/discover/{id}` | an admin is signed in and `title`, `data` and `type` are present and typed |
| `DELETE /api/v1/blocklist/{tmdbId}` | a `MANAGE_BLOCKLIST` holder and `mediaType` is `movie` or `tv` |
| `GET /api/v1/discover/movies`, `/tv`, `/trending`, `/movies/upcoming`, `/tv/upcoming`, `/{movies,tv}/language/{iso}`, `/{movies,tv}/genre/{id}`, `/movies/studio/{id}`, `/tv/network/{id}`, `/keyword/{id}/movies`, `/genreslider/{movie,tv}` | a user is signed in, the query is only `page` (plus `sortBy` for the popular lists and `mediaType`/`timeWindow` for trending), the user has no saved discover filter defaults and no MDBList key is configured; the upcoming lists also need the server's local time to be UTC. Filtered browsing stays with Node |
| `GET /api/v1/user/{id}/watchlist`  | the user has local watchlist rows, or no Plex token (the Plex watchlist stays with Node) |
| `GET /api/v1/user/{id}/pushSubscriptions`, `GET`/`DELETE /api/v1/user/{id}/pushSubscription/{endpoint}` | the user themselves or a `MANAGE_USERS` holder |
| `GET /api/v1/user/{id}/settings/linked-accounts/trakt`, `/simkl` | the same; Trakt only with the direct provider |
| `POST /api/v1/auth/local`          | no session cookie is present yet, no `X-Forwarded-Proto` (the cookie's `secure` flag would depend on trust proxy), an ASCII email and a bcrypt hash; the new session is stored as `connect-typeorm` stores it and Node accepts its cookie |
| `POST /api/v1/request/{id}/approve`, `/decline`, `/retry` | a request manager, no query string, a plain integer id; the save runs the request lifecycle (`src/lifecycle.rs`): notifications, sending to Radarr/Sonarr in the background, parent media and season statuses |
| `POST /api/v1/settings/network`   | an admin, a body whose keys and value types already exist in `settings.network`; saved as Node saves settings.json, then Node is told to reload it (`POST /internal/settings/reload`) |
| `POST /api/v1/auth/logout`         | the media server isn't Jellyfin or Emby (Node also unregisters the device there) |
| `GET /api/v1/media`                | a user is signed in and `take`/`skip` are plain non-negative integers (Node answers negative or fractional ones oddly, so they stay with it); the download tracker is read from Node when a row has a server and external id |

Routes are registered from two tables in `src/routes/mod.rs`: one maps a
path to the function that answers it, the other maps a path to the
settings.json section it returns as it is.

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

While routes are split between the two processes, each keeps its own
response cache, so a route still on Node may re-fetch from TMDB what this
server already holds (the shadow report lists it as an extra outgoing
call). It goes away as the routes that share a lookup move over together.

Two Node quirks are reproduced on purpose in `GET /user`: the OpenAPI
validator fills in `sort=created`, so the handler's own default never
applies, and TypeORM leaves the search `OR` chain unparenthesised, so
`includeIds` only narrows the last branch of it.

Each handler also hands the request to Node whenever Node would do
something this port doesn't reproduce, so the answer stays identical:

- plugin mode (`FORESEERR_PLUGIN`) and the desktop runtime, which change
  cookies and request checks (with Node behind; standalone mode runs both,
  see "Managed runtimes" below);
- `network.csrfProtection` on, where Node sets CSRF cookies on every call;
- a query string that isn't one the route accepts (Node's OpenAPI validator
  answers 400 for unknown parameters);
- `HEAD`, which the validator rejects with 405;
- `X-API-User` that isn't a plain number, or a stored `notificationTypes`
  or GitHub payload that would make Node throw;
- a signed-out or under-permissioned user, since Node's validator and
  `isAuthenticated` produce the 401 and 403 bodies;
- a `SQLite` datetime not in the shape TypeORM writes, which Node would
  read in the server's local timezone;
- Node hasn't answered a request yet after startup, so this server is as
  unavailable as Node while Node boots;
- settings.json or the database can't be read.

Writes (`src/routes/writes.rs`) receive the body as `express.json()`
parses it; a body it would refuse, or one whose fields the handler would
store oddly, goes to Node with the request intact. They run the statements
`TypeORM` would and print the entity as Node leaves it: fields the body
omitted are `undefined` and drop out, and a removed entity loses its id.

Responses match Express's `res.json`: compact JSON with a weak `ETag`, and a
`304` when `If-None-Match` matches.

## Running

Build with `cargo build --release`; the binary is `target/release/foreseerr`.
It reads the same environment as Node (`PORT`, `HOST`, `CONFIG_DIRECTORY`,
`DB_TYPE` and the `DB_*` Postgres variables, `API_KEY`, `FORESEERR_PLUGIN`,
`FORESEERR_RUNTIME`) plus:

| Variable             | Meaning                                                    | Default                 |
| -------------------- | ---------------------------------------------------------- | ----------------------- |
| `FORESEERR_NODE_URL` | Where Node listens; unset means standalone (below)         | standalone              |
| `FORESEERR_STANDALONE` | `1` forces standalone, `0` forces forwarding to `http://127.0.0.1:5056` | follows `FORESEERR_NODE_URL` |
| `FORESEERR_RUST_JOBS` | `1`: this process runs the scheduled jobs (implied by standalone) | unset           |
| `FORESEERR_APP_ROOT` | Directory with package.json, committag.json and `config/`  | current directory       |
| `FORESEERR_PUBLIC_PATH` | The built frontend served in standalone mode            | `$FORESEERR_APP_ROOT/dist/public` |
| `RUST_LOG`           | Log filter, e.g. `info,foreseerr=debug` to see what is forwarded and why | `info`    |

`scripts/with-node.sh` starts both processes as one tree: Rust on `$PORT`
and Node on `$PORT + 1000` bound to loopback. It is what a shadow replay
target or a container can run as "the backend".

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
- Nothing is forwarded. Under `/api` the OpenAPI validator's answers come
  from `seerr-api.yml` (`src/standalone/apiroutes.rs`, regenerate with
  `cd <repo> && bun backend-rs/scripts/gen-api-routes.ts . backend-rs && cargo fmt`):
  405 for an undocumented method, 401 without a credential, Express's HTML
  404 for an undocumented path, `isAuthenticated`'s 403 where a handler
  found no user or permission. A route or branch only Node implements
  answers `501 {"message":"This request is not available in standalone mode."}`
  and logs why at `warn`.
- In production the frontend is served like `express.static` +
  the SPA fallback: `index.html` with `Cache-Control: no-store`,
  `/assets/*` with `public, max-age=31536000, immutable`, everything else
  `public, max-age=0`, with `ETag`/`Last-Modified`, 304s and byte ranges.
  `/api-docs` is Swagger UI from `node_modules/swagger-ui-dist`
  (`src/standalone/apidocs.rs`).
- Node's `/internal` calls are answered in-process
  (`src/standalone/internal.rs`): the mapping layer (`src/mappinglayer/`)
  and the Node process state (`src/routes/procstate/`) run here.
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

## Lints and tests

The crate uses the same strict lint set as `tools/shadow`: rustc's
`future_incompatible`, `rust_2018_idioms`, `unused` and more, Clippy's
`all`, `pedantic` and `nursery` groups and a list of restriction lints (no
`unwrap`/`expect`, no panicking indexing, no `as` casts, no `println!`), all
denied in `Cargo.toml`. `allow_attributes` is denied too, so lints can't be
silenced inline. The one exception is `multiple_crate_versions`, which sqlx
makes unavoidable. The toolchain is pinned in `rust-toolchain.toml` and
`.github/workflows/backend-rs.yml` runs:

```sh
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

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
| `src/downloads.rs` | Node's download tracker, fetched over `/internal/downloads`           |
| `src/standalone/`  | Running without Node: startup (migrations, settings bootstrap, Overseerr merge), fallback answers, static frontend, in-process `/internal` |
| `src/runtime/`     | The desktop child and the Jellyfin plugin sidecar: readiness records, control channel, lock, request guards, sessions, host bootstrap |
| `src/dbmigrate/`   | The TypeORM migrations (generated by `scripts/gen-migrations.ts`) and the schema guard |
| `src/dnsresolve.rs` | `forceIpv4First` and the DNS cache for outgoing clients              |
| `src/servarr.rs`   | Radarr and Sonarr calls: `buildUrl`, `apikey`, the rolling response cache |
| `src/ratings.rs`   | `fetchCombinedRatings`: MDBList, or Rotten Tomatoes (with its Jaro title scoring) and the IMDb proxy |
| `src/outbound.rs`  | Outgoing HTTP client: proxy settings, CA file, user agent             |
| `src/github.rs`    | The GitHub update check with its response cache                       |
| `src/tmdb.rs`      | The TMDB client: regions, languages, watch providers                  |
| `src/proxy.rs`     | Forwarding to Node                                                    |
| `src/respond.rs`   | Express-shaped JSON responses                                         |
| `src/clock.rs`     | UTC calendar fields in the formats `TypeORM` and `Date.toJSON` write |
| `src/routes/`      | The ported routes, grouped per area (`user.rs`, `usersettings.rs`, `quota.rs`, `tmdb.rs`, `settings.rs`, `blocklist.rs`, `media.rs`, `request.rs`, `issue.rs`, `service.rs`, `movie.rs`, `tv.rs`, `person.rs`, `collection.rs`, `search.rs`, `discover.rs`, `writes.rs`, `userextra.rs`, `login.rs`; `related.rs` loads the media, users and tracker a page points at) |

`src/settings/defaults.json` mirrors the defaults in
`server/lib/settings/index.ts` and has to be updated when they change.
